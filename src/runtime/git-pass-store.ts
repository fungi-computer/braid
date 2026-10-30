import {
  repositoryRefsEqual,
  type RepositoryRef,
} from "@fungi.computer/agar/git";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import * as z from "zod";
import { canonicalJson } from "../index.js";
import {
  formatWorkflowGitPassToken,
  workflowGitPassTokenSchema,
  workflowGitPassGrantSchema,
  workflowGitPassRevocationSchema,
  type WorkflowGitCredential,
  type WorkflowGitPassGrant,
} from "./git-pass-contract.js";

const invocationIdSchema = z.string().min(1).max(256);
const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const leaseSchema = z.strictObject({
  invocation_id: invocationIdSchema,
  run_id: z.string(),
  grant_json: z.string(),
  token_digest: z.string().nullable(),
  expires_at: z.number().int(),
  state: z.enum(["open", "closed"]),
});
const remoteSchema = z
  .url({ protocol: /^https$/, abort: true })
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  }, "Workflow Git remotes must not contain credentials");

function mintToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A verifier digest, never a native invocation identity or replay hash. */
async function tokenDigest(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Optional internal fields use JSON's omission semantics at the storage boundary. */
function serializeGrant(grant: WorkflowGitPassGrant) {
  return canonicalJson(z.json().parse(JSON.parse(JSON.stringify(grant))));
}

/** One fresh credential per newly admitted native invocation; only its digest is durable. */
export function createWorkflowGitPassStore(
  options: Readonly<{
    sql: WatchdogSqliteOwner["sql"];
    transactionSync: <T>(body: () => T) => T;
    ownerId(): string | null;
    computerId(): string | undefined;
    mintToken?: () => string;
    remote(repository: RepositoryRef): string;
    denied(): Error;
    now?: () => number;
  }>,
) {
  const { sql } = options;
  const now = options.now ?? Date.now;
  // Pre-release reusable, plaintext pass state is disposable, not another reader.
  sql.exec("DROP TABLE IF EXISTS computer_workflow_git_passes");
  sql.exec(`CREATE TABLE IF NOT EXISTS computer_workflow_git_invocations (
    invocation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    grant_json TEXT NOT NULL, token_digest TEXT UNIQUE,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed'))
  ) STRICT`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS computer_workflow_git_ended_runs (run_id TEXT PRIMARY KEY) STRICT`,
  );
  function admittedGrant(raw: WorkflowGitPassGrant) {
    const grant = workflowGitPassGrantSchema.parse(raw);
    if (
      grant.teamId !== options.ownerId() ||
      grant.computerId !== options.computerId() ||
      grant.workflow.runId !== grant.runId ||
      grant.workflow.nodeId !== grant.nodeId ||
      grant.workflow.armedBy.kind !== "member" ||
      grant.workflow.armedBy.memberId !== grant.memberId
    )
      throw options.denied();
    return grant;
  }
  function ended(runId: string) {
    return (
      sql
        .exec(
          "SELECT 1 FROM computer_workflow_git_ended_runs WHERE run_id=?",
          runId,
        )
        .toArray().length !== 0
    );
  }
  function read(invocationId: string) {
    const row = sql
      .exec(
        "SELECT * FROM computer_workflow_git_invocations WHERE invocation_id=?",
        invocationId,
      )
      .toArray()[0];
    return row === undefined ? undefined : leaseSchema.parse(row);
  }
  return Object.freeze({
    /** Only the NEW native-admission path calls this; replay never obtains another secret. */
    async issue(
      rawInvocationId: string,
      rawGrant: WorkflowGitPassGrant,
    ): Promise<WorkflowGitCredential> {
      const invocationId = invocationIdSchema.parse(rawInvocationId);
      const grant = admittedGrant(rawGrant);
      if (ended(grant.runId) || read(invocationId) !== undefined)
        throw options.denied();
      const remote = remoteSchema.parse(
        options.remote(grant.gitAccess.repository),
      );
      const token = tokenSchema.parse((options.mintToken ?? mintToken)());
      const bearer = formatWorkflowGitPassToken(grant.teamId, token);
      const digest = await tokenDigest(token);
      return options.transactionSync(() => {
        // The digest await can race a terminal revocation or another issuer.
        admittedGrant(grant);
        if (ended(grant.runId) || read(invocationId) !== undefined)
          throw options.denied();
        const expiresAt = now() + 60_000;
        sql.exec(
          "INSERT INTO computer_workflow_git_invocations VALUES(?,?,?,?,?,'open')",
          invocationId,
          grant.runId,
          serializeGrant(grant),
          digest,
          expiresAt,
        );
        return { bearer, remote, expiresAt };
      });
    },
    /** A live native replay can extend its existing lease, never issue or resurrect it. */
    renew(rawInvocationId: string, rawGrant: WorkflowGitPassGrant): void {
      const invocationId = invocationIdSchema.parse(rawInvocationId);
      const grant = admittedGrant(rawGrant);
      options.transactionSync(() => {
        const row = read(invocationId);
        if (
          row?.state !== "open" ||
          row.expires_at <= now() ||
          row.grant_json !== serializeGrant(grant) ||
          ended(grant.runId)
        )
          throw options.denied();
        sql.exec(
          "UPDATE computer_workflow_git_invocations SET expires_at=? WHERE invocation_id=?",
          now() + 60_000,
          invocationId,
        );
      });
    },
    /** Keep the public receipt so a delayed issuer cannot reopen the same invocation. */
    close(rawInvocationId: string, rawGrant: WorkflowGitPassGrant): void {
      const invocationId = invocationIdSchema.parse(rawInvocationId);
      options.transactionSync(() => {
        const row = read(invocationId);
        if (row !== undefined) {
          // Revocation never depends on current authority or reconstructed
          // metadata still being sufficient to admit a new command.
          sql.exec(
            "UPDATE computer_workflow_git_invocations SET state='closed',token_digest=NULL WHERE invocation_id=?",
            invocationId,
          );
          return;
        }
        const grant = workflowGitPassGrantSchema.parse(rawGrant);
        // The run tombstone already prevents delayed issuance. Do not recreate
        // receipts after terminal cleanup has deleted the run's invocation rows.
        if (ended(grant.runId)) return;
        // Close can beat the issue RPC or its digest await. Retain the same
        // public identity either way, so neither can publish a later credential.
        sql.exec(
          "INSERT INTO computer_workflow_git_invocations VALUES(?,?,?,NULL,0,'closed')",
          invocationId,
          grant.runId,
          serializeGrant(grant),
        );
      });
    },
    /** Retain a tombstone so a delayed mint cannot resurrect a terminal run. */
    revokeWorkflowRunGitPasses(input: { teamId: string; runId: string }): void {
      const { teamId, runId } = workflowGitPassRevocationSchema.parse(input);
      if (teamId !== options.ownerId()) throw options.denied();
      options.transactionSync(() => {
        sql.exec(
          "INSERT OR IGNORE INTO computer_workflow_git_ended_runs VALUES(?)",
          runId,
        );
        sql.exec(
          "DELETE FROM computer_workflow_git_invocations WHERE run_id=?",
          runId,
        );
      });
    },
    /** Every request also needs the host's live native-invocation and domain admission. */
    async admit(input: {
      bearer: string;
      repository: RepositoryRef;
      scope: "read" | "write";
    }): Promise<{ invocationId: string; grant: WorkflowGitPassGrant } | null> {
      const parsed = workflowGitPassTokenSchema.safeParse(input.bearer);
      if (!parsed.success || parsed.data.ownerId !== options.ownerId())
        return null;
      const digest = await tokenDigest(parsed.data.token);
      const raw = sql
        .exec(
          "SELECT * FROM computer_workflow_git_invocations WHERE token_digest=?",
          digest,
        )
        .toArray()[0];
      if (raw === undefined) return null;
      const row = leaseSchema.parse(raw);
      if (row.state !== "open" || row.expires_at <= now()) return null;
      const grant = workflowGitPassGrantSchema.parse(
        JSON.parse(row.grant_json),
      );
      if (
        grant.teamId !== options.ownerId() ||
        grant.computerId !== options.computerId() ||
        !repositoryRefsEqual(grant.gitAccess.repository, input.repository) ||
        (input.scope === "write" && grant.scope !== "write") ||
        ended(grant.runId)
      )
        return null;
      return { invocationId: row.invocation_id, grant };
    },
  });
}

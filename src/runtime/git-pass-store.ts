import {
  repositoryRefsEqual,
  type RepositoryRef,
} from "@fungi.computer/agar/git";
import { workflowGitPassResultSchema } from "@fungi.computer/agar/computer-contracts";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { z } from "zod";
import {
  workflowGitPassGrantSchema,
  workflowGitPassRevocationSchema,
  type WorkflowGitPassGrant,
} from "./git-pass-contract.js";

/** Scoped pass state shared by both Computer hosts; credentials never enter the grant. */
export function createWorkflowGitPassStore(
  options: Readonly<{
    sql: WatchdogSqliteOwner["sql"];
    transactionSync: <T>(body: () => T) => T;
    ownerId(): string | null;
    computerId(): string | undefined;
    mintPassId(): string;
    remote(passId: string, repository: RepositoryRef): string;
    denied(): Error;
    now?: () => number;
  }>,
) {
  const { sql } = options;
  const now = options.now ?? Date.now;
  sql.exec(`CREATE TABLE IF NOT EXISTS computer_workflow_git_passes (
    pass_id TEXT PRIMARY KEY, node_key TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
    grant_json TEXT NOT NULL, expires_at INTEGER NOT NULL
  ) STRICT`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS computer_workflow_git_ended_runs (run_id TEXT PRIMARY KEY) STRICT`,
  );
  return Object.freeze({
    openWorkflowPass(raw: WorkflowGitPassGrant) {
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
      return options.transactionSync(() => {
        if (
          sql
            .exec(
              "SELECT 1 FROM computer_workflow_git_ended_runs WHERE run_id=?",
              grant.runId,
            )
            .toArray().length > 0
        )
          throw options.denied();
        const key = JSON.stringify([
          grant.runId,
          grant.graphId ?? null,
          grant.nodeId,
          grant.iteration,
          grant.scope,
        ]);
        const row = sql
          .exec(
            "SELECT pass_id,grant_json,expires_at FROM computer_workflow_git_passes WHERE node_key=?",
            key,
          )
          .toArray()[0];
        if (
          row !== undefined &&
          z.string().parse(row.grant_json) !== JSON.stringify(grant)
        )
          throw options.denied();
        const passId =
          row === undefined
            ? options.mintPassId()
            : z.string().parse(row.pass_id);
        const expiresAt = now() + 60_000;
        sql.exec(
          `INSERT INTO computer_workflow_git_passes VALUES(?,?,?,?,?)
          ON CONFLICT(node_key) DO UPDATE SET expires_at=excluded.expires_at`,
          passId,
          key,
          grant.runId,
          JSON.stringify(grant),
          expiresAt,
        );
        return workflowGitPassResultSchema.parse({
          passId,
          expiresAt,
          remote: options.remote(passId, grant.gitAccess.repository),
        });
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
          "DELETE FROM computer_workflow_git_passes WHERE run_id=?",
          runId,
        );
      });
    },
    /** Re-admit the stored scope for every Git request; an expired pass grants nothing. */
    admit(input: {
      passId: string;
      repository: RepositoryRef;
      scope: "read" | "write";
    }): WorkflowGitPassGrant | null {
      const at = now();
      const row = sql
        .exec(
          "SELECT grant_json,expires_at FROM computer_workflow_git_passes WHERE pass_id=?",
          input.passId,
        )
        .toArray()[0];
      if (row === undefined || z.number().parse(row.expires_at) <= at)
        return null;
      const grant = workflowGitPassGrantSchema.parse(
        JSON.parse(z.string().parse(row.grant_json)),
      );
      if (
        grant.teamId !== options.ownerId() ||
        grant.computerId !== options.computerId() ||
        !repositoryRefsEqual(grant.gitAccess.repository, input.repository) ||
        (input.scope === "write" && grant.scope !== "write")
      )
        return null;
      return grant;
    },
  });
}

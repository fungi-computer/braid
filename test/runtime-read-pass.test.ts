import { DatabaseSync } from "node:sqlite";
import type { RepositoryRef } from "@fungi.computer/agar/git";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import {
  createWorkflowGitPasses,
  createWorkflowGitPassStore,
  workflowGitPassGrantSchema,
  workflowGitPassWriter,
} from "../src/runtime/index.js";

const pond: RepositoryRef = {
  kind: "installation",
  installationId: "bonsai-a",
  repository: "pond",
};
const other: RepositoryRef = { ...pond, repository: "other" };
const workflow = {
  workflowId: "checks",
  runId: "run",
  nodeId: "tests",
  armedBy: { kind: "member" as const, memberId: "member" },
};
const readAccess = { repository: pond, access: "read" as const };

function readPassOwner(now: () => number) {
  const database = new DatabaseSync(":memory:");
  const store = createWorkflowGitPassStore({
    ...fromNodeSqlite(database),
    ownerId: () => "owner",
    computerId: () => "computer",
    mintToken: () => "b".repeat(64),
    remote: (repository) =>
      `https://oyster.test/git/${repository.kind === "installation" ? repository.installationId : "team"}/${repository.repository}.git`,
    denied: () => new Error("denied"),
    now,
  });
  const admitted =
    vi.fn<
      (memberId: string, repository: RepositoryRef, scope: string) => void
    >();
  const context = {
    ...workflow,
    iteration: "0",
    idempotencyKey: "opaque",
    gitAccess: readAccess,
  };
  const owner = createWorkflowGitPasses({
    denied: () => new Error("denied"),
    admitNode: () => ({
      teamId: "owner",
      memberId: "member",
      computerId: "computer",
      installationId: "shed-a",
      appId: "app_shed",
      method: "runCommand",
      methodDigest: "digest",
      context,
    }),
    admitMemberGitAccess: (memberId, repository, scope) => {
      admitted(memberId, repository, scope);
      return Promise.resolve();
    },
    revoke: (_computerId, input) => {
      store.revokeWorkflowRunGitPasses(input);
      return Promise.resolve();
    },
    pending: () => [],
    acknowledge: () => undefined,
  });
  return { database, store, owner, admitted, context };
}

it("admits a public read-only grant without issuing a credential, then limits its command to that repository", async () => {
  let at = 1000;
  const f = readPassOwner(() => at);
  try {
    const admitted = await f.owner.admitWorkflowGit(f.context, {
      installationId: "shed-a",
      method: "runCommand",
    });
    expect(admitted).toMatchObject({ scope: "read", gitAccess: readAccess });
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM computer_workflow_git_invocations",
        )
        .get()?.count,
    ).toBe(0);
    const pass = await f.store.issue("read-command", admitted);
    expect(pass).toEqual({
      bearer: `wgp.owner.${"b".repeat(64)}`,
      remote: "https://oyster.test/git/bonsai-a/pond.git",
      expiresAt: 61_000,
    });
    // Initial admission checks the member at read scope and returns only a grant.
    expect(f.admitted.mock.calls).toEqual([["member", pond, "read"]]);
    const credential = await f.store.admit({
      bearer: pass.bearer,
      repository: pond,
      scope: "read",
    });
    expect(credential).toMatchObject({
      invocationId: "read-command",
      grant: { scope: "read", gitAccess: readAccess },
    });
    if (credential === null) throw new Error("Read pass refused");
    // A read pass attests no branch ceiling: it can never become a writer.
    expect(workflowGitPassWriter(credential.grant)).toEqual({
      kind: "actor",
      actor: workflow.armedBy,
    });
    expect(
      await f.store.admit({
        bearer: pass.bearer,
        repository: pond,
        scope: "write",
      }),
    ).toBeNull();
    expect(
      await f.store.admit({
        bearer: pass.bearer,
        repository: other,
        scope: "read",
      }),
    ).toBeNull();
    at = pass.expiresAt;
    expect(
      await f.store.admit({
        bearer: pass.bearer,
        repository: pond,
        scope: "read",
      }),
    ).toBeNull();
  } finally {
    f.database.close();
  }
});

it("never lets a grant claim a scope wider than its admitted access", () => {
  const grant = {
    teamId: "owner",
    computerId: "computer",
    memberId: "member",
    workflow,
    runId: "run",
    nodeId: "tests",
    iteration: "0",
    gitAccess: readAccess,
  };
  expect(
    workflowGitPassGrantSchema.safeParse({ ...grant, scope: "read" }).success,
  ).toBe(true);
  expect(
    workflowGitPassGrantSchema.safeParse({ ...grant, scope: "write" }).success,
  ).toBe(false);
  expect(
    workflowGitPassGrantSchema.safeParse({
      ...grant,
      scope: "read",
      gitAccess: { repository: pond, branches: ["refs/heads/main"] },
    }).success,
  ).toBe(false);
});

it("ends a read pass with its run", async () => {
  const f = readPassOwner(() => 1000);
  try {
    const grant = await f.owner.admitWorkflowGit(f.context, {
      installationId: "shed-a",
      method: "runCommand",
    });
    const pass = await f.store.issue("read-command", grant);
    f.store.revokeWorkflowRunGitPasses({ teamId: "owner", runId: "run" });
    expect(
      await f.store.admit({
        bearer: pass.bearer,
        repository: pond,
        scope: "read",
      }),
    ).toBeNull();
    await expect(f.store.issue("later-command", grant)).rejects.toThrow(
      "denied",
    );
  } finally {
    f.database.close();
  }
});

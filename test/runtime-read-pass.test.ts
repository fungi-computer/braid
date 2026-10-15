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
    mintPassId: () => "wgp_read",
    remote: (_passId, repository) =>
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
    open: (_computerId, grant) =>
      Promise.resolve(store.openWorkflowPass(grant)),
    revoke: (_computerId, input) => {
      store.revokeWorkflowRunGitPasses(input);
      return Promise.resolve();
    },
    pending: () => [],
    acknowledge: () => undefined,
  });
  return { database, store, owner, admitted, context };
}

it("mints a read-only pass for exactly the admitted repository and refuses push", async () => {
  let at = 1000;
  const f = readPassOwner(() => at);
  try {
    const pass = await f.owner.openWorkflowPass(f.context, {
      installationId: "shed-a",
      method: "runCommand",
    });
    expect(pass).toEqual({
      passId: "wgp_read",
      remote: "https://oyster.test/git/bonsai-a/pond.git",
      expiresAt: 61_000,
    });
    // The live member policy is checked at read scope, before and after opening.
    expect(f.admitted.mock.calls).toEqual([
      ["member", pond, "read"],
      ["member", pond, "read"],
    ]);
    const grant = f.store.admit({
      passId: pass.passId,
      repository: pond,
      scope: "read",
    });
    expect(grant).toMatchObject({ scope: "read", gitAccess: readAccess });
    if (grant === null) throw new Error("Read pass refused");
    // A read pass attests no branch ceiling: it can never become a writer.
    expect(workflowGitPassWriter(grant)).toEqual({
      kind: "actor",
      actor: workflow.armedBy,
    });
    expect(
      f.store.admit({ passId: pass.passId, repository: pond, scope: "write" }),
    ).toBeNull();
    expect(
      f.store.admit({ passId: pass.passId, repository: other, scope: "read" }),
    ).toBeNull();
    at = pass.expiresAt;
    expect(
      f.store.admit({ passId: pass.passId, repository: pond, scope: "read" }),
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
    const pass = await f.owner.openWorkflowPass(f.context, {
      installationId: "shed-a",
      method: "runCommand",
    });
    f.store.revokeWorkflowRunGitPasses({ teamId: "owner", runId: "run" });
    expect(
      f.store.admit({ passId: pass.passId, repository: pond, scope: "read" }),
    ).toBeNull();
    await expect(
      f.owner.openWorkflowPass(f.context, {
        installationId: "shed-a",
        method: "runCommand",
      }),
    ).rejects.toThrow("denied");
  } finally {
    f.database.close();
  }
});

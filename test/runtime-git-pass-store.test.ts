import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import {
  createWorkflowGitPassStore,
  type WorkflowGitPassGrant,
} from "../src/runtime/index.js";

it("retains one scoped pass across recreation and never remints a terminal run", () => {
  const database = new DatabaseSync(":memory:");
  let now = 1000;
  const mintPassId = vi.fn(() => "cgp_fixture");
  const ports = {
    ...fromNodeSqlite(database),
    ownerId: () => "owner",
    computerId: () => "computer",
    mintPassId,
    remote: (
      passId: string,
      repository: import("@fungi.computer/agar/git").RepositoryRef,
    ) =>
      `https://git.team.internal/workflow/${passId}/${repository.repository}.git`,
    denied: () => new Error("denied"),
    now: () => now,
  };
  const grant: WorkflowGitPassGrant = {
    teamId: "owner",
    computerId: "computer",
    memberId: "member",
    runId: "run",
    nodeId: "save",
    iteration: "0",
    scope: "write",
    workflow: {
      workflowId: "save",
      runId: "run",
      nodeId: "save",
      armedBy: { kind: "member", memberId: "member" },
    },
    gitAccess: {
      repository: { kind: "team-source", repository: "project" },
      branches: ["refs/heads/main"],
    },
  };
  try {
    const initial = createWorkflowGitPassStore(ports).openWorkflowPass(grant);
    const reopened = createWorkflowGitPassStore(ports);
    expect(reopened.openWorkflowPass(grant)).toEqual(initial);
    expect(mintPassId).toHaveBeenCalledTimes(1);
    expect(
      reopened.admit({
        passId: initial.passId,
        repository: {
          kind: "installation",
          installationId: "another-app",
          repository: "project",
        },
        scope: "read",
      }),
    ).toBeNull();

    expect(
      reopened.admit({
        passId: initial.passId,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toEqual(grant);
    expect(
      reopened.admit({
        passId: initial.passId,
        repository: { kind: "team-source", repository: "other" },
        scope: "write",
      }),
    ).toBeNull();
    expect(() =>
      reopened.openWorkflowPass({ ...grant, memberId: "other" }),
    ).toThrow("denied");
    now = initial.expiresAt;
    expect(
      reopened.admit({
        passId: initial.passId,
        repository: { kind: "team-source", repository: "project" },
        scope: "write",
      }),
    ).toBeNull();
    reopened.revokeWorkflowRunGitPasses({ teamId: "owner", runId: "run" });
    const afterClose = createWorkflowGitPassStore(ports);
    expect(
      afterClose.admit({
        passId: initial.passId,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toBeNull();
    expect(() => afterClose.openWorkflowPass(grant)).toThrow("denied");
    expect(mintPassId).toHaveBeenCalledTimes(1);
  } finally {
    database.close();
  }
});

it.each(["human-revoked", "run-ended"])(
  "revokes a minted pass when %s wins during mint",
  async (race) => {
    const { createWorkflowGitPasses } = await import("../src/runtime/index.js");
    const database = new DatabaseSync(":memory:");
    const denial = new Error("denied");
    let humanAllowed = true;
    let runActive = true;
    const grant: WorkflowGitPassGrant = {
      teamId: "owner",
      computerId: "computer",
      memberId: "member",
      runId: "run",
      nodeId: "save",
      iteration: "0",
      scope: "write",
      workflow: {
        workflowId: "save",
        runId: "run",
        nodeId: "save",
        armedBy: { kind: "member", memberId: "member" },
      },
      gitAccess: {
        repository: { kind: "team-source", repository: "project" },
        branches: ["refs/heads/main"],
      },
    };
    const store = createWorkflowGitPassStore({
      ...fromNodeSqlite(database),
      ownerId: () => "owner",
      computerId: () => "computer",
      mintPassId: () => "cgp_race",
      remote: (passId, repository) =>
        `https://git.team.internal/workflow/${passId}/${repository.repository}.git`,
      denied: () => denial,
      now: () => 1000,
    });
    const context = {
      ...grant.workflow,
      iteration: "0",
      idempotencyKey: "opaque",
      gitAccess: grant.gitAccess,
    };
    const revoke = vi.fn(
      (_computerId: string, input: { teamId: string; runId: string }) => {
        store.revokeWorkflowRunGitPasses(input);
        return Promise.resolve();
      },
    );
    const owner = createWorkflowGitPasses({
      denied: () => denial,
      admitNode: () =>
        runActive
          ? {
              teamId: "owner",
              memberId: "member",
              computerId: "computer",
              installationId: "shed",
              appId: "app_shed",
              method: "save",
              methodDigest: "digest",
              context,
            }
          : null,
      admitMemberGitAccess: () =>
        humanAllowed ? Promise.resolve() : Promise.reject(denial),
      open: (_computerId, admitted) => {
        const pass = store.openWorkflowPass(admitted);
        if (race === "human-revoked") humanAllowed = false;
        else runActive = false;
        return Promise.resolve(pass);
      },
      revoke,
      pending: () => [],
      acknowledge: () => undefined,
    });
    try {
      await expect(
        owner.openWorkflowPass(context, {
          installationId: "shed",
          method: "save",
        }),
      ).rejects.toBe(denial);
      expect(revoke).toHaveBeenCalledExactlyOnceWith("computer", {
        teamId: "owner",
        runId: "run",
      });
      expect(
        store.admit({
          passId: "cgp_race",
          repository: { kind: "team-source", repository: "project" },
          scope: "write",
        }),
      ).toBeNull();
      expect(() => store.openWorkflowPass(grant)).toThrow("denied");
    } finally {
      database.close();
    }
  },
);

import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import {
  createWorkflowGitPassStore,
  workflowGitPassTokenSchema,
  type WorkflowGitPassGrant,
} from "../src/runtime/index.js";

const commandGrant: WorkflowGitPassGrant = {
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

function invocationFixture(database: DatabaseSync) {
  return {
    ...fromNodeSqlite(database),
    ownerId: () => "owner",
    computerId: () => "computer",
    mintToken: () => "a".repeat(64),
    remote: () => "https://git.team.internal/project.git",
    denied: () => new Error("denied"),
    now: () => 1000,
  };
}

// Colony emits team_<21 base36>; standalone emits an installation slug,
// including reminted <slug>-<21 base36>. Neither producer permits a dot.
it.each([`team_${"a".repeat(21)}`, "bonsai-a", `bonsai-a-${"a".repeat(21)}`])(
  "round-trips the host owner %s through the one bearer grammar",
  async (ownerId) => {
    const database = new DatabaseSync(":memory:");
    try {
      const store = createWorkflowGitPassStore({
        ...invocationFixture(database),
        ownerId: () => ownerId,
      });
      const grant = { ...commandGrant, teamId: ownerId };
      const credential = await store.issue("command", grant);
      expect(workflowGitPassTokenSchema.parse(credential.bearer)).toEqual({
        ownerId,
        token: "a".repeat(64),
      });
      expect(
        await store.admit({
          bearer: credential.bearer,
          repository: grant.gitAccess.repository,
          scope: "read",
        }),
      ).toEqual({ invocationId: "command", grant });
    } finally {
      database.close();
    }
  },
);

it.each(["owner-lost", "grant-changed"])(
  "closes an existing credential even when %s prevents new admission",
  async (change) => {
    const database = new DatabaseSync(":memory:");
    let ownerId: string | null = "owner";
    try {
      const store = createWorkflowGitPassStore({
        ...invocationFixture(database),
        ownerId: () => ownerId,
      });
      const credential = await store.issue("command", commandGrant);
      if (change === "owner-lost") ownerId = null;
      store.close(
        "command",
        change === "grant-changed"
          ? { ...commandGrant, triggerId: "reconstructed-trigger" }
          : commandGrant,
      );
      ownerId = "owner";
      expect(
        database
          .prepare(
            "SELECT state,token_digest FROM computer_workflow_git_invocations WHERE invocation_id='command'",
          )
          .get(),
      ).toMatchObject({ state: "closed", token_digest: null });
      expect(
        await store.admit({
          bearer: credential.bearer,
          repository: commandGrant.gitAccess.repository,
          scope: "read",
        }),
      ).toBeNull();
    } finally {
      database.close();
    }
  },
);

it("retains a pre-issue close even if the owner identity is no longer available", async () => {
  const database = new DatabaseSync(":memory:");
  let ownerId: string | null = null;
  try {
    const store = createWorkflowGitPassStore({
      ...invocationFixture(database),
      ownerId: () => ownerId,
    });
    store.close("command", commandGrant);
    ownerId = "owner";
    await expect(store.issue("command", commandGrant)).rejects.toThrow(
      "denied",
    );
  } finally {
    database.close();
  }
});

it("does not recreate invocation rows when completion follows run revocation", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createWorkflowGitPassStore(invocationFixture(database));
    await store.issue("command", commandGrant);
    store.revokeWorkflowRunGitPasses({
      teamId: commandGrant.teamId,
      runId: commandGrant.runId,
    });
    store.close("command", commandGrant);
    expect(
      database
        .prepare(
          "SELECT * FROM computer_workflow_git_invocations WHERE run_id=?",
        )
        .all(commandGrant.runId),
    ).toEqual([]);
    await expect(store.issue("command", commandGrant)).rejects.toThrow(
      "denied",
    );
  } finally {
    database.close();
  }
});

it("persists only the credential digest and public grant, never its bearer or token", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const store = createWorkflowGitPassStore(invocationFixture(database));
    const credential = await store.issue("command", commandGrant);
    const records = database
      .prepare("SELECT * FROM computer_workflow_git_invocations")
      .all();
    expect(records).toHaveLength(1);
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(credential.bearer);
    expect(serialized).not.toContain("a".repeat(64));
    expect(records[0]?.token_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      await store.admit({
        bearer: credential.bearer,
        repository: commandGrant.gitAccess.repository,
        scope: "write",
      }),
    ).toEqual({ invocationId: "command", grant: commandGrant });
  } finally {
    database.close();
  }
});

it.each(["command-closed", "run-ended"])(
  "does not publish a credential when %s wins during digest computation",
  async (race) => {
    const database = new DatabaseSync(":memory:");
    try {
      const ports = invocationFixture(database);
      const store = createWorkflowGitPassStore(ports);
      // issue reaches its real WebCrypto await before the synchronous close.
      const issuing = store.issue("command", commandGrant);
      if (race === "command-closed") store.close("command", commandGrant);
      else
        store.revokeWorkflowRunGitPasses({
          teamId: commandGrant.teamId,
          runId: commandGrant.runId,
        });
      await expect(issuing).rejects.toThrow("denied");
      const reopened = createWorkflowGitPassStore(ports);
      await expect(reopened.issue("command", commandGrant)).rejects.toThrow(
        "denied",
      );
      expect(
        await reopened.admit({
          bearer: `wgp.owner.${"a".repeat(64)}`,
          repository: commandGrant.gitAccess.repository,
          scope: "read",
        }),
      ).toBeNull();
    } finally {
      database.close();
    }
  },
);

it("issues fresh invocation credentials across recreation and never revives a closed command", async () => {
  const database = new DatabaseSync(":memory:");
  let now = 1000;
  let sequence = 0;
  const mintToken = vi.fn(() => (++sequence).toString(16).padStart(64, "0"));
  const ports = {
    ...fromNodeSqlite(database),
    ownerId: () => "owner",
    computerId: () => "computer",
    mintToken,
    remote: (repository: import("@fungi.computer/agar/git").RepositoryRef) =>
      `https://git.team.internal/${repository.repository}.git`,
    denied: () => new Error("denied"),
    now: () => now,
  };
  const grant = commandGrant;
  try {
    const initialStore = createWorkflowGitPassStore(ports);
    const initial = await initialStore.issue("command-a", grant);
    expect(initial.remote).toBe("https://git.team.internal/project.git");
    expect(initial.bearer).toBe(`wgp.owner.${"0".repeat(63)}1`);
    const reopened = createWorkflowGitPassStore(ports);
    expect(
      await reopened.admit({
        bearer: initial.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toEqual({ invocationId: "command-a", grant });
    await expect(reopened.issue("command-a", grant)).rejects.toThrow("denied");
    reopened.close("command-a", grant);
    const next = await reopened.issue("command-b", grant);
    expect(next.bearer).not.toBe(initial.bearer);
    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(
      await reopened.admit({
        bearer: initial.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toBeNull();
    expect(() => {
      reopened.renew("command-a", grant);
    }).toThrow("denied");
    await expect(reopened.issue("command-a", grant)).rejects.toThrow("denied");
    expect(
      await reopened.admit({
        bearer: next.bearer,
        repository: {
          kind: "installation",
          installationId: "another-app",
          repository: "project",
        },
        scope: "read",
      }),
    ).toBeNull();

    expect(
      await reopened.admit({
        bearer: next.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toEqual({ invocationId: "command-b", grant });
    // One native command admits multiple smart-HTTP requests without consuming it.
    expect(
      await reopened.admit({
        bearer: next.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "write",
      }),
    ).toEqual({ invocationId: "command-b", grant });
    expect(
      await reopened.admit({
        bearer: next.bearer,
        repository: { kind: "team-source", repository: "other" },
        scope: "write",
      }),
    ).toBeNull();
    expect(() => {
      reopened.renew("command-b", { ...grant, memberId: "other" });
    }).toThrow("denied");
    now = next.expiresAt;
    expect(
      await reopened.admit({
        bearer: next.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "write",
      }),
    ).toBeNull();
    reopened.revokeWorkflowRunGitPasses({ teamId: "owner", runId: "run" });
    const afterClose = createWorkflowGitPassStore(ports);
    expect(
      await afterClose.admit({
        bearer: next.bearer,
        repository: { kind: "team-source", repository: "project" },
        scope: "read",
      }),
    ).toBeNull();
    await expect(afterClose.issue("command-c", grant)).rejects.toThrow(
      "denied",
    );
    expect(mintToken).toHaveBeenCalledTimes(2);
  } finally {
    database.close();
  }
});

it.each(["human-revoked", "run-ended"])(
  "returns no grant or credential when %s wins during admission",
  async (race) => {
    const { createWorkflowGitPasses } = await import("../src/runtime/index.js");
    const denial = new Error("denied");
    let humanAllowed = true;
    let runActive = true;
    const grant = commandGrant;
    const context = {
      ...grant.workflow,
      iteration: "0",
      idempotencyKey: "opaque",
      gitAccess: grant.gitAccess,
    };
    let finishAdmission: () => void = () => undefined;
    const admission = new Promise<void>((resolve) => {
      finishAdmission = resolve;
    });
    const issue = vi.fn();
    const revoke = vi.fn(() => Promise.resolve());
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
      admitMemberGitAccess: async () => {
        await admission;
        if (!humanAllowed) throw denial;
      },
      revoke,
      pending: () => [],
      acknowledge: () => undefined,
    });
    const command = owner
      .admitWorkflowGit(context, {
        installationId: "shed",
        method: "save",
      })
      .then(issue);
    if (race === "human-revoked") humanAllowed = false;
    else runActive = false;
    finishAdmission();
    await expect(command).rejects.toBe(denial);
    expect(issue).not.toHaveBeenCalled();
    // Initial admission has no issuer to revoke; cleanup is still terminal-run work.
    expect(revoke).not.toHaveBeenCalled();
  },
);

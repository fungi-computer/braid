import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { compile, type ExecutionPlan } from "../src/index.js";
import { createGraphWorkflowRuns } from "../src/runtime/index.js";

async function emptyPlan(title: string): Promise<ExecutionPlan> {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title,
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return compiled.plan;
}

it("lists up to 50 runs for one installation, newest first, narrowed by actor and workflow", async () => {
  const plan = await emptyPlan("Listing");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const runs = createGraphWorkflowRuns(owner);
    const start = (
      runId: string,
      overrides: Partial<Parameters<typeof runs.startCompiled>[0]> = {},
    ) =>
      runs.startCompiled({
        teamId: "team",
        runId,
        requestId: runId,
        actorId: "member-a",
        computerId: null,
        plan,
        input: {},
        ceiling: { nodes: [], nodeGitAccess: [] },
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-a" },
        libraryInstallationId: "library-a",
        ...overrides,
      });
    for (let i = 0; i < 60; i++)
      expect(start(`run-${String(i).padStart(2, "0")}`)).toBe("started");
    // A run under a different installation never shows up in library-a's listing.
    expect(
      start("foreign-installation", { libraryInstallationId: "library-b" }),
    ).toBe("started");
    // Nor does another member's run under the same installation, once narrowed to one actor.
    expect(
      start("foreign-actor", {
        actorId: "member-b",
        initiatedBy: { kind: "member", memberId: "member-b" },
      }),
    ).toBe("started");
    const listed = runs.list({
      installationId: "library-a",
      actorId: "member-a",
    });
    expect(listed).toHaveLength(50);
    expect(listed.map((run) => run.runId)).toEqual(
      Array.from(
        { length: 50 },
        (_, i) => `run-${String(59 - i).padStart(2, "0")}`,
      ),
    );
    for (const run of listed) expect(Number.isFinite(run.startedAt)).toBe(true);
    // Without the actor filter, both members' runs under library-a are listed (capped at 50).
    const unscoped = runs.list({ installationId: "library-a" });
    expect(unscoped.some((run) => run.runId === "foreign-actor")).toBe(true);
    expect(unscoped.some((run) => run.runId === "foreign-installation")).toBe(
      false,
    );
  } finally {
    database.close();
  }
});

it("narrows list() to one workflow id within an installation", async () => {
  const plan = await emptyPlan("Workflow-scoped");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const runs = createGraphWorkflowRuns(owner);
    expect(
      runs.startCompiled({
        teamId: "team",
        runId: "echo-run",
        requestId: "echo-run",
        actorId: "member-a",
        computerId: null,
        plan,
        input: {},
        ceiling: { nodes: [], nodeGitAccess: [] },
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-a" },
        publication: {
          installationId: "library-a",
          workflowId: "echo",
          commit: "a".repeat(40),
          digest: "sha256:" + "a".repeat(64),
          armedBy: { kind: "member", memberId: "member-a" },
        },
      }),
    ).toBe("started");
    expect(
      runs.startCompiled({
        teamId: "team",
        runId: "notes-run",
        requestId: "notes-run",
        actorId: "member-a",
        computerId: null,
        plan,
        input: {},
        ceiling: { nodes: [], nodeGitAccess: [] },
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-a" },
        publication: {
          installationId: "library-a",
          workflowId: "notes",
          commit: "a".repeat(40),
          digest: "sha256:" + "b".repeat(64),
          armedBy: { kind: "member", memberId: "member-a" },
        },
      }),
    ).toBe("started");
    expect(
      runs
        .list({
          installationId: "library-a",
          actorId: "member-a",
          workflowId: "echo",
        })
        .map((run) => run.runId),
    ).toEqual(["echo-run"]);
    expect(
      runs
        .list({ installationId: "library-a", actorId: "member-a" })
        .map((run) => run.runId)
        .toSorted(),
    ).toEqual(["echo-run", "notes-run"]);
  } finally {
    database.close();
  }
});

it("treats a replay whose initiator or source differs as a conflict, not a replay", async () => {
  const plan = await emptyPlan("Replay");
  const database = new DatabaseSync(":memory:");
  try {
    const owner = fromNodeSqlite(database);
    const runs = createGraphWorkflowRuns(owner);
    const base = {
      teamId: "team",
      runId: "run",
      requestId: "request",
      computerId: null,
      plan,
      input: {},
      ceiling: { nodes: [], nodeGitAccess: [] },
    };
    expect(
      runs.startCompiled({
        ...base,
        actorId: "member-a",
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-a" },
      }),
    ).toBe("started");
    // The exact same admitted record replays.
    expect(
      runs.startCompiled({
        ...base,
        actorId: "member-a",
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-a" },
      }),
    ).toBe("replay");
    // A different initiator for the same run/request id is a conflict, never
    // silently accepted as the earlier admission.
    expect(
      runs.startCompiled({
        ...base,
        actorId: "member-b",
        source: "manual",
        initiatedBy: { kind: "member", memberId: "member-b" },
      }),
    ).toBe("conflict");
    // A different source for the same initiator is also a conflict.
    expect(
      runs.startCompiled({
        ...base,
        actorId: "member-a",
        source: "schedule",
        initiatedBy: { kind: "member", memberId: "member-a" },
      }),
    ).toBe("conflict");
    // Isolate the initiator law from source and actor: hold teamId, runId,
    // requestId, actorId and source fixed across both calls, and change only
    // the Agent initiator's grantor. Still a conflict, never a replay.
    const agentBase = {
      teamId: "team",
      runId: "agent-run",
      requestId: "agent-request",
      actorId: "member-a",
      computerId: null,
      plan,
      input: {},
      ceiling: { nodes: [], nodeGitAccess: [] },
      source: "agent" as const,
    };
    expect(
      runs.startCompiled({
        ...agentBase,
        initiatedBy: {
          kind: "agent",
          agentId: "agent-1",
          sessionId: "session-1",
          grantorMemberId: "member-a",
        },
      }),
    ).toBe("started");
    expect(
      runs.startCompiled({
        ...agentBase,
        initiatedBy: {
          kind: "agent",
          agentId: "agent-1",
          sessionId: "session-1",
          grantorMemberId: "member-b",
        },
      }),
    ).toBe("conflict");
  } finally {
    database.close();
  }
});

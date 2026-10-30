import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { realGit } from "@fungi.computer/agar/test-kit/git";
import { contentDigest, type WorkflowDefinition } from "../src/index.js";
import {
  createTeamWorkflowRuns,
  createTeamWorkflowTriggers,
  createWorkflowSchedules,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  workflowTriggerTargetSchema,
  type WorkflowArmer,
  type WorkflowTriggerPrincipal,
} from "../src/runtime/index.js";
import { memberArm } from "./armed-trigger.fixture.js";

const member: WorkflowTriggerPrincipal = { kind: "member", memberId: "owner" };
const armer: WorkflowArmer = { armedBy: "owner", armedVia: null };
type ScheduleClock = { now: number; wake: number | null };
const at = (minute: string) => Date.parse(`2026-10-11T12:${minute}:00Z`);
const unexpected = (): never => {
  throw new Error("Unexpected host port");
};

async function fixture(
  beforeLaunch?: () => Promise<void>,
  beforeCapture?: () => Promise<void>,
) {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  const git = realGit();
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Scheduled echo",
    apps: {},
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "clock",
        on: "schedule",
        cron: { expression: "*/5 * * * *", timeZone: "UTC" },
        input: {},
      },
    ],
  };
  const target = workflowTriggerTargetSchema.parse({
    installationId: "workflows-a",
    workflowId: "echo",
    triggerId: "clock",
    commit: "a".repeat(40),
    digest: await contentDigest(definition),
    bindings: {},
  });
  const catalog = () =>
    Promise.resolve([
      {
        installationId: "workflows-a",
        appId: "app_trellis",
        displayName: "Trellis",
        methods: {},
        capabilities: ["workflow.publish" as const],
        workflowPublishGranted: true,
      },
    ]);
  const authority = createWorkflowRunAuthority({
    member: () => Promise.resolve({ membershipVersion: 1 }),
    memberComputer: () => Promise.resolve(true),
    catalog,
    admitAgent: unexpected,
    capture: async (...args) => {
      await beforeCapture?.();
      return createWorkflowCeilingCapture({
        node: unexpected,
        git: unexpected,
      })(...args);
    },
    denied: () => new Error("denied"),
  });
  const runs = createTeamWorkflowRuns({
    ...storage,
    teamId: () => "team",
    admission: () => "active",
    authority,
    member: authority.member,
    memberComputer: authority.memberComputer,
    catalog: authority.catalog,
    errors: { app: (code) => new Error(code), suspended: unexpected },
    wake: unexpected,
    callWorkflowApp: unexpected,
    reviewer: unexpected,
    admitDelivery: unexpected,
    terminateGraphRun: unexpected,
  });
  const instances = new Set<string>();
  const triggers = createTeamWorkflowTriggers({
    runs,
    published: {
      resolve: (_context, selector) =>
        Promise.resolve({
          definition,
          digest: target.digest,
          workflowId: selector.workflowId,
          commit: target.commit,
          version: null,
        }),
    },
    source: () => Promise.resolve(git.git),
    admit: () => Promise.resolve(memberArm.installationAuthority),
    readAgentAccess: ({ agentId }) =>
      Promise.resolve({
        kind: "policy",
        agentId,
        policyRevision: "approval:1",
        grantorMemberId: "owner",
        level: "write",
      }),
    admitGitAccess: unexpected,
    errors: {
      denied: () => new Error("denied"),
      isDenied: (error) => error.message === "denied",
    },
    launch: async ({ runId }) => {
      await beforeLaunch?.();
      instances.add(runId);
    },
  });
  const clock: ScheduleClock = { now: at("00"), wake: null };
  const open = () =>
    createWorkflowSchedules({
      sql: storage.sql,
      triggers,
      teamId: () => "team",
      now: () => clock.now,
      commit: (body) => Promise.resolve(storage.transactionSync(body)),
      authorize: (memberId) =>
        memberId === "denied"
          ? Promise.reject(new Error("denied"))
          : Promise.resolve(),
      wake: (due) => {
        clock.wake = due;
        return Promise.resolve();
      },
      reportFailure: unexpected,
    });
  const schedules = open();
  return {
    schedules,
    open,
    runs,
    instances,
    clock,
    target,
    arm: (as: WorkflowArmer = armer) =>
      schedules.arm(as, target, "computer", memberArm.installationAuthority),
    close: () => {
      database.close();
      git.close();
    },
  };
}

it("manual pause survives reopening, retains an accepted run and history, and stops future occurrences", async () => {
  const f = await fixture();
  try {
    const armed = await f.arm();
    if (armed.kind !== "armed") throw new Error("Schedule not armed");
    f.clock.now = at("05");
    await f.schedules.fireDue();
    const [runId] = f.instances;
    if (runId === undefined) throw new Error("Run not started");
    const accepted = f.runs.graph.read(runId);
    expect(
      await f.schedules.pause(member, "workflows-a", armed.scheduleId),
    ).toEqual({ kind: "paused" });
    const reopened = f.open();
    expect(await reopened.list(member, "workflows-a", {})).toEqual({
      schedules: [
        expect.objectContaining({
          state: "paused",
          nextDueAt: at("10"),
          lastError: null,
        }),
      ],
      nextCursor: null,
    });
    expect(reopened.nextWake()).toBeNull();
    f.clock.now = at("20");
    await reopened.fireDue();
    expect(f.instances.size).toBe(1);
    expect(f.runs.graph.read(runId)).toEqual(accepted);
    expect(f.runs.workflowRunOutcome(runId)).toBe("active");
    expect(
      await reopened.disarm(member, "workflows-a", armed.scheduleId),
    ).toEqual({ kind: "disarmed" });
    expect(f.runs.graph.read(runId)).toEqual(accepted);
    expect(f.runs.workflowRunOutcome(runId)).toBe("active");
    expect(f.runs.listRuns("workflows-a").map((run) => run.runId)).toEqual([
      runId,
    ]);
  } finally {
    f.close();
  }
});

it("reads a bounded installation page and continues strictly after its last schedule", async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    for (const workflowId of ["echo", "second", "third"]) {
      const armed = await f.schedules.arm(
        armer,
        { ...f.target, workflowId },
        "computer",
        memberArm.installationAuthority,
      );
      if (armed.kind !== "armed") throw new Error("Schedule not armed");
      ids.push(armed.scheduleId);
    }
    ids.sort();
    const first = await f.schedules.list(member, "workflows-a", { limit: 2 });
    expect(first.schedules.map((row) => row.scheduleId)).toEqual(
      ids.slice(0, 2),
    );
    expect(first.nextCursor).toBe(ids[1]);
    if (first.nextCursor === null) throw new Error("Missing continuation");
    const second = await f
      .open()
      .list(member, "workflows-a", { limit: 2, after: first.nextCursor });
    expect(second).toEqual({
      schedules: [expect.objectContaining({ scheduleId: ids[2] })],
      nextCursor: null,
    });
    expect(
      await f.schedules.list(member, "other-installation", { limit: 2 }),
    ).toEqual({
      schedules: [],
      nextCursor: null,
    });
  } finally {
    f.close();
  }
});

it("pause wins over an in-flight accepted launch without cancelling it", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const launching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async () => {
    entered?.();
    await released;
  });
  try {
    const armed = await f.arm();
    if (armed.kind !== "armed") throw new Error("Schedule not armed");
    f.clock.now = at("05");
    const firing = f.schedules.fireDue();
    await launching;
    expect(
      await f.schedules.pause(member, "workflows-a", armed.scheduleId),
    ).toEqual({ kind: "paused" });
    release?.();
    await firing;
    expect(
      (await f.schedules.list(member, "workflows-a", {})).schedules,
    ).toEqual([expect.objectContaining({ state: "paused" })]);
    expect(f.clock.wake).toBeNull();
    expect(f.instances.size).toBe(1);
    f.clock.now = at("10");
    await f.schedules.fireDue();
    expect(f.instances.size).toBe(1);
    // Existing re-arm is the explicit way back to active, not a new scheduler.
    await f.arm();
    f.clock.now = at("15");
    await f.schedules.fireDue();
    expect(f.instances.size).toBe(2);
  } finally {
    release?.();
    f.close();
  }
});

it("pause keeps installation authorization and Agent-own-arm control boundaries", async () => {
  const f = await fixture();
  try {
    const human = await f.arm();
    const agent = await f.arm({
      armedBy: "owner",
      armedVia: {
        kind: "policy",
        agentId: "agent-a",
        policyRevision: "approval:1",
        grantorMemberId: "owner",
      },
    });
    if (human.kind !== "armed" || agent.kind !== "armed")
      throw new Error("Schedule not armed");
    const principal: WorkflowTriggerPrincipal = {
      kind: "agent",
      agentId: "agent-a",
      grantorMemberId: "owner",
    };
    expect(
      await f.schedules.pause(principal, "workflows-a", human.scheduleId),
    ).toEqual({ kind: "not_found" });
    expect(
      await f.schedules.pause(
        principal,
        "other-installation",
        agent.scheduleId,
      ),
    ).toEqual({ kind: "not_found" });
    await expect(
      f.schedules.pause(
        { kind: "member", memberId: "denied" },
        "workflows-a",
        agent.scheduleId,
      ),
    ).rejects.toThrow("denied");
    expect(
      await f.schedules.pause(principal, "workflows-a", agent.scheduleId),
    ).toEqual({ kind: "paused" });
    expect(
      await f.schedules.pause(principal, "workflows-a", agent.scheduleId),
    ).toEqual({ kind: "paused" });
    expect(
      await f.schedules.pause(member, "workflows-a", human.scheduleId),
    ).toEqual({ kind: "paused" });
  } finally {
    f.close();
  }
});

it("pause prevents a later schedule in the same alarm batch from being admitted", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const launching = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async () => {
    entered?.();
    await released;
  });
  try {
    const first = await f.arm();
    const second = await f.schedules.arm(
      armer,
      { ...f.target, workflowId: "second" },
      "computer",
      memberArm.installationAuthority,
    );
    if (first.kind !== "armed" || second.kind !== "armed")
      throw new Error("Schedule not armed");
    const later = [first.scheduleId, second.scheduleId].sort()[1];
    if (later === undefined) throw new Error("Second schedule missing");
    f.clock.now = at("05");
    const firing = f.schedules.fireDue();
    await launching;
    await f.schedules.pause(member, "workflows-a", later);
    release?.();
    await firing;
    expect(f.instances.size).toBe(1);
  } finally {
    release?.();
    f.close();
  }
});

it("pause before durable admission stops a firing still awaiting current authority", async () => {
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const capturing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(undefined, async () => {
    entered?.();
    await released;
  });
  try {
    const armed = await f.arm();
    if (armed.kind !== "armed") throw new Error("Schedule not armed");
    f.clock.now = at("05");
    const firing = f.schedules.fireDue();
    await capturing;
    await f.schedules.pause(member, "workflows-a", armed.scheduleId);
    release?.();
    await firing;
    expect(f.instances.size).toBe(0);
    expect(f.runs.listRuns("workflows-a")).toEqual([]);
    expect(
      (await f.schedules.list(member, "workflows-a", {})).schedules,
    ).toEqual([expect.objectContaining({ state: "paused", lastError: null })]);
  } finally {
    release?.();
    f.close();
  }
});

import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { catalogMethods, type WorkflowDefinition } from "../src/index.js";
import {
  createTeamWorkflowRuns,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  type WorkflowCatalogEntry,
} from "../src/runtime/index.js";

const unexpected = (): never => {
  throw new Error("Unexpected invocation or provider call");
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const methods = (
    await catalogMethods({
      draw: {
        description: "Draw one panel",
        effect: "write",
        requires: [],
        input: { type: "object", additionalProperties: false },
        output: { type: "object" },
      },
    })
  ).methods;
  const method = methods.draw;
  if (method === undefined) throw new Error("Draw method missing");
  const definition = (appId: string): WorkflowDefinition => ({
    format: "fungi.workflow/v1",
    title: "Panel",
    apps: { prints: { appId } },
    input: { type: "object", additionalProperties: false },
    nodes: [
      {
        id: "draw",
        kind: "app",
        app: "prints",
        method: "draw",
        methodDigest: method.digest,
        values: {},
      },
    ],
    edges: [],
    output: {},
  });
  const members = new Map([
    ["owner", 1],
    ["guest", 1],
  ]);
  const entries: WorkflowCatalogEntry[] = [
    {
      installationId: "prints",
      appId: "app_prints",
      displayName: "Prints",
      methods,
    },
    {
      installationId: "darkroom",
      appId: "app_darkroom",
      displayName: "Darkroom",
      methods,
    },
  ];
  const member = (id: string) => {
    const version = members.get(id);
    return Promise.resolve(
      version === undefined ? null : { membershipVersion: version },
    );
  };
  const catalog = () => Promise.resolve(entries);
  const memberComputer = (id: string, computer: string) =>
    Promise.resolve(members.has(id) && computer === "computer");
  const authority = createWorkflowRunAuthority({
    member,
    memberComputer,
    catalog,
    admitAgent: () => Promise.resolve(false),
    denied: () => new Error("denied"),
    capture: createWorkflowCeilingCapture({
      node: () =>
        Promise.resolve({ level: "write", capabilities: [], bindings: [] }),
      git: unexpected,
    }),
  });
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  let admission: "active" | "suspended" = "active";
  const wake = vi.fn();
  const owner = createTeamWorkflowRuns({
    ...fromNodeSqlite(database),
    authority,
    teamId: () => "team",
    admission: () => admission,
    errors: {
      app: (code) => new Error(code),
      suspended: () => new Error("suspended"),
    },
    wake,
    callWorkflowApp: unexpected,
    reviewer: unexpected,
    admitDelivery: (_memberId, delivery) =>
      Promise.resolve(delivery.agentId === "agent-reports"),
    terminateGraphRun: unexpected,
    member: async (id) => {
      const admitted = await member(id);
      if (admitted === null) throw new Error("denied");
      return admitted;
    },
    memberComputer,
    catalog,
  });
  const start = async (
    memberId: string,
    requestId: string,
    installation: "prints" | "darkroom" = "prints",
    computerId: string | null = "computer",
    delivery?: { agentId: string; sessionId: string },
  ) => {
    const appId = installation === "prints" ? "app_prints" : "app_darkroom";
    const request = {
      requestId,
      definition: definition(appId),
      bindings: { prints: installation },
      input: {},
    };
    const result = await owner.startGraph(
      memberId,
      delivery === undefined ? request : { ...request, delivery },
      computerId,
      // A report names its Workflows library.
      delivery === undefined ? undefined : "library",
    );
    if (result.kind !== "started")
      throw new Error(`Run did not start: ${result.kind}`);
    return result.runId;
  };
  const running = (runId: string) => {
    owner.graph.recordEvent({
      runId,
      nodeId: "draw",
      iteration: "0",
      state: "running",
      attempt: 1,
    });
    return {
      runId,
      nodeId: "draw",
      iteration: "0",
      state: "running" as const,
      attempt: 1,
    };
  };
  return {
    owner,
    wake,
    start,
    running,
    sql: fromNodeSqlite(database),
    removeMember: (id: string) => members.delete(id),
    suspend: () => {
      admission = "suspended";
    },
  };
}

it("ends a removed member's runs at once, refuses their nodes and queues Computer cleanup", async () => {
  const f = await fixture();
  const removed = await f.start("guest", "guest-run");
  const kept = await f.start("owner", "owner-run");
  const event = f.running(removed);
  f.owner.graph.openReview({
    runId: removed,
    nodeId: "draw",
    iteration: "0",
    instanceId: "instance",
    eventType: "review",
    title: "Approve",
    reviewers: "runner",
    timeout: 60_000,
    show: [],
  });
  f.removeMember("guest");
  f.owner.revokeMember("guest");
  expect(f.owner.workflowRunOutcome(removed)).toBe("cancelled");
  expect(f.owner.workflowRunOutcome(kept)).toBe("active");
  expect(f.owner.graph.reviews(removed).map((row) => row.status)).toEqual([
    "closed",
  ]);
  await expect(f.owner.recheckGraphNode(event)).resolves.toEqual({
    kind: "refused",
    code: "revoked",
  });
  expect(f.owner.pendingWorkflowRunCleanups()).toEqual([
    { teamId: "team", runId: removed, computerId: "computer" },
  ]);
  expect(f.wake).toHaveBeenCalledTimes(1);
  f.owner.revokeMember("guest");
  expect(f.wake).toHaveBeenCalledTimes(1);
});

it("revokes runs bound to a changed Installation only, and rolls back with its caller", async () => {
  const f = await fixture();
  const prints = await f.start("owner", "prints-run", "prints", null);
  const darkroom = await f.start("owner", "darkroom-run", "darkroom", null);
  expect(() =>
    f.sql.transactionSync(() => {
      f.owner.revokeInstallationInMutation("prints");
      throw new Error("Permission commit failed");
    }),
  ).toThrow("Permission commit failed");
  expect(f.owner.workflowRunOutcome(prints)).toBe("active");
  f.sql.transactionSync(() => {
    f.owner.revokeInstallationInMutation("prints");
  });
  expect(f.owner.workflowRunOutcome(prints)).toBe("cancelled");
  expect(f.owner.workflowRunOutcome(darkroom)).toBe("active");
  expect(f.owner.pendingWorkflowRunCleanups()).toEqual([]);
});

it("revokes runs whose frozen plan binds an App with a revoked Release", async () => {
  const f = await fixture();
  const prints = await f.start("owner", "prints-run", "prints");
  const darkroom = await f.start("owner", "darkroom-run", "darkroom");
  f.owner.revokeReleaseInMutation([]);
  expect(f.owner.workflowRunOutcome(prints)).toBe("active");
  f.owner.revokeReleaseInMutation(["app_darkroom"]);
  expect(f.owner.workflowRunOutcome(prints)).toBe("active");
  expect(f.owner.workflowRunOutcome(darkroom)).toBe("cancelled");
});

it("ends every active run when the Team is suspended and refuses new starts", async () => {
  const f = await fixture();
  const first = await f.start("owner", "first");
  const second = await f.start("guest", "second");
  f.owner.onLifecycle("active");
  expect(f.owner.workflowRunOutcome(first)).toBe("active");
  f.suspend();
  f.owner.onLifecycle("suspended");
  expect(f.owner.workflowRunOutcome(first)).toBe("cancelled");
  expect(f.owner.workflowRunOutcome(second)).toBe("cancelled");
  await expect(f.start("owner", "third")).rejects.toThrow("suspended");
});

it("refuses a start for a non-member before any run is recorded", async () => {
  const f = await fixture();
  await expect(f.start("stranger", "stranger-run")).rejects.toThrow("denied");
  expect(f.owner.graph.active()).toEqual([]);
});

it("settles a revoked trigger run's reservation so the trigger budget frees", async () => {
  const f = await fixture();
  const scope = {
    installationId: "library",
    workflowId: "panel",
    commit: "a".repeat(40),
    triggerId: "nightly",
  };
  const reserved = f.owner.reserveTriggerRun({ scope, requestId: "tick-1" });
  if (reserved.kind !== "reserved") throw new Error("Expected a reservation");
  const runId = await f.start("guest", "tick-1");
  expect(f.owner.bindTriggerRun(reserved.reservationId, runId)).toBe("bound");
  expect(f.owner.countActiveTriggerRuns(scope)).toBe(1);
  f.owner.revokeMember("guest");
  expect(f.owner.countActiveTriggerRuns(scope)).toBe(0);
  expect(f.owner.reserveTriggerRun({ scope, requestId: "tick-1" })).toEqual({
    kind: "replay",
    reservationId: reserved.reservationId,
    runId,
  });
});

it("stores a start's declared delivery and refuses a chat the member may not use", async () => {
  const f = await fixture();
  const delivery = { agentId: "agent-reports", sessionId: "session-a" };
  const runId = await f.start("owner", "reported", "prints", null, delivery);
  expect(f.owner.graph.read(runId)?.delivery).toEqual(delivery);
  await expect(
    f.owner.startGraph(
      "owner",
      {
        requestId: "no-library",
        definition: f.owner.graph.read(runId)?.plan.definition,
        bindings: { prints: "prints" },
        input: {},
        delivery,
      },
      null,
    ),
  ).rejects.toThrow("invalid");
  const silent = await f.start("owner", "silent", "prints", null);
  expect(f.owner.graph.read(silent)).not.toHaveProperty("delivery");
  await expect(
    f.start("owner", "foreign", "prints", null, {
      agentId: "agent-other",
      sessionId: "session-a",
    }),
  ).rejects.toThrow("denied");
});

import { memberArm } from "./armed-trigger.fixture.js";
import {
  compile,
  contentDigest,
  type WorkflowDefinition,
} from "../src/index.js";
import { expect, it } from "vitest";
import {
  createTeamWorkflowRuns,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  memberRunIdentity,
  type WorkflowRunPreparation,
  armedWorkflowTriggerSchema,
} from "../src/runtime/index.js";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
const unusedBinding = (): never => {
  throw new Error("Unexpected host port");
};

it("preserves the original publication digest through cache recreation and starts without opening Git", async () => {
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Ordered result",
    apps: {},
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "last",
        kind: "transform",
        fields: { text: { from: { node: "first", port: "text" } } },
      },
      {
        id: "first",
        kind: "transform",
        fields: { text: { literal: "A saved result" } },
      },
    ],
    edges: [],
    output: { text: { node: "last", port: "text" } },
  };
  const digest = await contentDigest(definition);
  const compiled = await compile(definition, {}, {});
  if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
  expect(await contentDigest(compiled.plan.definition)).not.toBe(digest);
  const binding = armedWorkflowTriggerSchema.parse({
    installationId: "workflows-a",
    workflowId: "saved",
    commit: "a".repeat(40),
    digest,
    triggerId: "clock",
    bindings: {},
    armedBy: "member-a",
    ...memberArm,
    computerId: "computer-a",
  });
  const database = new DatabaseSync(":memory:");
  const sqlite = {
    owner: fromNodeSqlite(database),
    close: () => {
      database.close();
    },
  };
  let memberActive = true;
  let revokeDuringCapture = false;
  const preparations: WorkflowRunPreparation[] = [];
  const capture = createWorkflowCeilingCapture({
    node: unusedBinding,
    git: unusedBinding,
  });
  const authority = createWorkflowRunAuthority({
    member: () =>
      Promise.resolve(memberActive ? { membershipVersion: 1 } : null),
    memberComputer: (memberId, computerId) =>
      Promise.resolve(memberId === "member-a" && computerId === "computer-a"),
    catalog: () =>
      Promise.resolve([
        {
          installationId: "workflows-a",
          appId: "app_trellis",
          displayName: "Trellis",
          methods: {},
          capabilities: ["workflow.publish" as const],
          workflowPublishGranted: true,
        },
      ]),
    admitAgent: () => Promise.resolve(false),
    capture: async (preparation, actor, member) => {
      preparations.push(preparation);
      const ceiling = await capture(preparation, actor, member);
      if (revokeDuringCapture) memberActive = false;
      return ceiling;
    },
    denied: () => new Error("denied"),
  });
  const options: Parameters<typeof createTeamWorkflowRuns>[0] = {
    ...sqlite.owner,
    teamId: () => "team-a",
    admission: () => "active",
    errors: {
      app: (code) => new Error(code),
      suspended: () => new Error("suspended"),
    },
    authority,
    wake: unusedBinding,
    callWorkflowApp: unusedBinding,
    reviewer: unusedBinding,
    admitDelivery: unusedBinding,
    terminateGraphRun: unusedBinding,
    member: () => Promise.resolve({ membershipVersion: 1 }),
    memberComputer: () => Promise.resolve(true),
    catalog: () =>
      Promise.resolve([
        {
          installationId: "workflows-a",
          appId: "app_trellis",
          displayName: "Trellis",
          methods: {},
          capabilities: ["workflow.publish" as const],
          workflowPublishGranted: true,
        },
      ]),
  };
  try {
    const owner = createTeamWorkflowRuns(options);
    owner.triggerPlans.put(binding, compiled.plan);
    const restored = createTeamWorkflowRuns(options);
    expect(restored.triggerPlans.read(binding)?.binding.digest).toBe(digest);
    const started = await restored.startCachedGraph(binding, {
      requestId: "cached-start",
      input: {},
    });
    if (started.kind !== "started") throw new Error("Cached run did not start");
    expect(restored.graph.read(started.runId)?.publication?.digest).toBe(
      digest,
    );
    expect(restored.graph.read(started.runId)?.ceiling).toEqual({
      nodes: [],
      nodeGitAccess: [],
    });
    expect(preparations[0]).toMatchObject({
      initiatedBy: { kind: "member", memberId: "member-a" },
      plan: compiled.plan,
      computerId: "computer-a",
      libraryInstallationId: "workflows-a",
    });
    const manual = await restored.startGraph(
      "member-a",
      {
        requestId: "manual-start",
        definition,
        bindings: {},
        input: {},
      },
      "computer-a",
    );
    if (manual.kind !== "started") throw new Error("Manual run did not start");
    expect(
      createTeamWorkflowRuns(options).graph.read(manual.runId)?.ceiling,
    ).toEqual({ nodes: [], nodeGitAccess: [] });
    expect(preparations[1]).toMatchObject({
      initiatedBy: { kind: "member", memberId: "member-a" },
      source: "manual",
      computerId: "computer-a",
      plan: compiled.plan,
    });
    revokeDuringCapture = true;
    await expect(
      restored.startGraph(
        "member-a",
        {
          requestId: "revoked-start",
          definition,
          bindings: {},
          input: {},
        },
        "computer-a",
      ),
    ).rejects.toThrow("denied");
    const refusedIdentity = await memberRunIdentity(
      "team-a",
      "member-a",
      "revoked-start",
    );
    expect(restored.graph.read(refusedIdentity.runId)).toBeNull();
    memberActive = true;
    revokeDuringCapture = false;
    restored.triggerPlans.refuse(
      binding,
      "Workflow changed; re-arm after publishing",
    );
    await expect(
      restored.startCachedGraph(binding, {
        requestId: "stale-start",
        input: {},
      }),
    ).resolves.toEqual({
      kind: "refused",
      reason: "Workflow changed; re-arm after publishing",
    });
  } finally {
    sqlite.close();
  }
});

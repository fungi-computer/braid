import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  catalogMethods,
  contentDigest,
  type WorkflowDefinition,
} from "../src/index.js";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  createTeamWorkflowRuns,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  type WorkflowCatalogEntry,
} from "../src/runtime/index.js";

const unexpected = (): never => {
  throw new Error("Unexpected invocation or provider call");
};

it("admits the exact active node context while keeping its binding ceiling host-only", async () => {
  const methods = (
    await catalogMethods({
      save: {
        description: "Save",
        effect: "write",
        requires: ["computer.execute"],
        input: { type: "object", additionalProperties: false },
        output: { type: "object" },
      },
    })
  ).methods;
  const method = methods.save;
  if (method === undefined) throw new Error("Save method missing");
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Save",
    apps: { shed: { appId: "app_shed" } },
    input: { type: "object", additionalProperties: false },
    nodes: [
      {
        id: "save",
        kind: "app",
        app: "shed",
        method: "save",
        methodDigest: method.digest,
        values: {},
        gitAccess: {
          binding: "source",
          repository: "repo",
          branches: ["refs/heads/main"],
        },
      },
    ],
    edges: [],
    output: {},
  };
  const catalog = (): Promise<readonly WorkflowCatalogEntry[]> =>
    Promise.resolve([
      {
        installationId: "library",
        appId: "app_workflows",
        displayName: "Workflows",
        methods: {},
        capabilities: ["workflow.publish"],
        workflowPublishGranted: true,
      },
      {
        installationId: "shed",
        appId: "app_shed",
        displayName: "Shed",
        methods,
      },
    ]);
  const member = (id: string) =>
    Promise.resolve(id === "owner" ? { membershipVersion: 1 } : null);
  const memberComputer = (id: string, computer: string) =>
    Promise.resolve(id === "owner" && computer === "computer");
  const authority = createWorkflowRunAuthority({
    member,
    memberComputer,
    catalog,
    admitAgent: () => Promise.resolve(false),
    denied: () => new Error("denied"),
    capture: createWorkflowCeilingCapture({
      node: () =>
        Promise.resolve({
          level: "write",
          capabilities: ["computer.execute"],
          bindings: [{ name: "COMPUTER", operations: ["workflowGitPass"] }],
        }),
      git: (actor, capturedMember, repository, scope) =>
        Promise.resolve(
          actor.memberId === "owner" &&
            capturedMember.membershipVersion === 1 &&
            repository.kind === "team-source" &&
            repository.repository === "repo" &&
            scope === "write",
        ),
    }),
  });
  const database = new DatabaseSync(":memory:");
  try {
    const owner = createTeamWorkflowRuns({
      ...fromNodeSqlite(database),
      authority,
      teamId: () => "team",
      admission: () => "active",
      errors: {
        app: (code) => new Error(code),
        suspended: () => new Error("suspended"),
      },
      wake: unexpected,
      callWorkflowApp: unexpected,
      reviewer: unexpected,
      admitDelivery: unexpected,
      terminateGraphRun: unexpected,
      member: async (id) => {
        const admitted = await member(id);
        if (admitted === null) throw new Error("denied");
        return admitted;
      },
      memberComputer,
      catalog,
    });
    const result = await owner.startGraph(
      "owner",
      {
        requestId: "save",
        definition,
        bindings: { shed: "shed", source: { kind: "team-source" } },
        input: {},
        published: {
          workflowId: "save",
          commit: "a".repeat(40),
          digest: S.decodeUnknownSync(sha256DigestSchema)(
            await contentDigest(definition),
          ),
        },
      },
      "computer",
      "library",
    );
    if (result.kind !== "started")
      throw new Error(`Run did not start: ${result.kind}`);
    const context = {
      workflowId: "save",
      armedBy: { kind: "member" as const, memberId: "owner" },
      runId: result.runId,
      nodeId: "save",
      iteration: "0",
      poll: 0,
      idempotencyKey: "opaque",
      gitAccess: {
        repository: { kind: "team-source" as const, repository: "repo" },
        branches: ["refs/heads/main"],
      },
    };
    owner.graph.recordEvent({
      runId: result.runId,
      nodeId: "save",
      iteration: "0",
      poll: 0,
      state: "running",
      attempt: 1,
    });
    expect(
      owner.admitWorkflowNode(context, {
        installationId: "shed",
        method: "save",
      }),
    ).toEqual({
      teamId: "team",
      memberId: "owner",
      computerId: "computer",
      installationId: "shed",
      appId: "app_shed",
      method: "save",
      methodDigest: method.digest,
      context,
    });
    const stored = owner.graph.read(result.runId);
    if (stored === null) throw new Error("Started run missing");
    expect(stored.ceiling.nodes[0]?.bindings).toEqual([
      { name: "COMPUTER", operations: ["workflowGitPass"] },
    ]);
    const target = { installationId: "shed", method: "save" };
    for (const changed of [
      { ...context, poll: 1 },
      { ...context, iteration: "other" },
      { ...context, workflowId: "other" },
      { ...context, armedBy: { kind: "member" as const, memberId: "other" } },
      {
        ...context,
        gitAccess: {
          repository: { kind: "team-source" as const, repository: "other" },
          branches: ["refs/heads/main"],
        },
      },
    ])
      expect(owner.admitWorkflowNode(changed, target)).toBeNull();
    const guestCeiling = {
      ...context,
      bindingCeiling: stored.ceiling.nodes[0]?.bindings,
    };
    expect(() => owner.admitWorkflowNode(guestCeiling, target)).toThrow();
    owner.graph.recordEvent({
      runId: result.runId,
      nodeId: "save",
      iteration: "0",
      poll: 0,
      state: "complete",
      attempt: 1,
    });
    expect(owner.admitWorkflowNode(context, target)).toBeNull();
    owner.terminalTriggerRun(result.runId);
    expect(owner.admitWorkflowNode(context, target)).toBeNull();
  } finally {
    database.close();
  }
});

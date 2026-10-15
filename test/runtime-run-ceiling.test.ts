import * as Schema from "effect/Schema";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { compile } from "../src/index.js";
import {
  createGraphWorkflowRuns,
  planNodeCall,
  runCeilingSchema,
  type RunCeiling,
  type RunAuthority,
} from "../src/runtime/index.js";

it("keeps the admitted starting human's Git ceiling for a manual run after recreation", async () => {
  const authority: RunAuthority<string, RunCeiling> = {
    resolve: (memberId) =>
      Promise.resolve({
        kind: "admitted",
        actor: { kind: "member", memberId },
        ceiling: {
          nodes: [
            {
              nodeId: "save",
              level: "write",
              capabilities: ["git.repository"],
              bindings: [
                { name: "GIT", operations: ["read", "write", "exchange"] },
              ],
            },
          ],
          nodeGitAccess: [
            {
              nodeId: "save",
              gitAccess: {
                repository: {
                  kind: "installation",
                  installationId: "bonsai-installed",
                  repository: "project",
                },
                branches: ["refs/heads/main"],
              },
            },
          ],
        },
      }),
    stillAttached: () => Promise.resolve(true),
  };
  const admitted = await authority.resolve("member");
  if (admitted.kind !== "admitted")
    throw new Error("Fixture admission refused");
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Manual save",
      apps: { terminal: { appId: "app_shed" } },
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          id: "save",
          kind: "app",
          app: "terminal",
          method: "save",
          methodDigest: "sha256:" + "a".repeat(64),
          values: {},
          gitAccess: {
            binding: "source",
            repository: "project",
            branches: ["refs/heads/main"],
          },
        },
      ],
      edges: [],
      output: { value: { node: "save", port: "value" } },
    },
    {
      app_shed: {
        methods: {
          save: {
            description: "Save",
            approval: "none",
            input: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            output: {
              type: "object",
              properties: { value: { type: "string" } },
            },
            effect: "write",
            requires: ["git.repository"],
            digest: "sha256:" + "a".repeat(64),
          },
        },
      },
    },
    {
      terminal: { appId: "app_shed", installationId: "shed" },
      source: { appId: "app_bonsai", installationId: "bonsai-installed" },
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const database = new DatabaseSync(":memory:");
  try {
    const storage = fromNodeSqlite(database);
    const run = {
      teamId: "team",
      runId: "manual-save",
      requestId: "request",
      actorId: admitted.actor.memberId,
      computerId: "computer",
      plan: compiled.plan,
      input: {},
      ceiling: admitted.ceiling,
      source: "manual" as const,
      initiatedBy: {
        kind: "member" as const,
        memberId: admitted.actor.memberId,
      },
    };
    expect(createGraphWorkflowRuns(storage).startCompiled(run)).toBe("started");
    const restored = createGraphWorkflowRuns(storage).read(run.runId);
    if (restored === null) throw new Error("Run missing");
    const methodSpec = compiled.plan.catalog.app_shed?.methods.save;
    if (methodSpec === undefined) throw new Error("Fixture method missing");
    const nodeCall = {
      teamId: run.teamId,
      runId: run.runId,
      methodSpec,
      nodeId: "save",
      iteration: "0",
      idempotencyKey: "save-0",
      installationId: "shed",
      method: "save",
      input: {},
    };
    const call = planNodeCall(restored, nodeCall);
    expect(call).toHaveProperty(
      "bindingCeiling",
      restored.ceiling.nodes[0]?.bindings,
    );
    expect(call?.gitAccess).toEqual({
      repository: {
        kind: "installation",
        installationId: "bonsai-installed",
        repository: "project",
      },
      branches: ["refs/heads/main"],
    });
    expect(call).not.toHaveProperty("trigger");
    for (const repository of [
      {
        kind: "installation",
        installationId: "other-installation",
        repository: "project",
      },
      { kind: "team-source", repository: "project" },
    ]) {
      const altered = Schema.decodeUnknownSync(runCeilingSchema)({
        ...restored.ceiling,
        nodeGitAccess: [
          {
            nodeId: "save",
            gitAccess: { repository, branches: ["refs/heads/main"] },
          },
        ],
      });
      expect(
        planNodeCall({ ...restored, ceiling: altered }, nodeCall),
      ).toBeNull();
    }

    const node = restored.ceiling.nodes[0];
    if (node === undefined) throw new Error("Captured node missing");
    const narrowedNodes: RunCeiling["nodes"] = [
      { ...node, capabilities: [] },
      { ...node, level: "read" },
    ];
    for (const narrowed of narrowedNodes) {
      expect(
        planNodeCall(
          {
            ...restored,
            ceiling: { ...restored.ceiling, nodes: [narrowed] },
          },
          nodeCall,
        ),
      ).toBeNull();
    }
  } finally {
    database.close();
  }
});

it("rejects missing, widened and ambiguous saved node authority", () => {
  const valid = {
    nodes: [
      {
        nodeId: "save",
        level: "read",
        capabilities: ["git.repository"],
        bindings: [{ name: "GIT", operations: ["read"] }],
      },
    ],
    nodeGitAccess: [],
  };
  const decode = Schema.decodeUnknownSync(runCeilingSchema, {
    onExcessProperty: "error",
  });
  expect(decode(valid)).toEqual(valid);
  for (const value of [
    undefined,
    { nodeGitAccess: [] },
    { ...valid, role: "owner" },
    { ...valid, nodes: [{ ...valid.nodes[0], level: "owner" }] },
    { ...valid, nodes: [{ ...valid.nodes[0], capabilities: ["anything"] }] },
    {
      ...valid,
      nodes: [
        {
          ...valid.nodes[0],
          bindings: [{ name: "GIT", operations: ["anything"] }],
        },
      ],
    },
    { ...valid, nodes: [valid.nodes[0], valid.nodes[0]] },
  ])
    expect(() => decode(value)).toThrow();
});

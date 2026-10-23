import { memberArm } from "./armed-trigger.fixture.js";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import {
  catalogMethods,
  compile,
  contentDigest,
  type WorkflowDefinition,
} from "../src/index.js";
import * as runtime from "../src/runtime/index.js";

async function preparation(
  effect: "read" | "write" = "write",
  requires: readonly string[] = ["computer.execute", "computer.writeFile"],
  withGit = true,
) {
  const catalog = {
    app_shed: await catalogMethods({
      save: {
        description: "Save",
        effect,
        requires,
        input: { type: "object" },
        output: { type: "object", properties: { value: { type: "string" } } },
      },
    }),
  };
  const method = catalog.app_shed.methods.save;
  if (method === undefined) throw new Error("Fixture method missing");
  const baseNode: Extract<
    WorkflowDefinition["nodes"][number],
    { kind: "app" }
  > = {
    id: "save",
    kind: "app",
    app: "terminal",
    method: "save",
    methodDigest: method.digest,
    values: {},
  };
  const saveNode = withGit
    ? {
        ...baseNode,
        gitAccess: {
          binding: "source",
          repository: "project",
          branches: ["refs/heads/main"],
        },
      }
    : baseNode;
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Save",
      apps: { terminal: { appId: "app_shed" } },
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [saveNode],
      edges: [],
      output: { value: { node: "save", port: "value" } },
    },
    catalog,
    {
      terminal: { appId: "app_shed", installationId: "shed-installed" },
      source: { kind: "team-source" },
    },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  return {
    plan: compiled.plan,
    computerId: "computer-pinned",
    initiatedBy: { kind: "member" as const, memberId: "member-start" },
    source: "manual" as const,
  };
}

it("captures a graph without Computer-bound nodes when no Computer is selected", async () => {
  const catalog = {
    app_events: await catalogMethods({
      announce: {
        description: "Announce",
        effect: "write",
        requires: ["app.events.emit"],
        input: { type: "object" },
        output: { type: "object" },
      },
    }),
  };
  const method = catalog.app_events.methods.announce;
  if (method === undefined) throw new Error("Fixture method missing");
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Announce",
      apps: { events: { appId: "app_events" } },
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          id: "announce",
          kind: "app",
          app: "events",
          method: "announce",
          methodDigest: method.digest,
          values: {},
        },
      ],
      edges: [],
      output: {},
    },
    catalog,
    { events: { appId: "app_events", installationId: "events-installed" } },
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
  const node = vi.fn<runtime.WorkflowCeilingCapturePorts["node"]>(() =>
    Promise.resolve({
      level: "write",
      capabilities: ["app.events.emit"],
      bindings: [{ name: "EVENTS", operations: ["emit"] }],
    }),
  );
  const git = vi.fn(() =>
    Promise.reject(new Error("Unexpected Git admission")),
  );
  const capture = runtime.createWorkflowCeilingCapture({ node, git });
  await expect(
    capture(
      {
        plan: compiled.plan,
        computerId: null,
        initiatedBy: { kind: "member", memberId: "member-start" },
        source: "manual",
      },
      { kind: "member", memberId: "member-start" },
      { membershipVersion: 2 },
    ),
  ).resolves.toEqual({
    nodes: [
      {
        nodeId: "announce",
        level: "write",
        capabilities: ["app.events.emit"],
        bindings: [{ name: "EVENTS", operations: ["emit"] }],
      },
    ],
    nodeGitAccess: [],
  });
  expect(node.mock.lastCall?.[2].computerId).toBeNull();
  expect(git).not.toHaveBeenCalled();
});

it.each([
  "computer.list",
  "computer.readFile",
  "computer.writeFile",
  "computer.execute",
  "media.generation",
])(
  "refuses null Computer for a node requiring %s before node admission",
  async (capability) => {
    const prepared = await preparation("write", [capability], false);
    const node = vi.fn<runtime.WorkflowCeilingCapturePorts["node"]>(() =>
      Promise.reject(new Error("Unexpected node admission")),
    );
    const git = vi.fn(() =>
      Promise.reject(new Error("Unexpected Git admission")),
    );
    const capture = runtime.createWorkflowCeilingCapture({ node, git });
    await expect(
      capture(
        { ...prepared, computerId: null },
        { kind: "member", memberId: "member-start" },
        { membershipVersion: 2 },
      ),
    ).resolves.toBeNull();
    expect(node).not.toHaveBeenCalled();
    expect(git).not.toHaveBeenCalled();
  },
);

it("refuses a null Computer for a Git step even without Computer capabilities", async () => {
  const prepared = await preparation("write", ["app.events.emit"]);
  const node = vi.fn<runtime.WorkflowCeilingCapturePorts["node"]>(() =>
    Promise.reject(new Error("Unexpected node admission")),
  );
  const git = vi.fn(() =>
    Promise.reject(new Error("Unexpected Git admission")),
  );
  const capture = runtime.createWorkflowCeilingCapture({ node, git });
  await expect(
    capture(
      { ...prepared, computerId: null },
      { kind: "member", memberId: "member-start" },
      { membershipVersion: 2 },
    ),
  ).resolves.toBeNull();
  expect(node).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
});

it("captures real node admission and resolves Git through the run binding without minting or invoking", async () => {
  const prepared = await preparation();
  const actor = { kind: "member" as const, memberId: "member-start" };
  const member = { membershipVersion: 2 };
  const node = vi.fn(() =>
    Promise.resolve({
      level: "write" as const,
      capabilities: [
        "computer.execute" as const,
        "computer.writeFile" as const,
      ],
      bindings: [
        {
          name: "COMPUTER" as const,
          operations: ["exec" as const, "processStart" as const],
        },
      ],
    }),
  );
  const git = vi.fn(() => Promise.resolve(true));
  const capture = runtime.createWorkflowCeilingCapture({ node, git });
  await expect(capture(prepared, actor, member)).resolves.toEqual({
    nodes: [
      {
        nodeId: "save",
        level: "write",
        capabilities: ["computer.execute", "computer.writeFile"],
        bindings: [{ name: "COMPUTER", operations: ["exec", "processStart"] }],
      },
    ],
    nodeGitAccess: [
      {
        nodeId: "save",
        gitAccess: {
          repository: { kind: "team-source", repository: "project" },
          branches: ["refs/heads/main"],
        },
      },
    ],
  });
  expect(node).toHaveBeenCalledExactlyOnceWith(actor, member, {
    installationId: "shed-installed",
    appId: "app_shed",
    method: "save",
    methodDigest: prepared.plan.catalog.app_shed?.methods.save?.digest,
    computerId: "computer-pinned",
  });
  expect(git).toHaveBeenCalledExactlyOnceWith(
    actor,
    member,
    { kind: "team-source", repository: "project" },
    "write",
  );
});

it("refuses missing human/Computer or node/Git authority without a captured default", async () => {
  const prepared = await preparation();
  const actor = { kind: "member" as const, memberId: "member-start" };
  const member = { membershipVersion: 2 };
  const scope: runtime.WorkflowNodeCeiling = {
    level: "write",
    capabilities: ["computer.execute", "computer.writeFile"],
    bindings: [],
  };
  const node = vi.fn<runtime.WorkflowCeilingCapturePorts["node"]>(() =>
    Promise.resolve(scope),
  );
  const git = vi.fn(() => Promise.resolve(true));
  const capture = runtime.createWorkflowCeilingCapture({ node, git });
  expect(
    await capture({ ...prepared, computerId: null }, actor, member),
  ).toBeNull();
  expect(
    await capture(
      prepared,
      { kind: "member", memberId: "someone-else" },
      member,
    ),
  ).toBeNull();
  expect(node).not.toHaveBeenCalled();
  for (const denied of [
    null,
    { ...scope, level: "read" as const },
    { ...scope, capabilities: [] },
  ]) {
    node.mockResolvedValueOnce(denied);
    expect(await capture(prepared, actor, member)).toBeNull();
  }
  expect(git).not.toHaveBeenCalled();
  git.mockResolvedValueOnce(false);
  expect(await capture(prepared, actor, member)).toBeNull();
});

it("narrows a read node's real broader admission to read operations and Git read", async () => {
  const prepared = await preparation("read");
  const actor = { kind: "member" as const, memberId: "member-start" };
  const member = { membershipVersion: 2 };
  const node = vi.fn<runtime.WorkflowCeilingCapturePorts["node"]>(() =>
    Promise.resolve({
      level: "write",
      capabilities: [
        "computer.execute",
        "computer.writeFile",
        "app.events.emit",
      ],
      bindings: [
        {
          name: "COMPUTER",
          operations: ["ports", "processStart", "exec", "write"],
        },
        { name: "EVENTS", operations: ["emit"] },
      ],
    }),
  );
  const git = vi.fn(() => Promise.resolve(true));
  const captured = await runtime.createWorkflowCeilingCapture({ node, git })(
    prepared,
    actor,
    member,
  );
  expect(captured?.nodes).toEqual([
    {
      nodeId: "save",
      level: "read",
      capabilities: ["computer.execute", "computer.writeFile"],
      bindings: [{ name: "COMPUTER", operations: ["ports"] }],
    },
  ]);
  expect(git).toHaveBeenCalledExactlyOnceWith(
    actor,
    member,
    { kind: "team-source", repository: "project" },
    "read",
  );
});

const unexpected = (): never => {
  throw new Error("Unexpected host port");
};

it("starts a cached Save with its armed Team-source binding only inside the current human Git ceiling", async () => {
  const methods = await catalogMethods({
    run: {
      description: "Save",
      effect: "write",
      requires: ["computer.execute", "computer.writeFile"],
      input: { type: "object" },
      output: { type: "object" },
    },
  });
  const method = methods.methods.run;
  if (method === undefined) throw new Error("Missing fixture method");
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Save source",
    apps: { terminal: { appId: "app_shed" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "save",
        kind: "app",
        app: "terminal",
        method: "run",
        methodDigest: method.digest,
        values: {},
        gitAccess: {
          binding: "source",
          repository: "project",
          branches: ["refs/heads/main"],
        },
      },
    ],
    edges: [],
    output: {},
  };
  const publisher = {
    installationId: "workflows-a",
    appId: "app_trellis",
    displayName: "Trellis",
    methods: {},
    capabilities: ["workflow.publish" as const],
    workflowPublishGranted: true,
  };
  const entries = [
    publisher,
    {
      installationId: "shed-a",
      appId: "app_shed",
      displayName: "Shed",
      methods: methods.methods,
    },
  ];
  let currentEntries = entries;
  const binding = runtime.armedWorkflowTriggerSchema.parse({
    installationId: "workflows-a",
    workflowId: "save",
    commit: "a".repeat(40),
    digest: await contentDigest(definition),
    triggerId: "clock",
    bindings: { terminal: "shed-a", source: { kind: "team-source" } },
    armedBy: "human-a",
    ...memberArm,
    computerId: "computer-a",
  });
  const compiled = await runtime.compileForMember(entries, {
    requestId: "compile-save",
    definition,
    bindings: binding.bindings,
    input: {},
  });
  if (compiled.kind !== "compiled") throw new Error(JSON.stringify(compiled));
  expect(compiled.plan.bindings.source).toEqual({ kind: "team-source" });
  let gitAllowed = true;
  const git = vi.fn<runtime.WorkflowCeilingCapturePorts["git"]>(
    (actor, _member, repository, scope) =>
      Promise.resolve(
        gitAllowed &&
          actor.memberId === "human-a" &&
          repository.kind === "team-source" &&
          repository.repository === "project" &&
          scope === "write",
      ),
  );
  const capture = runtime.createWorkflowCeilingCapture({
    node: () =>
      Promise.resolve({
        level: "write",
        capabilities: ["computer.execute", "computer.writeFile"],
        bindings: [{ name: "COMPUTER", operations: ["exec", "processStart"] }],
      }),
    git,
  });
  const authority = runtime.createWorkflowRunAuthority({
    member: (id) =>
      Promise.resolve(id === "human-a" ? { membershipVersion: 1 } : null),
    memberComputer: (id, computer) =>
      Promise.resolve(id === "human-a" && computer === "computer-a"),
    catalog: () => Promise.resolve(currentEntries),
    admitAgent: () => Promise.resolve(false),
    capture,
    denied: () => new Error("denied"),
  });
  const database = new DatabaseSync(":memory:");
  const options: Parameters<typeof runtime.createTeamWorkflowRuns>[0] = {
    ...fromNodeSqlite(database),
    teamId: () => "team-a",
    admission: () => "active",
    errors: {
      app: (code) => new Error(code),
      suspended: () => new Error("suspended"),
    },
    authority,
    wake: unexpected,
    callWorkflowApp: unexpected,
    reviewer: unexpected,
    admitDelivery: unexpected,
    terminateGraphRun: unexpected,
    member: () => Promise.resolve({ membershipVersion: 1 }),
    memberComputer: () => Promise.resolve(true),
    catalog: () => Promise.resolve(currentEntries),
  };
  try {
    const owner = runtime.createTeamWorkflowRuns(options);
    owner.triggerPlans.put(binding, compiled.plan);
    const restored = runtime.createTeamWorkflowRuns(options);
    const started = await restored.startCachedGraph(binding, {
      requestId: "cached-save",
      input: {},
    });
    expect(started.kind).toBe("started");
    if (started.kind !== "started") throw new Error(JSON.stringify(started));
    expect(git).toHaveBeenCalledExactlyOnceWith(
      { kind: "member", memberId: "human-a" },
      { membershipVersion: 1 },
      { kind: "team-source", repository: "project" },
      "write",
    );
    expect(restored.graph.read(started.runId)?.ceiling.nodeGitAccess).toEqual([
      {
        nodeId: "save",
        gitAccess: {
          repository: { kind: "team-source", repository: "project" },
          branches: ["refs/heads/main"],
        },
      },
    ]);
    gitAllowed = false;
    await expect(
      restored.startCachedGraph(binding, {
        requestId: "revoked-save",
        input: {},
      }),
    ).rejects.toThrow("denied");
    const revoked = await runtime.memberRunIdentity(
      "team-a",
      "human-a",
      "revoked-save",
    );
    expect(restored.graph.read(revoked.runId)).toBeNull();
    currentEntries = [
      publisher,
      {
        ...entries[1],
        installationId: "shed-a",
        appId: "app_shed",
        displayName: "Shed",
        methods: {
          ...methods.methods,
          run: { ...method, digest: `sha256:${"b".repeat(64)}` },
        },
      },
    ];
    await expect(
      restored.startCachedGraph(binding, {
        requestId: "changed-app",
        input: {},
      }),
    ).resolves.toEqual({
      kind: "refused",
      reason: "Workflow is no longer valid for this member",
    });
  } finally {
    database.close();
  }
});

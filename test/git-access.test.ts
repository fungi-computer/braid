import * as S from "effect/Schema";
import * as access from "../src/git-access.js";
import { expect, it } from "vitest";
import { gitAccessSchema, resolvedGitAccessSchema } from "../src/git-access.js";
import {
  catalogMethods,
  compile,
  decodeExecutionPlan,
  bindingsSchema,
  type WorkflowDefinition,
  type Bindings,
} from "../src/index.js";

it("freezes a node's fixed repository and exact branches into its published plan", async () => {
  const catalog = await catalogMethods({
    run: {
      description: "Run a process",
      effect: "write",
      requires: ["computer.execute"],
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
  });
  const method = catalog.methods.run;
  if (!method) throw new Error("Missing method");
  const node = {
    id: "build",
    kind: "app" as const,
    app: "shed",
    method: "run",
    methodDigest: method.digest,
    values: {},
    gitAccess: {
      binding: "shed",
      repository: "project",
      branches: ["refs/heads/main"],
    },
  };
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1" as const,
    title: "Published build",
    apps: { shed: { appId: "shed" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [node],
    edges: [],
    output: {},
  };
  const bindings = { shed: { appId: "shed", installationId: "shed-a" } };
  const compiled = await compile(definition, { shed: catalog }, bindings);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error("Compilation failed");
  expect(compiled.plan.definition.nodes[0]).toMatchObject({
    gitAccess: {
      binding: "shed",
      repository: "project",
      branches: ["refs/heads/main"],
    },
  });
  const changed = await compile(
    {
      ...definition,
      nodes: [
        {
          ...node,
          gitAccess: {
            binding: "shed",
            repository: "other",
            branches: ["refs/heads/release"],
          },
        },
      ],
    },
    { shed: catalog },
    bindings,
  );
  expect(changed.ok).toBe(true);
  if (!changed.ok) throw new Error("Compilation failed");
  expect(changed.plan.planDigest).not.toBe(compiled.plan.planDigest);
  await expect(
    decodeExecutionPlan({
      ...changed.plan,
      planDigest: compiled.plan.planDigest,
    }),
  ).rejects.toThrow("digest mismatch");
});

it("keeps symbolic trigger repositories read-only and out of resolved process scopes", () => {
  const read = {
    binding: "bonsai",
    repository: "$trigger.repository",
    access: "read",
  };
  expect(gitAccessSchema.parse(read)).toEqual(read);
  expect(resolvedGitAccessSchema.safeParse(read).success).toBe(false);
  // A write ceiling always names its fixed repository at arm time.
  expect(
    gitAccessSchema.safeParse({
      binding: "shed",
      repository: "$trigger.repository",
      branches: ["refs/heads/main"],
    }).success,
  ).toBe(false);
  // Read access carries no branch ceiling and cannot be widened to one.
  expect(
    gitAccessSchema.safeParse({ ...read, branches: ["refs/heads/main"] })
      .success,
  ).toBe(false);
  const bindings = {
    bonsai: { appId: "app_bonsai", installationId: "bonsai-a" },
  } as const;
  const parsed = gitAccessSchema.parse(read);
  expect(access.resolveGitAccess(bindings, parsed)).toBeNull();
  const pond = access.resolveGitAccess(bindings, parsed, "pond");
  expect(pond).toEqual({
    repository: {
      kind: "installation",
      installationId: "bonsai-a",
      repository: "pond",
    },
    access: "read",
  });
  if (pond === null) throw new Error("Unresolved read access");
  expect(access.gitAccessScope(pond)).toBe("read");
  const other = access.resolveGitAccess(bindings, parsed, "other");
  if (other === null) throw new Error("Unresolved read access");
  expect(access.resolvedGitAccessEqual(pond, other)).toBe(false);
  expect(
    access.resolvedGitAccessEqual(pond, {
      repository: pond.repository,
      branches: ["refs/heads/main"],
    }),
  ).toBe(false);
  for (const branch of [
    "main",
    "refs/tags/v1",
    "refs/heads/*",
    "refs/heads/main:other",
    "refs/heads/../main",
  ]) {
    expect(
      gitAccessSchema.safeParse({
        binding: "shed",
        repository: "project",
        branches: [branch],
      }).success,
    ).toBe(false);
  }
});

it("requires an authored binding and a host-resolved canonical repository namespace", () => {
  const branches = ["refs/heads/main"];
  expect(
    gitAccessSchema.safeParse({ repository: "project", branches }).success,
  ).toBe(false);
  expect(
    gitAccessSchema.parse({
      binding: "bonsai",
      repository: "project",
      branches,
    }),
  ).toEqual({ binding: "bonsai", repository: "project", branches });
  expect(
    resolvedGitAccessSchema.safeParse({ repository: "project", branches })
      .success,
  ).toBe(false);
  for (const repository of [
    {
      kind: "installation",
      installationId: "bonsai-installed",
      repository: "project",
    },
    { kind: "team-source", repository: "project" },
  ]) {
    expect(resolvedGitAccessSchema.parse({ repository, branches })).toEqual({
      repository,
      branches,
    });
  }
});

it("freezes a Save target binding separately from the App executing the step", async () => {
  const catalog = await catalogMethods({
    save: {
      description: "Save",
      effect: "write",
      requires: ["git.repository"],
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
  });
  const method = catalog.methods.save;
  if (!method) throw new Error("Missing method");
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Save to a selected repository",
    apps: { terminal: { appId: "shed" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "save",
        kind: "app",
        app: "terminal",
        method: "save",
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
  const sources: Bindings[string][] = [
    { appId: "bonsai", installationId: "bonsai-installed" },
    { kind: "team-source" },
  ];
  for (const source of sources) {
    const result = await compile(
      definition,
      { shed: catalog },
      { terminal: { appId: "shed", installationId: "shed-installed" }, source },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.plan.bindings.source).toEqual(source);
  }
  const missing = await compile(
    definition,
    { shed: catalog },
    { terminal: { appId: "shed", installationId: "shed-installed" } },
  );
  expect(missing.ok).toBe(false);
});

it("admits one canonical installation or explicit Team-source binding grammar", () => {
  const selected: access.BindingsSelection = {
    app: "installation-a",
    source: { kind: "team-source" },
  };
  const frozen = {
    app: { appId: "app-a", installationId: "installation-a" },
    source: { kind: "team-source" },
  };
  expect(
    S.decodeUnknownSync(bindingsSchema)(frozen, { onExcessProperty: "error" }),
  ).toEqual(frozen);
  expect(access.bindingsSelectionSchema.parse(selected)).toEqual(selected);
  for (const binding of Object.values(frozen)) {
    expect(access.workflowBindingSchema.parse(binding)).toEqual(binding);
  }
  for (const invalid of [
    { source: { kind: "team-source", installationId: "foreign" } },
    { source: { kind: "installation", installationId: "installation-a" } },
    { source: "" },
    { source: 42 },
  ])
    expect(access.bindingsSelectionSchema.safeParse(invalid).success).toBe(
      false,
    );
  const authored = {
    binding: "app",
    repository: "project",
    branches: ["refs/heads/main"],
  };
  const resolved = {
    repository: {
      kind: "installation",
      installationId: "installation-a",
      repository: "project",
    },
    branches: authored.branches,
  };
  expect(access.gitAccessSchema.parse(authored)).toEqual(authored);
  expect(access.resolvedGitAccessSchema.parse(resolved)).toEqual(resolved);
});

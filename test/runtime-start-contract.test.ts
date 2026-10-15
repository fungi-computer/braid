import { workflowTriggerTargetSchema } from "../src/runtime/trigger-owner.js";
import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  compileForMember,
  graphStartRequestSchema,
} from "../src/runtime/graph-start.js";
import { catalogMethods } from "../src/index.js";

it("preserves canonical installation and Team-source selections for raw and published starts", () => {
  const bindings = {
    renderer: "installed-renderer",
    repository: { kind: "team-source" as const },
  };
  for (const selected of [
    { definition: {} },
    {
      definition: {},
      published: {
        workflowId: "review",
        commit: "a".repeat(40),
        digest: "sha256:" + "a".repeat(64),
      },
    },
  ]) {
    const request = { requestId: "request", bindings, input: {}, ...selected };
    expect(
      S.decodeUnknownSync(graphStartRequestSchema)(request, {
        onExcessProperty: "error",
      }),
    ).toEqual(request);
  }
});

it("compiles an admitted installation while a Team-source selection cannot stand in for it", async () => {
  const catalog = await catalogMethods({
    render: {
      description: "Read a declared scalar",
      effect: "read",
      requires: [],
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  const method = catalog.methods.render;
  if (!method) throw new Error("Missing fixture method");
  const definition = {
    format: "fungi.workflow/v1",
    title: "Selected namespace",
    apps: { renderer: { appId: "app.renderer" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "render",
        kind: "app",
        app: "renderer",
        method: "render",
        methodDigest: method.digest,
        values: { value: { literal: "Garden" } },
      },
    ],
    edges: [],
    output: { result: { node: "render", port: "value" } },
  };
  const entries = [
    {
      installationId: "installed-renderer",
      appId: "app.renderer",
      displayName: "Renderer",
      methods: catalog.methods,
    },
  ];
  const input = {
    requestId: "request",
    definition,
    bindings: {
      renderer: "installed-renderer",
      repository: { kind: "team-source" as const },
    },
    input: {},
  };
  const selected = S.decodeUnknownSync(graphStartRequestSchema)(input);
  const compiled = await compileForMember(entries, { ...selected, definition });
  expect(compiled.kind, JSON.stringify(compiled)).toBe("compiled");
  if (compiled.kind !== "compiled")
    throw new Error("Declared installation did not compile");
  expect(compiled.plan.bindings.renderer).toEqual({
    appId: "app.renderer",
    installationId: "installed-renderer",
  });
  expect(compiled.plan.requiredBindings).toHaveLength(1);
  const namespaceOnly = S.decodeUnknownSync(graphStartRequestSchema)({
    ...input,
    bindings: { renderer: { kind: "team-source" } },
  });
  expect(
    (await compileForMember(entries, { ...namespaceOnly, definition })).kind,
  ).toBe("invalid");
});

it("retains the same canonical bindings in a trigger target without granting an App installation", () => {
  const target = {
    installationId: "workflows",
    workflowId: "review",
    commit: "a".repeat(40),
    digest: "sha256:" + "a".repeat(64),
    triggerId: "daily",
    bindings: {
      renderer: "installed-renderer",
      repository: { kind: "team-source" as const },
    },
  };
  expect(workflowTriggerTargetSchema.parse(target)).toEqual(target);
});

it("requires the original definition and a concrete publication commit, never guest authority", () => {
  const request = {
    requestId: "published",
    definition: {},
    bindings: {},
    input: {},
    published: {
      workflowId: "review",
      commit: "a".repeat(40),
      digest: "sha256:" + "a".repeat(64),
    },
  };
  for (const invalid of [
    {
      requestId: request.requestId,
      bindings: request.bindings,
      input: request.input,
      published: request.published,
    },
    {
      ...request,
      published: {
        workflowId: "review",
        version: 1,
        digest: request.published.digest,
      },
    },
    { ...request, ceiling: { nodes: [], nodeGitAccess: [] } },
  ])
    expect(
      S.decodeUnknownResult(graphStartRequestSchema, {
        onExcessProperty: "error",
      })(invalid)._tag,
    ).toBe("Failure");
});

import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  validate,
  compile,
  decodeExecutionPlan,
  workflowDefinitionSchema,
  methodInputValue,
  methodOutputValues,
  parseProjection,
} from "../src/index.js";

function trimNames() {
  const names = {
    type: "array",
    items: { type: "string" },
    maxItems: 50,
  };
  return {
    format: "fungi.workflow/v1",
    title: "Trim names",
    apps: {},
    input: {
      type: "object",
      properties: { names },
      required: ["names"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "trim",
        kind: "code",
        source:
          "const input = await env.INPUT.read({}); return input.map((name) => name.trim());",
        input: names,
        output: names,
        values: { value: { from: { node: "$input", port: "names" } } },
      },
    ],
    edges: [],
    output: { names: { node: "trim", port: "value" } },
  };
}

it("admits a Code node that reshapes only its explicitly mapped JSON array", () => {
  const definition = trimNames();
  expect(validate(definition, {})).toEqual([]);
  const node = definition.nodes[0];
  if (!node) throw new Error("Expected Code fixture");
  const input = parseProjection(node.input);
  expect(methodInputValue(input, { value: [" Garden "] })).toEqual([
    " Garden ",
  ]);
  expect(methodOutputValues(input, ["Garden"])).toEqual({ value: ["Garden"] });
});

it("freezes exact Code source, schemas and mappings without adding App authority", async () => {
  const definition = S.decodeUnknownSync(workflowDefinitionSchema)(trimNames());
  const compiled = await compile(definition, {}, {});
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error("Code fixture did not compile");
  expect(compiled.plan.requiredBindings).toEqual([]);
  expect(compiled.plan.catalog).toEqual({});
  expect(compiled.plan.estimatedSteps).toBe(3);
  expect(await decodeExecutionPlan(compiled.plan)).toEqual(compiled.plan);
  const original = definition.nodes[0];
  if (original?.kind !== "code") throw new Error("Expected Code fixture");
  for (const changed of [
    { ...original, source: original.source + "\n" },
    { ...original, input: { ...original.input, description: "Names to trim" } },
    { ...original, output: { ...original.output, maxItems: 60 } },
    { ...original, values: { value: { array: [{ literal: "Garden" }] } } },
  ]) {
    const result = await compile({ ...definition, nodes: [changed] }, {}, {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Changed Code fixture did not compile");
    expect(result.plan.planDigest).not.toBe(compiled.plan.planDigest);
  }
  await expect(
    decodeExecutionPlan({
      ...compiled.plan,
      definition: {
        ...definition,
        nodes: [{ ...original, source: "return []" }],
      },
    }),
  ).rejects.toThrow("digest");
});

it("refuses missing Code input and reserved ordering ports through typed issues", () => {
  const definition = trimNames();
  const original = definition.nodes[0];
  if (!original) throw new Error("Expected Code fixture");
  expect(
    validate({ ...definition, nodes: [{ ...original, values: {} }] }, {}),
  ).toContainEqual(
    expect.objectContaining({ code: "required_port", port: "value" }),
  );
  expect(
    validate(
      {
        ...definition,
        nodes: [
          {
            ...original,
            output: {
              type: "object",
              properties: { after: { type: "boolean" } },
            },
          },
        ],
      },
      {},
    ),
  ).toContainEqual(expect.objectContaining({ code: "schema", port: "after" }));
});

it("bounds source through the existing graph envelope without parsing JavaScript", () => {
  const definition = trimNames();
  const original = definition.nodes[0];
  if (!original) throw new Error("Expected Code fixture");
  expect(
    validate(
      { ...definition, nodes: [{ ...original, source: "return (" }] },
      {},
    ),
  ).toEqual([]);
  expect(
    validate(
      { ...definition, nodes: [{ ...original, source: "🌱".repeat(65_000) }] },
      {},
    ),
  ).toContainEqual(expect.objectContaining({ code: "schema" }));
});

it("orders Code dependencies inside each/coalesce and ignores editor node order", async () => {
  const raw = trimNames();
  const trim = raw.nodes[0];
  if (!trim) throw new Error("Expected Code fixture");
  const copy = {
    ...trim,
    id: "copy",
    source: "return await env.INPUT.read({});",
    values: {
      value: {
        coalesce: [
          {
            each: {
              over: { from: { node: "trim", port: "value" } },
              body: { from: { node: "$item", port: "value" } },
              maxItems: 50,
            },
          },
          { literal: [] },
        ],
      },
    },
  };
  const definition = S.decodeUnknownSync(workflowDefinitionSchema)({
    ...raw,
    nodes: [copy, trim],
    output: { names: { node: "copy", port: "value" } },
  });
  const one = await compile(definition, {}, {});
  const two = await compile(
    { ...definition, nodes: [...definition.nodes].reverse() },
    {},
    {},
  );
  if (!one.ok) expect(one.issues).toEqual([]);
  if (!two.ok) expect(two.issues).toEqual([]);
  expect(one).toMatchObject({ ok: true });
  expect(two).toMatchObject({ ok: true });
  if (!one.ok || !two.ok) throw new Error("Code dependencies did not compile");
  expect(one.plan.definition.nodes.map((node) => node.id)).toEqual([
    "trim",
    "copy",
  ]);
  expect(one.plan.planDigest).toBe(two.plan.planDigest);
});

it("projects whole Code completion records through the shared ok/refused outlets", async () => {
  const raw = trimNames();
  const node = raw.nodes[0];
  if (!node) throw new Error("Expected Code fixture");
  const output = {
    anyOf: [
      node.output,
      {
        type: "object",
        properties: { error: { type: "string", const: "empty_names" } },
        required: ["error"],
        additionalProperties: false,
      },
    ],
  };
  const definition = S.decodeUnknownSync(workflowDefinitionSchema)({
    ...raw,
    nodes: [{ ...node, output }],
    output: {
      names: { node: "trim", port: "ok" },
      refusal: { node: "trim", port: "refused" },
    },
  });
  expect((await compile(definition, {}, {})).ok).toBe(true);
  const schema = parseProjection(output);
  expect(methodOutputValues(schema, ["Garden"])).toEqual({ ok: ["Garden"] });
  expect(methodOutputValues(schema, { error: "empty_names" })).toEqual({
    refused: { error: "empty_names" },
  });
  expect(methodOutputValues(schema, { error: "different" })).toBeUndefined();
});

import { expect, it, vi } from "vitest";
import Mustache from "mustache";
import {
  compile,
  validate,
  templateRefs,
  mappingRefs,
  ExpressionSyntaxError,
  type WorkflowDefinition,
} from "../src/index.js";
import { animeCatalog, animeBindings, animeTemplate } from "./anime.fixture.js";
const expressionGraph = (template: string): WorkflowDefinition => ({
  format: "fungi.workflow/v1",
  title: "Expression failures",
  apps: {},
  input: { type: "object", properties: { text: { type: "string" } } },
  nodes: [{ id: "format", kind: "transform", fields: { text: { template } } }],
  edges: [],
  output: { text: { node: "format", port: "text" } },
});
it.each([
  "{{$input.text",
  "{{/missing}}",
  "{{#missing}}",
  "{{#missing}}{{/other}}",
  "{{#missing}}{{/missing}}",
])("reports expected template syntax refusal: %s", (template) => {
  expect(() => templateRefs(template)).toThrow(ExpressionSyntaxError);
  expect(validate(expressionGraph(template), {})).toContainEqual(
    expect.objectContaining({ code: "template" }),
  );
});
it("retains vendor syntax failures as the domain error cause", () => {
  expect.assertions(2);
  try {
    templateRefs("{{$input.text");
  } catch (cause) {
    expect(cause).toBeInstanceOf(ExpressionSyntaxError);
    if (!(cause instanceof ExpressionSyntaxError)) throw cause;
    expect(cause.cause).toBeInstanceOf(Error);
  }
});
it("reports the maintained JSON Pointer parser's expected syntax refusal", () => {
  const mapping = {
    from: { node: "$input", port: "text" },
    path: "not/a/pointer",
  };
  expect(() => mappingRefs(mapping)).toThrow(ExpressionSyntaxError);
  const graph = expressionGraph("{{$input.text}}");
  expect(
    validate(
      {
        ...graph,
        nodes: [{ id: "format", kind: "transform", fields: { text: mapping } }],
      },
      {},
    ),
  ).toContainEqual(expect.objectContaining({ code: "template" }));
});
it("keeps schema and binding decode failures as typed issues", async () => {
  expect(
    validate({ ...animeTemplate, title: "x".repeat(121) }, animeCatalog),
  ).toContainEqual(expect.objectContaining({ code: "schema" }));
  expect(
    await compile(animeTemplate, animeCatalog, {
      ...animeBindings,
      "!": { appId: "invalid", installationId: "invalid" },
    }),
  ).toMatchObject({ ok: false, issues: [{ code: "binding" }] });
});
it("rethrows unexpected parser defects rather than mislabelling them as author issues", async () => {
  const defect = new TypeError("parser defect");
  const parser = vi.spyOn(Mustache, "parse").mockImplementation(() => {
    throw defect;
  });
  try {
    const graph = expressionGraph("{{$input.text}}");
    expect(() => templateRefs("{{$input.text}}")).toThrow(defect);
    expect(() => validate(graph, {})).toThrow(defect);
    await expect(compile(graph, {}, {})).rejects.toBe(defect);
  } finally {
    parser.mockRestore();
  }
});

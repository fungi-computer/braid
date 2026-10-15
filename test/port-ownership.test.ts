import { it, expect } from "vitest";
import { readPort, validate, type WorkflowDefinition } from "../src/index.js";
import { animeCatalog } from "./anime.fixture.js";
it("data ports cannot silently replace the reserved after signal", () => {
  const graph: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Reserved signal",
    apps: {},
    input: { type: "object", properties: {} },
    nodes: [
      {
        id: "transform",
        kind: "transform",
        fields: { after: { literal: false } },
      },
    ],
    edges: [],
    output: { value: { node: "transform", port: "after" } },
  };
  expect(validate(graph, {})).toContainEqual(
    expect.objectContaining({
      code: "schema",
      node: "transform",
      port: "after",
    }),
  );
  const method = animeCatalog["app:prints"]?.methods.generate;
  if (!method) throw new Error("Missing fixture method");
  const appGraph: WorkflowDefinition = {
    ...graph,
    apps: { prints: { appId: "app:prints" } },
    nodes: [
      {
        id: "app",
        kind: "app",
        app: "prints",
        method: "generate",
        methodDigest: method.digest,
        values: { prompt: { literal: "Panel" } },
      },
    ],
    output: { value: { node: "app", port: "after" } },
  };
  const catalog = {
    "app:prints": {
      methods: {
        generate: {
          ...method,
          output: { type: "object", properties: { after: { type: "string" } } },
        },
      },
    },
  };
  expect(validate(appGraph, catalog)).toContainEqual(
    expect.objectContaining({ code: "schema", node: "app", port: "after" }),
  );
});
it("ordinary JSON dictionary prototypes never supply workflow ports", () => {
  expect(readPort({}, { node: "constructor", port: "name" })).toBeUndefined();
  expect(
    readPort({ $input: {} }, { node: "$input", port: "constructor" }),
  ).toBeUndefined();
  expect(
    readPort(
      { constructor: { name: "real data" } },
      { node: "constructor", port: "name" },
    ),
  ).toBe("real data");
  const graph: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Ports are own properties",
    apps: {},
    input: { type: "object", properties: {} },
    nodes: [],
    edges: [],
    output: { value: { node: "$input", port: "constructor" } },
  };
  expect(validate(graph, {})).toContainEqual(
    expect.objectContaining({ code: "unknown_port", port: "constructor" }),
  );
});

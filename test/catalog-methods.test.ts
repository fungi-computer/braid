import { expect, it } from "vitest";
import {
  catalogMethods,
  compile,
  type WorkflowDefinition,
} from "../src/index.js";

const generate = {
  description: "Make an image",
  input: {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
  },
  output: {
    type: "object",
    properties: { image: { type: "string", format: "fungi:image" } },
  },
  effect: "write",
  requires: ["media.generation"],
} as const;

it("omits hidden methods from the Workflow catalog without changing visible method digests", async () => {
  const visible = await catalogMethods({ generate });
  const catalog = await catalogMethods({
    generate,
    rebuildCopies: { ...generate, hidden: true },
  });
  expect(catalog).toEqual(visible);
});

it("keeps a method's presentation out of its graph contract and digest", async () => {
  const visible = await catalogMethods({ generate });
  const presented = await catalogMethods({
    generate: { ...generate, present: { verb: "made" } },
  });
  expect(presented).toEqual(visible);
});

it("pins a declared method by its ports, effect and requires, not its wording", async () => {
  const first = await catalogMethods({ generate });
  const reworded = await catalogMethods({
    generate: { ...generate, description: "Draw a picture" },
  });
  const widened = await catalogMethods({
    generate: { ...generate, requires: [] },
  });
  const digest = first.methods.generate?.digest;
  expect(digest).toBe(
    "sha256:71f86954e01a3dbc331e84b35b1e2f3f05d3ec55dac7ba49e50c21a1032adabf",
  );
  expect(reworded.methods.generate?.digest).toBe(digest);
  expect(widened.methods.generate?.digest).not.toBe(digest);
  expect(first.methods.generate?.approval).toBe("none");
  const external = await catalogMethods({
    send: { ...generate, effect: "external" },
  });
  expect(external.methods.send?.approval).toBe("queue");
});

it("compiles a node pinned to the derived digest", async () => {
  const catalog = { "app.prints": await catalogMethods({ generate }) };
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "One image",
    apps: { prints: { appId: "app.prints" } },
    input: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    nodes: [
      {
        id: "image",
        kind: "app",
        app: "prints",
        method: "generate",
        methodDigest: catalog["app.prints"].methods.generate?.digest ?? "",
        values: { prompt: { template: "{{$input.prompt}}" } },
      },
    ],
    edges: [],
    output: { image: { node: "image", port: "image" } },
  };
  const compiled = await compile(definition, catalog, {
    prints: { appId: "app.prints", installationId: "installation-1" },
  });
  expect(compiled.ok).toBe(true);
});

it("pins an opted-in Pending method and preserves the completed output contract", async () => {
  const baseline = await catalogMethods({ generate });
  const optedIn = await catalogMethods({
    generate: { ...generate, pending: true },
  });
  expect(optedIn.methods.generate?.pending).toBe(true);
  expect(optedIn.methods.generate?.digest).not.toBe(
    baseline.methods.generate?.digest,
  );
  expect(Object.hasOwn(baseline.methods.generate ?? {}, "pending")).toBe(false);
  expect(optedIn.methods.generate?.output).toEqual(generate.output);
});

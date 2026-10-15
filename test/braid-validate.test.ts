import { describe, it, expect } from "vitest";
import {
  compile,
  validate,
  decodeExecutionPlan,
  assignable,
  portKind,
  evaluateMapping,
  type WorkflowDefinition,
} from "../src/index.js";
import { animeCatalog, animeBindings, animeTemplate } from "./anime.fixture.js";
const simple = (): WorkflowDefinition => ({
  format: "fungi.workflow/v1",
  title: "Panel",
  apps: animeTemplate.apps,
  input: {
    type: "object",
    properties: { prompt: { type: "string" } },
    required: ["prompt"],
    additionalProperties: false,
  },
  nodes: [
    {
      id: "panel",
      kind: "app",
      app: "prints",
      method: "generate",
      methodDigest: "fixture-generate-v1",
      values: {},
    },
  ],
  edges: [
    {
      from: { node: "$input", port: "prompt" },
      to: { node: "panel", port: "prompt" },
    },
  ],
  output: { panel: { node: "panel", port: "image" } },
});
describe("braid-validate", () => {
  it("refuses a cycle with a typed issue", () => {
    const graph = simple();
    expect(
      validate(
        {
          ...graph,
          edges: [
            {
              from: { node: "panel", port: "image" },
              to: { node: "panel", port: "prompt" },
            },
          ],
        },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "cycle" }));
  });
  it("refuses an unassignable edge", () => {
    const graph = simple();
    expect(
      validate(
        {
          ...graph,
          input: { type: "object", properties: { prompt: { type: "number" } } },
        },
        animeCatalog,
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "unassignable_edge", edge: 0 }),
    );
  });
  it.each([
    ["missing", "fixture-generate-v1", "unknown_method"],
    ["generate", "old", "digest_drift"],
  ])("refuses %s / %s", (method, methodDigest, code) => {
    const graph = simple();
    expect(
      validate(
        {
          ...graph,
          nodes: [
            {
              id: "panel",
              kind: "app",
              app: "prints",
              method,
              methodDigest,
              values: {},
            },
          ],
        },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code, node: "panel" }));
  });
  it("refuses oversized graphs and deeply bounded projections", () => {
    expect(
      validate(
        {
          ...simple(),
          nodes: Array.from({ length: 65 }, (_, i) => ({
            id: `n${String(i)}`,
            kind: "wait",
            for: 1,
          })),
        },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "schema" }));
  });
  it("refuses expanded maps exceeding step headroom", () => {
    const graph = animeTemplate;
    const body = graph.subgraphs?.beat;
    expect(body).toBeDefined();
    expect(
      validate(
        {
          ...graph,
          nodes: [
            {
              id: "beats",
              kind: "map",
              over: { node: "$input", port: "beats" },
              body: "beat",
              concurrency: 8,
              maxItems: 50,
            },
          ],
          subgraphs: {
            beat: {
              ...body,
              nodes: [
                ...(body?.nodes ?? []),
                { id: "more", kind: "wait", for: 1 },
              ],
            },
          },
        },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "step_budget" }));
  });
  it("requires ports, rejects unknown references and unreachable nodes", () => {
    expect(validate({ ...simple(), edges: [] }, animeCatalog)).toContainEqual(
      expect.objectContaining({ code: "required_port", port: "prompt" }),
    );
    const graph = simple();
    expect(
      validate(
        {
          ...graph,
          nodes: [...graph.nodes, { id: "unused", kind: "wait", for: 1 }],
        },
        animeCatalog,
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "unreachable", node: "unused" }),
    );
    expect(
      validate(
        {
          ...graph,
          nodes: [
            {
              id: "panel",
              kind: "app",
              app: "prints",
              method: "generate",
              methodDigest: "fixture-generate-v1",
              values: { prompt: { template: "{{missing.port}}" } },
            },
          ],
          edges: [],
        },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "unknown_port" }));
  });
  it("compiles the anime fixture to a stable frozen content identity", async () => {
    expect(validate(animeTemplate, animeCatalog)).toEqual([]);
    const one = await compile(animeTemplate, animeCatalog, animeBindings);
    const two = await compile(
      {
        ...animeTemplate,
        nodes: [...animeTemplate.nodes].reverse(),
        subgraphs: Object.fromEntries(
          Object.entries(animeTemplate.subgraphs ?? {}).map(([key, body]) => [
            key,
            {
              ...body,
              nodes: [...body.nodes].reverse(),
              edges: [...body.edges].reverse(),
            },
          ]),
        ),
      },
      animeCatalog,
      animeBindings,
    );
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) throw new Error("Fixture did not compile");
    expect(one.plan.planDigest).toBe(two.plan.planDigest);
    expect(
      await decodeExecutionPlan(JSON.parse(JSON.stringify(one.plan))),
    ).toEqual(one.plan);
    expect(one.plan.requiredBindings).toHaveLength(2);
    await expect(
      decodeExecutionPlan({ ...one.plan, estimatedSteps: 1 }),
    ).rejects.toThrow("digest");
  });
  it("refuses binding substitution and unsupported schema assertions", async () => {
    expect(
      await compile(simple(), animeCatalog, {
        prints: { appId: "different", installationId: "x" },
      }),
    ).toMatchObject({ ok: false, issues: [{ code: "binding" }] });
    expect(
      validate(
        { ...simple(), input: { type: "object", oneOf: [] } },
        animeCatalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "schema" }));
  });
  it("types refs and checks required object shape, enums and ranges", () => {
    expect(
      portKind({
        type: "array",
        items: { type: "string", format: "fungi:image" },
      }),
    ).toEqual({ list: "fungi:image" });
    expect(
      assignable({ type: "string" }, { type: "string", format: "fungi:image" }),
    ).toBe(false);
    expect(
      assignable({ type: "string", format: "fungi:image" }, { type: "string" }),
    ).toBe(false);
    expect(
      assignable(
        { type: "object", additionalProperties: false },
        { type: "object", required: ["x"] },
      ),
    ).toBe(false);
    expect(
      assignable(
        { type: "number", minimum: 3 },
        { type: "number", minimum: 2 },
      ),
    ).toBe(true);
  });
  it("interpolation remains data and JSON pointers use their decoder", () => {
    expect(
      evaluateMapping(
        { template: "{{node.text}}" },
        { node: { text: "<script>not code</script>" } },
      ),
    ).toBe("<script>not code</script>");
    expect(
      evaluateMapping(
        { from: { node: "node", port: "item" }, path: "/a~1b" },
        { node: { item: { "a/b": 7 } } },
      ),
    ).toBe(7);
  });
});

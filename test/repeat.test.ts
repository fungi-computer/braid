import { expect, it } from "vitest";
import { validate } from "../src/index.js";

const repeatGraph = () => ({
  format: "fungi.workflow/v1",
  title: "Revise an item",
  apps: {},
  input: {
    type: "object",
    properties: { item: { type: "string" } },
    required: ["item"],
    additionalProperties: false,
  },
  nodes: [
    {
      id: "revise",
      kind: "repeat",
      body: "attempt",
      maxRounds: 3,
      until: {
        op: "eq",
        left: { from: { node: "$input", port: "accepted" } },
        right: { literal: true },
      },
    },
  ],
  edges: [],
  output: { result: { node: "revise", port: "result" } },
  subgraphs: {
    attempt: {
      input: {
        type: "object",
        properties: {
          item: { type: "string" },
          round: { type: "integer", minimum: 0, maximum: 4 },
          previous: { type: "object" },
        },
        required: ["item", "round", "previous"],
        additionalProperties: false,
      },
      nodes: [
        {
          id: "answer",
          kind: "transform",
          fields: { accepted: { literal: true } },
        },
      ],
      edges: [],
      output: { accepted: { node: "answer", port: "accepted" } },
    },
  },
});

it("accepts a bounded repeat whose stop predicate reads the body's declared result", () => {
  expect(validate(repeatGraph(), {})).toEqual([]);
});

it.each([0, 6, 1.5])("refuses an invalid repeat bound of %s", (maxRounds) => {
  const graph = repeatGraph();
  expect(
    validate({ ...graph, nodes: [{ ...graph.nodes[0], maxRounds }] }, {}),
  ).toContainEqual(expect.objectContaining({ code: "schema" }));
});

it("refuses a missing repeat body and a stop predicate outside the completed result", () => {
  const graph = repeatGraph();
  expect(
    validate({ ...graph, nodes: [{ ...graph.nodes[0], body: "missing" }] }, {}),
  ).toContainEqual(
    expect.objectContaining({ code: "subgraph", node: "revise" }),
  );
  expect(
    validate(
      {
        ...graph,
        nodes: [
          {
            ...graph.nodes[0],
            until: {
              op: "exists",
              value: { from: { node: "answer", port: "accepted" } },
            },
          },
        ],
      },
      {},
    ),
  ).toContainEqual(
    expect.objectContaining({ code: "unknown_port", node: "revise" }),
  );
});

it("refuses recursive repeat bodies instead of admitting an unbounded workflow", () => {
  const graph = repeatGraph();
  expect(
    validate(
      {
        ...graph,
        subgraphs: {
          attempt: {
            ...graph.subgraphs.attempt,
            nodes: [
              ...graph.subgraphs.attempt.nodes,
              { ...graph.nodes[0], id: "again", maxRounds: 1 },
            ],
            output: {
              ...graph.subgraphs.attempt.output,
              loop: { node: "again", port: "result" },
            },
          },
        },
      },
      {},
    ),
  ).toContainEqual(
    expect.objectContaining({ code: "cycle", graph: "attempt" }),
  );
});

it("admits a typed optional prior note when the body emits that same note type", () => {
  const graph = repeatGraph();
  const body = graph.subgraphs.attempt;
  const answer = body.nodes.at(0);
  if (!answer) throw new Error("Missing attempt fixture");
  expect(
    validate(
      {
        ...graph,
        subgraphs: {
          attempt: {
            ...body,
            input: {
              ...body.input,
              properties: {
                ...body.input.properties,
                previous: {
                  type: "object",
                  properties: { note: { type: "string", maxLength: 1000 } },
                },
              },
            },
            nodes: [
              {
                ...body.nodes[0],
                fields: {
                  ...answer.fields,
                  note: { literal: "More contrast" },
                },
              },
            ],
            output: { ...body.output, note: { node: "answer", port: "note" } },
          },
        },
      },
      {},
    ),
  ).toEqual([]);
});

it("refuses a future round whose note cannot fit the declared previous result", () => {
  const graph = repeatGraph();
  const body = graph.subgraphs.attempt;
  expect(
    validate(
      {
        ...graph,
        subgraphs: {
          attempt: {
            ...body,
            input: {
              ...body.input,
              properties: {
                ...body.input.properties,
                previous: {
                  type: "object",
                  properties: { note: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
            nodes: [
              {
                ...body.nodes[0],
                fields: { accepted: { literal: true }, note: { literal: 42 } },
              },
            ],
            output: { ...body.output, note: { node: "answer", port: "note" } },
          },
        },
      },
      {},
    ),
  ).toContainEqual(
    expect.objectContaining({ code: "unassignable_edge", node: "revise" }),
  );
});
it("counts nested repeat bounds against the existing workflow step budget", () => {
  const graph = repeatGraph();
  const attempt = graph.subgraphs.attempt;
  const body = (next: string) => ({
    ...attempt,
    nodes: [...attempt.nodes, { ...graph.nodes[0], body: next, maxRounds: 5 }],
    output: { ...attempt.output, result: { node: "revise", port: "result" } },
  });
  expect(
    validate(
      {
        ...graph,
        nodes: [{ ...graph.nodes[0], maxRounds: 5 }],
        subgraphs: {
          attempt: body("second"),
          second: body("third"),
          third: body("fourth"),
          fourth: attempt,
        },
      },
      {},
    ),
  ).toContainEqual(expect.objectContaining({ code: "step_budget" }));
});

it("keeps the body's declared result type on repeat output mappings", () => {
  const graph = repeatGraph();
  expect(
    validate(
      {
        ...graph,
        nodes: [
          ...graph.nodes,
          {
            id: "consume",
            kind: "code",
            source: "return true;",
            input: {
              type: "object",
              properties: {
                result: {
                  type: "object",
                  properties: { accepted: { type: "boolean" } },
                  additionalProperties: false,
                },
              },
              required: ["result"],
              additionalProperties: false,
            },
            output: { type: "boolean" },
            values: { result: { from: { node: "revise", port: "result" } } },
          },
        ],
        output: { accepted: { node: "consume", port: "value" } },
      },
      {},
    ),
  ).toEqual([]);
});

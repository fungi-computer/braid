import { expect, it } from "vitest";
import { validate, type WorkflowDefinition } from "../src/index.js";

type Choices = readonly {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}[];
const look = {
  id: "look",
  kind: "review",
  title: "Pick what happens next",
  show: [{ node: "$input", port: "image" }],
  reviewers: "runner",
  timeout: 60_000,
} as const;
const reviewGraph = (
  choices: Choices | undefined,
  output: WorkflowDefinition["output"],
): WorkflowDefinition => ({
  format: "fungi.workflow/v1",
  title: "Choose",
  apps: {},
  input: {
    type: "object",
    properties: { image: { type: "string" } },
    required: ["image"],
  },
  nodes: [choices === undefined ? look : { ...look, choices }],
  edges: [],
  output,
});
const choices = [
  {
    id: "keep",
    label: "Keep",
    description: "added to the contact sheet, then the next beat starts",
  },
  { id: "animate", label: "Keep and animate" },
  { id: "redo", label: "Regenerate" },
];

it("gives a review one output port per named choice, carrying the shown item", () => {
  expect(
    validate(
      reviewGraph(choices, {
        kept: { node: "look", port: "keep" },
        animated: { node: "look", port: "animate" },
        redo: { node: "look", port: "redo" },
      }),
      {},
    ),
  ).toEqual([]);
  // A review with choices has no approved/rejected ports.
  expect(
    validate(
      reviewGraph(choices, { x: { node: "look", port: "approved" } }),
      {},
    ),
  ).toContainEqual(expect.objectContaining({ code: "unknown_port" }));
  // A plain review keeps approve/reject.
  expect(
    validate(
      reviewGraph(undefined, { x: { node: "look", port: "approved" } }),
      {},
    ),
  ).toEqual([]);
});

it.each([
  [
    "the reserved note port",
    [
      { id: "keep", label: "Keep" },
      { id: "note", label: "Note" },
    ],
  ],
  [
    "the reserved choice port",
    [
      { id: "keep", label: "Keep" },
      { id: "choice", label: "Choice" },
    ],
  ],
  ["a single choice", [{ id: "keep", label: "Keep" }]],
  [
    "duplicate ids",
    [
      { id: "keep", label: "Keep" },
      { id: "keep", label: "Also keep" },
    ],
  ],
  [
    "the reserved ordering port",
    [
      { id: "keep", label: "Keep" },
      { id: "after", label: "After" },
    ],
  ],
])("refuses %s", (_label, invalid) => {
  expect(
    validate(reviewGraph(invalid, { x: { node: "look", port: "keep" } }), {}),
  ).toContainEqual(expect.objectContaining({ node: "look" }));
});

it("makes the review choice and bounded note available to downstream nodes", () => {
  for (const selected of [choices, undefined]) {
    expect(
      validate(
        reviewGraph(selected, {
          choice: { node: "look", port: "choice" },
          note: { node: "look", port: "note" },
        }),
        {},
      ),
    ).toEqual([]);
  }
});

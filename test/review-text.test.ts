import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  fillReviewText,
  graphParamsSchema,
  validate,
  type LoopPosition,
} from "../src/index.js";

const beatTwoTryOne: LoopPosition = [
  { node: "beats", loop: "map", index: 1, count: 3 },
  { node: "revise", loop: "repeat", index: 0, count: 3 },
];

it("fills the item and try from the loops around a review, counting from 1", () => {
  expect(
    fillReviewText(
      "Beat {item} of {items} · try {try} of {tries}",
      beatTwoTryOne,
    ),
  ).toBe("Beat 2 of 3 · try 1 of 3");
  expect(fillReviewText("Plain words")).toBe("Plain words");
});

it("reads the innermost Map and Repeat when loops nest", () => {
  expect(
    fillReviewText("{item}/{items} {try}/{tries}", [
      { node: "chapters", loop: "map", index: 4, count: 9 },
      ...beatTwoTryOne,
      { node: "polish", loop: "repeat", index: 2, count: 5 },
    ]),
  ).toBe("2/3 3/5");
});

it("shows nothing rather than a hole when the position cannot fill the text", () => {
  expect(fillReviewText("try {try} of {tries}", [])).toBeUndefined();
  expect(
    fillReviewText("Beat {item}, try {try}", beatTwoTryOne.slice(0, 1)),
  ).toBeUndefined();
  expect(fillReviewText("{beat}", beatTwoTryOne)).toBeUndefined();
});

it("refuses review text that asks for a placeholder no review can fill", () => {
  const issues = validate(
    {
      format: "fungi.workflow/v1",
      title: "Choose",
      apps: {},
      input: {
        type: "object",
        properties: { image: { type: "string" } },
        required: ["image"],
      },
      nodes: [
        {
          id: "look",
          kind: "review",
          title: "Keep this panel?",
          detail: "Beat {beat} of {items}",
          show: [{ node: "$input", port: "image" }],
          reviewers: "runner",
          timeout: 60_000,
          choices: [
            { id: "keep", label: "Keep", description: "then beat {next}" },
            { id: "redo", label: "Regenerate", description: "try {try}" },
          ],
        },
      ],
      edges: [],
      output: { kept: { node: "look", port: "keep" } },
    },
    {},
  );
  expect(issues.map((issue) => issue.message)).toEqual([
    expect.stringContaining("{beat}"),
    expect.stringContaining("{next}"),
  ]);
});

it("requires every map item and repeat round to carry its position", () => {
  const params = {
    kind: "map-item",
    teamId: "team",
    runId: "run",
    planDigest: "plan",
    body: "beat",
    iteration: "digest",
    parentInstanceId: "parent",
    completionEvent: "item_x",
    input: {},
  };
  expect(S.is(graphParamsSchema)(params)).toBe(false);
  expect(S.is(graphParamsSchema)({ ...params, position: beatTwoTryOne })).toBe(
    true,
  );
});

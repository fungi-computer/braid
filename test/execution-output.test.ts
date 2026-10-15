import { it, expect } from "vitest";
import * as S from "effect/Schema";
import {
  nodeEventSchema,
  reviewAnswerSchema,
  reviewAnswerOutput,
} from "../src/execution.js";

it("retains a completed node's output in its persisted run event", () => {
  const record = {
    runId: "run",
    nodeId: "say",
    iteration: "0",
    attempt: 0,
    state: "complete",
    outputDigest: "digest",
    output: { value: "A recorded step result" },
  };
  expect(S.decodeUnknownSync(nodeEventSchema)(record)).toEqual(record);
});

it("retains a choice review note and refuses notes beyond its 1000-character bound", () => {
  const answer = {
    choice: "redo",
    note: "Keep the character, change the lighting.",
  };
  expect(
    S.decodeUnknownSync(reviewAnswerSchema)(answer, {
      onExcessProperty: "error",
    }),
  ).toEqual(answer);
  expect(
    S.decodeUnknownSync(reviewAnswerSchema)({
      choice: "redo",
      note: "x".repeat(1000),
    }),
  ).toEqual({ choice: "redo", note: "x".repeat(1000) });
  expect(() =>
    S.decodeUnknownSync(reviewAnswerSchema)({
      choice: "redo",
      note: "x".repeat(1001),
    }),
  ).toThrow();
  expect(S.decodeUnknownSync(reviewAnswerSchema)({ choice: "keep" })).toEqual({
    choice: "keep",
  });
  expect(S.decodeUnknownSync(reviewAnswerSchema)({ approved: false })).toEqual({
    approved: false,
  });
});

it("projects the selected item, actual choice and note for the next round", () => {
  const answer = S.decodeUnknownSync(reviewAnswerSchema)({
    choice: "redo",
    note: "Use warm lighting.",
  });
  const item = { image: "artifact:panel" };
  expect(reviewAnswerOutput(answer, item)).toEqual({
    redo: item,
    choice: "redo",
    note: "Use warm lighting.",
  });
  expect(reviewAnswerOutput({ choice: "keep" }, item)).toEqual({
    keep: item,
    choice: "keep",
    note: "",
  });
  expect(reviewAnswerOutput({ approved: true }, item)).toEqual({
    approved: item,
    choice: "approved",
    note: "",
  });
  expect(reviewAnswerOutput({ approved: false }, item)).toEqual({
    rejected: item,
    choice: "rejected",
    note: "",
  });
});

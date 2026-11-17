import { expect, it } from "vitest";
import * as S from "effect/Schema";
import { nodeSchema } from "../src/index.js";

const projection = { type: "object", properties: {} };
const kinds = {
  app: {
    id: "a",
    kind: "app",
    app: "prints",
    method: "generate",
    methodDigest: "digest",
    values: {},
  },
  code: {
    id: "a",
    kind: "code",
    source: "return {}",
    input: projection,
    output: projection,
    values: {},
  },
  condition: {
    id: "a",
    kind: "condition",
    test: { op: "and", tests: [] },
  },
  map: {
    id: "a",
    kind: "map",
    over: { node: "$input", port: "items" },
    body: "each",
    concurrency: 1,
    maxItems: 1,
  },
  repeat: {
    id: "a",
    kind: "repeat",
    body: "again",
    maxRounds: 1,
    until: { op: "and", tests: [] },
  },
  wait: { id: "a", kind: "wait", for: 1000 },
  transform: { id: "a", kind: "transform", fields: {} },
} as const;
const review = {
  id: "a",
  kind: "review",
  title: "Is this right?",
  show: [],
  reviewers: "runner",
  timeout: 1000,
} as const;
// Stored data is decoded refusing unknown keys, so a key the schema lacks fails.
const accepts = (node: S.Json) =>
  S.decodeUnknownExit(nodeSchema)(node, { onExcessProperty: "error" })._tag ===
  "Success";

it("keeps every stored node shape valid: title and note are optional", () => {
  for (const node of [...Object.values(kinds), review])
    expect(accepts(node), node.kind).toBe(true);
});

it("takes an optional step name on every kind except review, and a note on every kind", () => {
  for (const node of Object.values(kinds)) {
    expect(accepts({ ...node, title: "Make a panel" }), node.kind).toBe(true);
    expect(accepts({ ...node, note: "Why this step exists" }), node.kind).toBe(
      true,
    );
  }
  expect(accepts({ ...review, note: "Ask the editor" })).toBe(true);
});

it("bounds a step name at 120 characters and a note at 500", () => {
  for (const node of Object.values(kinds)) {
    expect(accepts({ ...node, title: "t".repeat(120) }), node.kind).toBe(true);
    expect(accepts({ ...node, title: "t".repeat(121) }), node.kind).toBe(false);
    expect(accepts({ ...node, note: "n".repeat(500) }), node.kind).toBe(true);
    expect(accepts({ ...node, note: "n".repeat(501) }), node.kind).toBe(false);
  }
});

it("keeps a review's title as its required question", () => {
  const untitled = Object.fromEntries(
    Object.entries(review).filter(([key]) => key !== "title"),
  );
  expect(accepts(untitled)).toBe(false);
  expect(accepts({ ...review, title: "t".repeat(121) })).toBe(false);
});

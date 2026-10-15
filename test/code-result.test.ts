import { expect, it } from "vitest";
import { codeResult } from "../src/code-result.js";

it("checks the whole Code checkpoint after projecting scalar output", () => {
  expect(codeResult({ type: "string" }, "Garden")).toEqual({
    kind: "complete",
    ports: { value: "Garden", after: true },
  });
  // UTF-8 cargo fits 64 KiB; its required checkpoint framing does not.
  expect(codeResult({ type: "string" }, "a".repeat(65_500))).toEqual({
    kind: "refused",
    code: "result_limit",
  });
});

it("refuses transport values that cannot be JSON without coercing them", () => {
  for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY])
    expect(codeResult({ type: "number" }, value)).toEqual({
      kind: "refused",
      code: "invalid_output",
    });
  expect(codeResult({ type: "string" }, 7)).toEqual({
    kind: "refused",
    code: "invalid_output",
  });
});

it("keeps authored refusal records on their declared outlet", () => {
  const output = {
    anyOf: [
      { type: "array", items: { type: "string" } },
      {
        type: "object",
        properties: { error: { type: "string", const: "empty_names" } },
        required: ["error"],
        additionalProperties: false,
      },
    ],
  };
  expect(codeResult(output, ["Garden"])).toEqual({
    kind: "complete",
    ports: { ok: ["Garden"], after: true },
  });
  expect(codeResult(output, { error: "empty_names" })).toEqual({
    kind: "complete",
    ports: { refused: { error: "empty_names" }, after: true },
  });
  expect(codeResult(output, { error: "different" })).toEqual({
    kind: "refused",
    code: "invalid_output",
  });
});

it("treats a pending-shaped Code return as ordinary declared JSON", () => {
  expect(
    codeResult(
      {
        type: "object",
        properties: {
          kind: { type: "string", const: "pending" },
          retryAfterMs: { type: "integer" },
        },
        required: ["kind", "retryAfterMs"],
        additionalProperties: false,
      },
      { kind: "pending", retryAfterMs: 1000 },
    ),
  ).toEqual({
    kind: "complete",
    ports: { kind: "pending", retryAfterMs: 1000, after: true },
  });
});

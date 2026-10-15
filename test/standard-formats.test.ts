import { expect, it } from "vitest";
import {
  accepts,
  assignable,
  parseProjection,
  portKind,
} from "../src/index.js";

it("admits and validates the standard formats supplied by App declarations", () => {
  for (const [format, valid, invalid] of [
    ["uri", "https://oyster.shiit.app/git/bonsai/pond.git", "not a URI"],
    ["uuid", "0199caff-aaaa-7000-8000-aaaaaaaaaaaa", "not a UUID"],
    ["date-time", "2026-10-12T08:00:00Z", "not a timestamp"],
  ] as const) {
    const schema = parseProjection({ type: "string", format });
    expect(accepts(schema, valid)).toBe(true);
    expect(accepts(schema, invalid)).toBe(false);
    expect(portKind(schema)).toBe("text");
    expect(assignable(schema, { type: "string" })).toBe(true);
    expect(assignable({ type: "string" }, schema)).toBe(false);
  }
});
it("keeps media annotations distinct and unknown assertions refused", () => {
  const image = parseProjection({ type: "string", format: "fungi:image" });
  expect(portKind(image)).toBe("fungi:image");
  expect(assignable(image, { type: "string" })).toBe(false);
  expect(assignable({ type: "string" }, image)).toBe(false);
  expect(() =>
    parseProjection({ type: "string", format: "not-supported" }),
  ).toThrow();
  expect(() =>
    parseProjection({ type: "string", pattern: "x", not: { const: "x" } }),
  ).toThrow();
});

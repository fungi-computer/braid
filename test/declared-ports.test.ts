import { expect, it } from "vitest";
import {
  catalogMethods,
  compile,
  methodInputValue,
  methodOutputValues,
  parseProjection,
} from "../src/index.js";

it("calls a scalar App API through value and preserves whole success or refusal records", async () => {
  const catalog = await catalogMethods({
    render: {
      description: "A declared scalar input and completion union",
      effect: "write",
      requires: [],
      input: { type: "string", minLength: 1 },
      output: {
        anyOf: [
          {
            type: "object",
            properties: {
              destination: {
                type: "object",
                properties: { path: { type: "string", pattern: "^/" } },
                required: ["path"],
                additionalProperties: false,
              },
              bytes: { type: "integer", exclusiveMinimum: 0 },
            },
            required: ["destination", "bytes"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { error: { type: "string", const: "not_granted" } },
            required: ["error"],
            additionalProperties: false,
          },
        ],
      },
    },
  });
  const method = catalog.methods.render;
  if (!method) throw new Error("Missing method");
  const result = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Declared ports",
      apps: { renderer: { appId: "app.renderer" } },
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [
        {
          id: "render",
          kind: "app",
          app: "renderer",
          method: "render",
          methodDigest: method.digest,
          values: { value: { literal: "Garden" } },
        },
      ],
      edges: [],
      output: {
        image: { node: "render", port: "ok" },
        error: { node: "render", port: "refused" },
      },
    },
    { "app.renderer": catalog },
    {
      renderer: { appId: "app.renderer", installationId: "installed-renderer" },
    },
  );
  expect(result.ok).toBe(true);
  expect(
    methodInputValue(parseProjection(method.input), { value: "Garden" }),
  ).toBe("Garden");
  const output = parseProjection(method.output);
  const media = { destination: { path: "/media/garden.png" }, bytes: 100 };
  expect(methodOutputValues(output, media)).toEqual({ ok: media });
  expect(methodOutputValues(output, { error: "not_granted" })).toEqual({
    refused: { error: "not_granted" },
  });
  expect(methodOutputValues(output, { ...media, bytes: 0 })).toBeUndefined();
  expect(
    methodOutputValues(output, {
      ...media,
      destination: { path: "relative.png" },
    }),
  ).toBeUndefined();
});

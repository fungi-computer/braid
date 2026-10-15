import * as S from "effect/Schema";
import { expect, it } from "vitest";
import {
  mappingSchema,
  evaluateMapping,
  mappingRefs,
  catalogMethods,
  compile,
} from "../src/index.js";

it("builds nested App settings and path-only references from each beat", () => {
  const mapping = S.decodeUnknownSync(mappingSchema)(
    {
      each: {
        over: { from: { node: "$input", port: "beats" } },
        maxItems: 4,
        body: {
          object: {
            settings: {
              object: {
                model: { literal: "bytedance/seedance-2.0" },
                prompt: {
                  template:
                    "Animate this approved anime storyboard panel: {{$item.value}}",
                },
                references: {
                  array: [
                    {
                      object: {
                        path: {
                          from: { node: "chosen", port: "panel" },
                          path: "/destination/path",
                        },
                        role: { literal: "first-frame" },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
    { onExcessProperty: "error" },
  );
  expect(
    evaluateMapping(mapping, {
      $input: { beats: ["A quiet garden", "A rainy street"] },
      chosen: {
        panel: {
          destination: {
            computerId: "computer",
            path: "/media/approved-panel.png",
          },
        },
      },
    }),
  ).toEqual([
    {
      settings: {
        model: "bytedance/seedance-2.0",
        prompt: "Animate this approved anime storyboard panel: A quiet garden",
        references: [
          { path: "/media/approved-panel.png", role: "first-frame" },
        ],
      },
    },
    {
      settings: {
        model: "bytedance/seedance-2.0",
        prompt: "Animate this approved anime storyboard panel: A rainy street",
        references: [
          { path: "/media/approved-panel.png", role: "first-frame" },
        ],
      },
    },
  ]);
  expect(mappingRefs(mapping)).toEqual([
    { node: "$input", port: "beats" },
    { node: "chosen", port: "panel" },
  ]);
  expect(
    evaluateMapping(mapping, { $input: { beats: ["Missing panel"] } }),
  ).toBeUndefined();
  expect(
    evaluateMapping(mapping, { $input: { beats: ["1", "2", "3", "4", "5"] } }),
  ).toBeUndefined();
});

it("compiles each output as a bounded list of constructed App inputs", async () => {
  const result = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Beat settings",
      apps: {},
      input: {
        type: "object",
        properties: {
          beats: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 512 },
            minItems: 1,
            maxItems: 4,
          },
        },
        required: ["beats"],
        additionalProperties: false,
      },
      nodes: [
        {
          id: "settings",
          kind: "transform",
          fields: {
            items: {
              each: {
                over: { from: { node: "$input", port: "beats" } },
                maxItems: 4,
                body: {
                  object: {
                    prompt: { from: { node: "$item", port: "value" } },
                    index: { from: { node: "$item", port: "index" } },
                  },
                },
              },
            },
          },
        },
      ],
      edges: [],
      output: { settings: { node: "settings", port: "items" } },
    },
    {},
    {},
  );
  expect(result.ok).toBe(true);
});

it("compiles constructed settings using the declared nested input constraints", async () => {
  const catalog = await catalogMethods({
    generate: {
      description: "Generate from settings",
      effect: "write",
      requires: [],
      input: {
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: {
              model: { type: "string", enum: ["model"] },
              prompt: { type: "string", minLength: 1, maxLength: 2048 },
            },
            required: ["model", "prompt"],
            additionalProperties: false,
          },
        },
        required: ["settings"],
        additionalProperties: false,
      },
      output: { type: "string" },
    },
  });
  const result = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Dynamic settings",
      apps: { media: { appId: "media" } },
      input: {
        type: "object",
        properties: { beat: { type: "string", minLength: 1, maxLength: 512 } },
        required: ["beat"],
        additionalProperties: false,
      },
      nodes: [
        {
          id: "generate",
          kind: "app",
          app: "media",
          method: "generate",
          methodDigest: catalog.methods.generate?.digest ?? "",
          values: {
            settings: S.decodeUnknownSync(mappingSchema)({
              object: {
                model: { literal: "model" },
                prompt: { template: "Animate: {{$input.beat}}" },
              },
            }),
          },
        },
      ],
      edges: [],
      output: { image: { node: "generate", port: "value" } },
    },
    { media: catalog },
    { media: { appId: "media", installationId: "installed-media" } },
  );
  expect(result).toMatchObject({ ok: true });
});

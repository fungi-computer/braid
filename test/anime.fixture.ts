import type { WorkflowDefinition, Catalog, Bindings } from "../src/index.js";
const prompt = { type: "string" };
const image = { type: "string", format: "fungi:image" };
const video = { type: "string", format: "fungi:video" };
/** Fixture catalog only: these are not deployed Prints method declarations. */
export const animeCatalog: Catalog = {
  "app:prints": {
    methods: {
      generate: {
        description: "Generate a panel",
        digest: "fixture-generate-v1",
        input: {
          type: "object",
          properties: { prompt },
          required: ["prompt"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { image },
          required: ["image"],
          additionalProperties: false,
        },
        effect: "write",
        approval: "none",
        requires: ["media.generation"],
      },
      animate: {
        description: "Animate a panel",
        digest: "fixture-animate-v1",
        input: {
          type: "object",
          properties: { image },
          required: ["image"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { video },
          required: ["video"],
          additionalProperties: false,
        },
        effect: "write",
        approval: "none",
        requires: ["media.generation"],
      },
    },
  },
};
export const animeBindings: Bindings = {
  prints: {
    appId: "app:prints",
    installationId: "fixture-prints-installation",
  },
};
export const animeTemplate: WorkflowDefinition = {
  format: "fungi.workflow/v1",
  title: "Anime storyboard",
  apps: { prints: { appId: "app:prints", role: "media" } },
  input: {
    type: "object",
    properties: {
      beats: {
        type: "array",
        items: {
          type: "object",
          properties: { prompt, animate: { type: "boolean" } },
          required: ["prompt", "animate"],
          additionalProperties: false,
        },
        maxItems: 4,
      },
    },
    required: ["beats"],
    additionalProperties: false,
  },
  nodes: [
    {
      id: "beats",
      kind: "map",
      over: { node: "$input", port: "beats" },
      body: "beat",
      concurrency: 4,
      maxItems: 4,
    },
  ],
  edges: [],
  output: { beats: { node: "beats", port: "items" } },
  subgraphs: {
    beat: {
      input: {
        type: "object",
        properties: {
          item: {
            type: "object",
            properties: { prompt, animate: { type: "boolean" } },
            required: ["prompt", "animate"],
            additionalProperties: false,
          },
          index: { type: "integer" },
        },
        required: ["item", "index"],
        additionalProperties: false,
      },
      nodes: [
        {
          id: "unpack",
          kind: "transform",
          fields: {
            prompt: { from: { node: "$input", port: "item" }, path: "/prompt" },
            animate: {
              from: { node: "$input", port: "item" },
              path: "/animate",
            },
          },
        },
        {
          id: "generate",
          kind: "app",
          app: "prints",
          method: "generate",
          methodDigest: "fixture-generate-v1",
          values: { prompt: { template: "{{unpack.prompt}} in watercolour" } },
        },
        {
          id: "review",
          kind: "review",
          title: "Review the panel",
          show: [{ node: "generate", port: "image" }],
          reviewers: "runner",
          timeout: 86_400_000,
        },
        {
          id: "clip",
          kind: "condition",
          test: {
            op: "eq",
            left: { from: { node: "unpack", port: "animate" } },
            right: { literal: true },
          },
        },
        {
          id: "animate",
          kind: "app",
          app: "prints",
          method: "animate",
          methodDigest: "fixture-animate-v1",
          values: {},
        },
      ],
      edges: [
        {
          from: { node: "review", port: "approved" },
          to: { node: "clip", port: "after" },
        },
        {
          from: { node: "review", port: "approved" },
          to: { node: "animate", port: "image" },
        },
        {
          from: { node: "clip", port: "true" },
          to: { node: "animate", port: "after" },
        },
      ],
      output: {
        panel: { node: "generate", port: "image" },
        clip: { node: "animate", port: "video" },
      },
    },
  },
};

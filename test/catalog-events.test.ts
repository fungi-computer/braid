import { expect, it } from "vitest";
import {
  catalogEvents,
  compile,
  contentDigest,
  type WorkflowDefinition,
} from "../src/index.js";

const payload = {
  type: "object",
  properties: { branch: { type: "string" } },
  required: ["branch"],
  additionalProperties: false,
};
const declared = { "git.push": { description: "Repository pushed", payload } };

it("pins the original event payload schema while wording changes preserve its digest", async () => {
  const first = await catalogEvents(declared);
  expect(first.events["git.push"]?.digest).toBe(
    await contentDigest({ payload }),
  );
  const reworded = await catalogEvents({
    "git.push": { ...declared["git.push"], description: "Push received" },
  });
  expect(reworded.events["git.push"]?.digest).toBe(
    first.events["git.push"]?.digest,
  );
  const changed = await catalogEvents({
    "git.push": {
      ...declared["git.push"],
      payload: { ...payload, additionalProperties: true },
    },
  });
  expect(changed.events["git.push"]?.digest).not.toBe(
    first.events["git.push"]?.digest,
  );
});

it("pins an event-only emitter installation and catalog in the compiled plan", async () => {
  const events = await catalogEvents(declared);
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Push",
    apps: { repo: { appId: "app.repo" } },
    input: payload,
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "push",
        on: "event",
        app: "repo",
        event: "git.push",
        eventDigest: events.events["git.push"]?.digest ?? "",
      },
    ],
  };
  const catalog = { "app.repo": { methods: {}, ...events } };
  const bindings = { repo: { appId: "app.repo", installationId: "repo-a" } };
  const compiled = await compile(definition, catalog, bindings);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error("Event fixture did not compile");
  expect(compiled.plan.bindings).toEqual(bindings);
  expect(compiled.plan.catalog).toEqual(catalog);
  expect(compiled.plan.requiredBindings).toEqual([]);
  expect((await compile(definition, catalog, {})).ok).toBe(false);
});

it("refuses missing event declarations, digest drift and statically incompatible payload mappings", async () => {
  const events = await catalogEvents(declared);
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Push",
    apps: { repo: { appId: "app.repo" } },
    input: {
      type: "object",
      properties: { branch: { type: "string" } },
      required: ["branch"],
      additionalProperties: false,
    },
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "push",
        on: "event",
        app: "repo",
        event: "git.push",
        eventDigest: events.events["git.push"]?.digest ?? "",
        input: {
          branch: {
            from: { node: "$input", port: "payload" },
            path: "/branch",
          },
        },
      },
    ],
  };
  const bindings = { repo: { appId: "app.repo", installationId: "repo-a" } };
  expect(
    (
      await compile(
        definition,
        { "app.repo": { methods: {}, ...events } },
        bindings,
      )
    ).ok,
  ).toBe(true);
  expect
    .soft(await compile(definition, { "app.repo": { methods: {} } }, bindings))
    .toMatchObject({ ok: false });
  const changed = await catalogEvents({
    "git.push": {
      description: "Push",
      payload: { ...payload, properties: { branch: { type: "number" } } },
    },
  });
  const drifted = await compile(
    definition,
    { "app.repo": { methods: {}, ...changed } },
    bindings,
  );
  expect(drifted.ok).toBe(false);
  if (drifted.ok) throw new Error("Changed event digest was accepted");
  expect(drifted.issues.some((issue) => issue.code === "digest_drift")).toBe(
    true,
  );
  const repinned: WorkflowDefinition = {
    ...definition,
    triggers: (definition.triggers ?? []).map((trigger) =>
      trigger.on === "event"
        ? { ...trigger, eventDigest: changed.events["git.push"]?.digest ?? "" }
        : trigger,
    ),
  };
  const incompatible = await compile(
    repinned,
    { "app.repo": { methods: {}, ...changed } },
    bindings,
  );
  expect(incompatible.ok).toBe(false);
  if (incompatible.ok)
    throw new Error("Incompatible payload mapping was accepted");
  expect(
    incompatible.issues.some(
      (issue) => issue.code === "trigger" && issue.port === "branch",
    ),
  ).toBe(true);
});

it("refuses a coalesce mapping that can never provide a required input", async () => {
  const events = await catalogEvents(declared);
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Push",
    apps: { repo: { appId: "app.repo" } },
    input: payload,
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "push",
        on: "event",
        app: "repo",
        event: "git.push",
        eventDigest: events.events["git.push"]?.digest ?? "",
        input: { branch: { coalesce: [{ literal: null }] } },
      },
    ],
  };
  expect(
    (
      await compile(
        definition,
        { "app.repo": { methods: {}, ...events } },
        { repo: { appId: "app.repo", installationId: "repo-a" } },
      )
    ).ok,
  ).toBe(false);
});

it("projects an emitted event type literal without changing its pinned schema", async () => {
  const emitted = {
    type: "object",
    properties: { type: { type: "string", const: "git.push" } },
    required: ["type"],
    additionalProperties: false,
  };
  const events = await catalogEvents({
    "git.push": { description: "Push", payload: emitted },
  });
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Push",
    apps: { repo: { appId: "app.repo" } },
    input: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    nodes: [],
    edges: [],
    output: {},
    triggers: [
      {
        id: "push",
        on: "event",
        app: "repo",
        event: "git.push",
        eventDigest: events.events["git.push"]?.digest ?? "",
        input: {
          name: { from: { node: "$input", port: "payload" }, path: "/type" },
        },
      },
    ],
  };
  expect(
    (
      await compile(
        definition,
        { "app.repo": { methods: {}, ...events } },
        { repo: { appId: "app.repo", installationId: "repo-a" } },
      )
    ).ok,
  ).toBe(true);
  expect(events.events["git.push"]?.payload).toEqual(emitted);
});

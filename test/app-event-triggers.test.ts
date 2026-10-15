import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  triggerRun,
  validate,
  workflowDefinitionSchema,
} from "../src/index.js";

const definition = {
  format: "fungi.workflow/v1",
  title: "On App event",
  apps: { repository: { appId: "app_repository" } },
  input: {
    type: "object",
    properties: { branch: { type: "string" }, eventId: { type: "string" } },
    required: ["branch", "eventId"],
    additionalProperties: false,
  },
  nodes: [],
  edges: [],
  output: {},
  triggers: [
    {
      id: "push",
      on: "event",
      app: "repository",
      event: "git.push",
      eventDigest: "push-v1",
      when: {
        op: "eq",
        left: {
          from: { node: "$input", port: "payload" },
          path: "/data/branch",
        },
        right: { literal: "main" },
      },
      input: {
        branch: {
          from: { node: "$input", port: "payload" },
          path: "/data/branch",
        },
        eventId: { from: { node: "$input", port: "eventId" } },
      },
    },
  ],
};

it("maps an admitted App event payload and stable event id onto run input", () => {
  const parsed = S.decodeUnknownSync(workflowDefinitionSchema)(definition);
  expect(
    triggerRun(parsed, "push", {
      payload: {
        type: "git.push",
        timestamp: "2026-10-11T12:00:00Z",
        data: { branch: "main" },
      },
      eventId: "push-1",
    }),
  ).toEqual({ kind: "start", input: { branch: "main", eventId: "push-1" } });
});

it("ignores an App event that the trigger filter does not select", () => {
  const parsed = S.decodeUnknownSync(workflowDefinitionSchema)(definition);
  expect(
    triggerRun(parsed, "push", {
      payload: {
        type: "git.push",
        timestamp: "2026-10-11T12:00:00Z",
        data: { branch: "dev" },
      },
      eventId: "push-2",
    }),
  ).toEqual({ kind: "ignored" });
});

it("refuses App-event filters that read outside the delivered event", () => {
  expect(
    validate(
      {
        ...definition,
        triggers: definition.triggers.map((trigger) => ({
          ...trigger,
          when: {
            op: "exists",
            value: { from: { node: "foreign", port: "value" } },
          },
        })),
      },
      {},
    ),
  ).toContainEqual({
    code: "trigger",
    trigger: "push",
    port: "value",
    message: "A trigger reads only its declared event ports",
  });
});

it("names the event's one repository from the trigger's repository mapping", () => {
  const parsed = S.decodeUnknownSync(workflowDefinitionSchema)({
    ...definition,
    triggers: [
      {
        ...definition.triggers[0],
        repository: {
          from: { node: "$input", port: "payload" },
          path: "/data/repository",
        },
      },
    ],
  });
  const event = (repository: string | number | null) => ({
    payload: {
      type: "git.push",
      timestamp: "2026-10-11T12:00:00Z",
      data: { branch: "main", repository },
    },
    eventId: "push-1",
  });
  expect(triggerRun(parsed, "push", event("pond"))).toEqual({
    kind: "start",
    input: { branch: "main", eventId: "push-1" },
    repository: "pond",
  });
  for (const invalid of ["..", "a/b", "", 42, null])
    expect(triggerRun(parsed, "push", event(invalid))).toEqual({
      kind: "refused",
      code: "invalid_repository",
    });
});

it("refuses a trigger repository that reads outside the delivered event", () => {
  expect(
    validate(
      {
        ...definition,
        triggers: definition.triggers.map((trigger) => ({
          ...trigger,
          repository: { from: { node: "foreign", port: "repository" } },
        })),
      },
      {},
    ),
  ).toContainEqual({
    code: "trigger",
    trigger: "push",
    port: "repository",
    message: "A trigger reads only its declared event ports",
  });
});

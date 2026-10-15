import { expect, it } from "vitest";
import * as S from "effect/Schema";
import {
  triggerRun,
  triggerRequestId,
  validate,
  workflowDefinitionSchema,
} from "../src/index.js";

const definition = {
  format: "fungi.workflow/v1",
  title: "Scheduled echo",
  apps: {},
  input: {
    type: "object",
    properties: { at: { type: "string" } },
    required: ["at"],
    additionalProperties: false,
  },
  nodes: [
    {
      id: "echo",
      kind: "transform",
      fields: { at: { from: { node: "$input", port: "at" } } },
    },
  ],
  edges: [],
  output: { at: { node: "echo", port: "at" } },
  triggers: [
    {
      id: "clock",
      on: "schedule",
      cron: { expression: "*/5 * * * *", timeZone: "UTC" },
      input: { at: { from: { node: "$input", port: "scheduledAt" } } },
    },
  ],
};

it("maps a five-minute schedule occurrence to the declared run input", () => {
  expect(validate(definition, {})).toEqual([]);
  const parsed = S.decodeUnknownSync(workflowDefinitionSchema)(definition);
  expect(
    triggerRun(parsed, "clock", {
      scheduledAt: "2026-10-11T12:05:00.000Z",
      eventId: "schedule-a:1791720300000",
    }),
  ).toEqual({ kind: "start", input: { at: "2026-10-11T12:05:00.000Z" } });
});

it.each([
  ["bad cron", "tomorrow", "UTC"],
  ["bad zone", "*/5 * * * *", "Not/AZone"],
  ["one-minute cadence", "* * * * *", "UTC"],
])("refuses %s with a trigger issue", (_label, expression, timeZone) => {
  expect(
    validate(
      {
        ...definition,
        triggers: [
          {
            ...definition.triggers[0],
            cron: { expression, timeZone },
          },
        ],
      },
      {},
    ),
  ).toContainEqual(
    expect.objectContaining({ code: "trigger", trigger: "clock" }),
  );
});

it("uses the occurrence eventId to deduplicate one tick and distinguish the next", async () => {
  const tick = {
    scope: "team/schedule/clock",
    triggerId: "clock",
    eventId: "clock:1791720300000",
  };
  expect(await triggerRequestId(tick)).toBe(
    await triggerRequestId({ ...tick }),
  );
  expect(await triggerRequestId(tick)).not.toBe(
    await triggerRequestId({ ...tick, eventId: "clock:1791720600000" }),
  );
});

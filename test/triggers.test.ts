import { describe, expect, it } from "vitest";
import {
  admitRunInput,
  compile,
  decodeExecutionPlan,
  triggerRequestId,
  triggerRun,
  validate,
  type Catalog,
  type TriggerEvent,
  type WorkflowDefinition,
} from "../src/index.js";

const catalog: Catalog = {
  "app.echo": {
    methods: {
      echo: {
        description: "Echo",
        digest: "echo-v1",
        input: {
          type: "object",
          properties: { value: {} },
          required: ["value"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { value: {} },
          required: ["value"],
        },
        effect: "write",
        approval: "none",
        requires: [],
      },
    },
  },
};
const bindings = {
  echo: { appId: "app.echo", installationId: "installation-1" },
};
/** A generic git push source: any signed sender that posts this body shape. */
const untriggered: WorkflowDefinition = {
  format: "fungi.workflow/v1",
  title: "On push",
  apps: { echo: { appId: "app.echo" } },
  input: {
    type: "object",
    properties: {
      repository: { type: "string" },
      ref: { type: "string" },
      after: { type: "string" },
      source: { type: "string" },
    },
    required: ["repository", "ref", "after"],
    additionalProperties: false,
  },
  nodes: [
    {
      id: "echo",
      kind: "app",
      app: "echo",
      method: "echo",
      methodDigest: "echo-v1",
      values: { value: { template: "{{$input.repository}}@{{$input.after}}" } },
    },
  ],
  edges: [],
  output: { value: { node: "echo", port: "value" } },
};
const pushWorkflow = (
  triggers: WorkflowDefinition["triggers"],
): WorkflowDefinition =>
  triggers === undefined ? untriggered : { ...untriggered, triggers };
const body = (path: string) => ({
  from: { node: "$input", port: "body" },
  path,
});
const onPush: NonNullable<WorkflowDefinition["triggers"]>[number] = {
  id: "push",
  on: "webhook",
  title: "When main is pushed",
  when: {
    op: "and",
    tests: [
      { op: "eq", left: body("/type"), right: { literal: "git.push" } },
      {
        op: "eq",
        left: body("/data/ref"),
        right: { literal: "refs/heads/main" },
      },
    ],
  },
  input: {
    repository: body("/data/repository"),
    ref: body("/data/ref"),
    after: body("/data/after"),
    source: { template: "webhook {{$input.eventId}}" },
  },
};
const event = (data: Record<string, string>, type = "git.push") =>
  ({
    body: { type, data },
    eventId: "msg_1",
    headers: { "content-type": "application/json" },
  }) satisfies TriggerEvent;
const pushed = {
  repository: "acme/game",
  ref: "refs/heads/main",
  after: "0123abc",
};

describe("run input defaults", () => {
  it("admits an event with a missing required default through the shared start policy", () => {
    const definition: WorkflowDefinition = {
      ...untriggered,
      input: {
        type: "object",
        properties: {
          aspect: { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
        },
        required: ["aspect"],
        additionalProperties: false,
      },
      triggers: [
        {
          id: "new-change",
          on: "event",
          app: "echo",
          event: "change.opened",
          eventDigest: "change-v1",
        },
      ],
    };
    expect(
      triggerRun(definition, "new-change", {
        payload: {},
        eventId: "change-1",
      }),
    ).toEqual({
      kind: "start",
      input: { aspect: "16:9" },
    });
  });
  it("keeps explicit false, zero and null while filling nested defaults without changing the caller", () => {
    const definition = {
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          count: { type: "number", default: 4 },
          note: { type: "null", default: null },
          settings: {
            type: "object",
            properties: { aspect: { type: "string", default: "16:9" } },
            required: ["aspect"],
          },
        },
      },
    };
    const raw = { enabled: false, count: 0, note: null, settings: {} };
    expect(admitRunInput(definition, raw)).toEqual({
      kind: "accepted",
      input: {
        enabled: false,
        count: 0,
        note: null,
        settings: { aspect: "16:9" },
      },
    });
    expect(raw.settings).toEqual({});
    expect(admitRunInput({ input: { type: "object" } }, null).kind).toBe(
      "invalid",
    );
  });
  it("returns validator issues instead of replacing an explicitly invalid argument with its default", () => {
    const result = admitRunInput(
      {
        input: {
          type: "object",
          properties: { aspect: { type: "string", default: "16:9" } },
        },
      },
      { aspect: 42 },
    );
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid")
      throw new Error("Invalid input was admitted");
    expect(
      result.issues.some(
        (issue) => issue.path === "#/aspect" && issue.message.length > 0,
      ),
    ).toBe(true);
  });
});

describe("webhook triggers in fungi.workflow/v1", () => {
  it("accepts a typed webhook trigger and keeps it in the compiled plan identity", async () => {
    const definition = pushWorkflow([onPush]);
    expect(validate(definition, catalog)).toEqual([]);
    const compiled = await compile(definition, catalog, bindings);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.plan.definition.triggers).toEqual([onPush]);
    await expect(decodeExecutionPlan(compiled.plan)).resolves.toEqual(
      compiled.plan,
    );
    const without = await compile(pushWorkflow(undefined), catalog, bindings);
    expect(without.ok && without.plan.planDigest).not.toBe(
      compiled.plan.planDigest,
    );
  });

  it.each([
    [
      "a reference outside the event",
      {
        ...onPush,
        input: {
          ...onPush.input,
          ref: { from: { node: "echo", port: "value" } },
        },
      },
    ],
    [
      "an event port name read from a node",
      {
        ...onPush,
        input: {
          ...onPush.input,
          ref: { from: { node: "echo", port: "body" } },
        },
      },
    ],
    [
      "a dropped receive-time port",
      {
        ...onPush,
        input: {
          ...onPush.input,
          ref: { from: { node: "$input", port: "receivedAt" } },
        },
      },
    ],
    [
      "an unknown event port",
      {
        ...onPush,
        input: {
          ...onPush.input,
          ref: { from: { node: "$input", port: "cookie" } },
        },
      },
    ],
    [
      "a template reading a node",
      {
        ...onPush,
        input: { ...onPush.input, source: { template: "{{echo.value}}" } },
      },
    ],
    [
      "a filter reading a node",
      {
        ...onPush,
        when: {
          op: "exists",
          value: { from: { node: "echo", port: "value" } },
        },
      },
    ],
    [
      "a mapped field the run input does not declare",
      { ...onPush, input: { ...onPush.input, branch: body("/data/ref") } },
    ],
    [
      "a required run input left unmapped",
      {
        ...onPush,
        input: { repository: body("/data/repository"), ref: body("/data/ref") },
      },
    ],
    [
      "a literal that does not fit the run input",
      { ...onPush, input: { ...onPush.input, ref: { literal: 7 } } },
    ],
  ] as const)("refuses %s with a typed trigger issue", (_label, trigger) => {
    expect(validate(pushWorkflow([trigger]), catalog)).toContainEqual(
      expect.objectContaining({ code: "trigger", trigger: "push" }),
    );
  });

  it("refuses duplicate trigger ids and invalid trigger syntax", () => {
    expect(validate(pushWorkflow([onPush, onPush]), catalog)).toContainEqual(
      expect.objectContaining({ code: "duplicate", trigger: "push" }),
    );
    expect(
      validate(
        pushWorkflow([
          {
            ...onPush,
            input: { ...onPush.input, source: { template: "{{$input.body" } },
          },
        ]),
        catalog,
      ),
    ).toContainEqual(
      expect.objectContaining({ code: "template", trigger: "push" }),
    );
    expect(
      validate(
        { ...pushWorkflow(undefined), triggers: [{ ...onPush, on: "cron" }] },
        catalog,
      ),
    ).toContainEqual(expect.objectContaining({ code: "schema" }));
  });

  it("maps a matching event onto typed run input", () => {
    expect(triggerRun(pushWorkflow([onPush]), "push", event(pushed))).toEqual({
      kind: "start",
      input: { ...pushed, source: "webhook msg_1" },
    });
  });

  it("ignores events the filter does not select", () => {
    const definition = pushWorkflow([onPush]);
    expect(
      triggerRun(
        definition,
        "push",
        event({ ...pushed, ref: "refs/heads/dev" }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(triggerRun(definition, "push", event(pushed, "git.tag"))).toEqual({
      kind: "ignored",
    });
  });

  it("refuses an event that does not produce valid run input", () => {
    const definition = pushWorkflow([onPush]);
    const missingAfter = { repository: pushed.repository, ref: pushed.ref };
    expect(triggerRun(definition, "push", event(missingAfter))).toEqual({
      kind: "refused",
      code: "invalid_input",
    });
    expect(
      triggerRun(definition, "push", {
        ...event(pushed),
        body: { type: "git.push", data: { ...pushed, after: 42 } },
      }),
    ).toEqual({ kind: "refused", code: "invalid_input" });
  });

  it("uses the body itself as run input when the trigger declares no mapping", () => {
    const definition = pushWorkflow([{ id: "raw", on: "webhook" }]);
    expect(validate(definition, catalog)).toEqual([]);
    expect(
      triggerRun(definition, "raw", { ...event(pushed), body: pushed }),
    ).toEqual({ kind: "start", input: pushed });
    expect(
      triggerRun(definition, "raw", { ...event(pushed), body: "not json" }),
    ).toEqual({ kind: "refused", code: "invalid_input" });
    expect(
      triggerRun(definition, "raw", {
        ...event(pushed),
        body: { ...pushed, extra: true },
      }),
    ).toEqual({ kind: "refused", code: "invalid_input" });
  });

  it("refuses a trigger the definition does not declare", () => {
    expect(
      triggerRun(pushWorkflow([onPush]), "missing", event(pushed)),
    ).toEqual({ kind: "refused", code: "unknown_trigger" });
    expect(triggerRun(pushWorkflow(undefined), "push", event(pushed))).toEqual({
      kind: "refused",
      code: "unknown_trigger",
    });
  });

  it("derives one stable request id per (scope, trigger, event)", async () => {
    const id = await triggerRequestId({
      scope: "binding-1",
      triggerId: "push",
      eventId: "msg_1",
    });
    expect(id).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await expect(
      triggerRequestId({
        scope: "binding-1",
        triggerId: "push",
        eventId: "msg_1",
      }),
    ).resolves.toBe(id);
    await expect(
      triggerRequestId({
        scope: "binding-1",
        triggerId: "push",
        eventId: "msg_2",
      }),
    ).resolves.not.toBe(id);
    await expect(
      triggerRequestId({
        scope: "binding-1",
        triggerId: "tag",
        eventId: "msg_1",
      }),
    ).resolves.not.toBe(id);
    await expect(
      triggerRequestId({
        scope: "binding-2",
        triggerId: "push",
        eventId: "msg_1",
      }),
    ).resolves.not.toBe(id);
  });
});

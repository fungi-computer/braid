import * as S from "effect/Schema";
import {
  gitAccessSchema,
  workflowBindingSchema,
  type GitAccess,
} from "./git-access.js";

const boundedString = (max: number) =>
  S.String.pipe(S.check(S.isMaxLength(max)));
const name = boundedString(80).pipe(
  S.check(S.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/)),
);
const count = (min: number, max: number) =>
  S.Number.pipe(
    S.check(S.isInt()),
    S.check(S.isBetween({ minimum: min, maximum: max })),
  );
const array = <A extends S.Top>(schema: A, max: number) =>
  S.Array(schema).pipe(S.check(S.isMaxLength(max)));
const record = <A extends S.Top>(schema: A) => S.Record(name, schema);
const json = S.Json.pipe(
  S.check(S.makeFilter((value) => JSON.stringify(value).length <= 20_000)),
);
/** Same byte/depth envelope as the App API projection. */
export const projectionSchema = S.JsonObject.pipe(
  S.check(
    S.makeFilter((value) => {
      const withinDepth = (item: S.Json, depth: number): boolean => {
        if (depth > 16) return false;
        if (S.is(S.Array(S.Json))(item))
          return item.every((child) => withinDepth(child, depth + 1));
        if (S.is(S.JsonObject)(item))
          return Object.values(item).every((child) =>
            withinDepth(child, depth + 1),
          );
        return true;
      };
      return (
        new TextEncoder().encode(JSON.stringify(value)).length <= 20_000 &&
        withinDepth(value, 0)
      );
    }),
  ),
);
export const portRefSchema = S.Struct({
  node: S.Union([name, S.Literals(["$input", "$item"])]),
  port: name,
});
const templateSchema = S.Struct({ template: boundedString(4000) });
const literalSchema = S.Struct({ literal: json });
export const valueSchema = S.Union([literalSchema, templateSchema]);
const fromSchema = S.Struct({
  from: portRefSchema,
  path: S.optionalKey(boundedString(512)),
});
export type Mapping =
  | typeof fromSchema.Type
  | typeof valueSchema.Type
  | { readonly coalesce: readonly Mapping[] }
  | { readonly object: Readonly<Record<string, Mapping>> }
  | { readonly array: readonly Mapping[] }
  | {
      readonly each: {
        readonly over: Mapping;
        readonly body: Mapping;
        readonly maxItems: number;
      };
    };
export const mappingSchema: S.Codec<Mapping> = S.Union([
  fromSchema,
  valueSchema,
  S.Struct({ coalesce: S.suspend(() => array(mappingSchema, 16)) }),
  S.Struct({ object: S.suspend(() => S.Record(S.String, mappingSchema)) }),
  S.Struct({ array: S.suspend(() => array(mappingSchema, 50)) }),
  S.Struct({
    each: S.Struct({
      over: S.suspend(() => mappingSchema),
      body: S.suspend(() => mappingSchema),
      maxItems: count(1, 50),
    }),
  }),
]);
export type Predicate =
  | {
      readonly op: "eq" | "neq" | "gt" | "lt" | "in";
      readonly left: Mapping;
      readonly right: Mapping;
    }
  | { readonly op: "exists"; readonly value: Mapping }
  | { readonly op: "and" | "or"; readonly tests: readonly Predicate[] }
  | { readonly op: "not"; readonly test: Predicate };
export const predicateSchema: S.Codec<Predicate> = S.Union([
  S.Struct({
    op: S.Literals(["eq", "neq", "gt", "lt", "in"]),
    left: mappingSchema,
    right: mappingSchema,
  }),
  S.Struct({ op: S.Literal("exists"), value: mappingSchema }),
  S.Struct({
    op: S.Literals(["and", "or"]),
    tests: S.suspend(() => array(predicateSchema, 16)),
  }),
  S.Struct({ op: S.Literal("not"), test: S.suspend(() => predicateSchema) }),
]);
const duration = count(1, 7 * 24 * 60 * 60 * 1000);
/** JavaScript body and declared data only; the whole graph also bounds UTF-8 bytes. */
export const codeNodeSchema = S.Struct({
  id: name,
  kind: S.Literal("code"),
  source: boundedString(256_000),
  input: projectionSchema,
  output: projectionSchema,
  values: record(mappingSchema),
});
export type CodeNode = typeof codeNodeSchema.Type;
export const nodeSchema = S.Union([
  codeNodeSchema,
  S.Struct({
    id: name,
    kind: S.Literal("app"),
    app: name,
    method: boundedString(80),
    methodDigest: boundedString(128),
    values: record(mappingSchema),
    gitAccess: S.optionalKey(
      S.declare(
        (value): value is GitAccess => gitAccessSchema.safeParse(value).success,
      ),
    ),
    retry: S.optionalKey(S.Struct({ attempts: count(1, 5) })),
  }),
  S.Struct({
    id: name,
    kind: S.Literal("review"),
    title: boundedString(120),
    show: array(portRefSchema, 64),
    reviewers: S.Literals(["runner", "owners"]),
    timeout: duration,
    /**
     * Named outcomes a reviewer picks from; each is an output port carrying
     * the shown item. Without choices the review approves or rejects.
     */
    choices: S.optionalKey(
      array(S.Struct({ id: name, label: boundedString(80) }), 8),
    ),
  }),
  S.Struct({ id: name, kind: S.Literal("condition"), test: predicateSchema }),
  S.Struct({
    id: name,
    kind: S.Literal("map"),
    over: portRefSchema,
    body: name,
    concurrency: count(1, 8),
    maxItems: count(1, 50),
  }),
  S.Struct({
    id: name,
    kind: S.Literal("repeat"),
    body: name,
    maxRounds: count(1, 5),
    /** The predicate reads the completed body's output through $input. */
    until: predicateSchema,
  }),
  S.Struct({ id: name, kind: S.Literal("wait"), for: duration }),
  S.Struct({
    id: name,
    kind: S.Literal("transform"),
    fields: record(mappingSchema),
  }),
]);
export const edgeSchema = S.Struct({ from: portRefSchema, to: portRefSchema });
/**
 * Ports of the event a trigger receives. Inside a trigger, `$input` names this
 * event, not the run input: the trigger maps it onto the run's `$input`. Every
 * port is the same on a redelivery of the same event, so a redelivery maps to
 * the same run input and replays instead of conflicting.
 */
export const TRIGGER_EVENT_PORTS = {
  webhook: ["body", "eventId", "headers"],
  schedule: ["scheduledAt", "eventId"],
  event: ["payload", "eventId"],
} as const;
/**
 * An incoming webhook. The host owns the URL, the secret and the signature
 * scheme; the definition owns only the filter and the mapping onto run input.
 * Without `input`, the event body itself must be the run input.
 */
const webhookTriggerSchema = S.Struct({
  id: name,
  on: S.Literal("webhook"),
  title: S.optionalKey(boundedString(120)),
  when: S.optionalKey(predicateSchema),
  input: S.optionalKey(record(mappingSchema)),
});
const scheduleTriggerSchema = S.Struct({
  id: name,
  on: S.Literal("schedule"),
  title: S.optionalKey(boundedString(120)),
  cron: S.Struct({
    expression: boundedString(256),
    timeZone: boundedString(128),
  }),
  input: S.optionalKey(record(mappingSchema)),
});
const appEventTriggerSchema = S.Struct({
  id: name,
  on: S.Literal("event"),
  title: S.optionalKey(boundedString(120)),
  app: name,
  event: boundedString(128),
  eventDigest: boundedString(128),
  when: S.optionalKey(predicateSchema),
  input: S.optionalKey(record(mappingSchema)),
  /**
   * The one repository, in the event App's own Git namespace, this event is
   * about. A node's `gitAccess` names it as `$trigger.repository`.
   */
  repository: S.optionalKey(mappingSchema),
});
const triggerSchema = S.Union([
  webhookTriggerSchema,
  scheduleTriggerSchema,
  appEventTriggerSchema,
]);
export const graphSchema = S.Struct({
  input: projectionSchema,
  nodes: array(nodeSchema, 64),
  edges: array(edgeSchema, 256),
  output: record(portRefSchema),
});
export const workflowDefinitionSchema = S.Struct({
  ...graphSchema.fields,
  format: S.Literal("fungi.workflow/v1"),
  title: boundedString(120),
  description: S.optionalKey(boundedString(1000)),
  apps: record(
    S.Struct({
      appId: boundedString(256),
      role: S.optionalKey(boundedString(80)),
    }),
  ),
  subgraphs: S.optionalKey(record(graphSchema)),
  triggers: S.optionalKey(array(triggerSchema, 8)),
}).pipe(
  S.check(
    S.makeFilter(
      (value) =>
        new TextEncoder().encode(JSON.stringify(value)).length <= 256_000,
    ),
  ),
);
/** Structural App API method shape from T1; digests are supplied by its catalog owner. */
export const methodSchema = S.Struct({
  /** This method may yield Agar Pending before its completed output. */
  pending: S.optionalKey(S.Literal(true)),
  description: boundedString(1000),
  input: projectionSchema,
  output: projectionSchema,
  effect: S.Literals(["read", "write", "external"]),
  approval: S.Literals(["none", "queue", "simulate"]),
  requires: array(boundedString(80), 64),
});
export const eventSchema = S.Struct({
  description: boundedString(1000),
  payload: projectionSchema,
});
export const catalogSchema = S.Record(
  S.String,
  S.Struct({
    methods: S.Record(
      S.String,
      S.Struct({ ...methodSchema.fields, digest: boundedString(128) }),
    ),
    events: S.optionalKey(
      S.Record(
        S.String,
        S.Struct({ ...eventSchema.fields, digest: boundedString(128) }),
      ),
    ),
  }),
);
export const bindingsSchema = record(
  S.declare(
    (value): value is import("zod").output<typeof workflowBindingSchema> =>
      workflowBindingSchema.safeParse(value).success,
  ),
);
export type WorkflowDefinition = typeof workflowDefinitionSchema.Type;
export type Graph = typeof graphSchema.Type;
export type Node = typeof nodeSchema.Type;
export type PortRef = typeof portRefSchema.Type;
export type Json = S.Json;
export type JsonSchemaProjection = typeof projectionSchema.Type;
export type Catalog = typeof catalogSchema.Type;
export type Bindings = typeof bindingsSchema.Type;
export type Method = typeof methodSchema.Type;
export const planContentSchema = S.Struct({
  definition: workflowDefinitionSchema,
  catalog: catalogSchema,
  bindings: bindingsSchema,
  estimatedSteps: count(0, 800),
  requiredBindings: array(
    S.Struct({
      app: name,
      installationId: boundedString(256),
      method: boundedString(80),
      ...methodSchema.fields,
    }),
    64,
  ),
});
export const executionPlanSchema = S.Struct({
  ...planContentSchema.fields,
  planDigest: boundedString(128),
});
export type ExecutionPlan = typeof executionPlanSchema.Type;

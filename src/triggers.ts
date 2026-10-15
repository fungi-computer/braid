import * as S from "effect/Schema";
import { contentDigest } from "./compile.js";
import { evaluateMapping, evaluatePredicate } from "./expressions.js";
import { admitRunInput } from "./ports.js";
import { triggerRepositorySchema } from "./git-access.js";
import type { Json, WorkflowDefinition } from "./schema.js";

/**
 * One verified incoming event, as the host hands it to a trigger. The host has
 * already authenticated the sender and bounded the body. `eventId` is the
 * host's stable, non-secret identity for the event; `headers` holds only the
 * host's allowlisted, non-secret headers that a redelivery repeats.
 */
export type TriggerEvent =
  | Readonly<{
      body: Json;
      eventId: string;
      headers: Readonly<Record<string, string>>;
    }>
  | Readonly<{ scheduledAt: string; eventId: string }>
  | Readonly<{ payload: Json; eventId: string }>;

export type TriggerOutcome =
  | Readonly<{ kind: "start"; input: S.JsonObject; repository?: string }>
  | Readonly<{ kind: "ignored" }>
  | Readonly<{
      kind: "refused";
      code: "unknown_trigger" | "invalid_input" | "invalid_repository";
    }>;

/**
 * Decide what one event does to a Workflow: start a run with typed input,
 * nothing (its filter does not select the event), or a refusal. Pure; the
 * definition has already passed `validate`.
 */
export function triggerRun(
  definition: WorkflowDefinition,
  triggerId: string,
  event: TriggerEvent,
): TriggerOutcome {
  const trigger = definition.triggers?.find((item) => item.id === triggerId);
  if (trigger === undefined)
    return { kind: "refused", code: "unknown_trigger" };
  let eventInput: S.JsonObject;
  let defaultInput: Json;
  switch (trigger.on) {
    case "webhook":
      if (!("body" in event)) return { kind: "refused", code: "invalid_input" };
      eventInput = {
        body: event.body,
        eventId: event.eventId,
        headers: { ...event.headers },
      };
      defaultInput = event.body;
      break;
    case "schedule":
      if (!("scheduledAt" in event))
        return { kind: "refused", code: "invalid_input" };
      eventInput = { scheduledAt: event.scheduledAt, eventId: event.eventId };
      defaultInput = eventInput;
      break;
    case "event":
      if (!("payload" in event))
        return { kind: "refused", code: "invalid_input" };
      eventInput = { payload: event.payload, eventId: event.eventId };
      defaultInput = event.payload;
      break;
  }
  const values = { $input: eventInput };
  if (
    trigger.on !== "schedule" &&
    trigger.when !== undefined &&
    !evaluatePredicate(trigger.when, values)
  )
    return { kind: "ignored" };
  const input =
    trigger.input === undefined
      ? defaultInput
      : Object.fromEntries(
          Object.entries(trigger.input).flatMap(([key, mapping]) => {
            const value = evaluateMapping(mapping, values);
            return value === undefined ? [] : [[key, value]];
          }),
        );
  const admitted = admitRunInput(definition, input);
  if (admitted.kind === "invalid")
    return { kind: "refused", code: "invalid_input" };
  if (trigger.on !== "event" || trigger.repository === undefined)
    return { kind: "start", input: admitted.input };
  const repository = triggerRepositorySchema.safeParse(
    evaluateMapping(trigger.repository, values),
  );
  return repository.success
    ? { kind: "start", input: admitted.input, repository: repository.data }
    : { kind: "refused", code: "invalid_repository" };
}

/**
 * The idempotent start key for a triggered run. `scope` is the host's name for
 * where the event arrived (for example a webhook binding); a redelivery of the
 * same event through the same trigger yields the same key, so it starts at
 * most one run.
 */
export function triggerRequestId(
  input: Readonly<{ scope: string; triggerId: string; eventId: string }>,
): Promise<string> {
  return contentDigest([
    "fungi.workflow/v1 trigger",
    input.scope,
    input.triggerId,
    input.eventId,
  ]);
}

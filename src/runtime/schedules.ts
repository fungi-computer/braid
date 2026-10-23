import { z } from "zod";
import * as Result from "effect/Result";
import {
  afterAdmitted,
  afterRefused,
  isDue,
  nextOccurrence,
  occurrenceKey,
  paused,
  cancelled,
} from "@fungi.computer/almanac";
import { canonicalJson, contentDigest } from "../index.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  armedWorkflowTriggerSchema,
  workflowArmerKey,
  workflowTriggerControlledBy,
  workflowTriggerPrincipalMember,
  type WorkflowArmer,
  type WorkflowInstallationAuthority,
  type WorkflowTriggerPrincipal,
  type WorkflowTriggerTarget,
  type ArmedWorkflowTrigger,
  type createTeamWorkflowTriggers,
} from "./trigger-owner.js";
import { storedTriggerRows } from "./stored-trigger-rows.js";

const recordSchema = armedWorkflowTriggerSchema.extend({
  id: z.string().min(1).max(256),
  cron: z.strictObject({
    expression: z.string().max(256),
    timeZone: z.string().max(128),
  }),
  nextDueAt: z.number().int(),
  state: z.enum(["active", "paused", "cancelled", "finished"]),
  lastError: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  retryAt: z.number().int().nullable(),
});
const bindingOf = (
  record: z.infer<typeof recordSchema>,
): ArmedWorkflowTrigger => armedWorkflowTriggerSchema.strip().parse(record);

/** Team-owned schedule records; Almanac alone decides occurrences and transitions. */
export function createWorkflowSchedules(options: {
  sql: WatchdogSqliteOwner["sql"];
  triggers: ReturnType<typeof createTeamWorkflowTriggers>;
  teamId: () => string;
  now: () => number;
  commit: <A>(body: () => A) => Promise<A>;
  authorize: (memberId: string, installationId: string) => Promise<void>;
  wake: (due: number | null) => Promise<void>;
  reportFailure: (
    failure: Readonly<{ source: "workflow_schedule_fire"; cause: unknown }>,
  ) => void;
}) {
  const { sql, reportFailure } = options;
  sql.exec(
    `CREATE TABLE IF NOT EXISTS hub_workflow_schedules (scheduleId TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT`,
  );
  const rows = storedTriggerRows(sql, {
    table: "hub_workflow_schedules",
    key: "scheduleId",
    record: recordSchema,
  });
  const records = () =>
    rows.all().map((record) => {
      if (record.state !== "active") return record;
      const reason = options.triggers.refusal(bindingOf(record));
      if (reason === null) return record;
      const next = { ...paused(record), lastError: reason, retryAt: null };
      store(next);
      return next;
    });
  const nextWake = () => {
    const due = records()
      .filter((record) => record.state === "active")
      .map((record) =>
        Math.max(record.nextDueAt, record.retryAt ?? record.nextDueAt),
      );
    return due.length === 0 ? null : Math.min(...due);
  };
  const store = (record: z.infer<typeof recordSchema>) => {
    const checked = recordSchema.parse(record);
    sql.exec(
      "INSERT INTO hub_workflow_schedules(scheduleId,record) VALUES(?,?) ON CONFLICT(scheduleId) DO UPDATE SET record=excluded.record",
      checked.id,
      JSON.stringify(checked),
    );
  };
  return {
    nextWake,
    async arm(
      armer: WorkflowArmer,
      target: WorkflowTriggerTarget,
      computerId: string,
      installationAuthority: WorkflowInstallationAuthority,
    ) {
      await options.authorize(armer.armedBy, target.installationId);
      const armed = await options.triggers.arm(
        armer,
        target,
        computerId,
        installationAuthority,
      );
      if (armed.kind === "refused") return armed;
      if (armed.trigger.on !== "schedule")
        return {
          kind: "refused" as const,
          reason: "Workflow trigger is not a schedule",
        };
      const cron = armed.trigger.cron;
      const next = nextOccurrence(cron, options.now());
      if (Result.isFailure(next))
        return { kind: "refused" as const, reason: next.failure.message };
      const id = await contentDigest([
        "workflow-schedule",
        ...workflowArmerKey(armer),
        target.installationId,
        target.workflowId,
        target.triggerId,
      ]);
      await options.commit(() => {
        const previous = records().find((record) => record.id === id);
        if (
          previous !== undefined &&
          canonicalJson(z.json().parse(bindingOf(previous))) !==
            canonicalJson(z.json().parse(armed.binding))
        )
          options.triggers.disarm(bindingOf(previous));
        store({
          ...armed.binding,
          id,
          cron,
          nextDueAt: next.success,
          state: "active",
          lastError: null,
          attempt: 0,
          retryAt: null,
        });
      });
      await options.wake(nextWake());
      return { kind: "armed" as const, scheduleId: id };
    },
    async list(principal: WorkflowTriggerPrincipal, installationId: string) {
      await options.authorize(
        workflowTriggerPrincipalMember(principal),
        installationId,
      );
      return records()
        .filter((record) => record.installationId === installationId)
        .map((record) => ({
          scheduleId: record.id,
          installationId: record.installationId,
          workflowId: record.workflowId,
          triggerId: record.triggerId,
          nextDueAt: record.nextDueAt,
          state: record.state,
          lastError: record.lastError,
        }));
    },
    async disarm(
      principal: WorkflowTriggerPrincipal,
      installationId: string,
      scheduleId: string,
    ) {
      const memberId = workflowTriggerPrincipalMember(principal);
      await options.authorize(memberId, installationId);
      const record = rows.read(scheduleId);
      if (record === null) return { kind: "not_found" as const };
      if (
        record.installationId !== installationId ||
        !workflowTriggerControlledBy(principal, record)
      )
        return { kind: "not_found" as const };
      await options.commit(() => {
        store(cancelled(record));
        options.triggers.disarm(bindingOf(record));
      });
      await options.wake(nextWake());
      return { kind: "disarmed" as const };
    },
    async fireDue() {
      for (const record of records()) {
        if (
          !isDue(record, options.now()) ||
          (record.retryAt !== null && record.retryAt > options.now())
        )
          continue;
        const binding = bindingOf(record);
        let next: z.infer<typeof recordSchema>;
        try {
          const result = await options.triggers.fire(
            binding,
            `${options.teamId()}/schedule/${record.id}`,
            {
              scheduledAt: new Date(record.nextDueAt).toISOString(),
              eventId: occurrenceKey(record),
            },
          );
          next =
            result.kind === "refused"
              ? { ...paused(record), lastError: result.reason, retryAt: null }
              : { ...afterAdmitted(record, options.now()), retryAt: null };
        } catch (cause) {
          reportFailure({ source: "workflow_schedule_fire", cause });
          const refused = afterRefused(
            record,
            options.now(),
            "Workflow execution temporarily unavailable",
          );
          next = { ...refused.schedule, retryAt: refused.retryAt };
        }
        // A disarm or re-arm admitted during upstream I/O wins over this firing.
        sql.exec(
          "UPDATE hub_workflow_schedules SET record=? WHERE scheduleId=? AND record=?",
          JSON.stringify(recordSchema.parse(next)),
          record.id,
          JSON.stringify(record),
        );
      }
      await options.wake(nextWake());
    },
  };
}

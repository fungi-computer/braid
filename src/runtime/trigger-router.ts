import * as z from "zod";
import { canonicalJson, contentDigest } from "../index.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  appEventFactSchema,
  type AppEventFact,
} from "@fungi.computer/puffball/app-event-facts";
import {
  armedWorkflowTriggerSchema,
  workflowArmerKey,
  workflowTriggerControlledBy,
  workflowTriggerPrincipalMember,
  type WorkflowArmer,
  type WorkflowInstallationAuthority,
  type WorkflowTriggerPrincipal,
  type WorkflowTriggerTarget,
  type createTeamWorkflowTriggers,
} from "./trigger-owner.js";
import { storedTriggerRows } from "./stored-trigger-rows.js";

const recordSchema = armedWorkflowTriggerSchema.extend({
  id: z.string(),
  emitterInstallationId: appEventFactSchema.shape.installationId,
  appId: appEventFactSchema.shape.appId,
  event: appEventFactSchema.shape.type,
  state: z.enum(["active", "paused"]),
  lastError: z.string().nullable(),
});

/** The Team's one App-event index; admission and execution belong to the shared trigger owner. */
export function createWorkflowEventRouter(options: {
  sql: WatchdogSqliteOwner["sql"];
  triggers: ReturnType<typeof createTeamWorkflowTriggers>;
  teamId(): string;
  commit<A>(body: () => A): Promise<A>;
  authorize(memberId: string, installationId: string): Promise<void>;
}) {
  const { sql } = options;
  sql.exec(`CREATE TABLE IF NOT EXISTS hub_workflow_event_triggers (
    id TEXT PRIMARY KEY, record TEXT NOT NULL
  ) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS hub_workflow_event_trigger_source
    ON hub_workflow_event_triggers(json_extract(record,'$.emitterInstallationId'),json_extract(record,'$.event'))`);
  const rows = storedTriggerRows(sql, {
    table: "hub_workflow_event_triggers",
    key: "id",
    record: recordSchema,
  });
  const readable = (raw: readonly unknown[]) =>
    raw.flatMap((row) => {
      const decoded = rows.read(
        z.strictObject({ id: z.string() }).parse(row).id,
      );
      return decoded === null ? [] : [decoded];
    });
  return {
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
      if (armed.trigger.on !== "event")
        return {
          kind: "refused" as const,
          reason: "Workflow trigger is not an App event",
        };
      const emitterInstallationId = armed.binding.bindings[armed.trigger.app];
      const appId = armed.definition.apps[armed.trigger.app]?.appId;
      if (emitterInstallationId === undefined || appId === undefined)
        return {
          kind: "refused" as const,
          reason: "Event App installation is not bound",
        };
      const id = await contentDigest([
        "workflow-event",
        ...workflowArmerKey(armer),
        target.installationId,
        target.workflowId,
        target.triggerId,
      ]);
      const record = recordSchema.parse({
        ...armed.binding,
        id,
        emitterInstallationId,
        appId,
        event: armed.trigger.event,
        state: "active",
        lastError: null,
      });
      await options.commit(() => {
        const previous = rows.read(id);
        if (previous !== null) {
          const binding = armedWorkflowTriggerSchema.strip().parse(previous);
          if (
            canonicalJson(z.json().parse(binding)) !==
            canonicalJson(z.json().parse(armed.binding))
          )
            options.triggers.disarm(binding);
        }
        sql.exec(
          "INSERT INTO hub_workflow_event_triggers(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
          id,
          JSON.stringify(record),
        );
      });
      return { kind: "armed" as const, eventTriggerId: id };
    },
    async disarm(
      principal: WorkflowTriggerPrincipal,
      installationId: string,
      eventTriggerId: string,
    ) {
      const memberId = workflowTriggerPrincipalMember(principal);
      await options.authorize(memberId, installationId);
      const record = rows.read(eventTriggerId);
      if (record === null) return { kind: "not_found" as const };
      if (
        record.installationId !== installationId ||
        !workflowTriggerControlledBy(principal, record)
      )
        return { kind: "not_found" as const };
      return options.commit(() => {
        // Re-read inside the commit; a concurrent change may have replaced the row.
        const current = rows.read(eventTriggerId);
        if (
          current === null ||
          !workflowTriggerControlledBy(principal, current)
        )
          return { kind: "not_found" as const };
        options.triggers.disarm(
          armedWorkflowTriggerSchema.strip().parse(current),
        );
        rows.remove(eventTriggerId);
        return { kind: "disarmed" as const };
      });
    },
    async list(principal: WorkflowTriggerPrincipal, installationId: string) {
      await options.authorize(
        workflowTriggerPrincipalMember(principal),
        installationId,
      );
      const stored = readable(
        sql
          .exec(
            "SELECT id FROM hub_workflow_event_triggers WHERE json_valid(record) AND json_extract(record,'$.installationId')=? ORDER BY id",
            installationId,
          )
          .toArray(),
      ).map((record) => {
        const refusal = options.triggers.refusal(
          armedWorkflowTriggerSchema.strip().parse(record),
        );
        return {
          eventTriggerId: record.id,
          workflowId: record.workflowId,
          triggerId: record.triggerId,
          emitterInstallationId: record.emitterInstallationId,
          event: record.event,
          state: refusal === null ? record.state : ("paused" as const),
          lastError: record.lastError ?? refusal,
        };
      });
      return stored;
    },
    async deliver(raw: AppEventFact) {
      const fact = appEventFactSchema.parse(raw);
      const records = readable(
        sql
          .exec(
            "SELECT id FROM hub_workflow_event_triggers WHERE json_valid(record) AND json_extract(record,'$.emitterInstallationId')=? AND json_extract(record,'$.event')=? ORDER BY id",
            fact.installationId,
            fact.type,
          )
          .toArray(),
      );
      for (const record of records) {
        if (record.appId !== fact.appId || record.state !== "active") continue;
        const result = await options.triggers.fire(
          armedWorkflowTriggerSchema.strip().parse(record),
          canonicalJson([
            options.teamId(),
            "app-event",
            record.id,
            fact.installationId,
          ]),
          { payload: fact.payload, eventId: fact.eventId },
        );
        if (result.kind === "refused") {
          await options.commit(() => {
            // A concurrent disarm or re-arm owns the newer record.
            sql.exec(
              "UPDATE hub_workflow_event_triggers SET record=? WHERE id=? AND record=?",
              JSON.stringify({
                ...record,
                state: "paused",
                lastError: result.reason,
              }),
              record.id,
              JSON.stringify(record),
            );
          });
        }
      }
      return "accepted" as const;
    },
  };
}

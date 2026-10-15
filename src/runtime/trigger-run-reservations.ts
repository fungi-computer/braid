import { defineIdFamily } from "@fungi.computer/cairn/id";
import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import { workflowIdSchema } from "../index.js";

const reservationIds = defineIdFamily({
  family: "workflow-trigger-reservation",
  version: 1,
  kinds: { reservation: { prefix: "wf_trigger_reservation" } },
});
const identity = z.string().min(1).max(256);
const triggerRunScopeSchema = z.strictObject({
  installationId: identity,
  workflowId: workflowIdSchema,
  commit: gitSha1Schema,
  triggerId: z.string().min(1).max(80),
});
export type TriggerRunScope = z.output<typeof triggerRunScopeSchema>;
const reservationInputSchema = z.strictObject({
  scope: triggerRunScopeSchema,
  requestId: z.string().min(1).max(1024),
});
const rowSchema = z.object({
  reservation_id: identity,
  run_id: identity.nullable(),
  status: z.enum(["active", "released", "terminal"]),
});
const countSchema = z.object({ count: z.number().int().nonnegative() });
const scopeKey = (scope: TriggerRunScope) => {
  const parsed = triggerRunScopeSchema.parse(scope);
  return JSON.stringify([
    parsed.installationId,
    parsed.workflowId,
    parsed.commit,
    parsed.triggerId,
  ]);
};

/** The enclosing Team owner supplies SQLite; callers never select the Team. */
export function createTriggerRunReservations(
  options: Pick<WatchdogSqliteOwner, "sql" | "transactionSync">,
) {
  const { sql } = options;
  sql.exec(`CREATE TABLE IF NOT EXISTS hub_trigger_run_reservations (
    reservation_id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL,
    run_id TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','released','terminal')),
    UNIQUE(scope,request_id)
  ) STRICT`);
  return {
    reserveTriggerRun(raw: { scope: TriggerRunScope; requestId: string }):
      | {
          kind: "reserved" | "replay";
          reservationId: string;
          runId: string | null;
        }
      | { kind: "refused"; reason: "limit" } {
      const input = reservationInputSchema.parse(raw);
      const scope = scopeKey(input.scope);
      return options.transactionSync(() => {
        const stored = sql
          .exec(
            "SELECT reservation_id,run_id,status FROM hub_trigger_run_reservations WHERE scope=? AND request_id=?",
            scope,
            input.requestId,
          )
          .toArray()[0];
        const prior = stored === undefined ? null : rowSchema.parse(stored);
        if (prior !== null && prior.status !== "released")
          return {
            kind: "replay",
            reservationId: prior.reservation_id,
            runId: prior.run_id,
          };
        const active = countSchema.parse(
          sql
            .exec(
              "SELECT count(*) AS count FROM hub_trigger_run_reservations WHERE status='active'",
            )
            .toArray()[0],
        ).count;
        if (active >= 20) return { kind: "refused", reason: "limit" };
        const reservationId =
          prior?.reservation_id ?? reservationIds.reservation.generate();
        if (prior === null)
          sql.exec(
            "INSERT INTO hub_trigger_run_reservations(reservation_id,scope,request_id,run_id,status) VALUES(?,?,?,NULL,'active')",
            reservationId,
            scope,
            input.requestId,
          );
        else
          sql.exec(
            "UPDATE hub_trigger_run_reservations SET status='active' WHERE reservation_id=?",
            reservationId,
          );
        return {
          kind: "reserved",
          reservationId,
          runId: prior?.run_id ?? null,
        };
      });
    },
    countActiveTriggerRuns(scope: TriggerRunScope): number {
      return countSchema.parse(
        sql
          .exec(
            "SELECT count(*) AS count FROM hub_trigger_run_reservations WHERE scope=? AND status='active'",
            scopeKey(scope),
          )
          .toArray()[0],
      ).count;
    },
    releaseTriggerRun(rawReservationId: string): void {
      const reservationId = identity.parse(rawReservationId);
      options.transactionSync(() => {
        sql.exec(
          "UPDATE hub_trigger_run_reservations SET status='released' WHERE reservation_id=? AND status='active'",
          reservationId,
        );
      });
    },
    bindTriggerRun(
      rawReservationId: string,
      rawRunId: string,
    ): "bound" | "replay" | "conflict" {
      const reservationId = identity.parse(rawReservationId);
      const runId = identity.parse(rawRunId);
      return options.transactionSync(() => {
        const stored = sql
          .exec(
            "SELECT reservation_id,run_id,status FROM hub_trigger_run_reservations WHERE reservation_id=?",
            reservationId,
          )
          .toArray()[0];
        if (stored === undefined) return "conflict";
        const prior = rowSchema.parse(stored);
        if (prior.run_id === runId) return "replay";
        if (prior.run_id !== null || prior.status !== "active")
          return "conflict";
        if (
          sql
            .exec(
              "SELECT reservation_id FROM hub_trigger_run_reservations WHERE run_id=?",
              runId,
            )
            .toArray().length > 0
        )
          return "conflict";
        sql.exec(
          "UPDATE hub_trigger_run_reservations SET run_id=? WHERE reservation_id=?",
          runId,
          reservationId,
        );
        return "bound";
      });
    },
    terminalTriggerRun(rawRunId: string): void {
      const runId = identity.parse(rawRunId);
      sql.exec(
        "UPDATE hub_trigger_run_reservations SET status='terminal' WHERE run_id=?",
        runId,
      );
    },
  };
}

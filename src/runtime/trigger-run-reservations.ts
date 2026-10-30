import { defineIdFamily } from "@fungi.computer/cairn/id";
import * as z from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import { workflowIdSchema } from "../index.js";

const reservationIds = defineIdFamily({
  family: "workflow-trigger-reservation",
  version: 1,
  kinds: { reservation: { prefix: "wf_trigger_reservation" } },
});
const identity = z.string().min(1).max(256);
const triggerRunScopeSchema = z.lazy(() =>
  z.strictObject({
    installationId: identity,
    workflowId: workflowIdSchema,
    commit: gitSha1Schema,
    triggerId: z.string().min(1).max(80),
  }),
);
export type TriggerRunScope = z.output<typeof triggerRunScopeSchema>;
const reservationInputSchema = z.lazy(() =>
  z.strictObject({
    scope: triggerRunScopeSchema,
    requestId: z.string().min(1).max(1024),
  }),
);
const rowSchema = z.lazy(() =>
  z.object({
    reservation_id: identity,
    run_id: identity.nullable(),
    status: z.enum(["active", "released", "terminal"]),
  }),
);
const countSchema = z.lazy(() =>
  z.object({ count: z.number().int().nonnegative() }),
);
const scopeKey = (scope: TriggerRunScope) => {
  const parsed = triggerRunScopeSchema.parse(scope);
  return JSON.stringify([
    parsed.installationId,
    parsed.workflowId,
    parsed.commit,
    parsed.triggerId,
  ]);
};
const deliveryIdentitySchema = z.strictObject({
  host: identity,
  tenant: identity,
  bindingId: identity,
  eventId: identity,
});
const deliveryInputSchema = z.strictObject({
  scope: triggerRunScopeSchema,
  delivery: deliveryIdentitySchema,
  cargo: z.json(),
  limits: z.strictObject({
    hostConcurrency: z.number().int().positive().max(20),
    bindingConcurrency: z.number().int().positive().max(20),
  }),
});
const deliveryOwnerSchema = deliveryIdentitySchema.pick({
  host: true,
  tenant: true,
});
const pendingDeliverySchema = rowSchema.and(
  z.object({
    scope: z.string(),
    delivery_record: z.string().nullable(),
  }),
);
const DAY = 24 * 60 * 60 * 1000;

/** The enclosing Team owner supplies SQLite; callers never select the Team. */
export function createTriggerRunReservations(
  options: Pick<WatchdogSqliteOwner, "sql" | "transactionSync"> & {
    now?: () => number;
  },
) {
  const { sql } = options;
  const now = options.now ?? Date.now;
  sql.exec(`CREATE TABLE IF NOT EXISTS hub_trigger_run_reservations (
    reservation_id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL,
    run_id TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','released','terminal')),
    delivery_key TEXT, delivery_record TEXT, delivery_expires_at INTEGER,
    delivery_host TEXT, delivery_tenant TEXT, delivery_binding TEXT,
    delivery_pending INTEGER NOT NULL DEFAULT 0 CHECK(delivery_pending IN (0,1)),
    UNIQUE(scope,request_id)
  ) STRICT`);
  sql.exec(`CREATE INDEX IF NOT EXISTS hub_trigger_delivery_identity
    ON hub_trigger_run_reservations(delivery_key,delivery_expires_at)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS hub_trigger_delivery_expiry
    ON hub_trigger_run_reservations(delivery_expires_at)`);
  const expireDeliveries = () => {
    const at = now();
    // An expired unstarted intent cannot wake forever. A recorded active run
    // still owns its concurrency slot even after delivery deduplication expires.
    sql.exec(
      "UPDATE hub_trigger_run_reservations SET status='terminal',delivery_pending=0 WHERE reservation_id IN (SELECT reservation_id FROM hub_trigger_run_reservations WHERE delivery_expires_at<=? AND run_id IS NULL LIMIT 100)",
      at,
    );
    sql.exec(
      "DELETE FROM hub_trigger_run_reservations WHERE reservation_id IN (SELECT reservation_id FROM hub_trigger_run_reservations WHERE delivery_expires_at<=? AND status!='active' AND delivery_pending=0 LIMIT 100)",
      at,
    );
    sql.exec(
      "UPDATE hub_trigger_run_reservations SET delivery_key=NULL,delivery_record=NULL,delivery_expires_at=NULL WHERE reservation_id IN (SELECT reservation_id FROM hub_trigger_run_reservations WHERE delivery_expires_at<=? AND run_id IS NOT NULL LIMIT 100)",
      at,
    );
    sql.exec(
      "DELETE FROM hub_trigger_run_reservations WHERE reservation_id IN (SELECT reservation_id FROM hub_trigger_run_reservations WHERE delivery_host IS NOT NULL AND delivery_expires_at IS NULL AND status!='active' AND delivery_pending=0 LIMIT 100)",
    );
  };
  return {
    /** Opaque verified cargo and delivery identity live with the run reservation. */
    reserveWebhookDelivery(raw: z.input<typeof deliveryInputSchema>):
      | {
          kind: "reserved" | "replay";
          reservationId: string;
          runId: string | null;
        }
      | { kind: "refused"; reason: "limit" } {
      const input = deliveryInputSchema.parse(raw);
      const key = JSON.stringify(input.delivery);
      return options.transactionSync(() => {
        expireDeliveries();
        const prior = sql
          .exec(
            "SELECT reservation_id,run_id,status FROM hub_trigger_run_reservations WHERE delivery_key=? AND delivery_expires_at>? ORDER BY delivery_expires_at DESC LIMIT 1",
            key,
            now(),
          )
          .toArray()[0];
        if (prior !== undefined) {
          const row = rowSchema.parse(prior);
          return {
            kind: "replay",
            reservationId: row.reservation_id,
            runId: row.run_id,
          };
        }
        const active = z
          .object({
            count: z.number(),
            binding_count: z.number(),
          })
          .parse(
            sql
              .exec(
                "SELECT count(*) AS count,coalesce(sum(delivery_host=? AND delivery_tenant=? AND delivery_binding=?),0) AS binding_count FROM hub_trigger_run_reservations WHERE status='active'",
                input.delivery.host,
                input.delivery.tenant,
                input.delivery.bindingId,
              )
              .toArray()[0],
          );
        if (
          active.count >= input.limits.hostConcurrency ||
          active.binding_count >= input.limits.bindingConcurrency
        )
          return { kind: "refused", reason: "limit" };
        const reservationId = reservationIds.reservation.generate();
        sql.exec(
          "INSERT INTO hub_trigger_run_reservations(reservation_id,scope,request_id,run_id,status,delivery_key,delivery_record,delivery_expires_at,delivery_pending,delivery_host,delivery_tenant,delivery_binding) VALUES(?,?,?,NULL,'active',?,?,?,1,?,?,?)",
          reservationId,
          scopeKey(input.scope),
          reservationId,
          key,
          JSON.stringify(input),
          now() + DAY,
          input.delivery.host,
          input.delivery.tenant,
          input.delivery.bindingId,
        );
        return { kind: "reserved", reservationId, runId: null };
      });
    },
    /** Bounded restart/lost-launch-reply recovery over the SAME reservations. */
    pendingWebhookDeliveries(rawOwner: z.input<typeof deliveryOwnerSchema>) {
      const owner = deliveryOwnerSchema.parse(rawOwner);
      return options.transactionSync(() => {
        expireDeliveries();
        return sql
          .exec(
            "SELECT reservation_id,run_id,status,scope,delivery_record FROM hub_trigger_run_reservations WHERE delivery_host=? AND delivery_tenant=? AND delivery_pending=1 ORDER BY delivery_expires_at LIMIT 32",
            owner.host,
            owner.tenant,
          )
          .toArray()
          .map((raw) => {
            const row = pendingDeliverySchema.parse(raw);
            if (row.run_id !== null)
              return {
                kind: "launch" as const,
                reservationId: row.reservation_id,
                runId: row.run_id,
              };
            const record = deliveryInputSchema.parse(
              JSON.parse(z.string().parse(row.delivery_record)),
            );
            return {
              kind: "start" as const,
              reservationId: row.reservation_id,
              ...record,
            };
          });
      });
    },
    /** Native alarms share this deadline with schedules, including idle TTL cleanup. */
    nextWebhookWake(
      rawOwner: z.input<typeof deliveryOwnerSchema>,
    ): number | null {
      const owner = deliveryOwnerSchema.parse(rawOwner);
      return options.transactionSync(() => {
        expireDeliveries();
        const row = z
          .object({
            pending: z.number(),
            expiry: z.number().nullable(),
          })
          .parse(
            sql
              .exec(
                "SELECT coalesce(max(delivery_pending),0) AS pending,min(delivery_expires_at) AS expiry FROM hub_trigger_run_reservations WHERE delivery_host=? AND delivery_tenant=?",
                owner.host,
                owner.tenant,
              )
              .toArray()[0],
          );
        return row.pending === 1 ? now() + 1000 : row.expiry;
      });
    },
    completeWebhookDelivery(rawReservationId: string): void {
      const reservationId = identity.parse(rawReservationId);
      sql.exec(
        "UPDATE hub_trigger_run_reservations SET delivery_pending=0,delivery_record=NULL,status=CASE WHEN run_id IS NULL THEN 'terminal' ELSE status END WHERE reservation_id=? AND delivery_pending=1",
        reservationId,
      );
    },
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

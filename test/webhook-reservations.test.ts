import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it } from "vitest";
import { createTriggerRunReservations } from "../src/runtime/trigger-run-reservations.js";

it("retains a webhook identity for an actual 24 hours across restart while preserving active-run accounting", () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  let now = 86_399_000;
  const open = () =>
    createTriggerRunReservations({ ...storage, now: () => now });
  const scope = {
    installationId: "trellis",
    workflowId: "hook",
    commit: "a".repeat(40),
    triggerId: "hook",
  };
  const delivery = {
    host: "oyster",
    tenant: "owner",
    bindingId: "binding",
    eventId: "delivery",
  };
  const input = {
    scope,
    delivery,
    cargo: { n: 1 },
    limits: { hostConcurrency: 20, bindingConcurrency: 20 },
  };
  const owner = { host: delivery.host, tenant: delivery.tenant };
  try {
    const first = open().reserveWebhookDelivery(input);
    if (first.kind === "refused") throw new Error("First admission refused");
    expect(open().bindTriggerRun(first.reservationId, "run-first")).toBe(
      "bound",
    );
    now += 86_400_000 - 1;
    expect(open().reserveWebhookDelivery(input)).toEqual({
      ...first,
      kind: "replay",
      runId: "run-first",
    });
    expect(open().pendingWebhookDeliveries(owner)[0]).toMatchObject({
      kind: "launch",
      reservationId: first.reservationId,
      runId: "run-first",
    });
    now++;
    const next = open().reserveWebhookDelivery(input);
    expect(next.kind).toBe("reserved");
    if (next.kind === "refused")
      throw new Error("New retention period refused");
    expect(next.reservationId).not.toBe(first.reservationId);
    expect(open().countActiveTriggerRuns(scope)).toBe(2);
    open().completeWebhookDelivery(first.reservationId);
    expect(
      open()
        .pendingWebhookDeliveries(owner)
        .map((row) => row.reservationId),
    ).toEqual([next.reservationId]);
    expect(
      database
        .prepare(
          "SELECT delivery_record FROM hub_trigger_run_reservations WHERE reservation_id=?",
        )
        .get(first.reservationId),
    ).toMatchObject({ delivery_record: null });
  } finally {
    database.close();
  }
});

it("deduplicates before concurrency admission, scopes identities, and expires unstarted cargo without a second store", () => {
  const database = new DatabaseSync(":memory:");
  const storage = fromNodeSqlite(database);
  let now = 1000;
  const open = () =>
    createTriggerRunReservations({ ...storage, now: () => now });
  const input = {
    scope: {
      installationId: "trellis",
      workflowId: "hook",
      commit: "a".repeat(40),
      triggerId: "hook",
    },
    delivery: {
      host: "oyster",
      tenant: "one",
      bindingId: "binding",
      eventId: "event",
    },
    cargo: { body: "retained verified intent" },
    limits: { hostConcurrency: 20, bindingConcurrency: 1 },
  };
  const owner = { host: "oyster", tenant: "one" };
  try {
    const first = open().reserveWebhookDelivery(input);
    expect(first.kind).toBe("reserved");
    expect(open().reserveWebhookDelivery(input)).toEqual({
      ...first,
      kind: "replay",
    });
    expect(
      open().reserveWebhookDelivery({
        ...input,
        delivery: { ...input.delivery, eventId: "other" },
      }),
    ).toEqual({ kind: "refused", reason: "limit" });
    for (const delivery of [
      { ...input.delivery, host: "hub" },
      { ...input.delivery, tenant: "two" },
      { ...input.delivery, bindingId: "other" },
    ])
      expect(open().reserveWebhookDelivery({ ...input, delivery }).kind).toBe(
        "reserved",
      );
    expect(open().pendingWebhookDeliveries(owner)).toHaveLength(2);
    expect(
      open().reserveWebhookDelivery({
        ...input,
        delivery: { ...input.delivery, bindingId: "third" },
        limits: { hostConcurrency: 4, bindingConcurrency: 1 },
      }),
    ).toEqual({ kind: "refused", reason: "limit" });
    expect(open().nextWebhookWake(owner)).toBe(now + 1000);
    now += 24 * 60 * 60 * 1000;
    expect(open().pendingWebhookDeliveries(owner)).toEqual([]);
    expect(open().nextWebhookWake(owner)).toBeNull();
    expect(open().countActiveTriggerRuns(input.scope)).toBe(0);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM hub_trigger_run_reservations")
        .get(),
    ).toMatchObject({ count: 0 });
  } finally {
    database.close();
  }
});

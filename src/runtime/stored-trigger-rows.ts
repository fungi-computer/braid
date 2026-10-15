import { z } from "zod";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";

const rowSchema = z.strictObject({ id: z.string(), record: z.string() });

/** Stored trigger rows decode strictly; an undecodable row is corruption. */
export function storedTriggerRows<Record extends z.ZodType>(
  sql: WatchdogSqliteOwner["sql"],
  table: Readonly<{
    table: "hub_workflow_schedules" | "hub_workflow_event_triggers";
    key: "scheduleId" | "id";
    record: Record;
  }>,
) {
  const select = `SELECT ${table.key} AS id, record FROM ${table.table}`;
  const decode = (raw: unknown): z.output<Record> =>
    table.record.parse(JSON.parse(rowSchema.parse(raw).record));
  return {
    all: () =>
      sql.exec(`${select} ORDER BY ${table.key}`).toArray().map(decode),
    read(id: string) {
      const row = sql.exec(`${select} WHERE ${table.key}=?`, id).toArray()[0];
      return row === undefined ? null : decode(row);
    },
    remove(id: string) {
      sql.exec(`DELETE FROM ${table.table} WHERE ${table.key}=?`, id);
    },
  };
}

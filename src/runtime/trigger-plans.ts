import { z } from "zod";
import * as S from "effect/Schema";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import {
  canonicalJson,
  executionPlanSchema,
  type ExecutionPlan,
} from "../index.js";
import {
  armedWorkflowTriggerSchema,
  type ArmedWorkflowTrigger,
} from "./trigger-owner.js";

const rowSchema = S.Struct({
  binding: S.String,
  plan: S.String,
  refusal: S.NullOr(S.String),
});

/** Immutable published plans survive Team owner recreation; only arm writes plans. */
export function createTriggerPlans(sql: WatchdogSqliteOwner["sql"]) {
  sql.exec(`CREATE TABLE IF NOT EXISTS hub_workflow_trigger_plans (
    binding TEXT PRIMARY KEY, installation_id TEXT NOT NULL,
    plan TEXT NOT NULL, refusal TEXT
  ) STRICT`);
  const key = (binding: ArmedWorkflowTrigger) =>
    canonicalJson(z.json().parse(armedWorkflowTriggerSchema.parse(binding)));
  const decode = (raw: unknown) => {
    const row = S.decodeUnknownSync(rowSchema)(raw);
    return {
      binding: armedWorkflowTriggerSchema.parse(JSON.parse(row.binding)),
      plan: S.decodeUnknownSync(executionPlanSchema)(JSON.parse(row.plan), {
        onExcessProperty: "error",
      }),
      refusal: row.refusal,
    };
  };
  return {
    put(binding: ArmedWorkflowTrigger, plan: ExecutionPlan) {
      sql.exec(
        "INSERT INTO hub_workflow_trigger_plans(binding,installation_id,plan,refusal) VALUES(?,?,?,NULL) ON CONFLICT(binding) DO UPDATE SET plan=excluded.plan,refusal=NULL",
        key(binding),
        binding.installationId,
        JSON.stringify(S.decodeUnknownSync(executionPlanSchema)(plan)),
      );
    },
    read(binding: ArmedWorkflowTrigger) {
      const row = sql
        .exec(
          "SELECT binding,plan,refusal FROM hub_workflow_trigger_plans WHERE binding=?",
          key(binding),
        )
        .toArray()[0];
      return row === undefined ? null : decode(row);
    },
    refusal(binding: ArmedWorkflowTrigger): string | null {
      const row = sql
        .exec(
          "SELECT refusal FROM hub_workflow_trigger_plans WHERE binding=?",
          key(binding),
        )
        .toArray()[0];
      return row === undefined
        ? "Compiled Workflow unavailable; re-arm required"
        : S.decodeUnknownSync(S.Struct({ refusal: S.NullOr(S.String) }))(row)
            .refusal;
    },
    installation(installationId: string) {
      return sql
        .exec(
          "SELECT binding,plan,refusal FROM hub_workflow_trigger_plans WHERE installation_id=?",
          installationId,
        )
        .toArray()
        .map(decode);
    },
    refuse(binding: ArmedWorkflowTrigger, reason: string) {
      sql.exec(
        "UPDATE hub_workflow_trigger_plans SET refusal=? WHERE binding=?",
        reason,
        key(binding),
      );
    },
    remove(binding: ArmedWorkflowTrigger) {
      sql.exec(
        "DELETE FROM hub_workflow_trigger_plans WHERE binding=?",
        key(binding),
      );
    },
    invalidateInstallation(installationId: string) {
      sql.exec(
        "DELETE FROM hub_workflow_trigger_plans WHERE installation_id=?",
        installationId,
      );
    },
  };
}

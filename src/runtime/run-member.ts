import * as S from "effect/Schema";
import * as Result from "effect/Result";
import type { WorkflowRunMember } from "./run-authority.js";

const memberSchema = S.Struct({
  membershipVersion: S.Number.pipe(
    S.check(S.isInt()),
    S.check(S.isGreaterThanOrEqualTo(0)),
  ),
});

/** The existing strict member readback, shared by run and arming authority. */
export function decodeWorkflowRunMember(
  value: unknown,
): WorkflowRunMember | null {
  const decoded = S.decodeUnknownResult(memberSchema, {
    onExcessProperty: "error",
  })(value);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

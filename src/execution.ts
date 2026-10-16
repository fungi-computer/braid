import * as S from "effect/Schema";
import { resultRowSchemaV1 } from "@fungi.computer/gills";
import type { ExecutionPlan, Json, Method } from "./schema.js";
const id = S.String.pipe(
  S.check(S.isMinLength(1)),
  S.check(S.isMaxLength(256)),
);
const natural = S.Number.pipe(
  S.check(S.isInt()),
  S.check(S.isGreaterThanOrEqualTo(0)),
);
/**
 * One loop a step runs inside: which Map item or Repeat round this pass is,
 * counted from 0, of how many. The runtime knows both while it executes; the
 * iteration id is a digest and says neither.
 */
export const loopPlaceSchema = S.Struct({
  node: id,
  loop: S.Literals(["map", "repeat"]),
  index: natural,
  count: natural,
});
export type LoopPlace = typeof loopPlaceSchema.Type;
/** Outermost loop first. Nesting needs one loop node per level, so the 64-node graph bound holds. */
export const loopPositionSchema = S.Array(loopPlaceSchema).check(
  S.isMaxLength(64),
);
export type LoopPosition = typeof loopPositionSchema.Type;
export const graphParamsSchema = S.Union([
  S.Struct({ kind: S.Literal("run"), teamId: id, runId: id, planDigest: id }),
  S.Struct({
    kind: S.Literal("map-item"),
    teamId: id,
    runId: id,
    planDigest: id,
    body: id,
    iteration: id,
    parentInstanceId: id,
    completionEvent: id,
    input: S.JsonObject,
    position: loopPositionSchema,
  }),
]);
export type GraphParams = typeof graphParamsSchema.Type;
export const nodeEventSchema = S.Struct({
  runId: id,
  graphId: S.optionalKey(id),
  nodeId: id,
  iteration: id,
  /** The loops around this step; absent at the top of the run. */
  position: S.optionalKey(loopPositionSchema),
  poll: S.optionalKey(natural),
  state: S.Literals([
    "queued",
    "running",
    "waiting",
    "complete",
    "failed",
    "skipped",
  ]),
  attempt: natural,
  /** Time the host durably recorded this lifecycle fact. */
  recordedAt: S.optionalKey(natural),
  durationMs: S.optionalKey(natural),
  costMilliunits: S.optionalKey(natural),
  outputDigest: S.optionalKey(id),
  output: S.optionalKey(S.JsonObject),
  /** How the finished App call reads to a person; absent when the App declares no presentation. */
  row: S.optionalKey(resultRowSchemaV1),
  errorMessage: S.optionalKey(S.String.check(S.isMaxLength(1024))),
  refusal: S.optionalKey(id),
});
export type NodeEvent = typeof nodeEventSchema.Type;
export const graphReviewSchema = S.Struct({
  runId: id,
  nodeId: id,
  iteration: id,
  /** The loops around this review; absent at the top of the run. */
  position: S.optionalKey(loopPositionSchema),
  instanceId: id,
  eventType: id,
  title: S.String,
  reviewers: S.Literals(["runner", "owners"]),
  timeout: natural,
  show: S.Array(S.Json),
  /** The review's named choices; absent for an approve/reject review. */
  choices: S.optionalKey(S.Array(id)),
});
export type GraphReview = typeof graphReviewSchema.Type;
/** Approve or reject a plain review, or pick one of a review's named choices. */
export const reviewAnswerSchema = S.Union([
  S.Struct({ approved: S.Boolean }),
  S.Struct({
    choice: id,
    note: S.optionalKey(S.String.check(S.isMaxLength(1000))),
  }),
]);
/** Project one decoded review answer into the review node's output ports. */
export function reviewAnswerOutput(
  answer: typeof reviewAnswerSchema.Type,
  item: Json,
) {
  const choice =
    "choice" in answer
      ? answer.choice
      : answer.approved
        ? "approved"
        : "rejected";
  return {
    [choice]: item,
    choice,
    note: "choice" in answer ? (answer.note ?? "") : "",
  };
}
const refusalCodes = [
  "not_granted",
  "invalid_input",
  "invalid_output",
  "revoked",
  "member_revoked",
  "workflow_run_revoked",
  "computer_revoked",
  "budget_exhausted",
  "unknown_method",
] as const;
export const dispatchResultSchema = S.Union([
  S.Struct({
    kind: S.Literal("complete"),
    output: S.Json,
    costMilliunits: natural,
    row: S.optionalKey(resultRowSchemaV1),
  }),
  S.Struct({ kind: S.Literal("refused"), code: S.Literals(refusalCodes) }),
  S.Struct({ kind: S.Literal("pending_approval"), actionId: id }),
  /**
   * The App accepted the work and it is still running. The engine calls the
   * same method again with the same idempotency key after `retryAfterMs`.
   */
  S.Struct({
    kind: S.Literal("pending"),
    retryAfterMs: S.Number.pipe(
      S.check(S.isInt()),
      S.check(S.isBetween({ minimum: 1_000, maximum: 60_000 })),
    ),
  }),
]);
export type DispatchResult = typeof dispatchResultSchema.Type;
/** Live admission before any node kind; refusals use the engine's sole vocabulary. */
export const nodeAdmissionResultSchema = S.Union([
  S.Struct({ kind: S.Literal("admitted") }),
  S.Struct({ kind: S.Literal("refused"), code: S.Literals(refusalCodes) }),
]);
export type NodeAdmissionResult = typeof nodeAdmissionResultSchema.Type;

export type NodeCall = {
  readonly teamId: string;
  readonly runId: string;
  readonly graphId?: string;
  readonly nodeId: string;
  readonly iteration: string;
  readonly poll?: number;
  readonly installationId: string;
  readonly method: string;
  readonly methodSpec: Method;
  readonly input: Json;
  readonly idempotencyKey: string;
};
/** Host ports: load an admitted plan, invoke Apps, and persist execution facts. */
export type NodeDispatcher = {
  loadRun(
    teamId: string,
    runId: string,
  ): Promise<{
    readonly plan: ExecutionPlan;
    readonly input: Readonly<Record<string, Json>>;
  }>;
  /** Recheck the run's member and live library grant before the node executes. */
  beforeNode(event: NodeEvent): Promise<NodeAdmissionResult>;
  dispatch(call: NodeCall): Promise<DispatchResult>;
  recordEvent(event: NodeEvent): Promise<void>;
  /** Persist once and return the owner-held expiration, unchanged on replay. */
  openReview(review: GraphReview): Promise<number>;
};

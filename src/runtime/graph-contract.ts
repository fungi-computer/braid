import { nodeGitAccessListSchema, runCeilingSchema } from "./run-ceiling.js";
import {
  hostActorSchema,
  type HostActor,
} from "@fungi.computer/puffball/app-method-runtime";
import * as S from "effect/Schema";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  resolvedGitAccessSchema,
  triggerRepositorySchema,
  type ResolvedGitAccess,
} from "../git-access.js";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import { workflowIdSchema } from "../workflow-id.js";
import { executionPlanSchema } from "../index.js";
const id = S.String.pipe(
  S.check(S.isMinLength(1)),
  S.check(S.isMaxLength(256)),
);
const natural = S.Number.pipe(
  S.check(S.isInt()),
  S.check(S.isGreaterThanOrEqualTo(0)),
);
const resolvedGitAccess = S.declare(
  (value): value is ResolvedGitAccess =>
    resolvedGitAccessSchema.safeParse(value).success,
);
/** Provenance supplied only by the admitted published-Workflow trigger owner. */
export const graphTriggerProvenanceSchema = S.Struct({
  libraryInstallationId: id,
  workflowId: S.declare(
    (value): value is string => workflowIdSchema.safeParse(value).success,
  ),
  commit: S.declare(
    (value): value is string => gitSha1Schema.safeParse(value).success,
  ),
  triggerId: id,
  armedBy: id,
  nodeGitAccess: S.optionalKey(nodeGitAccessListSchema),
  /** The firing event's repository, resolving `$trigger.repository`. */
  repository: S.optionalKey(
    S.declare(
      (value): value is string =>
        triggerRepositorySchema.safeParse(value).success,
    ),
  ),
});
export type GraphTriggerProvenance = typeof graphTriggerProvenanceSchema.Type;
const graphPublicationSchema = S.Struct({
  installationId: id,
  workflowId: graphTriggerProvenanceSchema.fields.workflowId,
  commit: graphTriggerProvenanceSchema.fields.commit,
  digest: S.declare((value): value is string =>
    S.is(sha256DigestSchema)(value),
  ),
  armedBy: S.declare(
    (value): value is HostActor => hostActorSchema.safeParse(value).success,
  ),
});
export type GraphPublication = typeof graphPublicationSchema.Type;
/**
 * The run's declared delivery: the Agent Session that receives its ending,
 * whoever started it. Declared at start or arming, never by a node.
 */
export const workflowRunDeliverySchema = S.Struct({
  agentId: id,
  sessionId: id,
});
export type WorkflowRunDelivery = typeof workflowRunDeliverySchema.Type;
/** The member who started or armed the run, or the Agent Session that did. */
export const workflowMemberInitiatorSchema = S.Struct({
  kind: S.Literal("member"),
  memberId: id,
});
export type WorkflowMemberInitiator = typeof workflowMemberInitiatorSchema.Type;
/** Trusted acquisition identity, never Workflow arguments or an Agent creator. */
export const workflowAgentInitiatorSchema = S.Struct({
  kind: S.Literal("agent"),
  agentId: id,
  sessionId: id,
  grantorMemberId: id,
});
export type WorkflowAgentInitiator = typeof workflowAgentInitiatorSchema.Type;
/** A key never becomes a principal of its own; the run always acts as its grantor. */
export const workflowKeyInitiatorSchema = S.Struct({
  kind: S.Literal("key"),
  keyId: id,
  grantorMemberId: id,
});
export type WorkflowKeyInitiator = typeof workflowKeyInitiatorSchema.Type;
export const workflowRunInitiatorSchema = S.Union([
  workflowMemberInitiatorSchema,
  workflowAgentInitiatorSchema,
  workflowKeyInitiatorSchema,
]);
export type WorkflowRunInitiator = typeof workflowRunInitiatorSchema.Type;
/** The Agent Session stays host-side; a listing names only the Agent/key and its grantor. */
export function wireRunInitiator(
  initiatedBy: WorkflowRunInitiator,
):
  | Readonly<{ kind: "member"; memberId: string }>
  | Readonly<{ kind: "agent"; agentId: string; grantorMemberId: string }>
  | Readonly<{ kind: "key"; keyId: string; grantorMemberId: string }> {
  if (initiatedBy.kind === "member") return initiatedBy;
  if (initiatedBy.kind === "agent")
    return {
      kind: "agent",
      agentId: initiatedBy.agentId,
      grantorMemberId: initiatedBy.grantorMemberId,
    };
  return {
    kind: "key",
    keyId: initiatedBy.keyId,
    grantorMemberId: initiatedBy.grantorMemberId,
  };
}
export const workflowRunSourceValues = [
  "manual",
  "schedule",
  "event",
  "agent",
  "key",
] as const;
export const workflowRunSourceSchema = S.Literals(workflowRunSourceValues);
export type WorkflowRunSource = typeof workflowRunSourceSchema.Type;
export const graphRunSchema = S.Struct({
  teamId: id,
  runId: id,
  requestId: id,
  actorId: id,
  /** Host-bound library for raw as well as published App starts; never guest input. */
  libraryInstallationId: S.optionalKey(id),
  /** The Computer the starting member pinned; `computer.*` work runs only there. */
  computerId: S.NullOr(id),
  plan: executionPlanSchema,
  input: S.JsonObject,
  ceiling: runCeilingSchema,
  trigger: S.optionalKey(graphTriggerProvenanceSchema),
  publication: S.optionalKey(graphPublicationSchema),
  delivery: S.optionalKey(workflowRunDeliverySchema),
  /** Recorded once, from the admitted preparation; never recomputed later. */
  source: workflowRunSourceSchema,
  initiatedBy: workflowRunInitiatorSchema,
});
export type GraphRun = typeof graphRunSchema.Type;
/** Host-owned identity of one App node execution within a graph run. */
export const graphNodeContextSchema = S.Struct({
  runId: id,
  graphId: S.optionalKey(id),
  nodeId: id,
  iteration: id,
  /** Pending-call poll identity, separate from retries of the same poll. */
  poll: S.optionalKey(natural),
  /** Opaque engine retry identity, never parsed as authority. */
  idempotencyKey: S.String,
  trigger: S.optionalKey(graphTriggerProvenanceSchema),
  gitAccess: S.optionalKey(resolvedGitAccess),
});
/** Execution coordinates alone do not attest a published Workflow. */
export type GraphNodeContext = typeof graphNodeContextSchema.Type;
/** Publication attribution from an admitted publisher App or trigger owner. */
export const workflowRunContextSchema = S.Struct({
  ...graphNodeContextSchema.fields,
  workflowId: graphPublicationSchema.fields.workflowId,
  armedBy: graphPublicationSchema.fields.armedBy,
});
export type WorkflowRunContext = typeof workflowRunContextSchema.Type;

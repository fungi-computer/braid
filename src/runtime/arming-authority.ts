import * as z from "zod";
import type { WorkflowRunMember } from "./run-authority.js";
import { decodeWorkflowRunMember } from "./run-member.js";

const identity = z.string().min(1).max(256);
const membershipVersion = z.lazy(() => z.number().int().nonnegative());
const connector = z.strictObject({
  kind: z.literal("connector"),
  agentId: identity,
  attachmentId: identity,
  attachmentVersion: z.number().int().positive(),
});
const policy = z.strictObject({
  kind: z.literal("policy"),
  agentId: identity,
  // The approved policy revision is opaque, nonempty and bounded.
  policyRevision: identity,
  grantorMemberId: identity,
});

/** Host-captured provenance from the actual connector or approved-policy owner. */
export const workflowArmedViaSchema = z.discriminatedUnion("kind", [
  connector,
  policy,
]);
/** Provenance from the actual connector or approved-policy owner. */
export type WorkflowArmedVia = z.output<typeof workflowArmedViaSchema>;

/** The grantor stays the armer; decoding this shape alone grants no authority. */
export const workflowArmingReceiptSchema = z.lazy(() =>
  z
    .strictObject({
      armedBy: identity,
      /** A human arm has an explicit null; Agent arms retain their actual live source. */
      armedVia: workflowArmedViaSchema.nullable(),
      grantorMembershipVersion: membershipVersion,
    })
    .superRefine((receipt, context) => {
      if (
        receipt.armedVia?.kind === "policy" &&
        receipt.armedVia.grantorMemberId !== receipt.armedBy
      )
        context.addIssue({
          code: "custom",
          path: ["armedVia", "grantorMemberId"],
          message: "The approved policy grantor must be the armer",
        });
    }),
);
/** Captured by a host after current frame, installation and member admission. */
export type WorkflowArmingReceipt = z.output<
  typeof workflowArmingReceiptSchema
>;

/** Current host-owner readback, after live grantor and approval checks. */
export const workflowArmingAccessSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    connector.extend({
      grantorMemberId: identity,
      level: z.enum(["read", "write"]),
    }),
    policy.extend({ level: z.enum(["read", "write"]) }),
  ]),
);
/** The actual source identity plus its currently approved access level. */
export type WorkflowArmingAccess = z.output<typeof workflowArmingAccessSchema>;

/** Lookup keys exclude captured versions, revisions and grantors. */
export type WorkflowArmingLookup =
  | Readonly<{ kind: "connector"; agentId: string; attachmentId: string }>
  | Readonly<{ kind: "policy"; agentId: string }>;

/** The host reader obtains approval, revision and grantor from its current owner row. */
export type WorkflowArmingAuthorityPorts = Readonly<{
  member(memberId: string): Promise<WorkflowRunMember | null>;
  readAgentAccess(
    lookup: WorkflowArmingLookup,
  ): Promise<WorkflowArmingAccess | null>;
}>;

/** Trusted result produced by the authority functions, never decoded from caller JSON. */
export type WorkflowArmingAdmission =
  | Readonly<{ kind: "admitted"; receipt: WorkflowArmingReceipt }>
  | Readonly<{ kind: "refused"; code: "not_granted" | "revoked" }>;

/** Recheck Agent authority only; the host also admits member, Computer and installation grants. */
export async function recheckWorkflowArming(
  receipt: WorkflowArmingReceipt,
  ports: WorkflowArmingAuthorityPorts,
): Promise<WorkflowArmingAdmission> {
  const captured = workflowArmingReceiptSchema.safeParse(receipt);
  if (!captured.success) return { kind: "refused", code: "not_granted" };
  const before = decodeWorkflowRunMember(
    await ports.member(captured.data.armedBy),
  );
  if (before?.membershipVersion !== captured.data.grantorMembershipVersion)
    return { kind: "refused", code: "revoked" };
  const via = captured.data.armedVia;
  if (via === null) return { kind: "admitted", receipt: captured.data };
  const lookup: WorkflowArmingLookup =
    via.kind === "connector"
      ? {
          kind: "connector",
          agentId: via.agentId,
          attachmentId: via.attachmentId,
        }
      : { kind: "policy", agentId: via.agentId };
  const current = workflowArmingAccessSchema.safeParse(
    await ports.readAgentAccess(lookup),
  );
  if (
    !current.success ||
    current.data.level !== "write" ||
    current.data.agentId !== via.agentId ||
    current.data.grantorMemberId !== captured.data.armedBy
  )
    return { kind: "refused", code: "revoked" };
  const unchanged =
    via.kind === "connector"
      ? current.data.kind === "connector" &&
        current.data.attachmentId === via.attachmentId &&
        current.data.attachmentVersion === via.attachmentVersion
      : current.data.kind === "policy" &&
        current.data.policyRevision === via.policyRevision;
  const after = decodeWorkflowRunMember(
    await ports.member(captured.data.armedBy),
  );
  return unchanged &&
    after?.membershipVersion === captured.data.grantorMembershipVersion
    ? { kind: "admitted", receipt: captured.data }
    : { kind: "refused", code: "revoked" };
}

/** Capture the version from the host's actual member owner, never a frame or tool argument. */
export async function captureWorkflowArming(
  source: Pick<WorkflowArmingReceipt, "armedBy" | "armedVia">,
  ports: WorkflowArmingAuthorityPorts,
): Promise<WorkflowArmingAdmission> {
  const current = decodeWorkflowRunMember(await ports.member(source.armedBy));
  if (current === null) return { kind: "refused", code: "not_granted" };
  return recheckWorkflowArming(
    { ...source, grantorMembershipVersion: current.membershipVersion },
    ports,
  );
}

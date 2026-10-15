import { z } from "zod";
import {
  bindingsSelectionSchema,
  gitAccessScope,
  resolveGitAccess,
} from "../git-access.js";
import * as S from "effect/Schema";
import {
  appIdSchema,
  releaseIdSchema,
  sha256DigestSchema,
} from "@fungi.computer/puffball/effect";
import { type GitBinding, type RepositoryRef } from "@fungi.computer/agar/git";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import { workflowIdSchema } from "../index.js";
import {
  canonicalJson,
  triggerRequestId,
  triggerRun,
  contentDigest,
  type TriggerEvent,
} from "../index.js";
import {
  nodeGitAccessListSchema,
  type NodeGitAccessList,
} from "./run-ceiling.js";
import { compileForMember } from "./graph-start.js";
import {
  workflowRunDeliverySchema,
  type WorkflowRunDelivery,
} from "./graph-contract.js";
import {
  captureWorkflowArming,
  recheckWorkflowArming,
  workflowArmedViaSchema,
  type WorkflowArmingAuthorityPorts,
  type WorkflowArmingReceipt,
} from "./arming-authority.js";
import type {
  PublishedDefinitionPort,
  WorkflowPublicationContext,
  WorkflowTriggerRunPorts,
  WorkflowErrorPort,
} from "./ports.js";

const id = z.string().min(1).max(256);
export const workflowTriggerTargetSchema = z.strictObject({
  installationId: id,
  workflowId: workflowIdSchema,
  commit: gitSha1Schema,
  digest: z.string().refine(S.is(sha256DigestSchema)),
  triggerId: z.string().min(1).max(80),
  bindings: bindingsSelectionSchema,
  /** Every run this trigger starts reports its ending to this Agent Session. */
  delivery: z
    .custom<WorkflowRunDelivery>(S.is(workflowRunDeliverySchema))
    .optional(),
});
/** The host frame's installation selection and verified artifact, pinned at arm time. */
export const workflowInstallationAuthoritySchema = z.strictObject({
  selection: z.strictObject({
    instanceId: id,
    owner: z.strictObject({
      kind: z.enum(["installation", "deployment"]),
      id,
    }),
    appId: z.string().refine(S.is(appIdSchema)),
    releaseId: z.string().refine(S.is(releaseIdSchema)),
    authorityVersion: z.number().int().positive(),
  }),
  artifactDigest: z.string().refine(S.is(sha256DigestSchema)),
});
export type WorkflowInstallationAuthority = z.infer<
  typeof workflowInstallationAuthoritySchema
>;
export const armedWorkflowTriggerSchema = workflowTriggerTargetSchema.extend({
  armedBy: id,
  /** Null for a member's own arm; an Agent arm retains its live source. */
  armedVia: workflowArmedViaSchema.nullable(),
  grantorMembershipVersion: z.number().int().nonnegative(),
  installationAuthority: workflowInstallationAuthoritySchema,
  computerId: id,
  nodeGitAccess: z
    .custom<NodeGitAccessList>(S.is(nodeGitAccessListSchema))
    .optional(),
});
export type WorkflowTriggerTarget = z.infer<typeof workflowTriggerTargetSchema>;
export type ArmedWorkflowTrigger = z.infer<typeof armedWorkflowTriggerSchema>;
/** Host-attested arming principal: the grantor member and, for an Agent, its live source. */
export type WorkflowArmer = Pick<WorkflowArmingReceipt, "armedBy" | "armedVia">;
/** Host-attested control principal for listing and disarming stored triggers. */
export type WorkflowTriggerPrincipal =
  | Readonly<{ kind: "member"; memberId: string }>
  | Readonly<{ kind: "agent"; agentId: string; grantorMemberId: string }>;

/** The member whose installation grant authorizes this principal's control. */
export const workflowTriggerPrincipalMember = (
  principal: WorkflowTriggerPrincipal,
) =>
  principal.kind === "member" ? principal.memberId : principal.grantorMemberId;

/** A member controls every decodable trigger; an Agent controls only its own arms. */
export const workflowTriggerControlledBy = (
  principal: WorkflowTriggerPrincipal,
  binding: Pick<ArmedWorkflowTrigger, "armedVia">,
) =>
  principal.kind === "member" ||
  binding.armedVia?.agentId === principal.agentId;

/** Separate arming principals keep separate stored triggers. */
export const workflowArmerKey = (armer: WorkflowArmer) => [
  armer.armedBy,
  armer.armedVia?.agentId ?? null,
];

const sameInstallationAuthority = (
  left: WorkflowInstallationAuthority,
  right: WorkflowInstallationAuthority,
) =>
  canonicalJson(z.json().parse(left)) === canonicalJson(z.json().parse(right));

/** Published provenance and current member authority shared by every trigger kind. */
export function createTeamWorkflowTriggers(options: {
  runs: WorkflowTriggerRunPorts;
  published: PublishedDefinitionPort<WorkflowPublicationContext>;
  errors: WorkflowErrorPort;
  /** Host-resolved installation GIT; rechecks membership and workflow.run on every call. */
  source: (
    memberId: string,
    installationId: string,
    computerId: string,
  ) => Promise<GitBinding>;
  /**
   * Live installation authority only (workflow.run, workflow.arm, Git and the
   * Computer); never opens Git or Artifact bytes. Returns the current pin.
   */
  admit: (
    memberId: string,
    installationId: string,
    computerId: string,
  ) => Promise<WorkflowInstallationAuthority>;
  /** The current Agent source owner; the member reader is the run owner's. */
  readAgentAccess: WorkflowArmingAuthorityPorts["readAgentAccess"];
  /** The member's current Team Git policy; this never mints a pass. */
  admitGitAccess: (
    memberId: string,
    repository: RepositoryRef,
    scope: "read" | "write",
  ) => Promise<void>;
  /** Idempotently ensure the recorded run has an engine instance, including on replay. */
  launch: (
    run: Readonly<{ runId: string; planDigest: string }>,
  ) => Promise<void>;
}) {
  const arming: WorkflowArmingAuthorityPorts = {
    async member(memberId) {
      try {
        // The run owner's reader may carry more membership facts; arming pins only the version.
        const { membershipVersion } = await options.runs.member(memberId);
        return { membershipVersion };
      } catch (cause) {
        if (cause instanceof Error && options.errors.isDenied(cause))
          return null;
        throw cause;
      }
    },
    readAgentAccess: options.readAgentAccess,
  };
  const pinRefusal = {
    kind: "refused" as const,
    reason: "The Workflows installation changed; re-arm this trigger",
  };

  async function arm(
    armer: WorkflowArmer,
    raw: WorkflowTriggerTarget,
    computerId: string,
    rawAuthority: WorkflowInstallationAuthority,
  ) {
    const target = workflowTriggerTargetSchema.parse(raw);
    const installationAuthority =
      workflowInstallationAuthoritySchema.parse(rawAuthority);
    const memberId = armer.armedBy;
    const captured = await captureWorkflowArming(armer, arming);
    if (captured.kind === "refused")
      return {
        kind: "refused" as const,
        reason: "The arming Agent or member is no longer authorized",
      };
    if (!(await options.runs.memberComputer(memberId, computerId)))
      throw options.errors.denied();
    if (
      target.delivery !== undefined &&
      !(await options.runs.admitDelivery(memberId, target.delivery))
    )
      return {
        kind: "refused" as const,
        reason: "The chat for this trigger's results is not available to you",
      };
    if (
      !sameInstallationAuthority(
        await options.admit(memberId, target.installationId, computerId),
        installationAuthority,
      )
    )
      return pinRefusal;
    const git = await options.source(
      memberId,
      target.installationId,
      computerId,
    );
    const entries = await options.runs.catalog(memberId);
    const published = await options.published.resolve(
      { memberId, installationId: target.installationId, computerId, git },
      { workflowId: target.workflowId, commit: target.commit },
    );
    if (published === null)
      return {
        kind: "refused" as const,
        reason: "Workflow commit is not published",
      };
    if (
      target.digest !==
      (await contentDigest(S.decodeUnknownSync(S.Json)(published.definition)))
    )
      return {
        kind: "refused" as const,
        reason: "Workflow publication changed; re-arm after publishing",
      };
    const compiled = await compileForMember(entries, {
      requestId: "trigger-admission",
      definition: published.definition,
      bindings: target.bindings,
      input: {},
    });
    if (compiled.kind === "invalid")
      return {
        kind: "refused" as const,
        reason: "Workflow is no longer valid for this member",
        issues: compiled.issues,
      };
    const trigger = published.definition.triggers?.find(
      (item) => item.id === target.triggerId,
    );
    if (trigger === undefined)
      return {
        kind: "refused" as const,
        reason: "Workflow does not declare this trigger",
      };
    const nodeGitAccess: NodeGitAccessList[number][] = [];
    const graphs = [
      { graphId: undefined, graph: compiled.plan.definition },
      ...Object.entries(compiled.plan.definition.subgraphs ?? {}).map(
        ([graphId, graph]) => ({ graphId, graph }),
      ),
    ];
    for (const { graphId, graph } of graphs) {
      for (const node of graph.nodes) {
        if (node.kind !== "app" || node.gitAccess === undefined) continue;
        const { repository } = node.gitAccess;
        if (repository === "$trigger.repository") {
          // Resolved per event at fire time, inside the event App's namespace.
          if (
            trigger.on !== "event" ||
            trigger.repository === undefined ||
            node.gitAccess.binding !== trigger.app
          )
            return {
              kind: "refused" as const,
              reason:
                "This trigger names no event repository for the Workflow's Git access",
            };
          continue;
        }
        const resolved = resolveGitAccess(
          compiled.plan.bindings,
          node.gitAccess,
        );
        if (resolved === null)
          return {
            kind: "refused" as const,
            reason: "Git repository binding is unavailable",
          };
        const scope = gitAccessScope(resolved);
        try {
          await options.admitGitAccess(memberId, resolved.repository, scope);
        } catch (cause) {
          if (cause instanceof Error && options.errors.isDenied(cause))
            return {
              kind: "refused" as const,
              reason: `You do not have Git ${scope} access to ${repository}`,
            };
          throw cause;
        }
        const entry = { nodeId: node.id, gitAccess: resolved };
        nodeGitAccess.push(
          graphId === undefined ? entry : { ...entry, graphId },
        );
      }
    }
    const binding = armedWorkflowTriggerSchema.parse({
      ...target,
      ...captured.receipt,
      installationAuthority,
      computerId,
    });
    if (nodeGitAccess.length > 0) binding.nodeGitAccess = nodeGitAccess;
    options.runs.triggerPlans.put(binding, compiled.plan);
    return {
      kind: "armed" as const,
      binding,
      trigger,
      definition: published.definition,
    };
  }

  return {
    arm,
    disarm: (binding: ArmedWorkflowTrigger) => {
      options.runs.triggerPlans.remove(binding);
    },
    refusal: (binding: ArmedWorkflowTrigger) =>
      options.runs.triggerPlans.refusal(binding),
    invalidateInstallation: (installationId: string) => {
      options.runs.triggerPlans.invalidateInstallation(installationId);
    },
    /** The single native push owner supplies host-issued Git, never a fire caller. */
    async revalidatePublished(installationId: string, git: GitBinding) {
      for (const { binding } of options.runs.triggerPlans.installation(
        installationId,
      )) {
        const published = await options.published.resolve(
          {
            memberId: binding.armedBy,
            installationId,
            computerId: binding.computerId,
            git,
          },
          { workflowId: binding.workflowId, commit: binding.commit },
        );
        if (published === null)
          options.runs.triggerPlans.refuse(
            binding,
            "commit no longer published",
          );
      }
    },
    async fire(raw: ArmedWorkflowTrigger, scope: string, event: TriggerEvent) {
      const binding = armedWorkflowTriggerSchema.parse(raw);
      try {
        const current = await options.admit(
          binding.armedBy,
          binding.installationId,
          binding.computerId,
        );
        if (!sameInstallationAuthority(current, binding.installationAuthority))
          return pinRefusal;
        const armedBy = await recheckWorkflowArming(
          {
            armedBy: binding.armedBy,
            armedVia: binding.armedVia,
            grantorMembershipVersion: binding.grantorMembershipVersion,
          },
          arming,
        );
        if (armedBy.kind === "refused")
          return {
            kind: "refused" as const,
            reason: "The arming Agent or member is no longer authorized",
          };
        const stored = options.runs.triggerPlans.read(binding);
        if (stored?.refusal !== null)
          return {
            kind: "refused" as const,
            reason:
              stored?.refusal ??
              "Compiled Workflow unavailable; re-arm required",
          };
        const mapped = triggerRun(
          stored.plan.definition,
          binding.triggerId,
          event,
        );
        if (mapped.kind === "ignored") return mapped;
        if (mapped.kind === "refused")
          return {
            kind: "refused" as const,
            reason:
              mapped.code === "invalid_repository"
                ? "Trigger event names no valid repository"
                : "Trigger event does not match the run input",
          };
        const request = {
          requestId: await triggerRequestId({
            scope,
            triggerId: binding.triggerId,
            eventId: event.eventId,
          }),
          input: mapped.input,
        };
        const result = await options.runs.startCachedGraph(
          binding,
          mapped.repository === undefined
            ? request
            : { ...request, triggerRepository: mapped.repository },
        );
        if (result.kind === "refused") return result;
        if (result.kind === "conflict")
          return {
            kind: "refused" as const,
            reason: "Workflow start was refused after current member admission",
          };
        await options.launch(result);
        return result;
      } catch (cause) {
        if (cause instanceof Error && options.errors.isDenied(cause))
          return {
            kind: "refused" as const,
            reason: "Arming member no longer has Workflow or Computer access",
          };
        throw cause;
      }
    },
  };
}

import type { NodeAdmissionResult } from "../execution.js";
import { decodeWorkflowRunMember } from "./run-member.js";
import type { ExecutionPlan } from "../index.js";
import type { HostActor } from "@fungi.computer/puffball/app-method-runtime";
import type { RunAuthority, WorkflowCatalogEntry } from "./ports.js";
import type { RunCeiling } from "./run-ceiling.js";
import { runCeilingSchema } from "./run-ceiling.js";
import * as S from "effect/Schema";
import * as Result from "effect/Result";
import type {
  GraphRun,
  WorkflowMemberInitiator,
  WorkflowAgentInitiator,
  WorkflowKeyInitiator,
} from "./graph-contract.js";

export type {
  WorkflowMemberInitiator,
  WorkflowAgentInitiator,
  WorkflowKeyInitiator,
};
/** Host-owned start context after publication resolution and compilation. */
export type WorkflowRunPreparation = Readonly<{
  plan: ExecutionPlan;
  computerId: string | null;
}> &
  (
    | Readonly<{
        initiatedBy: WorkflowMemberInitiator;
        source: "manual" | "schedule" | "event";
        libraryInstallationId?: string;
        /** The firing event's repository; only the trigger owner supplies it. */
        triggerRepository?: string;
      }>
    | Readonly<{
        initiatedBy: WorkflowAgentInitiator;
        source: "agent";
        libraryInstallationId: string;
      }>
    | Readonly<{
        initiatedBy: WorkflowKeyInitiator;
        source: "key";
        libraryInstallationId: string;
      }>
  );
export type WorkflowRunMember = Readonly<{ membershipVersion: number }>;
export type WorkflowRunAuthority = RunAuthority<
  WorkflowRunPreparation,
  RunCeiling
> &
  Readonly<{
    recheckRun(
      preparation: WorkflowRunPreparation,
    ): Promise<NodeAdmissionResult>;
    member(memberId: string): Promise<WorkflowRunMember>;
    memberComputer(memberId: string, computerId: string): Promise<boolean>;
    catalog(memberId: string): Promise<readonly WorkflowCatalogEntry[]>;
  }>;
/** Every check and capture is required; no role, creator or binding default grants access. */
export type WorkflowRunAuthorityPorts = Readonly<{
  member(memberId: string): Promise<WorkflowRunMember | null>;
  memberComputer(memberId: string, computerId: string): Promise<boolean>;
  catalog(memberId: string): Promise<readonly WorkflowCatalogEntry[]>;
  admitAgent(
    preparation: Extract<WorkflowRunPreparation, { source: "agent" }>,
  ): Promise<boolean>;
  /** Absent on a host that never admits key-sourced runs; never a default grant. */
  admitKey?(
    preparation: Extract<WorkflowRunPreparation, { source: "key" }>,
  ): Promise<boolean>;
  capture(
    preparation: WorkflowRunPreparation,
    actor: Extract<HostActor, { kind: "member" }>,
    member: WorkflowRunMember,
  ): Promise<RunCeiling | null>;
  denied(): Error;
}>;

/** Shared admission and capture ordering; hosts supply their real human and attachment checks. */
export function createWorkflowRunAuthority(
  ports: WorkflowRunAuthorityPorts,
): WorkflowRunAuthority {
  const readMember = async (id: string): Promise<WorkflowRunMember | null> =>
    decodeWorkflowRunMember(await ports.member(id));
  const member = async (id: string): Promise<WorkflowRunMember> => {
    const current = await readMember(id);
    if (current === null) throw ports.denied();
    return current;
  };
  const memberComputer = async (
    id: string,
    computerId: string,
  ): Promise<boolean> => {
    const admitted = await readMember(id);
    if (admitted === null) return false;
    const allowed = await ports.memberComputer(id, computerId);
    const current = await readMember(id);
    return allowed && current?.membershipVersion === admitted.membershipVersion;
  };
  const memberId = (preparation: WorkflowRunPreparation) =>
    preparation.initiatedBy.kind === "member"
      ? preparation.initiatedBy.memberId
      : preparation.initiatedBy.grantorMemberId;
  const admitKey = (
    preparation: Extract<WorkflowRunPreparation, { source: "key" }>,
  ): Promise<boolean> =>
    ports.admitKey ? ports.admitKey(preparation) : Promise.resolve(false);
  const stillAttached = async (
    preparation: WorkflowRunPreparation,
  ): Promise<boolean> => {
    if ((await readMember(memberId(preparation))) === null) return false;
    if (
      preparation.computerId !== null &&
      !(await memberComputer(memberId(preparation), preparation.computerId))
    )
      return false;
    if (preparation.source === "agent") return ports.admitAgent(preparation);
    if (preparation.source === "key") return admitKey(preparation);
    return true;
  };
  return {
    async recheckRun(preparation) {
      const id = memberId(preparation);
      const before = await readMember(id);
      if (before === null) return { kind: "refused", code: "member_revoked" };
      if (preparation.computerId !== null) {
        const allowed = await ports.memberComputer(id, preparation.computerId);
        const afterComputer = await readMember(id);
        if (afterComputer?.membershipVersion !== before.membershipVersion)
          return { kind: "refused", code: "member_revoked" };
        if (!allowed) return { kind: "refused", code: "computer_revoked" };
      }
      if (
        preparation.source === "agent" &&
        !(await ports.admitAgent(preparation))
      )
        return { kind: "refused", code: "revoked" };
      if (preparation.source === "key" && !(await admitKey(preparation)))
        return { kind: "refused", code: "revoked" };
      let runGranted = true;
      if (preparation.libraryInstallationId !== undefined) {
        const entries = await ports.catalog(id);
        runGranted = entries.some(
          (entry) =>
            entry.installationId === preparation.libraryInstallationId &&
            entry.workflowRunGranted === true,
        );
      }
      const after = await readMember(id);
      if (after?.membershipVersion !== before.membershipVersion)
        return { kind: "refused", code: "member_revoked" };
      return runGranted
        ? { kind: "admitted" }
        : { kind: "refused", code: "workflow_run_revoked" };
    },
    member,
    memberComputer,
    async catalog(id) {
      const admitted = await member(id);
      const entries = await ports.catalog(id);
      const current = await member(id);
      if (current.membershipVersion !== admitted.membershipVersion)
        throw ports.denied();
      return entries;
    },
    stillAttached,
    async resolve(preparation) {
      const admitted = await readMember(memberId(preparation));
      if (admitted === null) return { kind: "refused", code: "not_granted" };
      if (!(await stillAttached(preparation)))
        return { kind: "refused", code: "not_granted" };
      const actor = {
        kind: "member" as const,
        memberId: memberId(preparation),
      };
      const captured = await ports.capture(preparation, actor, admitted);
      const decoded = S.decodeUnknownResult(runCeilingSchema, {
        onExcessProperty: "error",
      })(captured);
      if (Result.isFailure(decoded))
        return { kind: "refused", code: "not_granted" };
      if (!(await stillAttached(preparation)))
        return { kind: "refused", code: "revoked" };
      const current = await readMember(actor.memberId);
      if (current?.membershipVersion !== admitted.membershipVersion)
        return { kind: "refused", code: "revoked" };
      return { kind: "admitted", actor, ceiling: decoded.success };
    },
  };
}

/**
 * Rebuild the preparation a stored run was admitted with, from its recorded
 * `source`/`initiatedBy`, for a later recheck. A run whose source and
 * initiator kind disagree is corrupt, not a recoverable shape.
 */
export function preparationFromRun(
  run: Pick<
    GraphRun,
    "source" | "initiatedBy" | "plan" | "computerId" | "teamId"
  >,
  libraryInstallationId: string | undefined,
): WorkflowRunPreparation {
  if (run.source === "agent") {
    if (run.initiatedBy.kind !== "agent")
      throw new Error("Workflow run source does not match its initiator");
    return {
      initiatedBy: run.initiatedBy,
      source: "agent",
      plan: run.plan,
      computerId: run.computerId,
      libraryInstallationId: libraryInstallationId ?? run.teamId,
    };
  }
  if (run.source === "key") {
    if (run.initiatedBy.kind !== "key")
      throw new Error("Workflow run source does not match its initiator");
    return {
      initiatedBy: run.initiatedBy,
      source: "key",
      plan: run.plan,
      computerId: run.computerId,
      libraryInstallationId: libraryInstallationId ?? run.teamId,
    };
  }
  if (run.initiatedBy.kind !== "member")
    throw new Error("Workflow run source does not match its initiator");
  const preparation: WorkflowRunPreparation = {
    initiatedBy: run.initiatedBy,
    source: run.source,
    plan: run.plan,
    computerId: run.computerId,
  };
  return libraryInstallationId === undefined
    ? preparation
    : { ...preparation, libraryInstallationId };
}

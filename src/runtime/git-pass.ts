import type { RepositoryRef } from "@fungi.computer/agar/git";
import {
  workflowGitPassResultSchema,
  type WorkflowGitPassResult,
} from "@fungi.computer/agar/computer-contracts";
import type { WorkflowRunContext } from "./graph-contract.js";
import type { StoredWorkflowNode } from "./graph-dispatch.js";
import { canonicalJson } from "../index.js";
import { gitAccessScope } from "../git-access.js";

import {
  workflowGitPassGrantSchema,
  type WorkflowGitPassGrant,
} from "./git-pass-contract.js";

/** Admitted stored-node identity; host resource admission remains outside the shared owner. */
export type WorkflowGitPassNode = Pick<
  StoredWorkflowNode,
  "installationId" | "appId" | "method" | "methodDigest" | "computerId"
> & { teamId: string; memberId: string; context: WorkflowRunContext };
export type WorkflowGitScope = WorkflowGitPassGrant["scope"];

/** Compose the sole stored-node admission and retained terminal cleanup owners. */
export function createWorkflowGitPasses(
  ports: Readonly<{
    /** The host preserves its own typed refusal vocabulary. */
    denied(): Error;
    admitNode(
      context: WorkflowRunContext,
      target: { installationId: string; method: string },
    ): WorkflowGitPassNode | null;
    admitMemberGitAccess(
      memberId: string,
      repository: RepositoryRef,
      scope: WorkflowGitScope,
    ): Promise<void>;
    open(
      computerId: string,
      grant: WorkflowGitPassGrant,
    ): Promise<WorkflowGitPassResult>;
    revoke(
      computerId: string,
      input: { teamId: string; runId: string },
    ): Promise<void>;
    pending(): { teamId: string; runId: string; computerId: string }[];
    acknowledge(runId: string): void;
    wake?(due: number | null): Promise<void>;
  }>,
) {
  const cleanupWake = () =>
    ports.pending().length === 0 ? null : Date.now() + 5000;
  return {
    cleanupWake,
    async openWorkflowPass(
      context: WorkflowRunContext,
      target: { installationId: string; method: string },
    ): Promise<WorkflowGitPassResult> {
      const admitted = ports.admitNode(context, target);
      if (
        admitted?.computerId == null ||
        admitted.context.gitAccess === undefined ||
        admitted.context.armedBy.kind !== "member" ||
        admitted.context.armedBy.memberId !== admitted.memberId
      )
        throw ports.denied();
      // The admitted node's own access decides the scope; no caller widens it.
      const scope = gitAccessScope(admitted.context.gitAccess);
      const grant = workflowGitPassGrantSchema.parse({
        teamId: admitted.teamId,
        computerId: admitted.computerId,
        memberId: admitted.memberId,
        workflow: {
          workflowId: admitted.context.workflowId,
          runId: admitted.context.runId,
          nodeId: admitted.context.nodeId,
          armedBy: admitted.context.armedBy,
        },
        runId: admitted.context.runId,
        graphId: admitted.context.graphId,
        nodeId: admitted.context.nodeId,
        iteration: admitted.context.iteration,
        scope,
        gitAccess: admitted.context.gitAccess,
        triggerId: admitted.context.trigger?.triggerId,
      });
      await ports.admitMemberGitAccess(
        grant.memberId,
        grant.gitAccess.repository,
        scope,
      );
      if (
        canonicalJson(ports.admitNode(context, target)) !==
        canonicalJson(admitted)
      )
        throw ports.denied();
      const pass = workflowGitPassResultSchema.parse(
        await ports.open(grant.computerId, grant),
      );
      try {
        await ports.admitMemberGitAccess(
          grant.memberId,
          grant.gitAccess.repository,
          scope,
        );
        if (
          canonicalJson(ports.admitNode(context, target)) !==
          canonicalJson(admitted)
        )
          throw ports.denied();
      } catch (cause) {
        await ports.revoke(grant.computerId, {
          teamId: grant.teamId,
          runId: grant.runId,
        });
        throw cause;
      }
      return pass;
    },
    async deliverCleanups(): Promise<void> {
      try {
        for (const cleanup of ports.pending()) {
          await ports.revoke(cleanup.computerId, {
            teamId: cleanup.teamId,
            runId: cleanup.runId,
          });
          ports.acknowledge(cleanup.runId);
        }
      } finally {
        await ports.wake?.(cleanupWake());
      }
    },
  };
}

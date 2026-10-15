import * as S from "effect/Schema";
import * as Option from "effect/Option";
import type { RepositoryRef } from "@fungi.computer/agar/git";
import type { HostActor } from "@fungi.computer/puffball/app-method-runtime";
import {
  appBackendBindingOperation,
  scopeOperationToMethod,
  appBackendBindingsSchema,
  appCapabilityIdSchema,
} from "@fungi.computer/puffball/app";
import type { Node } from "../index.js";
import { gitAccessScope, resolveGitAccess } from "../git-access.js";
import {
  resolveWorkflowNodeTarget,
  workflowNodeWithinCeiling,
  type WorkflowNodeTarget,
  type WorkflowNodeCeiling,
} from "./graph-dispatch.js";
import { runCeilingSchema, type RunCeiling } from "./run-ceiling.js";
import type {
  WorkflowRunAuthorityPorts,
  WorkflowRunMember,
} from "./run-authority.js";

/** Same Computer-bound requirements as live Workflow App admission. */
export function workflowMethodRequiresComputer(
  requires: RunCeiling["nodes"][number]["capabilities"],
): boolean {
  return requires.some(
    (capability) =>
      capability === "computer.list" ||
      capability === "computer.readFile" ||
      capability === "computer.writeFile" ||
      capability === "computer.execute" ||
      capability === "media.generation",
  );
}

/** Hosts provide their existing live human admission, never the compiled catalog as a grant. */
export type WorkflowCeilingCapturePorts = Readonly<{
  node(
    actor: Extract<HostActor, { kind: "member" }>,
    member: WorkflowRunMember,
    target: WorkflowNodeTarget,
  ): Promise<WorkflowNodeCeiling | null>;
  git(
    actor: Extract<HostActor, { kind: "member" }>,
    member: WorkflowRunMember,
    repository: RepositoryRef,
    scope: "read" | "write",
  ): Promise<boolean>;
}>;

/** Assemble the start ceiling from real host admissions; minting and invocation stay outside capture. */
export function createWorkflowCeilingCapture(
  ports: WorkflowCeilingCapturePorts,
): WorkflowRunAuthorityPorts["capture"] {
  return async (preparation, actor, member) => {
    const initiator = preparation.initiatedBy;
    const human =
      initiator.kind === "member"
        ? initiator.memberId
        : initiator.grantorMemberId;
    if (actor.memberId !== human) return null;
    const nodes: RunCeiling["nodes"][number][] = [];
    const nodeGitAccess: RunCeiling["nodeGitAccess"][number][] = [];
    const captureGraph = async (
      graphId: string | undefined,
      graphNodes: readonly Node[],
    ): Promise<boolean> => {
      for (const node of graphNodes) {
        if (node.kind !== "app") continue;
        const binding = preparation.plan.bindings[node.app];
        if (binding === undefined || !("installationId" in binding))
          return false;
        const coordinates =
          graphId === undefined
            ? { nodeId: node.id }
            : { nodeId: node.id, graphId };
        const resolved = resolveWorkflowNodeTarget(preparation, {
          ...coordinates,
          installationId: binding.installationId,
          method: node.method,
        });
        if (resolved === null) return false;
        const requires = S.decodeUnknownOption(S.Array(appCapabilityIdSchema))(
          resolved.method.requires,
        );
        if (Option.isNone(requires)) return false;
        if (
          preparation.computerId === null &&
          (workflowMethodRequiresComputer(requires.value) ||
            node.gitAccess !== undefined)
        )
          return false;
        const scopedMethod = {
          effect: resolved.method.effect,
          requires: requires.value,
        };
        const admitted = await ports.node(actor, member, resolved.target);
        if (
          admitted === null ||
          !workflowNodeWithinCeiling(resolved.method, admitted)
        )
          return false;
        const level =
          resolved.method.effect === "read" ? "read" : admitted.level;
        const bindings = S.decodeUnknownSync(appBackendBindingsSchema)(
          admitted.bindings
            .map((binding) => ({
              name: binding.name,
              operations: binding.operations.filter((name) => {
                const operation = appBackendBindingOperation(
                  binding.name,
                  name,
                );
                return (
                  operation !== undefined &&
                  scopeOperationToMethod(operation, scopedMethod, level)
                );
              }),
            }))
            .filter((binding) => binding.operations.length > 0),
        );
        nodes.push({
          ...coordinates,
          level,
          capabilities: admitted.capabilities.filter((capability) =>
            resolved.method.requires.includes(capability),
          ),
          bindings,
        });
        if (node.gitAccess !== undefined) {
          const gitAccess = resolveGitAccess(
            preparation.plan.bindings,
            node.gitAccess,
            "triggerRepository" in preparation
              ? preparation.triggerRepository
              : undefined,
          );
          // Read access never needs more than read, whatever the node's level.
          const scope =
            gitAccess === null || gitAccessScope(gitAccess) === "read"
              ? "read"
              : level;
          if (
            gitAccess === null ||
            !(await ports.git(actor, member, gitAccess.repository, scope))
          )
            return false;
          nodeGitAccess.push({ ...coordinates, gitAccess });
        }
      }
      return true;
    };
    if (!(await captureGraph(undefined, preparation.plan.definition.nodes)))
      return null;
    for (const [graphId, graph] of Object.entries(
      preparation.plan.definition.subgraphs ?? {},
    ))
      if (!(await captureGraph(graphId, graph.nodes))) return null;
    const decoded = S.decodeUnknownOption(runCeilingSchema)(
      { nodes, nodeGitAccess },
      { onExcessProperty: "error" },
    );
    return Option.isSome(decoded) ? decoded.value : null;
  };
}

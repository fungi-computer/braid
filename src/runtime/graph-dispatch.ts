import { appCapabilityIdSchema } from "@fungi.computer/puffball/app";
import { resolveGitAccess, resolvedGitAccessEqual } from "../git-access.js";
import type { WorkflowAppCall } from "./ports.js";
import type { GraphRun } from "./graph-contract.js";
import type { NodeCall, Node, Catalog } from "../index.js";
import type { RunCeiling } from "./run-ceiling.js";
import {
  workflowRunContextSchema,
  graphNodeContextSchema,
  type GraphNodeContext,
  type WorkflowRunContext,
} from "./graph-contract.js";
import * as S from "effect/Schema";
import * as Option from "effect/Option";

/**
 * Resolve an engine node call against the run's own frozen plan. The engine's
 * claims (installation, method) are accepted only when the plan bound exactly
 * that pair, and the App id and method digest come from the plan, never from
 * the call; the Computer is the one the run pinned at start. Null means the
 * call names something the plan never allowed.
 */
/** Canonical installed identity and context of a stored App node, without method input. */
export type StoredWorkflowNode = Omit<WorkflowAppCall, "input"> &
  (GraphNodeContext | WorkflowRunContext);

/** Identity comes only from the frozen compiled plan, never the engine's claimed digest. */
export type WorkflowNodeTarget = Pick<
  WorkflowAppCall,
  "installationId" | "appId" | "method" | "methodDigest" | "computerId"
>;
export type WorkflowNodeCeiling = Pick<
  RunCeiling["nodes"][number],
  "level" | "capabilities" | "bindings"
>;
export type ResolvedWorkflowNodeTarget = Readonly<{
  node: Extract<Node, { kind: "app" }>;
  method: Catalog[string]["methods"][string];
  target: WorkflowNodeTarget;
}>;

/** Capture and execution share the same immutable node/installation/method match. */
export function resolveWorkflowNodeTarget(
  run: Pick<GraphRun, "plan" | "computerId">,
  call: Pick<NodeCall, "graphId" | "nodeId" | "installationId" | "method">,
): ResolvedWorkflowNodeTarget | null {
  const { plan } = run;
  const graph =
    call.graphId === undefined
      ? plan.definition
      : plan.definition.subgraphs?.[call.graphId];
  const node = graph?.nodes.find((candidate) => {
    if (
      candidate.kind !== "app" ||
      candidate.id !== call.nodeId ||
      candidate.method !== call.method
    )
      return false;
    const binding = plan.bindings[candidate.app];
    return (
      binding !== undefined &&
      "installationId" in binding &&
      binding.installationId === call.installationId
    );
  });
  if (node?.kind !== "app") return null;
  const required = plan.requiredBindings.find(
    (binding) =>
      binding.app === node.app &&
      binding.installationId === call.installationId &&
      binding.method === call.method,
  );
  if (required === undefined) return null;
  const app = plan.definition.apps[required.app];
  const method =
    app === undefined
      ? undefined
      : plan.catalog[app.appId]?.methods[call.method];
  if (app === undefined || method === undefined) return null;
  return {
    node,
    method,
    target: {
      installationId: call.installationId,
      appId: app.appId,
      method: call.method,
      methodDigest: method.digest,
      computerId: run.computerId,
    },
  };
}

/** A captured node must cover every required capability and the method's effect. */
export function workflowNodeWithinCeiling(
  method: Pick<Catalog[string]["methods"][string], "requires" | "effect">,
  ceiling: WorkflowNodeCeiling,
): boolean {
  const requires = S.decodeUnknownOption(S.Array(appCapabilityIdSchema))(
    method.requires,
  );
  return (
    Option.isSome(requires) &&
    requires.value.every((capability) =>
      ceiling.capabilities.includes(capability),
    ) &&
    (method.effect === "read" || ceiling.level === "write")
  );
}

export function resolveWorkflowNode(
  run: Pick<
    GraphRun,
    "plan" | "computerId" | "runId" | "trigger" | "publication" | "ceiling"
  >,
  call: Pick<
    NodeCall,
    | "graphId"
    | "nodeId"
    | "iteration"
    | "poll"
    | "idempotencyKey"
    | "installationId"
    | "method"
  >,
): StoredWorkflowNode | null {
  const resolved = resolveWorkflowNodeTarget(run, call);
  if (resolved === null) return null;
  const { node, method, target } = resolved;
  const { plan } = run;
  const ceiling = run.ceiling.nodes.find(
    (candidate) =>
      candidate.graphId === call.graphId && candidate.nodeId === node.id,
  );
  if (ceiling === undefined || !workflowNodeWithinCeiling(method, ceiling))
    return null;
  let context: GraphNodeContext | WorkflowRunContext = {
    runId: run.runId,
    nodeId: call.nodeId,
    iteration: call.iteration,
    idempotencyKey: call.idempotencyKey,
  };
  if (run.publication !== undefined)
    context = {
      ...context,
      workflowId: run.publication.workflowId,
      armedBy: run.publication.armedBy,
    };
  if (run.trigger !== undefined) context = { ...context, trigger: run.trigger };
  if (call.graphId !== undefined)
    context = { ...context, graphId: call.graphId };
  if (call.poll !== undefined) context = { ...context, poll: call.poll };
  if (node.gitAccess !== undefined) {
    const scope = run.ceiling.nodeGitAccess.find(
      (candidate) =>
        candidate.graphId === call.graphId && candidate.nodeId === node.id,
    );
    const expected = resolveGitAccess(
      plan.bindings,
      node.gitAccess,
      run.trigger?.repository,
    );
    if (
      scope === undefined ||
      expected === null ||
      !resolvedGitAccessEqual(scope.gitAccess, expected)
    )
      return null;
    context = { ...context, gitAccess: scope.gitAccess };
  }
  return {
    ...("workflowId" in context
      ? S.decodeUnknownSync(workflowRunContextSchema)(context)
      : S.decodeUnknownSync(graphNodeContextSchema)(context)),
    ...target,
    bindingCeiling: ceiling.bindings,
  };
}

/** Resolve the stored node once, then project its admitted scope into method input. */
export function planNodeCall(
  run: Pick<
    GraphRun,
    "plan" | "computerId" | "runId" | "trigger" | "publication" | "ceiling"
  >,
  call: NodeCall,
): WorkflowAppCall | null {
  const resolved = resolveWorkflowNode(run, call);
  if (resolved === null) return null;
  let input = call.input;
  if (resolved.gitAccess !== undefined) {
    const object = S.decodeUnknownOption(S.JsonObject)(input);
    if (Option.isNone(object)) return null;
    input = { ...object.value, gitAccess: resolved.gitAccess };
  }
  return { ...resolved, input };
}

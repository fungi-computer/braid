import * as S from "effect/Schema";
import {
  appBackendBindingsSchema,
  appCapabilityIdSchema,
} from "@fungi.computer/puffball/app";
import {
  resolvedGitAccessSchema,
  type ResolvedGitAccess,
} from "../git-access.js";

const id = S.String.pipe(
  S.check(S.isMinLength(1)),
  S.check(S.isMaxLength(256)),
);
const resolvedGitAccess = S.declare(
  (value): value is ResolvedGitAccess =>
    resolvedGitAccessSchema.safeParse(value).success,
);
export const nodeGitAccessListSchema = S.Array(
  S.Struct({
    graphId: S.optionalKey(id),
    nodeId: id,
    gitAccess: resolvedGitAccess,
  }),
).pipe(S.check(S.isMaxLength(64)));
export type NodeGitAccessList = typeof nodeGitAccessListSchema.Type;

/** Captured host admission for one frozen App node, never a live host object or role. */
const nodeCeilingSchema = S.Struct({
  graphId: S.optionalKey(id),
  nodeId: id,
  level: S.Literals(["read", "write"]),
  capabilities: S.Array(appCapabilityIdSchema).pipe(S.check(S.isMaxLength(64))),
  bindings: appBackendBindingsSchema,
});
/** At most the graph's existing total of 64 nodes. Missing authority never means write. */
export const runCeilingSchema = S.Struct({
  nodes: S.Array(nodeCeilingSchema).pipe(
    S.check(S.isMaxLength(64)),
    S.check(
      S.makeFilter(
        (nodes) =>
          new Set(
            nodes.map((node) =>
              JSON.stringify([node.graphId ?? null, node.nodeId]),
            ),
          ).size === nodes.length,
      ),
    ),
  ),
  nodeGitAccess: nodeGitAccessListSchema,
});
export type RunCeiling = typeof runCeilingSchema.Type;

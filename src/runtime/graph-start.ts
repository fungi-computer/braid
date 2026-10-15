import { z } from "zod";
import {
  bindingsSelectionSchema,
  workflowBindingSchema,
  type BindingsSelection,
} from "../git-access.js";
import { gitSha1Schema } from "@fungi.computer/puffball/git-representation";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import { workflowIdSchema } from "../workflow-id.js";
import * as S from "effect/Schema";
import {
  compile,
  contentDigest,
  type Catalog,
  type Bindings,
  type ExecutionPlan,
  type Issue,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from "../index.js";
import type { WorkflowCatalogEntry } from "./ports.js";
import { workflowRunDeliverySchema } from "./graph-contract.js";

const id = S.String.pipe(
  S.check(S.isMinLength(1)),
  S.check(S.isMaxLength(256)),
);
/** A stored publication selected by its admitted publisher App. */
export const workflowPublicationSelectionSchema = z.union([
  z.strictObject({
    workflowId: workflowIdSchema,
    version: z.number().int().positive(),
    digest: z.string().refine(S.is(sha256DigestSchema)),
  }),
  z.strictObject({
    workflowId: workflowIdSchema,
    commit: gitSha1Schema,
    digest: z.string().refine(S.is(sha256DigestSchema)),
  }),
]);
const startFields = {
  requestId: id,
  /** Canonical installation selections or explicit Team-source namespaces. */
  bindings: S.declare(
    (value): value is BindingsSelection =>
      bindingsSelectionSchema.safeParse(value).success,
  ),
  input: S.JsonObject,
  /** Where the run's ending is reported; absent reports nowhere. */
  delivery: S.optionalKey(workflowRunDeliverySchema),
};
/** Published starts retain the original document and its concrete stored row identity. */
export const graphStartRequestSchema = S.Union([
  S.Struct({
    ...startFields,
    definition: S.Unknown,
    published: S.optionalKey(S.Never),
  }),
  S.Struct({
    ...startFields,
    definition: S.Json,
    published: S.declare(
      (
        value,
      ): value is z.output<
        (typeof workflowPublicationSelectionSchema.options)[1]
      > =>
        workflowPublicationSelectionSchema.options[1].safeParse(value).success,
    ),
  }),
]);
export type GraphStartRequest = typeof graphStartRequestSchema.Type;

export type GraphCompileResult =
  | Readonly<{ kind: "invalid"; issues: readonly Issue[] }>
  | Readonly<{ kind: "compiled"; plan: ExecutionPlan }>;

/**
 * Compile a definition against the member's live catalog. The App supplies
 * only references to installations; each installation's App id and method
 * digests come from the catalog, so a stale or foreign binding is an issue,
 * never a guess.
 */
export async function compileForMember(
  entries: readonly WorkflowCatalogEntry[],
  request: Omit<GraphStartRequest, "definition" | "published"> &
    Readonly<{ definition: unknown }>,
): Promise<GraphCompileResult> {
  const byInstallation = new Map(
    entries.map((entry) => [entry.installationId, entry]),
  );
  const catalog: Record<string, Catalog[string]> = {};
  const bindings: Record<string, Bindings[string]> = {};
  for (const [ref, selection] of Object.entries(request.bindings)) {
    const installation =
      bindingsSelectionSchema.valueType.options[0].safeParse(selection);
    if (!installation.success) {
      bindings[ref] = workflowBindingSchema.parse(selection);
      continue;
    }
    const installationId = installation.data;
    const entry = byInstallation.get(installationId);
    if (entry === undefined)
      return {
        kind: "invalid",
        issues: [
          {
            code: "binding",
            message: "Installation is not available to you",
          },
        ],
      };
    catalog[entry.appId] =
      entry.events === undefined
        ? { methods: entry.methods }
        : { methods: entry.methods, events: entry.events };
    bindings[ref] = { appId: entry.appId, installationId };
  }
  let definition: WorkflowDefinition;
  try {
    definition = S.decodeUnknownSync(workflowDefinitionSchema)(
      request.definition,
      { onExcessProperty: "error" },
    );
  } catch (cause) {
    if (!S.isSchemaError(cause)) throw cause;
    return {
      kind: "invalid",
      issues: [{ code: "schema", message: "Definition failed v1 decoding" }],
    };
  }
  const result = await compile(definition, catalog, bindings);
  return result.ok
    ? { kind: "compiled", plan: result.plan }
    : { kind: "invalid", issues: result.issues };
}

/**
 * The highest effect any node in the compiled plan uses on each bound
 * installation, subgraphs included (`requiredBindings` already spans every
 * graph). A read-only binding keeps `"read"`; any write or external effect
 * raises it to `"write"`. Pure projection of the plan, never a live grant.
 */
export function planInstallationLevels(
  plan: Pick<ExecutionPlan, "requiredBindings">,
): readonly Readonly<{ installationId: string; level: "read" | "write" }>[] {
  const levels = new Map<string, "read" | "write">();
  for (const bound of plan.requiredBindings) {
    if (levels.get(bound.installationId) === "write") continue;
    levels.set(
      bound.installationId,
      bound.effect === "read" ? "read" : "write",
    );
  }
  return [...levels.entries()]
    .map(([installationId, level]) => ({ installationId, level }))
    .sort((a, b) => a.installationId.localeCompare(b.installationId));
}

/** One run per (Team, member, App request id); a repeat replays it. */
export async function memberRunIdentity(
  teamId: string,
  memberId: string,
  requestId: string,
): Promise<Readonly<{ requestId: string; runId: string }>> {
  const digest = await contentDigest([
    "fungi.workflow/v1 start",
    teamId,
    memberId,
    requestId,
  ]);
  return {
    requestId: digest,
    runId: "run_" + digest.slice("sha256:".length, 39),
  };
}

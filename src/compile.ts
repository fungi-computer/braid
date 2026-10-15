import * as S from "effect/Schema";
import * as Option from "effect/Option";
import { analyze, type Issue } from "./validate.js";
import {
  bindingsSchema,
  executionPlanSchema,
  methodSchema,
  eventSchema,
  projectionSchema,
  type JsonSchemaProjection,
  type ExecutionPlan,
  type Json,
  type Catalog,
  type Bindings,
  type WorkflowDefinition,
} from "./schema.js";
/** Canonical object ordering; array order remains semantic. No execution layout is accepted. */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (S.is(S.JsonObject)(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ":" + canonicalJson(value[key] ?? null),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function contentDigest(value: Json): Promise<string> {
  const json = S.decodeUnknownSync(S.Json)(value);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(json)),
  );
  return (
    "sha256:" +
    [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  );
}
export type CompileResult =
  | { readonly ok: false; readonly issues: readonly Issue[] }
  | { readonly ok: true; readonly plan: ExecutionPlan };
export async function compile(
  raw: WorkflowDefinition,
  rawCatalog: Catalog,
  rawBindings: Bindings,
): Promise<CompileResult> {
  const analysis = analyze(raw, rawCatalog);
  if (analysis.issues.length || !analysis.definition || !analysis.catalog)
    return { ok: false, issues: analysis.issues };
  let bindings: Bindings;
  try {
    bindings = S.decodeUnknownSync(bindingsSchema)(rawBindings, {
      onExcessProperty: "error",
    });
  } catch (cause) {
    if (!S.isSchemaError(cause)) throw cause;
    return {
      ok: false,
      issues: [{ code: "binding", message: "Invalid installation bindings" }],
    };
  }
  const { definition, catalog } = analysis;
  const requiredBindings: ExecutionPlan["requiredBindings"][number][] = [];
  const pinned: Record<string, Catalog[string]> = {};
  const bound: Record<string, Bindings[string]> = {};
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(analysis.order).flat()) {
    if (node.kind !== "app") continue;
    const app = definition.apps[node.app];
    const binding = bindings[node.app];
    if (
      !app ||
      binding === undefined ||
      !("installationId" in binding) ||
      !binding.installationId ||
      binding.appId !== app.appId
    ) {
      issues.push({
        code: "binding",
        node: node.id,
        message: "App binding missing or targets a different App",
      });
      continue;
    }
    const method = catalog[app.appId]?.methods[node.method];
    if (!method) continue;
    pinned[app.appId] = {
      methods: { ...pinned[app.appId]?.methods, [node.method]: method },
    };
    bound[node.app] = binding;
    if (node.gitAccess !== undefined) {
      const target = bindings[node.gitAccess.binding];
      if (target === undefined) {
        issues.push({
          code: "binding",
          node: node.id,
          message: "Git repository binding is missing",
        });
        continue;
      }
      bound[node.gitAccess.binding] = target;
    }
    const key = node.app + "." + node.method;
    if (seen.has(key)) continue;
    seen.add(key);
    const { description, input, output, effect, approval, requires } = method;
    requiredBindings.push({
      app: node.app,
      installationId: binding.installationId,
      method: node.method,
      description,
      input,
      output,
      effect,
      approval,
      requires,
    });
  }
  for (const trigger of definition.triggers ?? []) {
    if (trigger.on !== "event") continue;
    const app = definition.apps[trigger.app];
    const binding = bindings[trigger.app];
    if (
      !app ||
      binding === undefined ||
      !("installationId" in binding) ||
      !binding.installationId ||
      binding.appId !== app.appId
    ) {
      issues.push({
        code: "binding",
        trigger: trigger.id,
        message: "Event App binding missing or targets a different App",
      });
      continue;
    }
    const event = catalog[app.appId]?.events?.[trigger.event];
    if (!event) continue;
    const prior = pinned[app.appId];
    pinned[app.appId] = {
      methods: prior?.methods ?? {},
      events: { ...prior?.events, [trigger.event]: event },
    };
    bound[trigger.app] = binding;
  }
  if (issues.length) return { ok: false, issues };
  let sortedDefinition: WorkflowDefinition = {
    ...definition,
    nodes: analysis.order.root ?? [],
    edges: [...definition.edges].sort((a, b) =>
      canonicalJson(a).localeCompare(canonicalJson(b)),
    ),
  };
  if (definition.subgraphs) {
    sortedDefinition = {
      ...sortedDefinition,
      subgraphs: Object.fromEntries(
        Object.entries(definition.subgraphs).map(([id, graph]) => [
          id,
          {
            ...graph,
            nodes: analysis.order[id] ?? [],
            edges: [...graph.edges].sort((a, b) =>
              canonicalJson(a).localeCompare(canonicalJson(b)),
            ),
          },
        ]),
      ),
    };
  }
  const content = {
    definition: sortedDefinition,
    catalog: pinned,
    bindings: bound,
    estimatedSteps: analysis.estimatedSteps,
    requiredBindings: requiredBindings.sort((a, b) =>
      (a.app + a.method).localeCompare(b.app + b.method),
    ),
  };
  return {
    ok: true,
    plan: { ...content, planDigest: await contentDigest(content) },
  };
}
/** Stored plans are parsed and their content identity verified before interpretation. */
export async function decodeExecutionPlan(
  raw: unknown,
): Promise<ExecutionPlan> {
  const plan = S.decodeUnknownSync(executionPlanSchema)(raw, {
    onExcessProperty: "error",
  });
  const { planDigest, ...content } = plan;
  if ((await contentDigest(content)) !== planDigest)
    throw new Error("Workflow plan digest mismatch");
  const rebuilt = await compile(plan.definition, plan.catalog, plan.bindings);
  if (!rebuilt.ok || rebuilt.plan.planDigest !== planDigest)
    throw new Error("Workflow plan is not a compiled v1 plan");
  return plan;
}
/** One App method as an App's `api` block declares it; structural, no App SDK import. */
export type DeclaredMethod = Readonly<{
  /** Opt in to the shared Pending control result. */
  pending?: true | undefined;
  /** Discovery-only metadata from the App declaration; hidden methods have no graph ports. */
  hidden?: true | undefined;
  description: string;
  input: object;
  output: object;
  effect: "read" | "write" | "external";
  requires: readonly string[];
}>;
// The emitted draft identifier is metadata; graph ports use the completion schema.
function schemaView(schema: JsonSchemaProjection): JsonSchemaProjection {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "$schema"),
  );
}

// Agar emits exactly [declared Output, Pending]. This projects its completion
// side only; unsupported nested unions remain unsupported graph port schemas.
const emittedPendingUnion = S.Struct({
  anyOf: S.Tuple([projectionSchema, projectionSchema]),
});
function completionView(
  method: typeof methodSchema.Type,
): JsonSchemaProjection {
  const output = schemaView(method.output);
  if (method.pending !== true) return output;
  const union = S.decodeUnknownOption(emittedPendingUnion, {
    onExcessProperty: "error",
  })(output);
  return Option.isSome(union) ? schemaView(union.value.anyOf[0]) : output;
}

/**
 * The catalog entry for one App's declared methods. The digest covers what a
 * node depends on (ports, effect, approval, requires), not the description, so
 * rewording a method does not drift Workflows. External effects queue for
 * approval; v1 declares no other approval policy.
 */
export async function catalogMethods(
  methods: Readonly<Record<string, DeclaredMethod>>,
): Promise<Catalog[string]> {
  const entries = await Promise.all(
    Object.entries(methods)
      .flatMap(([name, { hidden, ...declared }]) =>
        hidden === true ? [] : [[name, declared] as const],
      )
      .map(async ([name, declared]) => {
        const method = S.decodeUnknownSync(methodSchema)(
          {
            ...declared,
            requires: [...declared.requires],
            approval: declared.effect === "external" ? "queue" : "none",
          },
          { onExcessProperty: "error" },
        );
        const pinned = {
          input: method.input,
          output: method.output,
          effect: method.effect,
          approval: method.approval,
          requires: method.requires,
        };
        const digestInput =
          method.pending === true ? { ...pinned, pending: true } : pinned;
        return [
          name,
          {
            ...method,
            input: schemaView(method.input),
            output: completionView(method),
            digest: await contentDigest(digestInput),
          },
        ] as const;
      }),
  );
  return { methods: Object.fromEntries(entries) };
}

/** Event identity pins the whole emitted schema; descriptions do not affect compatibility. */
export async function catalogEvents(
  events: Readonly<Record<string, { description: string; payload: object }>>,
): Promise<{ events: NonNullable<Catalog[string]["events"]> }> {
  const entries = await Promise.all(
    Object.entries(events).map(async ([name, raw]) => {
      const event = S.decodeUnknownSync(eventSchema)(raw, {
        onExcessProperty: "error",
      });
      return [
        name,
        { ...event, digest: await contentDigest({ payload: event.payload }) },
      ] as const;
    }),
  );
  return { events: Object.fromEntries(entries) };
}

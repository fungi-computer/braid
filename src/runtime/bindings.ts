import type { Issue, WorkflowDefinition } from "../index.js";
import type { WorkflowCatalogEntry } from "./ports.js";

/** Declared App references that require a current human-visible installation. */
export type WorkflowBindingRequest = Readonly<{
  name: string;
  appId: string;
  reason: "missing" | "ambiguous";
}>;
export type WorkflowBindingsResolution =
  | Readonly<{ kind: "bound"; bindings: Readonly<Record<string, string>> }>
  | Readonly<{
      kind: "needs-binding";
      bindings: readonly WorkflowBindingRequest[];
    }>
  | Readonly<{ kind: "invalid"; issues: readonly Issue[] }>;

export type CatalogInstallation = Pick<
  WorkflowCatalogEntry,
  "installationId" | "appId"
>;

function resolveInstallation(
  appId: string,
  explicit: string | undefined,
  catalog: readonly CatalogInstallation[],
): { installationId: string } | { reason: "missing" | "ambiguous" } {
  const matches = catalog.filter((entry) => entry.appId === appId);
  if (explicit !== undefined)
    return matches.some((entry) => entry.installationId === explicit)
      ? { installationId: explicit }
      : { reason: "missing" };
  const unique = matches.length === 1 ? matches[0] : undefined;
  return unique !== undefined
    ? { installationId: unique.installationId }
    : { reason: matches.length === 0 ? "missing" : "ambiguous" };
}

/**
 * Resolve parsed Workflow references against the starting human's live catalog.
 * An explicit choice must still be visible and match the declared App. Omitted
 * choices use only a unique current match; no saved installation defaults apply.
 */
export function resolveWorkflowBindings(
  definition: Pick<WorkflowDefinition, "apps">,
  requested: Readonly<Record<string, string>> | undefined,
  catalog: readonly CatalogInstallation[],
): WorkflowBindingsResolution {
  for (const name of Object.keys(requested ?? {})) {
    if (!Object.hasOwn(definition.apps, name))
      return {
        kind: "invalid",
        issues: [{ code: "binding", message: `Unknown App binding: ${name}` }],
      };
  }
  const selected: [string, string][] = [];
  const needed: WorkflowBindingRequest[] = [];
  for (const [name, spec] of Object.entries(definition.apps)) {
    const resolved = resolveInstallation(
      spec.appId,
      requested?.[name],
      catalog,
    );
    if ("installationId" in resolved)
      selected.push([name, resolved.installationId]);
    else
      needed.push({
        name,
        appId: spec.appId,
        reason: resolved.reason,
      });
  }
  return needed.length === 0
    ? { kind: "bound", bindings: Object.fromEntries(selected) }
    : { kind: "needs-binding", bindings: needed };
}

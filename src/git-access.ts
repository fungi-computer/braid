import * as z from "zod";
import {
  repositoryRefSchema,
  repositoryRefsEqual,
} from "@fungi.computer/agar/git";

const repository = z
  .string()
  .regex(/^[a-zA-Z0-9._-]{1,128}$/)
  .refine((value) => value !== "." && value !== "..");

const bindingName = z.lazy(() =>
  z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
);
const identity = z.string().min(1).max(256);
const teamSourceBinding = z.lazy(() =>
  z.strictObject({ kind: z.literal("team-source") }),
);
/** Frozen installation identity or explicit registered Team-source namespace. */
export const workflowBindingSchema = z.union([
  z.strictObject({ appId: identity, installationId: identity }),
  teamSourceBinding,
]);
/** Installation selections are admitted through the host's catalog before compilation. */
export const bindingsSelectionSchema = z.record(
  bindingName,
  z.union([identity, teamSourceBinding]),
);
export type BindingsSelection = z.output<typeof bindingsSelectionSchema>;

/** A literal branch scope, never a ref pattern or a revision expression. */
const branch = z
  .string()
  .max(1024)
  .regex(/^refs\/heads\/[A-Za-z0-9_/-][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
  );
const branches = z.lazy(() =>
  z
    .array(branch)
    .min(1)
    .max(256)
    .refine(
      (values) => new Set(values).size === values.length,
      "Branches must be unique",
    ),
);

/** Write access names a fixed repository and its exact branch ceiling, admitted at arm time. */
const writeGitAccessSchema = z.strictObject({
  binding: bindingName,
  repository,
  branches,
});
/**
 * Read access never pushes. `$trigger.repository` is the one repository the
 * firing event names through its trigger's `repository` mapping; it resolves
 * per run, inside the trigger App's own host-attested installation.
 */
const readGitAccessSchema = z.strictObject({
  binding: bindingName,
  repository: z.union([repository, z.literal("$trigger.repository")]),
  access: z.literal("read"),
});
/** Published node declaration: a write branch ceiling or a read-only scope. */
export const gitAccessSchema = z.union([
  writeGitAccessSchema,
  readGitAccessSchema,
]);

/** Host-resolved scope carried to a process; data alone never grants this authority. */
export const resolvedGitAccessSchema = z.lazy(() =>
  z.union([
    z.strictObject({ repository: repositoryRefSchema, branches }),
    z.strictObject({
      repository: repositoryRefSchema,
      access: z.literal("read"),
    }),
  ]),
);
export type GitAccess = z.infer<typeof gitAccessSchema>;
export type ResolvedGitAccess = z.infer<typeof resolvedGitAccessSchema>;

/** The Git scope a pass for this resolved access admits. */
export function gitAccessScope(access: GitAccess | ResolvedGitAccess) {
  return "access" in access ? access.access : ("write" as const);
}

/** Exact scope equality: same repository, same access, same ordered branches. */
export function resolvedGitAccessEqual(
  left: ResolvedGitAccess,
  right: ResolvedGitAccess,
): boolean {
  if (!repositoryRefsEqual(left.repository, right.repository)) return false;
  if ("access" in left || "access" in right)
    return "access" in left && "access" in right;
  return (
    left.branches.length === right.branches.length &&
    left.branches.every((branch, index) => branch === right.branches[index])
  );
}

/** One event-named repository, already decoded from the trigger's mapping. */
export const triggerRepositorySchema = repository;

/**
 * Resolve only the selected frozen namespace; never infer the App executing
 * the node. `$trigger.repository` resolves only with the run's trigger
 * repository; without one it is unavailable.
 */
export function resolveGitAccess(
  bindings: Readonly<Record<string, z.output<typeof workflowBindingSchema>>>,
  authored: GitAccess,
  triggerRepository?: string,
): ResolvedGitAccess | null {
  const binding = bindings[authored.binding];
  if (binding === undefined) return null;
  const name =
    authored.repository === "$trigger.repository"
      ? triggerRepository
      : authored.repository;
  if (name === undefined) return null;
  const repositoryRef =
    "installationId" in binding
      ? {
          kind: "installation",
          installationId: binding.installationId,
          repository: name,
        }
      : { kind: "team-source", repository: name };
  return resolvedGitAccessSchema.parse(
    "access" in authored
      ? { repository: repositoryRef, access: authored.access }
      : { repository: repositoryRef, branches: authored.branches },
  );
}

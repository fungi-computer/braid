import { z } from "zod";
import type { GitWriter } from "@fungi.computer/agar/git";

import { workflowAttestationSchema } from "@fungi.computer/puffball/app-method-runtime";
import { gitAccessScope, resolvedGitAccessSchema } from "../git-access.js";

const id = z.string().min(1).max(256);
/** Non-secret Team-issued authority for one stored Workflow step on its pinned Computer. */
export const workflowGitPassGrantSchema = z.lazy(() =>
  z
    .strictObject({
      teamId: id,
      computerId: id,
      memberId: id,
      workflow: workflowAttestationSchema,
      runId: id,
      graphId: id.optional(),
      nodeId: id,
      iteration: id,
      scope: z.enum(["read", "write"]),
      gitAccess: resolvedGitAccessSchema,
      triggerId: id.optional(),
    })
    .refine(
      (grant) => grant.scope === gitAccessScope(grant.gitAccess),
      "A pass's scope is its admitted Git access",
    ),
);
export type WorkflowGitPassGrant = z.output<typeof workflowGitPassGrantSchema>;

/** Run cleanup remains valid after the Computer's product data is erased. */
export const workflowGitPassRevocationSchema = z.strictObject({
  teamId: id,
  runId: id,
});

/** Project a stored, admitted pass; projection alone never admits authority. */
export function workflowGitPassWriter(
  grant: WorkflowGitPassGrant,
): Extract<GitWriter, { kind: "actor" }> {
  // A read pass never writes, so it carries no branch ceiling to attest.
  return "branches" in grant.gitAccess
    ? {
        kind: "actor",
        actor: grant.workflow.armedBy,
        workflow: { ...grant.workflow, branches: grant.gitAccess.branches },
      }
    : { kind: "actor", actor: grant.workflow.armedBy };
}

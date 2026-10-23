import { z } from "zod";
import type { GitWriter } from "@fungi.computer/agar/git";

import { workflowAttestationSchema } from "@fungi.computer/puffball/app-method-runtime";
import { gitAccessScope, resolvedGitAccessSchema } from "../git-access.js";

const id = z.string().min(1).max(256);

/** One credential grammar for both hosts; the owner is public, the token is not. */
export const workflowGitPassPrefix = "wgp.";
export const workflowGitPassTokenSchema = z
  .string()
  .regex(/^wgp\.([a-zA-Z0-9_-]{1,256})\.([0-9a-f]{64})$/u)
  .transform((bearer) => {
    const [, ownerId = "", token = ""] = bearer.split(".");
    return { ownerId, token };
  });

/** Format the existing standalone bearer shape, never a credential-bearing URL. */
export function formatWorkflowGitPassToken(ownerId: string, token: string) {
  const bearer = `${workflowGitPassPrefix}${ownerId}.${token}`;
  workflowGitPassTokenSchema.parse(bearer);
  return bearer;
}

/** Returned once to the native dispatcher, never to an App or a durable record. */
export type WorkflowGitCredential = Readonly<{
  bearer: string;
  remote: string;
  expiresAt: number;
}>;

/** Git reads this command-local config without writing a credential or repository config. */
export function workflowGitExecutionEnvironment(
  credential: WorkflowGitCredential,
) {
  return {
    FUNGI_GIT_REMOTE: credential.remote,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${credential.remote}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.bearer}`,
  };
}

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

import {
  gitAccessSchema,
  resolveGitAccess,
  type GitAccess,
  type ResolvedGitAccess,
} from "@fungi.computer/braid/git-access";

const access: GitAccess = gitAccessSchema.parse({
  binding: "app",
  repository: "notes",
  branches: ["refs/heads/main"],
});
const resolved: ResolvedGitAccess | null = resolveGitAccess(
  { app: { appId: "notes", installationId: "notes-installation" } },
  access,
);
void resolved;

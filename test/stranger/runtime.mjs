import assert from "node:assert/strict";
import {
  gitAccessSchema,
  resolveGitAccess,
  resolvedGitAccessEqual,
} from "@fungi.computer/braid/git-access";

const bindings = {
  app: { appId: "notes", installationId: "notes-installation" },
};
const access = gitAccessSchema.parse({
  binding: "app",
  repository: "notes",
  branches: ["refs/heads/main"],
});
const resolved = resolveGitAccess(bindings, access);
assert.deepEqual(resolved, {
  repository: {
    kind: "installation",
    installationId: "notes-installation",
    repository: "notes",
  },
  branches: ["refs/heads/main"],
});
assert.equal(resolvedGitAccessEqual(resolved, resolved), true);
assert.equal(resolveGitAccess({}, access), null);
assert.equal(
  gitAccessSchema.safeParse({
    binding: "app",
    repository: "notes",
    branches: ["main"],
  }).success,
  false,
);

const read = gitAccessSchema.parse({
  binding: "app",
  repository: "$trigger.repository",
  access: "read",
});
assert.equal(resolveGitAccess(bindings, read), null);
assert.deepEqual(resolveGitAccess(bindings, read, "trigger-notes"), {
  repository: {
    kind: "installation",
    installationId: "notes-installation",
    repository: "trigger-notes",
  },
  access: "read",
});

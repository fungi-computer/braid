import { workflowInstallationAuthoritySchema } from "../src/runtime/trigger-owner.js";

/** A member's own arm on the installation pin a host would capture from its frame. */
export const memberArm = {
  armedVia: null,
  grantorMembershipVersion: 1,
  installationAuthority: workflowInstallationAuthoritySchema.parse({
    selection: {
      instanceId: "instance-workflows",
      owner: { kind: "installation", id: "workflows-a" },
      appId: "app_workflows",
      releaseId: "rel_workflows",
      authorityVersion: 1,
    },
    artifactDigest: `sha256:${"a".repeat(64)}`,
  }),
};

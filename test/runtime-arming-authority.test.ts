import { expect, it } from "vitest";
import {
  workflowArmingReceiptSchema,
  recheckWorkflowArming,
  captureWorkflowArming,
  workflowArmingAccessSchema,
  type WorkflowArmingAccess,
} from "../src/runtime/arming-authority.js";

const connector = {
  kind: "connector" as const,
  agentId: "agent-one",
  attachmentId: "attachment-one",
  attachmentVersion: 1,
};
const policy = {
  kind: "policy" as const,
  agentId: "agent-one",
  policyRevision: "approved-policy:7",
  grantorMemberId: "member-one",
};
const member = () => Promise.resolve({ membershipVersion: 7 });

it("retains each host's real Agent arming provenance beside its human grantor", () => {
  for (const armedVia of [null, connector, policy]) {
    const receipt = {
      armedBy: "member-one",
      armedVia,
      grantorMembershipVersion: 7,
    };
    expect(workflowArmingReceiptSchema.parse(receipt)).toEqual(receipt);
  }
});

it("refuses missing, unknown, mixed and mismatched arming provenance", () => {
  for (const raw of [
    { armedBy: "member-one" },
    { armedBy: "member-one", armedVia: { ...policy, kind: "other" } },
    { armedBy: "member-one", armedVia: { ...connector, policyRevision: "7" } },
    { armedBy: "member-one", armedVia: { ...policy, attachmentVersion: 1 } },
    { armedBy: "member-other", armedVia: policy },
    { armedBy: "member-one", armedVia: { ...connector, attachmentVersion: 0 } },
  ])
    expect(
      workflowArmingReceiptSchema.safeParse({
        grantorMembershipVersion: 7,
        ...raw,
      }).success,
    ).toBe(false);
  expect(
    workflowArmingReceiptSchema.safeParse({
      armedBy: "member-one",
      armedVia: policy,
    }).success,
  ).toBe(false);
});

it("rechecks the same approved write source without changing the captured receipt", async () => {
  for (const armedVia of [connector, policy]) {
    const receipt = {
      armedBy: "member-one",
      armedVia,
      grantorMembershipVersion: 7,
    };
    const live: WorkflowArmingAccess = {
      ...armedVia,
      grantorMemberId: "member-one",
      level: "write",
    };
    const reads: unknown[] = [];
    expect(
      await recheckWorkflowArming(receipt, {
        member,
        readAgentAccess: (captured) => {
          reads.push(captured);
          return Promise.resolve(live);
        },
      }),
    ).toEqual({ kind: "admitted", receipt });
    expect(reads).toEqual([
      armedVia.kind === "connector"
        ? {
            kind: "connector",
            agentId: armedVia.agentId,
            attachmentId: armedVia.attachmentId,
          }
        : { kind: "policy", agentId: armedVia.agentId },
    ]);
  }
});

it("refuses lost approval, read level, changed grantor, changed revision and foreign producer variants", async () => {
  const receipt = {
    armedBy: "member-one",
    armedVia: policy,
    grantorMembershipVersion: 7,
  };
  const live: WorkflowArmingAccess = { ...policy, level: "write" };
  const changes: readonly (WorkflowArmingAccess | null)[] = [
    null,
    { ...live, level: "read" },
    { ...live, grantorMemberId: "member-other" },
    { ...live, agentId: "agent-other" },
    { ...live, policyRevision: "approved-policy:8" },
    { ...connector, grantorMemberId: "member-one", level: "write" },
  ];
  expect(
    workflowArmingAccessSchema.safeParse({ ...live, kind: "unknown" }).success,
  ).toBe(false);
  for (const current of changes)
    expect(
      await recheckWorkflowArming(receipt, {
        member,
        readAgentAccess: () => Promise.resolve(current),
      }),
    ).toEqual({ kind: "refused", code: "revoked" });
});

it("refuses a changed or detached connector and retains the member-only path without Agent policy reads", async () => {
  const receipt = {
    armedBy: "member-one",
    armedVia: connector,
    grantorMembershipVersion: 7,
  };
  const live: WorkflowArmingAccess = {
    ...connector,
    grantorMemberId: "member-one",
    level: "write",
  };
  for (const current of [
    null,
    { ...live, attachmentVersion: 2 },
    { ...live, attachmentId: "other" },
  ])
    expect(
      await recheckWorkflowArming(receipt, {
        member,
        readAgentAccess: () => Promise.resolve(current),
      }),
    ).toEqual({ kind: "refused", code: "revoked" });
  const human = {
    armedBy: "member-one",
    armedVia: null,
    grantorMembershipVersion: 7,
  };
  expect(
    await recheckWorkflowArming(human, {
      member,
      readAgentAccess: () =>
        Promise.reject(new Error("A member has no Agent policy")),
    }),
  ).toEqual({ kind: "admitted", receipt: human });
});

it("captures the actual member version and refuses demotion/re-promotion and changes during policy reads", async () => {
  const source = { armedBy: "member-one", armedVia: policy };
  const live: WorkflowArmingAccess = { ...policy, level: "write" };
  const captured = await captureWorkflowArming(source, {
    member,
    readAgentAccess: () => Promise.resolve(live),
  });
  expect(captured).toEqual({
    kind: "admitted",
    receipt: { ...source, grantorMembershipVersion: 7 },
  });
  if (captured.kind !== "admitted")
    throw new Error("Expected a captured receipt");
  let reads = 0;
  for (const current of [null, { membershipVersion: 9 }]) {
    expect(
      await recheckWorkflowArming(captured.receipt, {
        member: () => Promise.resolve(current),
        readAgentAccess: () => {
          reads++;
          return Promise.resolve(live);
        },
      }),
    ).toEqual({ kind: "refused", code: "revoked" });
  }
  expect(reads).toBe(0);
  let version = 7;
  expect(
    await recheckWorkflowArming(captured.receipt, {
      member: () => Promise.resolve({ membershipVersion: version }),
      readAgentAccess: () => {
        version = 8;
        return Promise.resolve(live);
      },
    }),
  ).toEqual({ kind: "refused", code: "revoked" });
});

it("refuses oversized policy revisions at the captured and current-owner boundaries", () => {
  const oversized = { ...policy, policyRevision: "x".repeat(257) };
  expect(
    workflowArmingReceiptSchema.safeParse({
      armedBy: "member-one",
      armedVia: oversized,
      grantorMembershipVersion: 7,
    }).success,
  ).toBe(false);
  expect(
    workflowArmingAccessSchema.safeParse({ ...oversized, level: "write" })
      .success,
  ).toBe(false);
  expect(
    workflowArmingReceiptSchema.safeParse({
      armedBy: "member-one",
      armedVia: { ...policy, policyRevision: "x".repeat(256) },
      grantorMembershipVersion: 7,
    }).success,
  ).toBe(true);
});

it("looks up only the source keys and refuses the owner's stale attachment row", async () => {
  const receipt = {
    armedBy: "member-one",
    armedVia: { ...connector, attachmentVersion: 2 },
    grantorMembershipVersion: 7,
  };
  const calls: unknown[] = [];
  expect(
    await recheckWorkflowArming(receipt, {
      member,
      readAgentAccess: (lookup) => {
        calls.push(lookup);
        return Promise.resolve({
          ...connector,
          grantorMemberId: "member-one",
          level: "write",
        });
      },
    }),
  ).toEqual({ kind: "refused", code: "revoked" });
  expect(calls).toEqual([
    { kind: "connector", agentId: "agent-one", attachmentId: "attachment-one" },
  ]);
});

it("refuses an invalid member owner row before reading Agent authority", async () => {
  let reads = 0;
  const decision = await recheckWorkflowArming(
    { armedBy: "member-one", armedVia: policy, grantorMembershipVersion: 7 },
    {
      member: () =>
        Promise.resolve({ membershipVersion: 7, extra: "not-member-grammar" }),
      readAgentAccess: () => {
        reads++;
        return Promise.resolve({ ...policy, level: "write" });
      },
    },
  );
  expect(decision).toEqual({ kind: "refused", code: "revoked" });
  expect(reads).toBe(0);
});

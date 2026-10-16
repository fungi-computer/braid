import { memberArm } from "./armed-trigger.fixture.js";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it } from "vitest";
import * as S from "effect/Schema";
import { sha256DigestSchema } from "@fungi.computer/puffball/effect";
import {
  compile,
  catalogMethods,
  contentDigest,
  type WorkflowDefinition,
} from "../src/index.js";
import {
  createTeamWorkflowRuns,
  createWorkflowRunAuthority,
  createWorkflowCeilingCapture,
  memberRunIdentity,
  type WorkflowCatalogEntry,
} from "../src/runtime/index.js";

const unexpected = (): never => {
  throw new Error("Unexpected host publication/Git port");
};

async function fixture(
  original?: WorkflowDefinition,
  nodeEntries: readonly WorkflowCatalogEntry[] = [],
) {
  const definition: WorkflowDefinition = original ?? {
    format: "fungi.workflow/v1",
    title: "Original order",
    apps: {},
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "last",
        kind: "transform",
        fields: { text: { from: { node: "first", port: "text" } } },
      },
      {
        id: "first",
        kind: "transform",
        fields: { text: { literal: "Original document" } },
      },
    ],
    edges: [],
    output: { text: { node: "last", port: "text" } },
  };
  const digest = S.decodeUnknownSync(sha256DigestSchema)(
    await contentDigest(definition),
  );
  let granted: boolean | undefined = true;
  let declared = true;
  let runGranted: boolean | undefined = true;
  let memberPresent = true;
  let captures = 0;
  let reads = 0;
  let revokeAfterCapture = false;
  const catalog = (): Promise<readonly WorkflowCatalogEntry[]> => {
    reads += 1;
    let entry: WorkflowCatalogEntry = {
      installationId: "library",
      appId: "app.workflows",
      displayName: "Trellis",
      methods: {},
    };
    entry = {
      ...entry,
      capabilities: declared
        ? ["workflow.publish", "workflow.run"]
        : ["workflow.run"],
    };
    if (runGranted !== undefined)
      entry = { ...entry, workflowRunGranted: runGranted };
    if (granted !== undefined)
      entry = { ...entry, workflowPublishGranted: granted };
    return Promise.resolve([entry, ...nodeEntries]);
  };
  const database = new DatabaseSync(":memory:");
  const capture = createWorkflowCeilingCapture({
    node: unexpected,
    git: unexpected,
  });
  const authority = createWorkflowRunAuthority({
    member: (id) =>
      Promise.resolve(
        id === "owner" && memberPresent ? { membershipVersion: 1 } : null,
      ),
    memberComputer: (id, computer) =>
      Promise.resolve(id === "owner" && computer === "computer"),
    catalog,
    admitAgent: () => Promise.resolve(false),
    async capture(preparation, actor, member) {
      const ceiling = await capture(preparation, actor, member);
      captures += 1;
      if (revokeAfterCapture) granted = false;
      return ceiling;
    },
    denied: () => new Error("denied"),
  });
  const owner = createTeamWorkflowRuns({
    ...fromNodeSqlite(database),
    teamId: () => "team",
    admission: () => "active",
    errors: {
      app: (code) => new Error(code),
      suspended: () => new Error("suspended"),
    },
    authority,
    wake: unexpected,
    callWorkflowApp: unexpected,
    reviewer: unexpected,
    admitDelivery: unexpected,
    terminateGraphRun: unexpected,
    member: () => Promise.resolve({ membershipVersion: 1 }),
    memberComputer: () => Promise.resolve(true),
    catalog,
  });
  return {
    owner,
    definition,
    digest,
    close: () => {
      database.close();
    },
    revoke: () => {
      granted = false;
    },
    revokeRun: () => {
      runGranted = false;
    },
    forgetRunGrant: () => {
      runGranted = undefined;
    },
    revokeMember: () => {
      memberPresent = false;
    },
    revokeDuringStart: () => {
      revokeAfterCapture = true;
    },
    forgetGrant: () => {
      granted = undefined;
    },
    removeDeclaration: () => {
      declared = false;
    },
    reads: () => reads,
    captures: () => captures,
  };
}

it.each(["computer", null])(
  "stores the original publication digest with Computer %s without resolving Git or hashing compiled ordering",
  async (computerId) => {
    const f = await fixture();
    try {
      const result = await f.owner.startGraph(
        "owner",
        {
          requestId: "start",
          definition: f.definition,
          bindings: {},
          input: {},
          published: {
            workflowId: "review",
            commit: "a".repeat(40),
            digest: f.digest,
          },
        },
        computerId,
        "library",
      );
      expect(result.kind).toBe("started");
      if (result.kind !== "started") throw new Error("Run did not start");
      const run = f.owner.graph.read(result.runId);
      if (run === null) throw new Error("Started run missing");
      expect(run.computerId).toBe(computerId);
      expect(run.ceiling).toEqual({ nodes: [], nodeGitAccess: [] });
      expect(run.publication?.digest).toBe(f.digest);
      expect(await contentDigest(run.plan.definition)).not.toBe(f.digest);
      expect(f.reads()).toBeGreaterThanOrEqual(2);
    } finally {
      f.close();
    }
  },
);

it("refuses changed original content before recording a published run", async () => {
  const f = await fixture();
  try {
    const result = await f.owner.startGraph(
      "owner",
      {
        requestId: "forged",
        definition: { ...f.definition, title: "Forged original" },
        bindings: {},
        input: {},
        published: {
          workflowId: "review",
          commit: "a".repeat(40),
          digest: f.digest,
        },
      },
      "computer",
      "library",
    );
    expect(result).toMatchObject({
      kind: "invalid",
      issues: [{ message: "Published definition digest does not match" }],
    });
    const identity = await memberRunIdentity("team", "owner", "forged");
    expect(f.owner.graph.read(identity.runId)).toBeNull();
  } finally {
    f.close();
  }
});

it.each(["before", "during"])(
  "refuses a publisher grant revoked %s start without a stored run",
  async (when) => {
    const f = await fixture();
    try {
      if (when === "before") f.revoke();
      else f.revokeDuringStart();
      await expect(
        f.owner.startGraph(
          "owner",
          {
            requestId: "revoked",
            definition: f.definition,
            bindings: {},
            input: {},
            published: {
              workflowId: "review",
              commit: "a".repeat(40),
              digest: f.digest,
            },
          },
          "computer",
          "library",
        ),
      ).rejects.toThrow("denied");
      expect(f.captures()).toBe(when === "during" ? 1 : 0);
      const identity = await memberRunIdentity("team", "owner", "revoked");
      expect(f.owner.graph.read(identity.runId)).toBeNull();
    } finally {
      f.close();
    }
  },
);

it.each(["before", "during"])(
  "refuses a cached publisher grant revoked %s start",
  async (when) => {
    const f = await fixture();
    try {
      const compiled = await compile(f.definition, {}, {});
      if (!compiled.ok) throw new Error("Fixture did not compile");
      const binding = {
        installationId: "library",
        workflowId: "review",
        commit: "a".repeat(40),
        digest: f.digest,
        triggerId: "clock",
        bindings: {},
        armedBy: "owner",
        ...memberArm,
        computerId: "computer",
      };
      f.owner.triggerPlans.put(binding, compiled.plan);
      if (when === "before") f.revoke();
      else f.revokeDuringStart();
      expect(
        await f.owner.startCachedGraph(binding, {
          requestId: "cached-revoked",
          input: {},
        }),
      ).toEqual({
        kind: "refused",
        reason: "Workflow publisher is no longer available; re-arm required",
      });
      expect(f.captures()).toBe(when === "during" ? 1 : 0);
      const identity = await memberRunIdentity(
        "team",
        "owner",
        "cached-revoked",
      );
      expect(f.owner.graph.read(identity.runId)).toBeNull();
    } finally {
      f.close();
    }
  },
);

it.each([
  ["direct", "missing grant fact"],
  ["cached", "missing grant fact"],
  ["direct", "missing workflow.publish declaration"],
  ["cached", "missing workflow.publish declaration"],
])(
  "refuses %s starts with %s before capture or record",
  async (path, missing) => {
    const f = await fixture();
    try {
      if (missing === "missing grant fact") f.forgetGrant();
      else f.removeDeclaration();
      const requestId = "missing-publisher";
      if (path === "direct") {
        await expect(
          f.owner.startGraph(
            "owner",
            {
              requestId,
              definition: f.definition,
              bindings: {},
              input: {},
              published: {
                workflowId: "review",
                commit: "a".repeat(40),
                digest: f.digest,
              },
            },
            "computer",
            "library",
          ),
        ).rejects.toThrow("denied");
      } else {
        const compiled = await compile(f.definition, {}, {});
        if (!compiled.ok) throw new Error("Fixture did not compile");
        const binding = {
          installationId: "library",
          workflowId: "review",
          commit: "a".repeat(40),
          digest: f.digest,
          triggerId: "clock",
          bindings: {},
          armedBy: "owner",
          ...memberArm,
          ...memberArm,
          computerId: "computer",
        };
        f.owner.triggerPlans.put(binding, compiled.plan);
        expect(
          await f.owner.startCachedGraph(binding, { requestId, input: {} }),
        ).toEqual({
          kind: "refused",
          reason: "Workflow publisher is no longer available; re-arm required",
        });
      }
      expect(f.captures()).toBe(0);
      const identity = await memberRunIdentity("team", "owner", requestId);
      expect(f.owner.graph.read(identity.runId)).toBeNull();
    } finally {
      f.close();
    }
  },
);

it.each(["computer", null])(
  "captures a member compiled start with Computer %s before storage and rejects caller ceilings",
  async (computerId) => {
    const f = await fixture();
    try {
      const compiled = await compile(f.definition, {}, {});
      if (!compiled.ok) throw new Error("Fixture did not compile");
      const request = {
        runId: "member-run",
        requestId: "member-request",
        computerId,
        plan: compiled.plan,
        input: {},
      };
      expect(await f.owner.startMemberGraph("owner", request)).toBe("started");
      expect(f.captures()).toBe(1);
      expect(f.owner.graph.read("member-run")?.ceiling).toEqual({
        nodes: [],
        nodeGitAccess: [],
      });
      await expect(
        f.owner.startMemberGraph("owner", {
          ...request,
          runId: "injected",
          requestId: "injected",
          ceiling: { nodes: [], nodeGitAccess: [] },
        }),
      ).rejects.toThrow();
      expect(f.owner.graph.read("injected")).toBeNull();
      await expect(
        f.owner.startMemberGraph("owner", {
          ...request,
          runId: "stale-plan",
          requestId: "stale-plan",
          plan: { ...request.plan, planDigest: "sha256:" + "0".repeat(64) },
        }),
      ).rejects.toThrow("denied");
      expect(f.captures()).toBe(1);
      expect(f.owner.graph.read("stale-plan")).toBeNull();
    } finally {
      f.close();
    }
  },
);

it("refuses a Computer-bound published or compiled member start with null before storing any run", async () => {
  const app = await catalogMethods({
    execute: {
      description: "Execute",
      effect: "write",
      requires: ["computer.execute"],
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
  });
  const method = app.methods.execute;
  if (method === undefined) throw new Error("Fixture method missing");
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Needs Computer",
    apps: { terminal: { appId: "app.shed" } },
    input: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        id: "execute",
        kind: "app",
        app: "terminal",
        method: "execute",
        methodDigest: method.digest,
        values: {},
      },
    ],
    edges: [],
    output: {},
  };
  const f = await fixture(definition, [
    {
      installationId: "shed",
      appId: "app.shed",
      displayName: "Shed",
      methods: app.methods,
    },
  ]);
  try {
    await expect(
      f.owner.startGraph(
        "owner",
        {
          requestId: "null-computer",
          definition,
          bindings: { terminal: "shed" },
          input: {},
          published: {
            workflowId: "execute",
            commit: "a".repeat(40),
            digest: f.digest,
          },
        },
        null,
        "library",
      ),
    ).rejects.toThrow("denied");
    const identity = await memberRunIdentity("team", "owner", "null-computer");
    expect(f.owner.graph.read(identity.runId)).toBeNull();
    const compiled = await compile(
      definition,
      { "app.shed": app },
      { terminal: { appId: "app.shed", installationId: "shed" } },
    );
    if (!compiled.ok) throw new Error("Fixture did not compile");
    await expect(
      f.owner.startMemberGraph("owner", {
        runId: "null-member",
        requestId: "null-member",
        computerId: null,
        plan: compiled.plan,
        input: {},
      }),
    ).rejects.toThrow("denied");
    expect(f.owner.graph.read("null-member")).toBeNull();
  } finally {
    f.close();
  }
});

it.each(["grant", "member"])(
  "stops at the next node after %s revocation and records the typed cause",
  async (revocation) => {
    const f = await fixture();
    try {
      const started = await f.owner.startGraph(
        "owner",
        {
          requestId: "node-recheck",
          definition: f.definition,
          bindings: {},
          input: {},
          published: {
            workflowId: "review",
            commit: "a".repeat(40),
            digest: f.digest,
          },
        },
        null,
        "library",
      );
      if (started.kind !== "started") throw new Error("Run did not start");
      const first = {
        runId: started.runId,
        nodeId: "first",
        iteration: "0",
        state: "running" as const,
        attempt: 0,
      };
      expect(await f.owner.recheckGraphNode(first)).toEqual({
        kind: "admitted",
      });
      f.owner.graph.recordEvent({ ...first, state: "complete" });
      if (revocation === "grant") f.revokeRun();
      else f.revokeMember();
      const second = { ...first, nodeId: "last" };
      const code =
        revocation === "grant" ? "workflow_run_revoked" : "member_revoked";
      expect(await f.owner.recheckGraphNode(second)).toEqual({
        kind: "refused",
        code,
      });
      expect(f.owner.graph.events(started.runId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...second,
            state: "failed",
            refusal: code,
            errorMessage: code.replaceAll("_", " "),
          }),
        ]),
      );
      expect(f.owner.graph.read(started.runId)?.publication?.digest).toBe(
        f.digest,
      );
    } finally {
      f.close();
    }
  },
);

it("keeps a started publication after publish-only revocation but refuses absent live run grant", async () => {
  const f = await fixture();
  try {
    const started = await f.owner.startGraph(
      "owner",
      {
        requestId: "keep-publication",
        definition: f.definition,
        bindings: {},
        input: {},
        published: {
          workflowId: "review",
          commit: "a".repeat(40),
          digest: f.digest,
        },
      },
      null,
      "library",
    );
    if (started.kind !== "started") throw new Error("Run did not start");
    f.revoke();
    const next = {
      runId: started.runId,
      nodeId: "last",
      iteration: "0",
      state: "running" as const,
      attempt: 0,
    };
    expect(await f.owner.recheckGraphNode(next)).toEqual({ kind: "admitted" });
    expect(f.owner.graph.read(started.runId)?.publication?.digest).toBe(
      f.digest,
    );
    f.forgetRunGrant();
    expect(await f.owner.recheckGraphNode(next)).toEqual({
      kind: "refused",
      code: "workflow_run_revoked",
    });
  } finally {
    f.close();
  }
});

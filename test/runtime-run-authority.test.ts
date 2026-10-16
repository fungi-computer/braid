import { expect, it } from "vitest";
import {
  compile,
  type Catalog,
  type Bindings,
  type WorkflowDefinition,
} from "../src/index.js";
import * as runtime from "../src/runtime/index.js";

it("requires live human admission and captures the actual compiled plan and Computer", async () => {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Authority port",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error("Fixture did not compile");
  const ceiling = { nodes: [], nodeGitAccess: [] };
  const preparation = {
    initiatedBy: { kind: "member" as const, memberId: "human-a" },
    source: "schedule" as const,
    libraryInstallationId: "workflows-a",
    computerId: "computer-a",
    plan: compiled.plan,
  };
  let captures = 0;
  const authority = runtime.createWorkflowRunAuthority({
    member: (memberId: string) =>
      Promise.resolve(memberId === "human-a" ? { membershipVersion: 7 } : null),
    memberComputer: (memberId: string, computerId: string) =>
      Promise.resolve(memberId === "human-a" && computerId === "computer-a"),
    catalog: () => Promise.resolve([]),
    admitAgent: () => Promise.resolve(false),
    capture: (
      actual: runtime.WorkflowRunPreparation,
      actor: { kind: "member"; memberId: string },
    ) => {
      captures += 1;
      expect(actual).toEqual(preparation);
      expect(actor).toEqual({ kind: "member", memberId: "human-a" });
      return Promise.resolve(ceiling);
    },
    denied: () => new Error("Human admission refused"),
  });
  expect(await authority.resolve(preparation)).toEqual({
    kind: "admitted",
    actor: { kind: "member", memberId: "human-a" },
    ceiling,
  });
  expect(captures).toBe(1);
  expect(await authority.member("human-a")).toEqual({ membershipVersion: 7 });
  expect(await authority.memberComputer("human-a", "computer-a")).toBe(true);
  expect(await authority.memberComputer("human-a", "foreign-computer")).toBe(
    false,
  );
  expect(await authority.catalog("human-a")).toEqual([]);
  await expect(authority.member("other-human")).rejects.toThrow(
    "Human admission refused",
  );
});

it("refuses Computer access when the human is revoked during its authoritative read", async () => {
  let current: runtime.WorkflowRunMember | null = { membershipVersion: 7 };
  const authority = runtime.createWorkflowRunAuthority({
    member: () => Promise.resolve(current),
    memberComputer: () => {
      current = null;
      return Promise.resolve(true);
    },
    catalog: () => Promise.resolve([]),
    admitAgent: () => Promise.resolve(false),
    capture: () => Promise.resolve(null),
    denied: () => new Error("Human admission refused"),
  });
  expect(await authority.memberComputer("human-a", "computer-a")).toBe(false);
});

it("admits a Computer-free graph with no selected Computer through required capture", async () => {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "No Computer",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error("Fixture did not compile");
  let captures = 0;
  let computerReads = 0;
  let revokeDuringCapture = false;
  let current: runtime.WorkflowRunMember | null = { membershipVersion: 7 };
  const authority = runtime.createWorkflowRunAuthority({
    member: () => Promise.resolve(current),
    memberComputer: () => {
      computerReads += 1;
      return Promise.resolve(false);
    },
    catalog: () => Promise.resolve([]),
    admitAgent: () => Promise.resolve(false),
    capture: () => {
      captures += 1;
      if (revokeDuringCapture) current = null;
      return Promise.resolve({ nodes: [], nodeGitAccess: [] });
    },
    denied: () => new Error("Human admission refused"),
  });
  const preparation: runtime.WorkflowRunPreparation = {
    initiatedBy: { kind: "member", memberId: "human-a" },
    source: "manual",
    computerId: null,
    plan: compiled.plan,
  };
  expect(await authority.resolve(preparation)).toEqual({
    kind: "admitted",
    actor: { kind: "member", memberId: "human-a" },
    ceiling: { nodes: [], nodeGitAccess: [] },
  });
  expect(captures).toBe(1);
  expect(computerReads).toBe(0);
  expect(
    await authority.resolve({
      ...preparation,
      initiatedBy: {
        kind: "agent",
        agentId: "agent-a",
        sessionId: "session-a",
        grantorMemberId: "human-a",
      },
      source: "agent",
      libraryInstallationId: "library",
    }),
  ).toEqual({ kind: "refused", code: "not_granted" });
  expect(captures).toBe(1);
  current = null;
  expect(await authority.resolve(preparation)).toEqual({
    kind: "refused",
    code: "not_granted",
  });
  expect(captures).toBe(1);
  current = { membershipVersion: 7 };
  revokeDuringCapture = true;
  expect(await authority.resolve(preparation)).toEqual({
    kind: "refused",
    code: "revoked",
  });
  expect(captures).toBe(2);
});

it("refuses a key run when admitKey is false, and fails closed when the port is absent", async () => {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Key authority",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error("Fixture did not compile");
  const preparation: runtime.WorkflowRunPreparation = {
    initiatedBy: {
      kind: "key",
      keyId: "morel",
      grantorMemberId: "owner-a",
    },
    source: "key",
    libraryInstallationId: "workflows-a",
    computerId: null,
    plan: compiled.plan,
  };
  const basePorts = {
    member: (memberId: string) =>
      Promise.resolve(memberId === "owner-a" ? { membershipVersion: 1 } : null),
    memberComputer: () => Promise.resolve(true),
    catalog: () =>
      Promise.resolve([
        {
          installationId: "workflows-a",
          appId: "app:workflows",
          displayName: "Trellis",
          methods: {},
          workflowRunGranted: true,
        },
      ]),
    admitAgent: () => Promise.resolve(false),
    capture: () => Promise.resolve({ nodes: [], nodeGitAccess: [] }),
    denied: () => new Error("Key admission refused"),
  };
  const refusing = runtime.createWorkflowRunAuthority({
    ...basePorts,
    admitKey: () => Promise.resolve(false),
  });
  expect(await refusing.recheckRun(preparation)).toEqual({
    kind: "refused",
    code: "revoked",
  });
  expect(await refusing.stillAttached(preparation)).toBe(false);
  // A host that never names `admitKey` never admits a key run either.
  const silent = runtime.createWorkflowRunAuthority(basePorts);
  expect(await silent.recheckRun(preparation)).toEqual({
    kind: "refused",
    code: "revoked",
  });
  expect(await silent.stillAttached(preparation)).toBe(false);
  const admitting = runtime.createWorkflowRunAuthority({
    ...basePorts,
    admitKey: () => Promise.resolve(true),
  });
  expect(await admitting.recheckRun(preparation)).toEqual({ kind: "admitted" });
});

it("rebuilds a key run's preparation from its stored source and initiator", async () => {
  const compiled = await compile(
    {
      format: "fungi.workflow/v1",
      title: "Key round trip",
      apps: {},
      input: { type: "object", properties: {}, additionalProperties: false },
      nodes: [],
      edges: [],
      output: {},
    },
    {},
    {},
  );
  if (!compiled.ok) throw new Error("Fixture did not compile");
  const run = {
    source: "key" as const,
    initiatedBy: {
      kind: "key" as const,
      keyId: "morel",
      grantorMemberId: "owner-a",
    },
    plan: compiled.plan,
    computerId: null,
    teamId: "team-a",
  };
  expect(runtime.preparationFromRun(run, "workflows-a")).toEqual({
    initiatedBy: run.initiatedBy,
    source: "key",
    plan: run.plan,
    computerId: null,
    libraryInstallationId: "workflows-a",
  });
  // Absent an explicit installation, the Team id stands in, same as an Agent run.
  expect(runtime.preparationFromRun(run, undefined)).toEqual({
    initiatedBy: run.initiatedBy,
    source: "key",
    plan: run.plan,
    computerId: null,
    libraryInstallationId: "team-a",
  });
  expect(() =>
    runtime.preparationFromRun(
      {
        ...run,
        initiatedBy: {
          kind: "agent",
          agentId: "a",
          sessionId: "s",
          grantorMemberId: "owner-a",
        },
      },
      "workflows-a",
    ),
  ).toThrow("Workflow run source does not match its initiator");
});

it("takes the highest effect bound to each installation, subgraphs included", async () => {
  const catalog: Catalog = {
    "app:reader": {
      methods: {
        peek: {
          description: "Read something",
          digest: "fixture-peek-v1",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          effect: "read",
          approval: "none",
          requires: [],
        },
      },
    },
    "app:writer": {
      methods: {
        poke: {
          description: "Write something",
          digest: "fixture-poke-v1",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          output: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          effect: "write",
          approval: "none",
          requires: [],
        },
      },
    },
  };
  const definition: WorkflowDefinition = {
    format: "fungi.workflow/v1",
    title: "Installation levels",
    apps: {
      reader: { appId: "app:reader" },
      reader2: { appId: "app:reader" },
      writer: { appId: "app:writer" },
    },
    input: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          maxItems: 1,
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    nodes: [
      {
        id: "peek-root",
        kind: "app",
        app: "reader",
        method: "peek",
        methodDigest: "fixture-peek-v1",
        values: {},
      },
      {
        id: "peek-root2",
        kind: "app",
        app: "reader2",
        method: "peek",
        methodDigest: "fixture-peek-v1",
        values: {},
      },
      {
        id: "loop",
        kind: "map",
        over: { node: "$input", port: "items" },
        body: "round",
        concurrency: 1,
        maxItems: 1,
      },
    ],
    edges: [],
    output: {
      peeked: { node: "peek-root", port: "ok" },
      peeked2: { node: "peek-root2", port: "ok" },
      looped: { node: "loop", port: "items" },
    },
    subgraphs: {
      round: {
        input: {
          type: "object",
          properties: {
            item: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            index: { type: "integer" },
          },
          required: ["item", "index"],
          additionalProperties: false,
        },
        nodes: [
          {
            id: "poke-sub",
            kind: "app",
            app: "writer",
            method: "poke",
            methodDigest: "fixture-poke-v1",
            values: {},
          },
        ],
        edges: [],
        output: { done: { node: "poke-sub", port: "ok" } },
      },
    },
  };
  // "reader" (root) and "writer" (subgraph) share one installation: its
  // highest bound effect wins. "reader2" names a second, read-only
  // installation that stays read.
  const bindings: Bindings = {
    reader: { appId: "app:reader", installationId: "inst-shared" },
    writer: { appId: "app:writer", installationId: "inst-shared" },
    reader2: { appId: "app:reader", installationId: "inst-read-only" },
  };
  const compiled = await compile(definition, catalog, bindings);
  if (!compiled.ok) throw new Error("Fixture did not compile");
  expect(runtime.planInstallationLevels(compiled.plan)).toEqual([
    { installationId: "inst-read-only", level: "read" },
    { installationId: "inst-shared", level: "write" },
  ]);
});

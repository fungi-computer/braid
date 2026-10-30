import * as S from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  nodeEventSchema,
  type NodeEvent,
  type NodeAdmissionResult,
} from "../execution.js";
import * as z from "zod";
import {
  bindingsSelectionSchema,
  workflowBindingSchema,
} from "../git-access.js";
import type { WatchdogSqliteOwner } from "@fungi.computer/watchdog";
import { canonicalJson, contentDigest } from "../index.js";
import { createTriggerPlans } from "./trigger-plans.js";
import {
  preparationFromRun,
  type WorkflowRunAuthority,
  type WorkflowRunPreparation,
} from "./run-authority.js";
import type { RunCeiling } from "./run-ceiling.js";
import { createTriggerRunReservations } from "./trigger-run-reservations.js";
import type { ArmedWorkflowTrigger } from "./trigger-owner.js";
import { createGraphWorkflowRuns } from "./graph-run-store.js";
import {
  graphRunSchema,
  graphTriggerProvenanceSchema,
  workflowRunContextSchema,
  type WorkflowRunContext,
  type GraphRun,
  type GraphPublication,
  type GraphTriggerProvenance,
  type WorkflowRunDelivery,
} from "./graph-contract.js";
import {
  resolveWorkflowNode,
  type StoredWorkflowNode,
} from "./graph-dispatch.js";
import type {
  WorkflowAppCall,
  WorkflowAppCallResult,
  WorkflowCatalogEntry,
  WorkflowTriggerAdmission,
} from "./ports.js";
import {
  compileForMember,
  graphStartRequestSchema,
  memberRunIdentity,
  type GraphStartRequest,
} from "./graph-start.js";
/** The member can supply a plan, never stored authority or a captured ceiling. */
export const memberCompiledGraphStartSchema = graphRunSchema.mapFields(
  Struct.omit([
    "teamId",
    "actorId",
    "trigger",
    "publication",
    "ceiling",
    "libraryInstallationId",
    "source",
    "initiatedBy",
  ]),
);

const publisherGranted = (
  entries: readonly WorkflowCatalogEntry[],
  installationId: string,
): boolean =>
  entries.some(
    (entry) =>
      entry.installationId === installationId &&
      entry.workflowPublishGranted === true &&
      entry.capabilities?.includes("workflow.publish") === true,
  );

/** Host-resolved identity of one active installed App node execution. */
export type WorkflowNodeAdmission = Pick<
  StoredWorkflowNode,
  "installationId" | "appId" | "method" | "methodDigest" | "computerId"
> & {
  teamId: string;
  memberId: string;
  context: WorkflowRunContext;
};
const workflowNodeTargetSchema = z.lazy(() =>
  z.strictObject({
    installationId: z.string().min(1).max(256),
    method: z.string().min(1).max(256),
  }),
);

/**
 * The one Workflow run owner: graph runs, their captured authority, trigger
 * reservations and revocation. Every run, Storyboard included, is a graph run.
 */
export function createTeamWorkflowRuns(options: {
  sql: WatchdogSqliteOwner["sql"];
  transactionSync: <T>(body: () => T) => T;
  teamId: () => string;
  /** Host-owned wall clock; deterministic native journeys may supply their clock. */
  now?: () => number;
  admission: () => "active" | "suspended";
  errors: Readonly<{
    app(code: "denied" | "invalid" | "unavailable"): Error;
    suspended(): Error;
  }>;
  /** Required host admission/capture after compilation; callers cannot supply ceilings. */
  authority: WorkflowRunAuthority;
  member: (actorId: string) => Promise<{ membershipVersion: number }>;
  /** Arms prompt delivery of the Computer cleanup a revocation queued. */
  wake: () => void;
  /** Graph node App calls, made as the member the run acts for. */
  callWorkflowApp: (
    memberId: string,
    call: WorkflowAppCall,
  ) => Promise<WorkflowAppCallResult>;
  /** Whether a member may pin this Computer to a run they start. */
  memberComputer: (memberId: string, computerId: string) => Promise<boolean>;
  /** The App methods this member's Workflows may call, admitted now. */
  catalog: (memberId: string) => Promise<readonly WorkflowCatalogEntry[]>;
  /** A current member answering a review, and whether they own the Team. */
  reviewer: (memberId: string) => Promise<{ isOwner: boolean }>;
  /** Whether this member may have run endings reported to the Agent Session. */
  admitDelivery: (
    memberId: string,
    delivery: WorkflowRunDelivery,
  ) => Promise<boolean>;
  terminateGraphRun: (runId: string) => Promise<"cancelled" | "terminal">;
}) {
  const { sql } = options;
  const graph = createGraphWorkflowRuns(options);
  const triggerReservations = createTriggerRunReservations(options);
  sql.exec(`CREATE TABLE IF NOT EXISTS hub_workflow_run_cleanups (
    run_id TEXT PRIMARY KEY REFERENCES hub_graph_runs(run_id), computer_id TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
  ) STRICT`);
  const triggerPlans = createTriggerPlans(sql);
  const admitGraphMember = async (
    memberId: string,
    computerId: string | null,
    delivery?: WorkflowRunDelivery,
  ) => {
    if (options.admission() !== "active") throw options.errors.suspended();
    await options.member(memberId);
    if (
      computerId !== null &&
      !(await options.memberComputer(memberId, computerId))
    )
      throw options.errors.app("denied");
    if (
      delivery !== undefined &&
      !(await options.admitDelivery(memberId, delivery))
    )
      throw options.errors.app("denied");
  };
  /** A report names its Workflows library, so only a library run may declare one. */
  const requireDeliveryLibrary = (
    delivery: WorkflowRunDelivery | undefined,
    libraryInstallationId: string | undefined,
  ) => {
    if (delivery !== undefined && libraryInstallationId === undefined)
      throw options.errors.app("invalid");
  };
  const captureGraph = async (preparation: WorkflowRunPreparation) => {
    if (options.admission() !== "active") throw options.errors.suspended();
    const admitted = await options.authority.resolve(preparation);
    const memberId =
      preparation.initiatedBy.kind === "member"
        ? preparation.initiatedBy.memberId
        : preparation.initiatedBy.grantorMemberId;
    if (admitted.kind !== "admitted" || admitted.actor.memberId !== memberId)
      throw options.errors.app("denied");
    if (options.admission() !== "active") throw options.errors.suspended();
    return admitted.ceiling;
  };
  const startCompiled = (
    preparation: WorkflowRunPreparation,
    request: Pick<GraphStartRequest, "requestId" | "input" | "delivery">,
    identity: Awaited<ReturnType<typeof memberRunIdentity>>,
    ceiling: RunCeiling,
    trigger?: GraphTriggerProvenance,
    publication?: GraphPublication,
    libraryInstallationId?: string,
  ) => {
    const memberId =
      preparation.initiatedBy.kind === "member"
        ? preparation.initiatedBy.memberId
        : preparation.initiatedBy.grantorMemberId;
    let run: GraphRun = {
      teamId: options.teamId(),
      actorId: memberId,
      runId: identity.runId,
      requestId: identity.requestId,
      computerId: preparation.computerId,
      plan: preparation.plan,
      input: request.input,
      ceiling,
      source: preparation.source,
      initiatedBy: preparation.initiatedBy,
    };
    if (trigger !== undefined) {
      const provenance = S.decodeUnknownSync(graphTriggerProvenanceSchema)(
        trigger,
        { onExcessProperty: "error" },
      );
      if (provenance.armedBy !== memberId) throw options.errors.app("denied");
      run = { ...run, trigger: provenance };
    }
    if (publication !== undefined) run = { ...run, publication };
    if (libraryInstallationId !== undefined)
      run = { ...run, libraryInstallationId };
    if (request.delivery !== undefined)
      run = { ...run, delivery: request.delivery };
    const result = graph.startCompiled(run);
    return {
      kind: result,
      runId: identity.runId,
      planDigest: preparation.plan.planDigest,
    };
  };
  const terminalTriggerRun = (
    rawRunId: string,
    outcome: "terminal" | "cancelled" = "terminal",
  ): void => {
    const runId = z.string().min(1).max(256).parse(rawRunId);
    options.transactionSync(() => {
      const run = graph.read(runId);
      if (run === null) return;
      graph.markTerminal(runId, outcome);
      triggerReservations.terminalTriggerRun(runId);
      if (run.computerId !== null)
        sql.exec(
          "INSERT OR IGNORE INTO hub_workflow_run_cleanups(run_id,computer_id) VALUES(?,?)",
          runId,
          run.computerId,
        );
    });
  };
  /** Every Installation a stored run acts through: plan bindings and its library. */
  const runInstallations = (run: GraphRun): ReadonlySet<string> =>
    new Set(
      [
        ...Object.values(run.plan.bindings).map((binding) =>
          "installationId" in binding ? binding.installationId : undefined,
        ),
        run.libraryInstallationId,
        run.publication?.installationId,
        run.trigger?.libraryInstallationId,
      ].filter((id): id is string => id !== undefined),
    );
  /**
   * Cancel matching active runs in one transaction: reviews close, trigger
   * reservations settle and Computer cleanup is queued. Every later node
   * admission, review answer and Git pass for the run then refuses.
   */
  const revoke = (matches: (run: GraphRun) => boolean): void => {
    const revoked = options.transactionSync(() => {
      const runs = graph.active().filter(matches);
      for (const run of runs) terminalTriggerRun(run.runId, "cancelled");
      return runs.length;
    });
    if (revoked > 0) options.wake();
  };
  const workflowRunOutcome = (rawRunId: string) =>
    graph.outcome(z.string().min(1).max(256).parse(rawRunId));
  const admitWorkflowNode = (
    rawContext: WorkflowRunContext,
    rawTarget: { installationId: string; method: string },
  ): WorkflowNodeAdmission | null => {
    const context = S.decodeUnknownSync(workflowRunContextSchema)(rawContext, {
      onExcessProperty: "error",
    });
    const target = workflowNodeTargetSchema.parse(rawTarget);
    const run = graph.read(context.runId);
    if (
      options.admission() !== "active" ||
      run?.teamId !== options.teamId() ||
      workflowRunOutcome(context.runId) !== "active"
    )
      return null;
    const resolved = resolveWorkflowNode(run, { ...context, ...target });
    if (resolved === null || !("workflowId" in resolved)) return null;
    const { installationId, appId, method, methodDigest, computerId } =
      resolved;
    // Host-only call metadata, including the captured ceiling, is not invocation context.
    const storedContext = S.decodeUnknownSync(workflowRunContextSchema)(
      resolved,
    );
    if (canonicalJson(context) !== canonicalJson(storedContext)) return null;
    const execution = graph
      .events(run.runId)
      .slice()
      .reverse()
      .find(
        (event) =>
          event.graphId === context.graphId &&
          event.nodeId === context.nodeId &&
          event.iteration === context.iteration,
      );
    if (execution?.state !== "running" || execution.poll !== context.poll)
      return null;
    return {
      teamId: run.teamId,
      memberId: run.actorId,
      computerId,
      installationId,
      appId,
      method,
      methodDigest,
      context: storedContext,
    };
  };
  const cancellations = new Map<
    string,
    Promise<{ kind: "cancelled" | "terminal" }>
  >();
  return {
    graph,
    /** Every node kind rechecks the stored run; completion cleanup stays with the root engine. */
    async recheckGraphNode(raw: NodeEvent): Promise<NodeAdmissionResult> {
      const event = S.decodeUnknownSync(nodeEventSchema)(raw, {
        onExcessProperty: "error",
      });
      const run = graph.read(event.runId);
      if (
        run?.teamId !== options.teamId() ||
        options.admission() !== "active" ||
        graph.outcome(event.runId) !== "active"
      )
        return { kind: "refused", code: "revoked" };
      const definition =
        event.graphId === undefined
          ? run.plan.definition
          : run.plan.definition.subgraphs?.[event.graphId];
      if (
        event.state !== "running" ||
        !definition?.nodes.some((node) => node.id === event.nodeId)
      )
        return { kind: "refused", code: "unknown_method" };
      const libraryInstallationId =
        run.publication?.installationId ??
        run.libraryInstallationId ??
        run.trigger?.libraryInstallationId;
      const preparation = preparationFromRun(run, libraryInstallationId);
      const decision = await options.authority.recheckRun(preparation);
      if (decision.kind === "refused")
        graph.recordEvent({
          ...event,
          state: "failed",
          refusal: decision.code,
          errorMessage: decision.code.replaceAll("_", " "),
        });
      return decision;
    },
    /** Recompile the member plan against live catalog, then capture before storage. */
    async startMemberGraph(
      memberId: string,
      raw: unknown,
      libraryInstallationId?: string,
    ) {
      const request = S.decodeUnknownSync(memberCompiledGraphStartSchema)(raw, {
        onExcessProperty: "error",
      });
      requireDeliveryLibrary(request.delivery, libraryInstallationId);
      await admitGraphMember(memberId, request.computerId, request.delivery);
      const entries = await options.catalog(memberId);
      const bindings = Object.fromEntries(
        Object.entries(request.plan.bindings).map(([name, binding]) => [
          name,
          "installationId" in binding ? binding.installationId : binding,
        ]),
      );
      const compiled = await compileForMember(entries, {
        requestId: request.requestId,
        definition: request.plan.definition,
        bindings,
        input: request.input,
      });
      if (
        compiled.kind !== "compiled" ||
        canonicalJson(compiled.plan) !== canonicalJson(request.plan)
      )
        throw options.errors.app("denied");
      let preparation: WorkflowRunPreparation = {
        initiatedBy: { kind: "member", memberId },
        source: "manual",
        plan: compiled.plan,
        computerId: request.computerId,
      };
      if (libraryInstallationId !== undefined)
        preparation = { ...preparation, libraryInstallationId };
      const ceiling = await captureGraph(preparation);
      let run: GraphRun = {
        ...request,
        plan: compiled.plan,
        teamId: options.teamId(),
        actorId: memberId,
        ceiling,
        source: preparation.source,
        initiatedBy: preparation.initiatedBy,
      };
      if (libraryInstallationId !== undefined)
        run = { ...run, libraryInstallationId };
      return graph.startCompiled(run);
    },
    ...triggerReservations,
    workflowRunOutcome,
    admitWorkflowNode,
    /** Up to 50 runs of one installation, newest first; `actorId` narrows to one viewer. */
    listRuns(installationId: string, actorId?: string, workflowId?: string) {
      let filter: Parameters<typeof graph.list>[0] = { installationId };
      if (actorId !== undefined) filter = { ...filter, actorId };
      if (workflowId !== undefined) filter = { ...filter, workflowId };
      return graph.list(filter);
    },
    bindTriggerRun(
      reservationId: string,
      rawRunId: string,
    ): "bound" | "replay" | "conflict" {
      const runId = z.string().min(1).max(256).parse(rawRunId);
      if (graph.read(runId) === null) return "conflict";
      return options.transactionSync(() => {
        const result = triggerReservations.bindTriggerRun(reservationId, runId);
        if (result !== "conflict" && graph.outcome(runId) !== "active")
          triggerReservations.terminalTriggerRun(runId);
        return result;
      });
    },
    terminalTriggerRun,
    async cancel(
      memberId: string,
      rawRunId: string,
    ): Promise<
      { kind: "cancelled" | "terminal" } | { kind: "refused"; reason: "denied" }
    > {
      const runId = z.string().min(1).max(256).parse(rawRunId);
      await options.member(memberId);
      const run = graph.read(runId);
      if (
        run === null ||
        (run.actorId !== memberId &&
          !(await options.reviewer(memberId)).isOwner)
      )
        return { kind: "refused", reason: "denied" };
      const prior = graph.outcome(runId);
      if (prior === "terminal" || prior === "cancelled") return { kind: prior };
      const pending = cancellations.get(runId);
      if (pending !== undefined) return pending;
      const cancellation = (async () => {
        const outcome = await options.terminateGraphRun(runId);
        terminalTriggerRun(runId, outcome);
        return {
          kind:
            graph.outcome(runId) === "cancelled"
              ? ("cancelled" as const)
              : ("terminal" as const),
        };
      })();
      cancellations.set(runId, cancellation);
      try {
        return await cancellation;
      } finally {
        cancellations.delete(runId);
      }
    },
    pendingWorkflowRunCleanups(): {
      teamId: string;
      runId: string;
      computerId: string;
    }[] {
      return sql
        .exec(
          "SELECT run_id,computer_id FROM hub_workflow_run_cleanups WHERE acknowledged=0 ORDER BY run_id LIMIT 100",
        )
        .toArray()
        .map((raw) => {
          const row = z
            .object({ run_id: z.string(), computer_id: z.string() })
            .parse(raw);
          return {
            teamId: options.teamId(),
            runId: row.run_id,
            computerId: row.computer_id,
          };
        });
    },
    /** Delivery consumer calls this only after durable Computer revocation resolves. */
    acknowledgeWorkflowRunCleanup(rawRunId: string): void {
      const runId = z.string().min(1).max(256).parse(rawRunId);
      options.transactionSync(() => {
        sql.exec(
          "UPDATE hub_workflow_run_cleanups SET acknowledged=1 WHERE run_id=?",
          runId,
        );
      });
    },
    triggerPlans,
    /** Member-started generic graphs only; trigger starts use startCachedGraph instead. */
    async startGraph(
      memberId: string,
      raw: GraphStartRequest,
      computerId: string | null,
      libraryInstallationId?: string,
    ) {
      const request = S.decodeUnknownSync(graphStartRequestSchema)(raw, {
        onExcessProperty: "error",
      });
      requireDeliveryLibrary(request.delivery, libraryInstallationId);
      await admitGraphMember(memberId, computerId, request.delivery);
      const entries = await options.catalog(memberId);
      let publication: GraphPublication | undefined;
      if (request.published !== undefined) {
        if (
          libraryInstallationId === undefined ||
          !publisherGranted(entries, libraryInstallationId)
        )
          throw options.errors.app("denied");
        // The admitted publisher supplies its original immutable row, not a compiled plan.
        publication = {
          installationId: libraryInstallationId,
          workflowId: request.published.workflowId,
          commit: request.published.commit,
          digest: request.published.digest,
          armedBy: { kind: "member", memberId },
        };
        if (
          publication.digest !==
          (await contentDigest(S.decodeUnknownSync(S.Json)(request.definition)))
        )
          return {
            kind: "invalid" as const,
            issues: [
              {
                code: "schema",
                message: "Published definition digest does not match",
              },
            ],
          };
      }
      const compiled = await compileForMember(entries, request);
      if (compiled.kind === "invalid") return compiled;
      const identity = await memberRunIdentity(
        options.teamId(),
        memberId,
        request.requestId,
      );
      let preparation: WorkflowRunPreparation = {
        initiatedBy: { kind: "member", memberId },
        source: "manual",
        computerId,
        plan: compiled.plan,
      };
      if (libraryInstallationId !== undefined)
        preparation = { ...preparation, libraryInstallationId };
      const ceiling = await captureGraph(preparation);
      if (
        publication !== undefined &&
        !publisherGranted(
          await options.catalog(memberId),
          publication.installationId,
        )
      )
        throw options.errors.app("denied");
      return startCompiled(
        preparation,
        request,
        identity,
        ceiling,
        undefined,
        publication,
        libraryInstallationId,
      );
    },
    async startCachedGraph(
      binding: ArmedWorkflowTrigger,
      started: Pick<GraphStartRequest, "requestId" | "input"> & {
        triggerRepository?: string;
      },
      admission?: WorkflowTriggerAdmission,
    ) {
      const { triggerRepository, ...request } = started;
      await admitGraphMember(binding.armedBy, binding.computerId);
      const stored = triggerPlans.read(binding);
      if (stored?.refusal !== null)
        return {
          kind: "refused" as const,
          reason:
            stored?.refusal ?? "Compiled Workflow unavailable; re-arm required",
        };
      const entries = await options.catalog(binding.armedBy);
      if (!publisherGranted(entries, binding.installationId))
        return {
          kind: "refused" as const,
          reason: "Workflow publisher is no longer available; re-arm required",
        };
      if (
        Object.values(binding.bindings).some((selection) => {
          const installation =
            bindingsSelectionSchema.valueType.options[0].safeParse(selection);
          return (
            installation.success &&
            !entries.some((entry) => entry.installationId === installation.data)
          );
        })
      )
        return {
          kind: "refused" as const,
          reason: "Workflow is no longer valid for this member",
        };
      for (const selectedBinding of Object.values(stored.plan.bindings)) {
        // The closed namespace variant is admitted by live Git capture below.
        if (workflowBindingSchema.options[1].safeParse(selectedBinding).success)
          continue;
        if (!("installationId" in selectedBinding))
          return {
            kind: "refused" as const,
            reason: "Workflow is no longer valid for this member",
          };
        const { appId, installationId } = selectedBinding;
        const current = entries.find(
          (entry) =>
            entry.installationId === installationId && entry.appId === appId,
        );
        const pinned = stored.plan.catalog[appId];
        if (
          current === undefined ||
          pinned === undefined ||
          Object.entries(pinned.methods).some(
            ([name, method]) => current.methods[name]?.digest !== method.digest,
          ) ||
          Object.entries(pinned.events ?? {}).some(
            ([name, event]) => current.events?.[name]?.digest !== event.digest,
          )
        )
          return {
            kind: "refused" as const,
            reason: "Workflow is no longer valid for this member",
          };
      }
      const identity = await memberRunIdentity(
        options.teamId(),
        binding.armedBy,
        request.requestId,
      );
      let preparation: WorkflowRunPreparation = {
        initiatedBy: { kind: "member", memberId: binding.armedBy },
        source:
          stored.plan.definition.triggers?.find(
            (trigger) => trigger.id === binding.triggerId,
          )?.on === "schedule"
            ? "schedule"
            : "event",
        libraryInstallationId: binding.installationId,
        computerId: binding.computerId,
        plan: stored.plan,
      };
      if (triggerRepository !== undefined)
        preparation = { ...preparation, triggerRepository };
      const ceiling = await captureGraph(preparation);
      if (
        !publisherGranted(
          await options.catalog(binding.armedBy),
          binding.installationId,
        )
      )
        return {
          kind: "refused" as const,
          reason: "Workflow publisher is no longer available; re-arm required",
        };
      // Re-read after live admission/capture I/O: disarm or push invalidation wins.
      const current = triggerPlans.read(binding);
      if (
        current?.refusal !== null ||
        canonicalJson(current.plan) !== canonicalJson(stored.plan)
      )
        return {
          kind: "refused" as const,
          reason:
            current?.refusal ??
            "Compiled Workflow unavailable; re-arm required",
        };
      let trigger: GraphTriggerProvenance = {
        libraryInstallationId: binding.installationId,
        workflowId: binding.workflowId,
        commit: binding.commit,
        triggerId: binding.triggerId,
        armedBy: binding.armedBy,
      };
      if (binding.nodeGitAccess !== undefined)
        trigger = { ...trigger, nodeGitAccess: binding.nodeGitAccess };
      if (triggerRepository !== undefined)
        trigger = { ...trigger, repository: triggerRepository };
      return options.transactionSync(() => {
        // Different external bindings may share the compiled publication.
        // Check the binding's owning store after all capture I/O, in the same
        // transaction as the durable start, rather than invalidating its peers.
        if (admission !== undefined && !admission.admitBinding())
          return {
            kind: "refused" as const,
            reason: "Trigger binding is no longer armed",
          };
        const result = startCompiled(
          preparation,
          binding.delivery === undefined
            ? request
            : { ...request, delivery: binding.delivery },
          identity,
          ceiling,
          trigger,
          {
            installationId: binding.installationId,
            workflowId: binding.workflowId,
            commit: binding.commit,
            digest: binding.digest,
            armedBy: { kind: "member", memberId: binding.armedBy },
          },
          binding.installationId,
        );
        if (
          admission?.reservationId !== undefined &&
          (result.kind === "started" || result.kind === "replay") &&
          triggerReservations.bindTriggerRun(
            admission.reservationId,
            result.runId,
          ) === "conflict"
        )
          throw new Error("Trigger reservation binding conflict");
        return result;
      });
    },
    callWorkflowApp: options.callWorkflowApp,
    admitDelivery: options.admitDelivery,
    memberComputer: options.memberComputer,
    catalog: options.catalog,
    reviewer: options.reviewer,
    member: options.member,
    /** A removed member's runs end now; node admission would refuse them anyway. */
    revokeMember(rawMemberId: string): void {
      const memberId = z.string().min(1).max(256).parse(rawMemberId);
      revoke((run) => run.actorId === memberId);
    },
    /** Apps calls this with its permission change inside the shared transaction. */
    revokeInstallationInMutation(rawInstallationId: string): void {
      const installationId = z
        .string()
        .min(1)
        .max(256)
        .parse(rawInstallationId);
      revoke((run) => runInstallations(run).has(installationId));
    },
    /** A revoked Release ends every run whose frozen plan binds an affected App. */
    revokeReleaseInMutation(appIds: readonly string[]): void {
      const affected = new Set(
        z.array(z.string().min(1).max(256)).parse(appIds),
      );
      if (affected.size === 0) return;
      revoke((run) =>
        Object.values(run.plan.bindings).some(
          (binding) => "appId" in binding && affected.has(binding.appId),
        ),
      );
    },
    /** The kernel's lifecycle caller owns the transaction. Suspension ends every run. */
    onLifecycle(status: "active" | "suspended"): void {
      if (status === "suspended") revoke(() => true);
    },
  };
}

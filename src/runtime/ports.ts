import type { Pending } from "@fungi.computer/agar/backend-definition";
import type { RunCeiling } from "./run-ceiling.js";
import type { Catalog } from "../index.js";
import type * as Schema from "effect/Schema";
import type { GraphNodeContext, WorkflowRunContext } from "./graph-contract.js";

/** One installed App's methods as a member's Workflows may call them. */
export type WorkflowCatalogEntry = Readonly<{
  installationId: string;
  appId: string;
  displayName: string;
  icon?: string;
  /** Requests declared by the current verified Release, never installation grants. */
  capabilities?: RunCeiling["nodes"][number]["capabilities"];
  /** The host projects its current workflow.publish grant decision, not declaration metadata. */
  workflowPublishGranted?: boolean;
  /** Current workflow.run + approved WORKFLOWS/runGraph host decision; absent refuses. */
  workflowRunGranted?: boolean;
  methods: Catalog[string]["methods"];
  events?: NonNullable<Catalog[string]["events"]>;
}>;

/** One graph node's App call, as the run's frozen plan names it. */
export type WorkflowAppCall = (GraphNodeContext | WorkflowRunContext) &
  Readonly<{
    installationId: string;
    appId: string;
    method: string;
    methodDigest: string;
    input: Schema.Json;
    /** The run's pinned Computer, if any. */
    computerId: string | null;
    /** Host-captured operations from this stored run, never method input. */
    bindingCeiling: RunCeiling["nodes"][number]["bindings"];
  }>;

/** The engine's refusal vocabulary (Braid dispatch results). */
export type WorkflowAppCallResult =
  | Pending
  | Readonly<{ kind: "complete"; output: Schema.Json; costMilliunits: number }>
  | Readonly<{
      kind: "refused";
      code:
        | "not_granted"
        | "invalid_input"
        | "invalid_output"
        | "revoked"
        | "unknown_method";
    }>
  | Readonly<{ kind: "unavailable" }>;

/** Delivery belongs to the host; saved review state belongs to the runtime. */
export type ReviewPort = Readonly<{
  notify(review: import("../execution.js").GraphReview): Promise<void>;
  settle(
    key: Pick<
      import("../execution.js").GraphReview,
      "runId" | "nodeId" | "iteration"
    >,
    state: "answered" | "delivered" | "timed_out" | "closed",
  ): Promise<void>;
}>;

/** Host facts are admitted by the host, never decoded from Workflow input. */
export type NodeInvoker<Facts> = Readonly<{
  invoke(
    actor: import("@fungi.computer/puffball/app-method-runtime").HostActor,
    installationId: string,
    method: string,
    input: Schema.Json,
    facts: Facts,
  ): Promise<WorkflowAppCallResult>;
}>;

/** The host keeps its existing initiator and captured-grant representations. */
export type RunAuthority<Initiator, Ceiling> = Readonly<{
  resolve(initiator: Initiator): Promise<
    | Readonly<{
        kind: "admitted";
        actor: Extract<
          import("@fungi.computer/puffball/app-method-runtime").HostActor,
          { kind: "member" }
        >;
        ceiling: Ceiling;
      }>
    | Readonly<{ kind: "refused"; code: "not_granted" | "revoked" }>
  >;
  stillAttached(initiator: Initiator): Promise<boolean>;
}>;

/** Shared lifecycle owners use host admission and the host's existing alarm. */
export type WorkflowLifecyclePorts = Readonly<{
  authorize(memberId: string, installationId: string): Promise<void>;
  wake(due: number | null): Promise<void>;
  commit<A>(body: () => A): Promise<A>;
}>;

/** Existing start result; published-selection metadata is supplied by its host. */
export type GraphStartReply =
  | Readonly<{
      kind: "invalid";
      issues: readonly import("../validate.js").Issue[];
    }>
  | Readonly<{
      kind: "started" | "replay" | "conflict";
      runId: string;
      planDigest: string;
    }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** One start port; hosts retain the protected invocation context. */
export type RunStarter<
  Context,
  Request = import("./graph-start.js").GraphStartRequest,
  Reply = GraphStartReply,
> = Readonly<{
  start(context: Context, request: Request): Promise<Reply>;
}>;

/** An admitted host delivers reports to the originating session, idempotently. */
export type RunReporter<Initiator> = Readonly<{
  report(
    initiator: Initiator,
    runId: string,
    event:
      | Readonly<{
          kind: "first-review";
          review: import("../execution.js").GraphReview;
        }>
      | Readonly<{ kind: "complete"; output: Schema.Json }>
      | Readonly<{
          kind: "failed";
          error: Readonly<{ name: string; message: string }>;
        }>,
  ): Promise<void>;
}>;

/** An immutable published document resolved by its admitted host library. */
export type PublishedDefinition = Readonly<{
  workflowId: string;
  definition: import("../schema.js").WorkflowDefinition;
  commit: string;
  version: number | null;
  /** Original stored publication digest, validated by the host before compilation. */
  digest: string;
}>;
export type WorkflowPublicationSelector = Readonly<{
  workflowId: string;
}> &
  (Readonly<{ version: number }> | Readonly<{ commit: string }>);

/** Context holds the host-selected library and access; a saved copy is not admission. */
export type PublishedDefinitionPort<Context> = Readonly<{
  resolve(
    context: Context,
    selector: WorkflowPublicationSelector,
  ): Promise<PublishedDefinition | null>;
}>;

/** Transient host-issued Git capability; this context is never persisted or guest input. */
export type WorkflowPublicationContext = Readonly<{
  memberId: string;
  installationId: string;
  computerId: string;
  git: import("@fungi.computer/agar/git").GitBinding;
}>;

/** Only the operations the shared trigger owner consumes from the shared run owner. */
export type WorkflowTriggerRunPorts = Readonly<{
  member(memberId: string): Promise<{ membershipVersion: number }>;
  memberComputer(memberId: string, computerId: string): Promise<boolean>;
  catalog(memberId: string): Promise<readonly WorkflowCatalogEntry[]>;
  /** Whether this member may have run endings reported to the Agent Session. */
  admitDelivery(
    memberId: string,
    delivery: import("./graph-contract.js").WorkflowRunDelivery,
  ): Promise<boolean>;
  triggerPlans: ReturnType<
    typeof import("./trigger-plans.js").createTriggerPlans
  >;
  startCachedGraph(
    binding: import("./trigger-owner.js").ArmedWorkflowTrigger,
    request: Pick<
      import("./graph-start.js").GraphStartRequest,
      "requestId" | "input"
    > & {
      /** The firing event's repository, evaluated from the armed trigger. */
      triggerRepository?: string;
    },
  ): Promise<Exclude<GraphStartReply, { kind: "invalid" }>>;
}>;

/** Hosts retain their existing error vocabulary and denial classification. */
export type WorkflowErrorPort = Readonly<{
  denied(): Error;
  isDenied(cause: Error): boolean;
}>;

# Braid

Braid owns `fungi.workflow/v1` and its graph interpreter. The browser-safe root
exports validation, compilation, and portable execution contracts.
`validate(unknown, catalog)` decodes with Effect Schema and returns typed issues
for the editor. Expected schema and expression-syntax refusals become issues;
unexpected parser or traversal defects propagate rather than being reported as
author errors. `compile` returns either issues or a topologically ordered,
installation-bound plan and SHA-256 `planDigest`. `decodeExecutionPlan` checks
stored content against that identity and recompiles its domain invariants.
Compilation grants no authority.

`catalogMethods` omits declarations marked `hidden: true` before reading their
graph ports. Visible method digests remain unchanged; the discovery marker does
not decide direct-call permissions.

## Workers engine

`@fungi.computer/braid/cloudflare` exports `GraphWorkflow` and
`GraphWorkflowBindings`. A host subclasses the base, supplies its
`GRAPH_WORKFLOWS` binding, and implements `dispatcher(params)` and
`terminalTriggerRun(params)`. The dispatcher loads the host's admitted plan,
invokes App methods, records node events, and persists review waits. A host
admitting Code also overrides `codeExecution()` with its actual Mycelium
`Sandbox` and an explicitly captured `timeoutMs`. Hosts without this port refuse
Code with `code_execution_unavailable`. Hub and standalone hosts give Workflow
data transforms a 30,000 ms budget; this is independent of Agent policy. Local
workerd hosts set `WORKFLOW_CODE_LOCAL_DEV=true` to report that CPU limits are
not enforced; celld and deployed Workers forward the budget to the Loader.
Terminal cleanup runs through the host callback; Braid does not own grants, run
storage, Git admission, trigger reservations, cancellation requests, or
outboxes.

The root exports `GraphParams`, `NodeDispatcher`, `NodeCall`, `NodeEvent`,
`GraphReview`, `DispatchResult`, and their wire decoders without importing a
Workers runtime. App pending calls retain their stable idempotency key while
each poll has a distinct event identity. Retry attempts remain local to a poll.
Hosts must re-admit App calls using their own stored authority.

The portable root is checked with `skipLibCheck: false`. The Workers build
retains the Hub's existing `skipLibCheck: true`: Effect 4.0.2's `KeyValueStore`
declaration refers to DOM `Storage`, which the Workers type environment does not
provide. No ambient compatibility declaration is added; the native runtime tests
exercise the actual Workers implementation.

The Hub adapter consumes this same engine. Its native graph tests cover branch
selection, Pending polls, reviews, maps, and terminal cancellation. Those tests
establish Hub behavior; a standalone host must qualify its own bindings and
admission ports.

## V1 contract

- Run input ports use the reserved node `$input`. Each node also emits `after`.
  `after` is reserved for that ordering signal: App input/output schemas and
  Code input/output schemas and transform fields declaring it are refused,
  rather than silently overwritten.
- `admitRunInput(definition, raw)` fills absent property defaults and validates
  the resulting object with the supported projection. It returns
  `{kind: "accepted", input}` or `{kind: "invalid", issues}`; issues retain the
  validator's instance location and message. Explicit values are never replaced
  by defaults. Hosts record the admitted input, and triggers and graph execution
  use the same admission function.
- Durations are integer milliseconds, positive and at most seven days. Retry
  `attempts` includes the first attempt (1–5); external effects cannot retry.
- App and Code `values` and transform fields use Mapping: `{literal: Json}`,
  `{template: string}`, `{from: PortRef, path?: JsonPointer}`,
  `{coalesce: Mapping[]}`, `{object: Record<string, Mapping>}`,
  `{array: Mapping[]}`, or
  `{each: {over: Mapping, body: Mapping, maxItems: 1..50}}`. `each` exposes its
  current value/index as `$item.value` and `$item.index`; nested each
  expressions get their own item scope. The evaluator bounds materialization to
  64 KiB and 65536 visits. A missing required member makes the whole
  construction absent. Mustache owns interpolation parsing (`{{node.port}}`,
  without HTML escaping or execution); JSON Pointer owns path lookup. References
  establish dependencies.
- Object method inputs/outputs keep their property ports. Non-object values and
  unions use a single `value` port; the dispatcher still sends/receives the raw
  declared App value. A completion union containing required `error` objects
  exposes `ok` / `refused`, each carrying the entire declared record. Both sides
  retain their original schema constraints. App refusals route data; host
  admission refusals still fail the node. Apps do not reshape their APIs.
- App nodes may declare `gitAccess: {binding, repository, branches}` (a write
  branch ceiling) or `gitAccess: {binding, repository, access: "read"}` (read
  only, no push). This declaration enters the plan digest and contains no
  installation IDs. The member selects installations through
  `bindingsSelectionSchema`; an explicit `{kind: "team-source"}` binding selects
  a registered Team source. Compilation freezes the selected binding, including
  a target separate from the executing App. `resolveGitAccess` forms Agar's
  canonical installation-local or Team-source `RepositoryRef`; resolved scopes
  are `{repository: RepositoryRef, branches}` or
  `{repository: RepositoryRef, access: "read"}`. These data alone grant no
  authority: the host checks the starting human's captured ceiling and live
  policy, at the access's own scope, before minting a pass, and the pass's scope
  is always its admitted access. Read access may name `$trigger.repository`: an
  App-event trigger declares `repository`, a mapping over its event (for example
  `{from: {node: "$input", port: "payload"}, path: "/data/repository/name"}`),
  and the node's binding must be that trigger's App. Arming admits no Git; each
  fire resolves the event's one repository inside the emitting installation, and
  run start admits the grantor's live read access to exactly it. A manual run or
  another trigger has no trigger repository, so the step is refused. Branches
  are unique exact `refs/heads/...` names, bounded to 256 entries; globs and
  revision expressions are refused.
- Coalesce selects the first present, non-null branch. When every candidate
  comes from an inactive branch, the dependent node skips. An available fallback
  still runs, so alternative review choices merge with OR semantics.
- Code nodes declare `{id, kind: "code", source, input, output, values}`.
  `source` is a JavaScript function body, including its return; `input` and
  `output` use the same projection grammar and ports as App methods. `values`
  and incoming edges explicitly map the data available to the node. Exact
  source, schemas and mappings enter the plan digest. Source uses the existing
  256,000-byte whole-definition envelope; each schema retains its 20,000-byte
  and depth-16 bounds. Compilation never parses or executes JavaScript and adds
  no required App binding. Its only data capability is `env.INPUT.read({})`,
  returning a fresh copy of its mapped JSON. No Apps or network are available.
  The native step checkpoints the validated completion or a closed refusal,
  including the whole 64 KiB result envelope, with automatic retries disabled.
  Replay reads the checkpoint instead of rerunning JavaScript. Guest errors do
  not expose source, inputs, or raw sandbox causes in run events. Sandbox calls
  run inside an interruptible Effect; cancellation remains the host run owner's
  native instance termination, with no separate cancellation owner.
- A named `subgraphs` entry has the same input/nodes/edges/output contract as
  the root. Map body inputs are `{item, index}`. Recursive map bodies are
  refused. The entire definition, including bodies, is capped at 64 nodes / 256
  edges.
- `after` edges order or gate any node. Other connected inputs belong to App or
  Code ports; controls name their references in their own fields. Review's
  selected port carries its first shown item; a condition's selected port is a
  signal.
- Unreachable means unable to contribute to a graph output or a write/external
  method. Skipped branch outputs may be absent; this is not an output error.
- The static expanded estimate budgets three durable operations per node plus
  all map items and three operations per item for creation, completion and
  parent notification, capped at 800 (headroom below Cloudflare's 1024).
- The catalog is keyed by portable App ID and preserves T1's method shape
  (description, input/output, effect, approval, requires), with a catalog-owned
  `digest` per method. Bindings must match the declared App ID. Only used
  methods enter the consent manifest. Used method and event catalogs, including
  event-only emitter installations, enter the plan.
- `pending: true` opts a method into Agar's shared Pending result. The catalog
  exposes only the completed output ports of the emitted Output/Pending union;
  its digest covers the original input/output declarations and the opt-in flag.
  Ordinary methods omit the flag and keep their existing digests. The Hub maps
  canonical Pending to engine Pending only for opted-in methods, with integer
  `retryAfterMs` from 1000 to 60000. Pending never becomes graph output and
  polls retain the same run/node/iteration key.

## Reviews

- A review shows ports to a person and waits up to its timeout. Without
  `choices` it approves or rejects (ports `approved` / `rejected`). With
  `choices` (two to eight `{id, label}`), the reviewer picks one; each choice id
  is an output port carrying the first shown item, so branches follow the pick.

## Triggers

- `triggers` (optional, at most 8, root graph only) declares what may start a
  run besides a person or Agent. For `{id, on: "webhook"}`, the host owns the
  URL, secret and signature scheme, so the format names no provider.
- Inside a trigger, `$input` is the verified event (`body`, a stable non-secret
  `eventId`, allowlisted `headers`), not the run input. Every port repeats on a
  redelivery, so a redelivery maps to the same input. `when` is an ordinary
  predicate over it; `input` maps it onto the run's declared input with ordinary
  mappings. Without `input`, the body itself must be the run input. Triggers are
  part of the plan identity.
- `validate` refuses references outside the event, unmapped required run input,
  undeclared fields and mismatched literals (`trigger` issues). `triggerRun`
  returns `start` with input checked against `definition.input`, `ignored` when
  `when` is false, or a typed refusal. `triggerRequestId` turns (scope, trigger,
  event id) into the idempotent start key.
- A schedule declares
  `{id, on: "schedule", cron: {expression, timeZone}, input?}`. Almanac
  validates the cadence; consecutive occurrences must be at least five minutes
  apart. Its event exposes `scheduledAt` (ISO) and `eventId`; without a mapping
  that event is the run input. The Team arms published definitions as a member,
  rechecks access at each firing, and coalesces missed ticks.

- An App event declares
  `{id, on: "event", app, event, eventDigest, when?, input?}`. `catalogEvents`
  pins the original emitted payload schema; rewording its description preserves
  the digest. Its event ports are `payload` (the full envelope) and `eventId`.
  Missing declarations and changed digests refuse compilation; a cached trigger
  checks those digests against the live catalog before starting.
- Event mappings prove assignability for the payload or required object paths
  within it, plus literals, templates and coalesce. JSON Pointer spelling uses
  the maintained encoder. Optional paths, array indexing and unsupported schema
  assertions remain unproven and are refused. An emitted `const` projects to an
  enum for checking, while the digest retains the original schema. Schedule and
  webhook mapping behavior is unchanged.

## Schema scope

App projections have the same 20 KB / depth-16 envelope as T1. V1 accepts the
JSON Schema vocabulary in `PortSchema`: primitive types, standard formats from
the maintained validator registry and Fungi media annotations, enum/const,
object properties/required/additionalProperties, array items/counts, string
lengths/patterns, number bounds (including exclusive bounds), nonempty
anyOf/oneOf, and title/description/default annotations. Effect decodes that
vocabulary; `@cfworker/json-schema` validates runtime values without dynamic
code generation. Standard formats remain text ports and validate instances;
Fungi image/video/file annotations remain distinct media ports. Assignability is
conservative subset checking. Unsupported assertions (for example `$ref` or
conditionals) produce a schema issue rather than a guessed connection. This is
not a general JSON Schema implication solver.

`test/anime.fixture.ts` models beats → map{generate → review → optional
animate}. Its Prints catalog and digests are explicitly fake; it does not
establish the shipped Storyboard template's parity, installed App methods,
grants, costs or production execution.

Run `pnpm --dir packages/braid test` for `braid-validate`.

`apps/hub/test/graph-declared-ports.native.mjs` uses the actual Prints
declarations and input parsers with a provider-boundary fake. It exercises both
animate choices, keep/reject, declared refusal, Pending replay, and raw
scalar/array method values through the native graph engine; it makes no provider
calls.

## Host runtime

`@fungi.computer/braid/runtime` owns the saved graph run, node event and review
records. Hosts provide the Watchdog SQLite owner to `createGraphWorkflowRuns`;
the store preserves immutable plans, idempotent starts and accepted review
answers across owner recreation. `resolveWorkflowNode` and `planNodeCall`
resolve calls against that saved plan. Hosts retain membership, installation,
Git and native Workflow admission and delivery. Stored rows alone grant no
permission to run an App method or answer a review.

The runtime entrypoint also owns `createTeamWorkflowTriggers`,
`createWorkflowSchedules`, `createWorkflowEventRouter`, immutable trigger plans
and run reservations. Hosts supply publication resolution, existing denial
errors, live authorization, transaction and alarm ports; the runtime owns saved
trigger state and occurrence identity. `PublishedDefinitionPort` resolves an
exact version or commit with host-issued access. A copied document never grants
that access.

A review answer is `{approved: boolean}` or `{choice: string, note?: string}`.
Choice notes are bounded to 1,000 characters. A completed review retains the
shown item on its selected outcome port and also emits `choice` (the actual
selected outcome) and `note` (an empty string when absent). Those two ports and
`after` are reserved and cannot be named choices. Downstream nodes can use these
saved outputs, including a subsequent Repeat round.

## Bounded Repeat

A Repeat node declares `{id, kind: "repeat", body, maxRounds, until}`.
`maxRounds` is an integer from one to five. The body receives `item` from the
enclosing graph input, a zero-based `round`, and `previous`: an empty object on
the first round, then the preceding body output. The stop predicate reads the
completed body output through `$input`. It cannot reach into another graph.

When the predicate becomes true, the node emits the body output on `result`.
When all rounds finish without satisfying it, the node emits the last output on
`exhausted`. The other outlet stays inactive. Both paths emit `after`; failed
children fail the Repeat rather than fabricating a successful result.

Validation checks body input and output compatibility, references, recursive
groups, and the bounded execution budget. The Cloudflare interpreter runs each
round as a durable child with its own review identity and passes saved feedback
into the next round. Map items retain their order when their bodies contain a
Repeat. `apps/hub/test/graph-workflow-repeat.native.mjs` exercises the real
engine and run owner with a fixture App dispatcher; it calls no media provider.

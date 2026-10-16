import * as S from "effect/Schema";
import * as Effect from "effect/Effect";
import { executeCode, type CodeExecution } from "../code-execution.js";
import type { ResultRow } from "@fungi.computer/gills";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  decodeExecutionPlan,
  admitRunInput,
  parseProjection,
  methodInputValue,
  methodOutputValues,
  methodOutputPorts,
  accepts,
  evaluateMapping,
  evaluatePredicate,
  readPort,
  contentDigest,
  type Json,
  type Graph,
  type Node,
  type Mapping,
  type Predicate,
  type PortRef,
  type Values,
} from "../index.js";
import {
  graphParamsSchema,
  nodeAdmissionResultSchema,
  reviewAnswerSchema,
  reviewAnswerOutput,
  dispatchResultSchema,
  type GraphParams,
  type NodeDispatcher,
  type NodeEvent,
  type NodeCall,
} from "../execution.js";
const resultLimit = 64 * 1024;
/** Durable steps one engine instance may take (Cloudflare's limit, with headroom). */
const INSTANCE_STEP_LIMIT = 1000;
type AppStep =
  | Readonly<{ pending: number }>
  | Readonly<{ ports: Readonly<Record<string, Json>> }>;
const reviewChoices = (node: Extract<Node, { kind: "review" }>) =>
  node.choices === undefined
    ? {}
    : { choices: node.choices.map((choice) => choice.id) };
const exceedsResultLimit = (output: Readonly<Record<string, Json>>) =>
  new TextEncoder().encode(JSON.stringify(output)).length > resultLimit;

// Ordering dependencies include optional expressions. Only required references
// propagate branch skips. Coalesce skips only when all its alternatives are
// inactive; exists and templates still observe absence.
function mappingBranchAbsent(
  mapping: Mapping,
  values: Values,
  absent: (ref: PortRef) => boolean,
): boolean {
  if ("from" in mapping) return absent(mapping.from);
  if ("coalesce" in mapping)
    return (
      mapping.coalesce.length > 0 &&
      mapping.coalesce.every((part) =>
        mappingBranchAbsent(part, values, absent),
      )
    );
  if ("object" in mapping)
    return Object.values(mapping.object).some((part) =>
      mappingBranchAbsent(part, values, absent),
    );
  if ("array" in mapping)
    return mapping.array.some((part) =>
      mappingBranchAbsent(part, values, absent),
    );
  if ("each" in mapping) {
    if (mappingBranchAbsent(mapping.each.over, values, absent)) return true;
    const over = evaluateMapping(mapping.each.over, values);
    return (
      S.is(S.Array(S.Json))(over) &&
      over.some((value, index) =>
        mappingBranchAbsent(
          mapping.each.body,
          { ...values, $item: { value, index } },
          (ref) => ref.node !== "$item" && absent(ref),
        ),
      )
    );
  }
  return false;
}
function predicateBranchAbsent(
  test: Predicate,
  values: Values,
  absent: (ref: PortRef) => boolean,
): boolean {
  if (test.op === "exists") return false;
  if ("tests" in test)
    return test.tests.some((part) =>
      predicateBranchAbsent(part, values, absent),
    );
  if ("test" in test) return predicateBranchAbsent(test.test, values, absent);
  return (
    mappingBranchAbsent(test.left, values, absent) ||
    mappingBranchAbsent(test.right, values, absent)
  );
}
function nodeArguments(
  graph: Graph,
  node: Extract<Node, { kind: "app" | "code" }>,
  values: Values,
) {
  const args: Record<string, Json> = {};
  for (const edge of graph.edges)
    if (edge.to.node === node.id && edge.to.port !== "after") {
      const value = readPort(values, edge.from);
      if (value !== undefined) args[edge.to.port] = value;
    }
  for (const [key, mapping] of Object.entries(node.values)) {
    const value = evaluateMapping(mapping, values);
    if (value !== undefined) args[key] = value;
  }
  return args;
}
function requiredRefs(graph: Graph, node: Node): readonly PortRef[] {
  const edges = graph.edges
    .filter((edge) => edge.to.node === node.id)
    .map((edge) => edge.from);
  switch (node.kind) {
    case "transform":
    case "condition":
      return edges;
    case "review":
      return [...edges, ...node.show];
    case "map":
      return [...edges, node.over];
    case "repeat":
      return [...edges, { node: "$input", port: "item" }];
    case "app":
    case "code":
    case "wait":
      return edges;
  }
}
const childCompletionSchema = S.Union([
  S.Struct({ output: S.JsonObject }),
  S.Struct({ refusal: S.String }),
]);
/** Native WorkflowStep owns checkpoints, retries, sleeps and event waits. */
export async function runGraphWorkflow(
  step: WorkflowStep,
  params: GraphParams,
  instanceId: string,
  workflows: Workflow<GraphParams>,
  dispatcher: NodeDispatcher,
  codeExecution?: CodeExecution,
): Promise<Readonly<Record<string, Json>>> {
  const checked = S.decodeUnknownSync(graphParamsSchema)(params, {
    onExcessProperty: "error",
  });
  if (checked.kind === "run" && checked.runId !== instanceId)
    throw new NonRetryableError("run_identity_mismatch");
  const stored = await dispatcher.loadRun(checked.teamId, checked.runId);
  const plan = await decodeExecutionPlan(stored.plan);
  if (checked.planDigest !== plan.planDigest)
    throw new NonRetryableError("plan_identity_mismatch");
  const graph: Graph | undefined =
    checked.kind === "run"
      ? plan.definition
      : plan.definition.subgraphs?.[checked.body];
  if (!graph) throw new NonRetryableError("unknown_subgraph");
  const admitted = admitRunInput(
    graph,
    checked.kind === "run" ? stored.input : checked.input,
  );
  if (admitted.kind === "invalid") throw new NonRetryableError("invalid_input");
  const input = admitted.input;
  const iteration = checked.kind === "run" ? "0" : checked.iteration;
  const position = checked.kind === "run" ? [] : checked.position;
  /** Steps inside a loop say which item or round they belong to. */
  const placed = <T extends object>(record: T) =>
    position.length === 0 ? record : { ...record, position };
  const values: Record<string, Readonly<Record<string, Json>>> = {};
  values.$input = input;
  const baseEvent = (
    node: Pick<Node, "id">,
    state: NodeEvent["state"],
    attempt = 0,
    poll?: number,
  ): NodeEvent => {
    let event: NodeEvent = {
      runId: checked.runId,
      nodeId: node.id,
      iteration,
      state,
      attempt,
    };
    if (poll !== undefined) event = { ...event, poll };
    return checked.kind === "map-item"
      ? placed({ ...event, graphId: checked.body })
      : event;
  };
  const complete = async (
    node: Node,
    output: Readonly<Record<string, Json>>,
    attempt = 0,
    costMilliunits = 0,
    durationMs = 0,
    poll?: number,
    row?: ResultRow,
  ) => {
    const ports = { ...output, after: true };
    if (exceedsResultLimit(ports))
      return fail(node, "step_result_limit", undefined, poll);
    const event = {
      ...baseEvent(node, "complete", attempt, poll),
      costMilliunits,
      durationMs,
      outputDigest: await contentDigest(ports),
      output,
    };
    await dispatcher.recordEvent(row === undefined ? event : { ...event, row });
    return ports;
  };
  const fail = async (
    node: Pick<Node, "id">,
    code: string,
    cause?: unknown,
    poll?: number,
  ): Promise<never> => {
    await dispatcher.recordEvent({
      ...baseEvent(node, "failed", 0, poll),
      refusal: code,
      errorMessage: code.replaceAll("_", " "),
    });
    const refusal = new NonRetryableError(code);
    if (cause !== undefined) refusal.cause = cause;
    throw refusal;
  };
  const skipped = new Set<string>();
  // Steps the static estimate did not spend may go to polling pending calls.
  const pollBudget = INSTANCE_STEP_LIMIT - plan.estimatedSteps;
  let pollSteps = 0;
  const branchAbsent = (ref: PortRef) => {
    const producer = graph.nodes.find((node) => node.id === ref.node);
    const app =
      producer?.kind === "app" ? plan.definition.apps[producer.app] : undefined;
    const method =
      producer?.kind === "app" && app
        ? plan.catalog[app.appId]?.methods[producer.method]
        : undefined;
    const output = producer?.kind === "code" ? producer.output : method?.output;
    const appOutlets = output
      ? methodOutputPorts(parseProjection(output))
      : undefined;
    const completionBranch =
      output &&
      (output.anyOf !== undefined || output.oneOf !== undefined) &&
      appOutlets &&
      Object.hasOwn(appOutlets, "ok") &&
      Object.hasOwn(appOutlets, "refused") &&
      (ref.port === "ok" || ref.port === "refused");
    return (
      skipped.has(ref.node) ||
      ((producer?.kind === "condition" ||
        producer?.kind === "review" ||
        producer?.kind === "repeat" ||
        completionBranch === true) &&
        readPort(values, ref) === undefined)
    );
  };
  for (const node of graph.nodes) {
    const name = `n:${node.id}:${iteration}`;
    const absentMapping =
      node.kind === "app" || node.kind === "code" || node.kind === "transform"
        ? Object.values(
            node.kind === "transform" ? node.fields : node.values,
          ).some((mapping) =>
            mappingBranchAbsent(mapping, values, branchAbsent),
          )
        : node.kind === "condition" &&
          predicateBranchAbsent(node.test, values, branchAbsent);
    if (requiredRefs(graph, node).some(branchAbsent) || absentMapping) {
      skipped.add(node.id);
      await step.do(name + ":skipped", async () => {
        await dispatcher.recordEvent(baseEvent(node, "skipped"));
        return null;
      });
      continue;
    }
    const admission = S.decodeUnknownSync(nodeAdmissionResultSchema)(
      await dispatcher.beforeNode(baseEvent(node, "running")),
      { onExcessProperty: "error" },
    );
    if (admission.kind === "refused") return fail(node, admission.code);
    switch (node.kind) {
      case "code": {
        if (!codeExecution) return fail(node, "code_execution_unavailable");
        const host = codeExecution;
        const outcome = await step.do(
          name,
          { retries: { limit: 0, delay: "1 second" } },
          async (ctx) => {
            await dispatcher.recordEvent(
              baseEvent(node, "running", ctx.attempt),
            );
            const args = nodeArguments(graph, node, values);
            const schema = parseProjection(node.input);
            const inputValue = methodInputValue(schema, args);
            if (inputValue === undefined || !accepts(schema, inputValue))
              return { kind: "refused", code: "invalid_input" } as const;
            const executionId = JSON.stringify([
              checked.runId,
              checked.kind === "map-item" ? checked.body : null,
              node.id,
              iteration,
            ]);
            return Effect.runPromise(
              executeCode(host, node, executionId, inputValue),
            );
          },
        );
        if (outcome.kind === "refused") return fail(node, outcome.code);
        values[node.id] = await step.do(name + ":complete", () =>
          complete(node, outcome.ports),
        );
        break;
      }
      case "app": {
        const app = plan.definition.apps[node.app];
        const binding = plan.bindings[node.app];
        const method = app
          ? plan.catalog[app.appId]?.methods[node.method]
          : undefined;
        if (!method || !binding || !("installationId" in binding))
          return fail(node, "unknown_method");
        const retries = node.retry
          ? node.retry.attempts - 1
          : method.effect === "external"
            ? 0
            : 3;
        const attemptCall = (poll: number) =>
          step.do(
            poll === 0 ? name : `${name}:poll:${String(poll)}`,
            {
              retries: {
                limit: retries,
                delay: "1 second",
                backoff: "exponential",
              },
            },
            async (ctx): Promise<AppStep> => {
              const start = Date.now();
              await dispatcher.recordEvent(
                baseEvent(node, "running", ctx.attempt, poll),
              );
              const args = nodeArguments(graph, node, values);
              const inputSchema = parseProjection(method.input);
              const inputValue = methodInputValue(inputSchema, args);
              if (inputValue === undefined || !accepts(inputSchema, inputValue))
                return fail(node, "invalid_input", undefined, poll);
              let call: NodeCall = {
                teamId: checked.teamId,
                runId: checked.runId,
                nodeId: node.id,
                iteration,
                poll,
                installationId: binding.installationId,
                method: node.method,
                methodSpec: method,
                input: inputValue,
                idempotencyKey: `${checked.runId}:${node.id}:${iteration}`,
              };
              if (checked.kind === "map-item")
                call = { ...call, graphId: checked.body };
              let dispatched;
              try {
                dispatched = await dispatcher.dispatch(call);
              } catch (cause) {
                await dispatcher.recordEvent({
                  ...baseEvent(node, "failed", ctx.attempt, poll),
                  refusal: "dispatch_failed",
                });
                throw cause;
              }
              let result;
              try {
                result = S.decodeUnknownSync(dispatchResultSchema)(dispatched, {
                  onExcessProperty: "error",
                });
              } catch (cause) {
                if (!S.isSchemaError(cause)) throw cause;
                return fail(node, "invalid_output", cause, poll);
              }
              if (result.kind === "refused")
                return fail(node, result.code, undefined, poll);
              if (result.kind === "pending") {
                await dispatcher.recordEvent(
                  baseEvent(node, "waiting", ctx.attempt, poll),
                );
                return { pending: result.retryAfterMs };
              }
              // W3 wires approval waits at the broker; a queue must never masquerade as a result.
              if (result.kind === "pending_approval")
                return fail(
                  node,
                  "pending_approval_requires_w3",
                  undefined,
                  poll,
                );
              const outputSchema = parseProjection(method.output);
              const ports = methodOutputValues(outputSchema, result.output);
              if (ports === undefined)
                return fail(node, "invalid_output", undefined, poll);
              return {
                ports: await complete(
                  node,
                  ports,
                  ctx.attempt,
                  result.costMilliunits,
                  Date.now() - start,
                  poll,
                  result.row,
                ),
              };
            },
          );
        // A pending App call is polled with the same idempotency key, within
        // the steps the plan's static estimate left for this instance.
        let outcome = await attemptCall(0);
        for (let poll = 1; "pending" in outcome; poll++) {
          if (pollSteps + 2 > pollBudget) return fail(node, "pending_budget");
          pollSteps += 2;
          await step.sleep(`${name}:wait:${String(poll)}`, outcome.pending);
          outcome = await attemptCall(poll);
        }
        values[node.id] = outcome.ports;
        break;
      }
      case "condition":
        values[node.id] = await step.do(name, () =>
          complete(node, {
            [evaluatePredicate(node.test, values) ? "true" : "false"]: true,
          }),
        );
        break;
      case "transform":
        values[node.id] = await step.do(name, async () => {
          const output: Record<string, Json> = {};
          for (const [key, mapping] of Object.entries(node.fields)) {
            const value = evaluateMapping(mapping, values);
            if (value === undefined) return fail(node, "missing_input");
            output[key] = value;
          }
          return complete(node, output);
        });
        break;
      case "wait": {
        await step.sleep(name, node.for);
        values[node.id] = await step.do(name + ":complete", () =>
          complete(node, {}),
        );
        break;
      }
      case "review": {
        const eventType =
          "review_" +
          (await contentDigest([instanceId, node.id, iteration])).slice(7);
        const expiresAt = await step.do(name + ":pending", async () => {
          const deadline = await dispatcher.openReview(
            placed({
              runId: checked.runId,
              nodeId: node.id,
              iteration,
              instanceId,
              eventType,
              title: node.title,
              reviewers: node.reviewers,
              timeout: node.timeout,
              show: node.show.map((ref) => readPort(values, ref) ?? null),
              ...reviewChoices(node),
            }),
          );
          await dispatcher.recordEvent(baseEvent(node, "waiting"));
          return deadline;
        });
        let answer;
        try {
          const event = await step.waitForEvent(name + ":answer", {
            type: eventType,
            timeout: node.timeout,
          });
          answer = S.decodeUnknownSync(reviewAnswerSchema)(event.payload, {
            onExcessProperty: "error",
          });
        } catch (cause) {
          if (S.isSchemaError(cause)) return fail(node, "invalid_input", cause);
          // RPC strips the native timeout subtype. The review owner already
          // owns expiry; handle that expected outcome without inspecting text,
          // retaining the original failure for diagnostics. Early failures escape.
          if (Date.now() >= expiresAt)
            return fail(node, "review_timeout", cause);
          throw cause;
        }
        const shown = node.show[0];
        const item = shown ? (readPort(values, shown) ?? null) : true;
        values[node.id] = await step.do(name + ":complete", () =>
          complete(node, reviewAnswerOutput(answer, item)),
        );
        break;
      }
      case "repeat": {
        const item = readPort(values, { node: "$input", port: "item" });
        if (item === undefined) return fail(node, "invalid_input");
        let previous: Readonly<Record<string, Json>> = {};
        let outlet: "result" | "exhausted" = "exhausted";
        for (let round = 0; round < node.maxRounds; round++) {
          const childIteration = (
            await contentDigest([iteration, node.id, "repeat", round])
          ).slice(7);
          const childId = (
            await contentDigest([
              checked.runId,
              node.id,
              childIteration,
              plan.planDigest,
            ])
          ).slice(7);
          const eventType =
            "round_" +
            (
              await contentDigest([
                checked.runId,
                checked.kind === "map-item" ? checked.body : "root",
                node.id,
                iteration,
                round,
              ])
            ).slice(7);
          await step.do(`${name}:round:${String(round)}`, async () => {
            const params: GraphParams = {
              kind: "map-item",
              teamId: checked.teamId,
              runId: checked.runId,
              planDigest: plan.planDigest,
              body: node.body,
              iteration: childIteration,
              parentInstanceId: instanceId,
              completionEvent: eventType,
              input: { item, round, previous },
              position: [
                ...position,
                {
                  node: node.id,
                  loop: "repeat",
                  index: round,
                  count: node.maxRounds,
                },
              ],
            };
            try {
              await workflows.create({ id: childId, params });
            } catch (cause) {
              const existing = await workflows.get(childId);
              if ((await existing.status()).status === "unknown") throw cause;
            }
            await dispatcher.recordEvent(baseEvent(node, "waiting"));
            return null;
          });
          const event = await step.waitForEvent(eventType, {
            type: eventType,
            timeout: "7 days",
          });
          const completed = S.decodeUnknownSync(childCompletionSchema)(
            event.payload,
            { onExcessProperty: "error" },
          );
          if ("refusal" in completed) return fail(node, completed.refusal);
          previous = completed.output;
          if (evaluatePredicate(node.until, { $input: previous })) {
            outlet = "result";
            break;
          }
        }
        values[node.id] = await step.do(name + ":complete", () =>
          complete(node, { [outlet]: previous }),
        );
        break;
      }
      case "map": {
        const items = readPort(values, node.over);
        if (!S.is(S.Array(S.Json))(items) || items.length > node.maxItems)
          return fail(node, "map_item_limit");
        const list = S.decodeUnknownSync(S.Array(S.Json))(items);
        const results: Json[] = [];
        for (let offset = 0; offset < list.length; offset += node.concurrency) {
          const wave = list.slice(offset, offset + node.concurrency);
          await step.do(name + ":wave:" + String(offset), async () => {
            await Promise.all(
              wave.map(async (item, index) => {
                const itemIndex = offset + index;
                const childIteration = (
                  await contentDigest([iteration, node.id, itemIndex])
                ).slice(7);
                const childId = (
                  await contentDigest([
                    checked.runId,
                    node.id,
                    childIteration,
                    plan.planDigest,
                  ])
                ).slice(7);
                const childParams: GraphParams = {
                  kind: "map-item",
                  teamId: checked.teamId,
                  runId: checked.runId,
                  planDigest: plan.planDigest,
                  body: node.body,
                  iteration: childIteration,
                  parentInstanceId: instanceId,
                  completionEvent:
                    "item_" +
                    (
                      await contentDigest([
                        checked.runId,
                        checked.kind === "map-item" ? checked.body : "root",
                        node.id,
                        iteration,
                        itemIndex,
                      ])
                    ).slice(7),
                  input: { item, index: itemIndex },
                  position: [
                    ...position,
                    {
                      node: node.id,
                      loop: "map",
                      index: itemIndex,
                      count: list.length,
                    },
                  ],
                };
                try {
                  await workflows.create({ id: childId, params: childParams });
                } catch (cause) {
                  const existing = await workflows.get(childId);
                  if ((await existing.status()).status === "unknown")
                    throw cause;
                }
              }),
            );
            await dispatcher.recordEvent(baseEvent(node, "waiting"));
            return null;
          });
          const completed = await Promise.all(
            wave.map(async (_, index) => {
              const eventType =
                "item_" +
                (
                  await contentDigest([
                    checked.runId,
                    checked.kind === "map-item" ? checked.body : "root",
                    node.id,
                    iteration,
                    offset + index,
                  ])
                ).slice(7);
              const event = await step.waitForEvent(eventType, {
                type: eventType,
                timeout: "7 days",
              });
              const completed = S.decodeUnknownSync(childCompletionSchema)(
                event.payload,
                { onExcessProperty: "error" },
              );
              if ("refusal" in completed) return fail(node, completed.refusal);
              return completed.output;
            }),
          );
          results.push(...completed);
        }
        values[node.id] = await step.do(name + ":complete", () =>
          complete(node, { items: results }),
        );
        break;
      }
    }
  }
  const output: Record<string, Json> = {};
  for (const [key, ref] of Object.entries(graph.output)) {
    const value = readPort(values, ref);
    if (value === undefined && !branchAbsent(ref))
      return fail({ id: "$output" }, "missing_output");
    if (value !== undefined) output[key] = value;
  }
  if (exceedsResultLimit(output))
    return fail({ id: "$output" }, "step_result_limit");
  if (checked.kind === "map-item")
    await step.do("notify-parent", async () => {
      const parent = await workflows.get(checked.parentInstanceId);
      await parent.sendEvent({
        type: checked.completionEvent,
        payload: { output },
      });
      return null;
    });
  return output;
}

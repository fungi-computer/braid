import { escapePointer } from "@cfworker/json-schema";
import * as S from "effect/Schema";
import * as Result from "effect/Result";
import { nextOccurrence } from "@fungi.computer/almanac";
import {
  reviewTextPlaceholders,
  unknownReviewPlaceholders,
} from "./review-text.js";
import {
  workflowDefinitionSchema,
  catalogSchema,
  TRIGGER_EVENT_PORTS,
  type Catalog,
  type Graph,
  type WorkflowDefinition,
  type Node,
  type PortRef,
  type Mapping,
  type JsonSchemaProjection,
} from "./schema.js";
import {
  parseProjection,
  methodInputPorts,
  methodOutputPorts,
  portProjection,
  ports,
  accepts,
  assignable,
  type PortSchema,
} from "./ports.js";
import {
  nodeRefs,
  mappingRefs,
  mappingProjection,
  predicateRefs,
  ExpressionSyntaxError,
} from "./expressions.js";
export type IssueCode =
  | "schema"
  | "unknown_app"
  | "unknown_method"
  | "unknown_event"
  | "digest_drift"
  | "unknown_port"
  | "unassignable_edge"
  | "required_port"
  | "cycle"
  | "unreachable"
  | "step_budget"
  | "template"
  | "duplicate"
  | "subgraph"
  | "binding"
  | "literal"
  | "trigger";
export type Issue = {
  readonly code: IssueCode;
  readonly message: string;
  readonly graph?: string;
  readonly node?: string;
  readonly trigger?: string;
  readonly port?: string;
  readonly edge?: number;
};
export type Analysis = {
  readonly issues: readonly Issue[];
  readonly definition?: WorkflowDefinition;
  readonly catalog?: Catalog;
  readonly estimatedSteps: number;
  readonly order: Readonly<Record<string, readonly Node[]>>;
};
/** CF permits 1024 durable steps; this private ceiling leaves execution headroom. */
export const STEP_BUDGET = 800;
const signal: PortSchema = {};

/** A trigger reads only its event and must produce the run input's declared fields. */
function triggerIssues(
  definition: WorkflowDefinition,
  catalog: Catalog,
): readonly Issue[] {
  const issues: Issue[] = [];
  let runInput: PortSchema | undefined;
  try {
    runInput = parseProjection(definition.input);
  } catch (cause) {
    // The root graph pass already reports the invalid input projection.
    if (!S.isSchemaError(cause)) throw cause;
  }
  const ids = new Set<string>();
  for (const trigger of definition.triggers ?? []) {
    const issue = (code: IssueCode, message: string, port?: string) =>
      issues.push(
        port === undefined
          ? { code, message, trigger: trigger.id }
          : { code, message, trigger: trigger.id, port },
      );
    if (ids.has(trigger.id)) issue("duplicate", "Duplicate trigger id");
    ids.add(trigger.id);
    if (trigger.on === "schedule") {
      const first = nextOccurrence(trigger.cron, Date.UTC(2026, 0, 1));
      const second = Result.flatMap(first, (at) =>
        nextOccurrence(trigger.cron, at),
      );
      if (Result.isFailure(second)) issue("trigger", second.failure.message);
      else if (
        Result.isSuccess(first) &&
        second.success - first.success < 300_000
      )
        issue(
          "trigger",
          "Schedule occurrences must be at least five minutes apart",
        );
    }
    let eventPayload: JsonSchemaProjection | undefined;
    if (trigger.on === "event") {
      const app = definition.apps[trigger.app];
      if (app === undefined) issue("unknown_app", "Unknown event App");
      const event =
        app === undefined
          ? undefined
          : catalog[app.appId]?.events?.[trigger.event];
      if (event === undefined)
        issue("unknown_event", "App does not declare this event");
      else {
        eventPayload = event.payload;
        if (event.digest !== trigger.eventDigest)
          issue("digest_drift", "App changed event; review mapping");
      }
    }
    // Index only guaranteed object properties. The maintained encoder owns JSON Pointer
    // spelling; arrays, optional paths and unsupported projections remain unproven.
    const payloadPaths = new Map<string, JsonSchemaProjection>();
    const indexPayload = (schema: JsonSchemaProjection, path: string) => {
      payloadPaths.set(path, schema);
      if (
        schema.type !== "object" ||
        !S.is(S.JsonObject)(schema.properties) ||
        !S.is(S.Array(S.String))(schema.required)
      )
        return;
      for (const key of schema.required) {
        const child = schema.properties[key];
        if (S.is(S.JsonObject)(child))
          indexPayload(child, `${path}/${escapePointer(key)}`);
      }
    };
    if (eventPayload !== undefined) indexPayload(eventPayload, "");
    const payloadProjection = (path: string): PortSchema | undefined => {
      const schema = payloadPaths.get(path);
      if (schema === undefined) return undefined;
      try {
        // The dialect annotation does not change the value's declared ports.
        const view = Object.fromEntries(
          Object.entries(schema).filter(
            ([key]) => key !== "$schema" && key !== "const",
          ),
        );
        return parseProjection(
          schema.const === undefined ? view : { ...view, enum: [schema.const] },
        );
      } catch (cause) {
        if (!S.isSchemaError(cause)) throw cause;
        return undefined;
      }
    };
    const compatible = (mapping: Mapping, target: PortSchema): boolean => {
      if ("literal" in mapping) return accepts(target, mapping.literal);
      if ("template" in mapping) return assignable({ type: "string" }, target);
      if ("coalesce" in mapping) {
        const candidates = mapping.coalesce.filter(
          (part) => !("literal" in part && part.literal === null),
        );
        return (
          candidates.length > 0 &&
          candidates.every((part) => compatible(part, target))
        );
      }
      const unproven: PortRef[] = [];
      let projected: PortSchema;
      try {
        projected = mappingProjection(mapping, (ref, path) => {
          const source: PortSchema | undefined =
            ref.node !== "$input"
              ? undefined
              : ref.port === "payload"
                ? payloadProjection(path ?? "")
                : ref.port === "eventId" && (path === undefined || path === "")
                  ? { type: "string" }
                  : undefined;
          if (source === undefined) unproven.push(ref);
          return source;
        });
      } catch (cause) {
        if (!(cause instanceof ExpressionSyntaxError)) throw cause;
        return false;
      }
      return unproven.length === 0 && assignable(projected, target);
    };
    const triggerEventPorts = new Set<string>(TRIGGER_EVENT_PORTS[trigger.on]);
    let refs: readonly PortRef[] = [];
    try {
      refs = [
        ...(trigger.on !== "schedule" && trigger.when !== undefined
          ? predicateRefs(trigger.when)
          : []),
        ...Object.values(trigger.input ?? {}).flatMap(mappingRefs),
        ...(trigger.on === "event" && trigger.repository !== undefined
          ? mappingRefs(trigger.repository)
          : []),
      ];
    } catch (cause) {
      if (!(cause instanceof ExpressionSyntaxError)) throw cause;
      issue("template", "Invalid interpolation or JSON pointer");
    }
    for (const ref of refs)
      if (ref.node !== "$input" || !triggerEventPorts.has(ref.port))
        issue(
          "trigger",
          "A trigger reads only its declared event ports",
          ref.port,
        );
    if (
      trigger.on === "event" &&
      trigger.repository !== undefined &&
      !compatible(trigger.repository, { type: "string" })
    )
      issue("trigger", "Trigger repository must be a string from the event");
    if (runInput === undefined) continue;
    if (trigger.input === undefined) {
      if (trigger.on === "event") {
        const source = payloadProjection("");
        if (source === undefined || !assignable(source, runInput))
          issue("trigger", "Event payload does not match the run input schema");
      }
      continue;
    }
    const targets = ports(runInput);
    for (const key of runInput.required ?? [])
      if (!Object.hasOwn(trigger.input, key))
        issue("trigger", "Required run input is not mapped", key);
    for (const [key, mapping] of Object.entries(trigger.input)) {
      const target = Object.hasOwn(targets, key) ? targets[key] : undefined;
      if (target === undefined)
        issue("trigger", "Run input does not declare this field", key);
      else if (
        trigger.on === "event"
          ? !compatible(mapping, target)
          : "literal" in mapping
            ? !accepts(target, mapping.literal)
            : "template" in mapping && !assignable({ type: "string" }, target)
      )
        issue("trigger", "Value does not match the run input schema", key);
    }
  }
  return issues;
}

export function dependencies(graph: Graph, node: Node): readonly PortRef[] {
  return [
    ...graph.edges
      .filter((edge) => edge.to.node === node.id)
      .map((edge) => edge.from),
    ...nodeRefs(node),
  ];
}
export function topological(graph: Graph): readonly Node[] {
  const remaining = new Map(graph.nodes.map((node) => [node.id, node]));
  const sorted: Node[] = [];
  const done = new Set(["$input"]);
  while (remaining.size) {
    const ready = [...remaining.values()]
      .filter((node) =>
        dependencies(graph, node).every((ref) => done.has(ref.node)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) break;
    for (const node of ready) {
      remaining.delete(node.id);
      done.add(node.id);
      sorted.push(node);
    }
  }
  return sorted;
}

/** Decode JSON boundaries once, then collect domain issues for the editor. */
export function analyze(
  raw: WorkflowDefinition,
  rawCatalog: Catalog,
): Analysis {
  let definition: WorkflowDefinition;
  let catalog: Catalog;
  try {
    definition = S.decodeUnknownSync(workflowDefinitionSchema)(raw, {
      onExcessProperty: "error",
    });
    catalog = S.decodeUnknownSync(catalogSchema)(rawCatalog, {
      onExcessProperty: "error",
    });
  } catch (cause) {
    if (!S.isSchemaError(cause)) throw cause;
    return {
      issues: [
        {
          code: "schema",
          message: "Definition or catalog failed v1 decoding and bounds",
        },
      ],
      estimatedSteps: 0,
      order: {},
    };
  }
  const issues: Issue[] = [];
  const order: Record<string, readonly Node[]> = {};
  const graphs = new Map<string, Graph>(
    Object.entries({ root: definition, ...definition.subgraphs }),
  );
  const totalNodes = [...graphs.values()].reduce(
    (sum, graph) => sum + graph.nodes.length,
    0,
  );
  const totalEdges = [...graphs.values()].reduce(
    (sum, graph) => sum + graph.edges.length,
    0,
  );
  if (totalNodes > 64 || totalEdges > 256)
    issues.push({
      code: "schema",
      message: "Total graph exceeds 64 nodes or 256 edges",
    });
  if (definition.subgraphs?.root)
    issues.push({ code: "subgraph", message: "root is reserved" });
  const used = new Set<string>();
  const outputSchemas = new Map<string, PortSchema>();
  const priorResults: {
    graph: string;
    node: string;
    body: string;
    target: PortSchema;
  }[] = [];
  // A control body's declared outputs must be known before its enclosing graph
  // maps a repeat result. Visiting once also leaves recursion to the cycle law.
  const bodyOrder: [string, Graph][] = [];
  const visitedBodies = new Set<string>();
  const visitBody = (graphId: string) => {
    if (visitedBodies.has(graphId)) return;
    visitedBodies.add(graphId);
    const graph = graphs.get(graphId);
    if (!graph) return;
    for (const node of graph.nodes)
      if (node.kind === "map" || node.kind === "repeat") visitBody(node.body);
    bodyOrder.push([graphId, graph]);
  };
  for (const graphId of graphs.keys()) visitBody(graphId);
  for (const [graphId, graph] of bodyOrder) {
    const issue = (
      code: IssueCode,
      message: string,
      location: Omit<Issue, "code" | "message"> = {},
    ) => issues.push({ code, message, graph: graphId, ...location });
    const projected = (
      schema: Parameters<typeof parseProjection>[0],
    ): PortSchema => {
      try {
        return parseProjection(schema);
      } catch (cause) {
        if (!S.isSchemaError(cause)) throw cause;
        issue("schema", "Unsupported or invalid JSON Schema projection");
        return {};
      }
    };
    const input = projected(graph.input);
    if (input.type !== "object")
      issue("schema", "Graph input must be an object schema");
    const ins = new Map<string, PortSchema>();
    const outs = new Map<string, Readonly<Record<string, PortSchema>>>();
    outs.set("$input", ports(input));
    const ids = new Set<string>();
    const declareDataPorts = (
      node: Pick<Node, "id">,
      inputProjection: JsonSchemaProjection,
      outputProjection: JsonSchemaProjection,
    ) => {
      const declaredInput = methodInputPorts(projected(inputProjection));
      const declaredOutput = methodOutputPorts(projected(outputProjection));
      if (
        Object.hasOwn(ports(declaredInput), "after") ||
        Object.hasOwn(declaredOutput, "after")
      )
        issue("schema", "after is reserved for the node ordering signal", {
          node: node.id,
          port: "after",
        });
      ins.set(node.id, declaredInput);
      outs.set(node.id, { ...declaredOutput, after: signal });
    };
    for (const node of graph.nodes) {
      if (ids.has(node.id))
        issue("duplicate", "Duplicate node id", { node: node.id });
      ids.add(node.id);
      if (node.kind === "code") declareDataPorts(node, node.input, node.output);
      if (node.kind === "app") {
        const app = Object.hasOwn(definition.apps, node.app)
          ? definition.apps[node.app]
          : undefined;
        const entry =
          app && Object.hasOwn(catalog, app.appId)
            ? catalog[app.appId]
            : undefined;
        if (!app || !entry) {
          issue("unknown_app", "Unknown App", { node: node.id });
          continue;
        }
        const method = Object.hasOwn(entry.methods, node.method)
          ? entry.methods[node.method]
          : undefined;
        if (!method) {
          issue("unknown_method", "Unknown App method", { node: node.id });
          continue;
        }
        if (method.digest !== node.methodDigest)
          issue("digest_drift", "App changed method; review mapping", {
            node: node.id,
          });
        if (method.effect === "external" && (node.retry?.attempts ?? 1) > 1)
          issue("schema", "External effects cannot retry automatically", {
            node: node.id,
          });
        declareDataPorts(node, method.input, method.output);
      }
    }
    let sorted: readonly Node[] = [];
    try {
      sorted = topological(graph);
    } catch (cause) {
      if (!(cause instanceof ExpressionSyntaxError)) throw cause;
      issue("template", "Invalid interpolation or JSON pointer");
    }
    order[graphId] = sorted;
    if (sorted.length !== graph.nodes.length)
      issue("cycle", "Cycle or unresolved dependency");
    const source = (ref: PortRef): PortSchema | undefined => {
      const declared = outs.get(ref.node);
      return declared && Object.hasOwn(declared, ref.port)
        ? declared[ref.port]
        : undefined;
    };
    const mapped = (mapping: Mapping): PortSchema => {
      try {
        return mappingProjection(mapping, (ref, path) =>
          portProjection(source(ref), path),
        );
      } catch (cause) {
        if (!(cause instanceof ExpressionSyntaxError)) throw cause;
        issue("template", "Invalid interpolation or JSON pointer");
        return {};
      }
    };
    for (const node of [
      ...sorted,
      ...graph.nodes.filter(
        (candidate) => !sorted.some((item) => item.id === candidate.id),
      ),
    ]) {
      switch (node.kind) {
        case "condition":
          outs.set(node.id, { true: signal, false: signal, after: signal });
          break;
        case "review": {
          const shown = node.show[0];
          const item = shown ? (source(shown) ?? {}) : {};
          for (const text of [
            node.detail ?? "",
            ...(node.choices ?? []).map((choice) => choice.description ?? ""),
          ])
            for (const name of unknownReviewPlaceholders(text))
              issue(
                "schema",
                `Unknown review placeholder {${name}}; use ${reviewTextPlaceholders.map((known) => `{${known}}`).join(", ")}`,
                { node: node.id },
              );
          if (node.choices === undefined) {
            outs.set(node.id, {
              approved: item,
              rejected: item,
              choice: { type: "string", enum: ["approved", "rejected"] },
              note: { type: "string", maxLength: 1000 },
              after: signal,
            });
            break;
          }
          const ids = node.choices.map((choice) => choice.id);
          if (ids.length < 2)
            issue("schema", "A review offers at least two choices", {
              node: node.id,
            });
          if (new Set(ids).size !== ids.length)
            issue("duplicate", "Duplicate review choice", { node: node.id });
          for (const reserved of ["after", "choice", "note"])
            if (ids.includes(reserved))
              issue("schema", `${reserved} is a reserved review output port`, {
                node: node.id,
                port: reserved,
              });
          outs.set(node.id, {
            ...Object.fromEntries(ids.map((id) => [id, item])),
            choice: { type: "string", enum: ids },
            note: { type: "string", maxLength: 1000 },
            after: signal,
          });
          break;
        }
        case "wait":
          outs.set(node.id, { after: signal });
          break;
        case "transform":
          if (Object.hasOwn(node.fields, "after"))
            issue("schema", "after is reserved for the node ordering signal", {
              node: node.id,
              port: "after",
            });
          outs.set(node.id, {
            ...Object.fromEntries(
              Object.entries(node.fields).map(([key, value]) => [
                key,
                mapped(value),
              ]),
            ),
            after: signal,
          });
          break;
        case "map": {
          used.add(node.body);
          const body = definition.subgraphs?.[node.body];
          const over = source(node.over);
          if (!body) issue("subgraph", "Unknown map body", { node: node.id });
          if (over?.type !== "array")
            issue("unassignable_edge", "Map requires a list", {
              node: node.id,
            });
          if (body) {
            const bodyInput = projected(body.input);
            if (
              !assignable(
                {
                  type: "object",
                  properties: {
                    item: over?.items ?? {},
                    index: { type: "integer" },
                  },
                  required: ["item", "index"],
                  additionalProperties: false,
                },
                bodyInput,
              )
            )
              issue("unassignable_edge", "Map item does not fit body input", {
                node: node.id,
              });
          }
          outs.set(node.id, {
            items: { type: "array", items: { type: "object" } },
            after: signal,
          });
          break;
        }
        case "repeat": {
          used.add(node.body);
          const body = definition.subgraphs?.[node.body];
          if (!body)
            issue("subgraph", "Unknown repeat body", { node: node.id });
          if (body) {
            const bodyInput = projected(body.input);
            if (
              !assignable(
                {
                  type: "object",
                  properties: {
                    item: source({ node: "$input", port: "item" }) ?? {},
                    round: {
                      type: "integer",
                      minimum: 0,
                      maximum: node.maxRounds - 1,
                    },
                    previous: {
                      type: "object",
                      properties: {},
                      additionalProperties: false,
                    },
                  },
                  required: ["item", "round", "previous"],
                  additionalProperties: false,
                },
                bodyInput,
              )
            )
              issue(
                "unassignable_edge",
                "Repeat item, round and previous result do not fit body input",
                { node: node.id },
              );
            const previous = ports(bodyInput).previous;
            if (previous !== undefined)
              priorResults.push({
                graph: graphId,
                node: node.id,
                body: node.body,
                target: previous,
              });
            try {
              for (const ref of predicateRefs(node.until))
                if (
                  ref.node !== "$input" ||
                  !Object.hasOwn(body.output, ref.port)
                )
                  issue(
                    "unknown_port",
                    "Repeat stop predicate reads only the body's declared output",
                    { node: node.id, port: ref.port },
                  );
            } catch (cause) {
              if (!(cause instanceof ExpressionSyntaxError)) throw cause;
              issue("template", "Invalid repeat stop predicate", {
                node: node.id,
              });
            }
          }
          outs.set(node.id, {
            result: outputSchemas.get(node.body) ?? { type: "object" },
            exhausted: outputSchemas.get(node.body) ?? { type: "object" },
            after: signal,
          });
          break;
        }
        case "app":
        case "code":
          break;
      }
      try {
        for (const ref of nodeRefs(node))
          if (!source(ref))
            issue("unknown_port", "Unknown referenced port", {
              node: node.id,
              port: ref.port,
            });
      } catch (cause) {
        if (!(cause instanceof ExpressionSyntaxError)) throw cause;
        issue("template", "Invalid interpolation or JSON pointer", {
          node: node.id,
        });
      }
      if (node.kind === "app" || node.kind === "code") {
        const schema = ins.get(node.id) ?? {};
        const targets = ports(schema);
        for (const key of schema.required ?? [])
          if (
            !Object.hasOwn(node.values, key) &&
            !graph.edges.some(
              (edge) => edge.to.node === node.id && edge.to.port === key,
            )
          )
            issue("required_port", "Required port needs an edge or value", {
              node: node.id,
              port: key,
            });
        for (const [key, value] of Object.entries(node.values)) {
          const target = Object.hasOwn(targets, key) ? targets[key] : undefined;
          if (!target)
            issue("unknown_port", "Unknown literal input port", {
              node: node.id,
              port: key,
            });
          else if (
            "literal" in value
              ? !accepts(target, value.literal)
              : !assignable(mapped(value), target)
          )
            issue("literal", "Value does not match input schema", {
              node: node.id,
              port: key,
            });
        }
      }
    }
    const destinations = new Set<string>();
    graph.edges.forEach((edge, index) => {
      const node = graph.nodes.find((item) => item.id === edge.to.node);
      const src = source(edge.from);
      const inputs = node ? ports(ins.get(node.id) ?? {}) : {};
      const target =
        edge.to.port === "after"
          ? signal
          : (node?.kind === "app" || node?.kind === "code") &&
              Object.hasOwn(inputs, edge.to.port)
            ? inputs[edge.to.port]
            : undefined;
      if (!node || !src || !target)
        issue("unknown_port", "Unknown edge node or port", { edge: index });
      else if (!assignable(src, target))
        issue("unassignable_edge", "Source schema is not assignable to input", {
          edge: index,
          node: node.id,
          port: edge.to.port,
        });
      const key = edge.to.node + "." + edge.to.port;
      if (
        destinations.has(key) ||
        ((node?.kind === "app" || node?.kind === "code") &&
          node.values[edge.to.port])
      )
        issue("duplicate", "Input has multiple producers", { edge: index });
      destinations.add(key);
    });
    for (const ref of Object.values(graph.output))
      if (!source(ref))
        issue("unknown_port", "Unknown graph output", {
          node: ref.node,
          port: ref.port,
        });
    outputSchemas.set(graphId, {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(graph.output).map(([key, ref]) => [
          key,
          source(ref) ?? {},
        ]),
      ),
      additionalProperties: false,
    });
    const observable = new Set(
      Object.values(graph.output).map((ref) => ref.node),
    );
    for (const node of graph.nodes)
      if (node.kind === "app") {
        const app = definition.apps[node.app];
        const effect = app
          ? catalog[app.appId]?.methods[node.method]?.effect
          : undefined;
        if (effect && effect !== "read") observable.add(node.id);
      }
    for (const node of [...sorted].reverse())
      if (observable.has(node.id)) {
        try {
          for (const ref of dependencies(graph, node)) observable.add(ref.node);
        } catch (cause) {
          if (!(cause instanceof ExpressionSyntaxError)) throw cause;
          issue("template", "Invalid interpolation or JSON pointer", {
            node: node.id,
          });
        }
      }
    for (const node of graph.nodes)
      if (!observable.has(node.id))
        issue(
          "unreachable",
          "Node cannot contribute to an output or side effect",
          { node: node.id },
        );
  }
  for (const prior of priorResults) {
    const supplied = outputSchemas.get(prior.body);
    if (supplied !== undefined && !assignable(supplied, prior.target))
      issues.push({
        code: "unassignable_edge",
        graph: prior.graph,
        node: prior.node,
        message:
          "Repeat body output does not fit the next round's previous result",
      });
  }
  issues.push(...triggerIssues(definition, catalog));
  for (const id of Object.keys(definition.subgraphs ?? {}))
    if (!used.has(id))
      issues.push({
        code: "unreachable",
        graph: id,
        message: "Unused subgraph",
      });
  const estimate = (id: string, visiting: ReadonlySet<string>): number => {
    if (visiting.has(id)) {
      issues.push({
        code: "cycle",
        graph: id,
        message: "Recursive control body",
      });
      return STEP_BUDGET + 1;
    }
    const graph = graphs.get(id);
    if (!graph) return 0;
    const next = new Set([...visiting, id]);
    return graph.nodes.reduce(
      (sum, node) =>
        Math.min(
          STEP_BUDGET + 1,
          sum +
            3 +
            (node.kind === "map"
              ? node.maxItems * (estimate(node.body, next) + 3)
              : node.kind === "repeat"
                ? node.maxRounds * (estimate(node.body, next) + 3)
                : 0),
        ),
      0,
    );
  };
  const estimatedSteps = estimate("root", new Set());
  if (estimatedSteps > STEP_BUDGET)
    issues.push({
      code: "step_budget",
      message: "Static maximum exceeds engine step budget with headroom",
    });
  return { issues, definition, catalog, estimatedSteps, order };
}
export function validate(
  definition: unknown,
  catalog: unknown,
): readonly Issue[] {
  try {
    const parsedDefinition = S.decodeUnknownSync(workflowDefinitionSchema)(
      definition,
      { onExcessProperty: "error" },
    );
    const parsedCatalog = S.decodeUnknownSync(catalogSchema)(catalog, {
      onExcessProperty: "error",
    });
    return analyze(parsedDefinition, parsedCatalog).issues;
  } catch (cause) {
    if (!S.isSchemaError(cause)) throw cause;
    return [
      {
        code: "schema",
        message: "Definition or catalog failed v1 decoding and bounds",
      },
    ];
  }
}

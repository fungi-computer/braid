import Mustache from "mustache";
import pointer from "jsonpointer";
import * as S from "effect/Schema";
import type { Mapping, Node, Predicate, PortRef, Json } from "./schema.js";
import { portProjection, type PortSchema } from "./ports.js";
export type Values = Readonly<Record<string, Readonly<Record<string, Json>>>>;
/** Expected syntax refusal only; defects in a parser or graph traversal escape. */
export class ExpressionSyntaxError extends Error {}
/** Mustache parses the representation; only its interpolation tokens belong to v1. */
export function templateRefs(template: string): readonly PortRef[] {
  let tokens: ReturnType<typeof Mustache.parse>;
  try {
    tokens = Mustache.parse(template, ["{{", "}}"]);
  } catch (cause) {
    // For a string and these fixed tags, Mustache 4's syntax refusals are plain
    // Error. Native defects (TypeError, RangeError, etc.) are not syntax issues.
    if (!(cause instanceof Error) || cause.constructor !== Error) throw cause;
    throw new ExpressionSyntaxError("Invalid Mustache syntax", { cause });
  }
  return tokens.flatMap((token) => {
    if (token[0] === "text") return [];
    if (
      token[0] !== "name" ||
      !/^([$]input|[$]item|[A-Za-z][A-Za-z0-9_-]*)[.][A-Za-z][A-Za-z0-9_-]*$/.test(
        token[1],
      )
    )
      throw new ExpressionSyntaxError(
        "Only node.port interpolation is supported",
      );
    const [node, port] = token[1].split(".");
    if (!node || !port)
      throw new ExpressionSyntaxError("Invalid template reference");
    return [{ node, port }];
  });
}
export function mappingRefs(mapping: Mapping): readonly PortRef[] {
  if ("from" in mapping) {
    if (mapping.path !== undefined) {
      try {
        pointer.compile(mapping.path);
      } catch (cause) {
        // jsonpointer's string compile interface reports invalid syntax as
        // plain Error; do not turn native error subtypes into author refusals.
        if (!(cause instanceof Error) || cause.constructor !== Error)
          throw cause;
        throw new ExpressionSyntaxError("Invalid JSON pointer syntax", {
          cause,
        });
      }
    }
    return [mapping.from];
  }
  if ("template" in mapping) return templateRefs(mapping.template);
  if ("coalesce" in mapping) return mapping.coalesce.flatMap(mappingRefs);
  if ("object" in mapping)
    return Object.values(mapping.object).flatMap(mappingRefs);
  if ("array" in mapping) return mapping.array.flatMap(mappingRefs);
  if ("each" in mapping)
    return [
      ...mappingRefs(mapping.each.over),
      ...mappingRefs(mapping.each.body).filter((ref) => {
        if (ref.node !== "$item") return true;
        if (ref.port !== "value" && ref.port !== "index")
          throw new ExpressionSyntaxError(
            "Each exposes only $item.value and $item.index",
          );
        return false;
      }),
    ];
  return [];
}
export function predicateRefs(test: Predicate): readonly PortRef[] {
  if ("tests" in test) return test.tests.flatMap(predicateRefs);
  if ("test" in test) return predicateRefs(test.test);
  if ("value" in test) return mappingRefs(test.value);
  return [...mappingRefs(test.left), ...mappingRefs(test.right)];
}
export function nodeRefs(node: Node): readonly PortRef[] {
  switch (node.kind) {
    case "app":
    case "code":
      return Object.values(node.values).flatMap(mappingRefs);
    case "review":
      return node.show;
    case "map":
      return [node.over];
    case "repeat":
      return [{ node: "$input", port: "item" }];
    case "condition":
      return predicateRefs(node.test);
    case "transform":
      return Object.values(node.fields).flatMap(mappingRefs);
    case "wait":
      return [];
  }
}
export function readPort(values: Values, ref: PortRef): Json | undefined {
  if (!Object.hasOwn(values, ref.node)) return undefined;
  const node = values[ref.node];
  return node && Object.hasOwn(node, ref.port) ? node[ref.port] : undefined;
}

/** Infer constructed data through the same Mapping grammar used at execution. */
export function mappingProjection(
  mapping: Mapping,
  source: (ref: PortRef, path?: string) => PortSchema | undefined,
): PortSchema {
  const mapped = (part: Mapping) => mappingProjection(part, source);
  const union = (parts: readonly PortSchema[]): PortSchema =>
    parts.length === 0
      ? {}
      : parts.length === 1
        ? (parts[0] ?? {})
        : { anyOf: [...parts] };
  if ("from" in mapping) return source(mapping.from, mapping.path) ?? {};
  if ("literal" in mapping) {
    const value = mapping.literal;
    if (S.is(S.Array(S.Json))(value))
      return {
        type: "array",
        const: value,
        items: union(value.map((item) => mapped({ literal: item }))),
        minItems: value.length,
        maxItems: value.length,
      };
    if (S.is(S.JsonObject)(value))
      return {
        type: "object",
        const: value,
        properties: Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            mapped({ literal: item }),
          ]),
        ),
        required: Object.keys(value),
        additionalProperties: false,
      };
    return {
      type:
        value === null
          ? "null"
          : S.is(S.String)(value)
            ? "string"
            : S.is(S.Boolean)(value)
              ? "boolean"
              : Number.isInteger(value)
                ? "integer"
                : "number",
      const: value,
    };
  }
  if ("coalesce" in mapping)
    return union(
      mapping.coalesce
        .filter((part) => !("literal" in part && part.literal === null))
        .map(mapped),
    );
  if ("object" in mapping)
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(mapping.object).map(([key, part]) => [
          key,
          mapped(part),
        ]),
      ),
      required: Object.keys(mapping.object),
      additionalProperties: false,
    };
  if ("array" in mapping)
    return {
      type: "array",
      items: union(mapping.array.map(mapped)),
      minItems: mapping.array.length,
      maxItems: mapping.array.length,
    };
  if ("each" in mapping) {
    const over = mapped(mapping.each.over);
    const items = mappingProjection(mapping.each.body, (ref, path) =>
      ref.node === "$item"
        ? portProjection(
            ref.port === "value"
              ? over.items
              : ref.port === "index"
                ? {
                    type: "integer",
                    minimum: 0,
                    maximum: mapping.each.maxItems - 1,
                  }
                : undefined,
            path,
          )
        : source(ref, path),
    );
    return over.type === "array"
      ? {
          type: "array",
          items,
          minItems: over.minItems ?? 0,
          maxItems: Math.min(
            over.maxItems ?? mapping.each.maxItems,
            mapping.each.maxItems,
          ),
        }
      : {};
  }
  const refs = templateRefs(mapping.template);
  let minimum = 0;
  let maximum: number | undefined = 0;
  let cursor = 0;
  for (const token of Mustache.parse(mapping.template, ["{{", "}}"])) {
    if (token[0] === "text") {
      minimum += token[1].length;
      if (maximum !== undefined) maximum += token[1].length;
    } else {
      const ref = refs[cursor++];
      const schema = ref ? source(ref) : undefined;
      // Templates retain their optional-reference behavior: absence renders empty text.
      if (schema?.maxLength === undefined) maximum = undefined;
      else if (maximum !== undefined) maximum += schema.maxLength;
    }
  }
  return maximum === undefined
    ? { type: "string", minLength: minimum }
    : { type: "string", minLength: minimum, maxLength: maximum };
}
export function evaluateMapping(
  mapping: Mapping,
  values: Values,
): Json | undefined {
  // Materialization shares the engine's 64 KiB result ceiling. Count visits as
  // well so nested each expressions cannot allocate an exponential intermediate.
  let remaining = 64 * 1024;
  const evaluate = (mapping: Mapping, values: Values): Json | undefined => {
    if (--remaining < 0) return undefined;
    const value = evaluateValue(mapping, values);
    return value !== undefined && JSON.stringify(value).length <= 64 * 1024
      ? value
      : undefined;
  };
  const evaluateValue = (
    mapping: Mapping,
    values: Values,
  ): Json | undefined => {
    if ("literal" in mapping) return mapping.literal;
    if ("from" in mapping) {
      const value = readPort(values, mapping.from);
      if (mapping.path === undefined || value === undefined) return value;
      if (!S.is(S.Union([S.JsonObject, S.Array(S.Json)]))(value))
        return undefined;
      const selected: unknown = pointer.get(value, mapping.path);
      return selected === undefined
        ? undefined
        : S.decodeUnknownSync(S.Json)(selected);
    }
    if ("coalesce" in mapping) {
      for (const part of mapping.coalesce) {
        const value = evaluate(part, values);
        if (value !== undefined && value !== null) return value;
      }
      return undefined;
    }
    if ("object" in mapping) {
      const entries: [string, Json][] = [];
      for (const [key, part] of Object.entries(mapping.object)) {
        const value = evaluate(part, values);
        if (value === undefined) return undefined;
        entries.push([key, value]);
      }
      return Object.fromEntries(entries);
    }
    if ("array" in mapping) {
      const items: Json[] = [];
      for (const part of mapping.array) {
        const value = evaluate(part, values);
        if (value === undefined) return undefined;
        items.push(value);
      }
      return items;
    }
    if ("each" in mapping) {
      const over = evaluate(mapping.each.over, values);
      if (!S.is(S.Array(S.Json))(over) || over.length > mapping.each.maxItems)
        return undefined;
      const items: Json[] = [];
      for (const [index, value] of over.entries()) {
        const item = evaluate(mapping.each.body, {
          ...values,
          $item: { value, index },
        });
        if (item === undefined) return undefined;
        items.push(item);
      }
      return items;
    }
    templateRefs(mapping.template);
    return Mustache.render(mapping.template, values, undefined, {
      escape: (value: string) => value,
    });
  };
  return evaluate(mapping, values);
}
export function evaluatePredicate(test: Predicate, values: Values): boolean {
  switch (test.op) {
    case "and":
      return test.tests.every((child) => evaluatePredicate(child, values));
    case "or":
      return test.tests.some((child) => evaluatePredicate(child, values));
    case "not":
      return !evaluatePredicate(test.test, values);
    case "exists":
      return evaluateMapping(test.value, values) !== undefined;
    default: {
      const left = evaluateMapping(test.left, values);
      const right = evaluateMapping(test.right, values);
      switch (test.op) {
        case "eq":
          return JSON.stringify(left) === JSON.stringify(right);
        case "neq":
          return JSON.stringify(left) !== JSON.stringify(right);
        case "gt":
          return S.is(S.Number)(left) && S.is(S.Number)(right) && left > right;
        case "lt":
          return S.is(S.Number)(left) && S.is(S.Number)(right) && left < right;
        case "in":
          return (
            Array.isArray(right) &&
            right.some((item) => JSON.stringify(item) === JSON.stringify(left))
          );
      }
    }
  }
}

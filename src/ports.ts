import * as S from "effect/Schema";
import { Validator, escapePointer, format } from "@cfworker/json-schema";
import type { Graph, Json, JsonSchemaProjection } from "./schema.js";

/** Deliberately conservative v1 projection vocabulary. Unsupported assertions are refused. */
export type PortSchema = {
  readonly type?:
    "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  readonly format?: string;
  readonly description?: string;
  readonly title?: string;
  readonly enum?: Json[];
  readonly const?: Json;
  readonly default?: Json;
  readonly pattern?: string;
  readonly anyOf?: PortSchema[];
  readonly oneOf?: PortSchema[];
  readonly properties?: Readonly<Record<string, PortSchema>>;
  readonly required?: string[];
  readonly additionalProperties?: boolean;
  readonly items?: PortSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
};
const portSchema: S.Codec<PortSchema> = S.Struct({
  type: S.optionalKey(
    S.Literals([
      "string",
      "number",
      "integer",
      "boolean",
      "array",
      "object",
      "null",
    ]),
  ),
  format: S.optionalKey(
    S.String.pipe(
      S.check(
        S.makeFilter(
          (value) =>
            Object.hasOwn(format, value) ||
            value === "fungi:image" ||
            value === "fungi:video" ||
            value === "fungi:file",
        ),
      ),
    ),
  ),
  title: S.optionalKey(S.String),
  description: S.optionalKey(S.String),
  const: S.optionalKey(S.Json),
  default: S.optionalKey(S.Json),
  pattern: S.optionalKey(S.String),
  anyOf: S.optionalKey(
    S.mutable(S.Array(S.suspend(() => portSchema))).pipe(
      S.check(S.isMinLength(1)),
    ),
  ),
  oneOf: S.optionalKey(
    S.mutable(S.Array(S.suspend(() => portSchema))).pipe(
      S.check(S.isMinLength(1)),
    ),
  ),
  enum: S.optionalKey(
    S.mutable(S.Array(S.Json)).pipe(
      S.check(S.isMinLength(1)),
      S.check(
        S.makeFilter(
          (values) =>
            new Set(values.map((value) => JSON.stringify(value))).size ===
            values.length,
        ),
      ),
    ),
  ),
  properties: S.optionalKey(
    S.Record(
      S.String,
      S.suspend(() => portSchema),
    ),
  ),
  required: S.optionalKey(
    S.mutable(S.Array(S.String)).pipe(
      S.check(S.makeFilter((values) => new Set(values).size === values.length)),
    ),
  ),
  additionalProperties: S.optionalKey(S.Boolean),
  items: S.optionalKey(S.suspend(() => portSchema)),
  minItems: S.optionalKey(
    S.Number.pipe(S.check(S.isInt()), S.check(S.isGreaterThanOrEqualTo(0))),
  ),
  maxItems: S.optionalKey(
    S.Number.pipe(S.check(S.isInt()), S.check(S.isGreaterThanOrEqualTo(0))),
  ),
  minLength: S.optionalKey(
    S.Number.pipe(S.check(S.isInt()), S.check(S.isGreaterThanOrEqualTo(0))),
  ),
  maxLength: S.optionalKey(
    S.Number.pipe(S.check(S.isInt()), S.check(S.isGreaterThanOrEqualTo(0))),
  ),
  minimum: S.optionalKey(S.Number),
  maximum: S.optionalKey(S.Number),
  exclusiveMinimum: S.optionalKey(S.Number),
  exclusiveMaximum: S.optionalKey(S.Number),
});
/** Effect owns the supported schema grammar; the Workers-safe validator owns instance validation. */
export function parseProjection(value: JsonSchemaProjection): PortSchema {
  const parsed = S.decodeUnknownSync(portSchema)(value, {
    onExcessProperty: "error",
  });
  return parsed;
}
export function accepts(schema: PortSchema, value: Json): boolean {
  return new Validator(schema, "7").validate(value).valid;
}

export type RunInputAdmission =
  | { readonly kind: "accepted"; readonly input: S.JsonObject }
  | {
      readonly kind: "invalid";
      readonly issues: readonly {
        readonly code: "invalid_input";
        readonly path: string;
        readonly message: string;
      }[];
    };

/** Defaults fill absent properties; explicit values still have to validate. */
function defaultRunValue(schema: PortSchema, value: Json): Json {
  const items = schema.items;
  if (S.is(S.Array(S.Json))(value) && items)
    return value.map((item) => defaultRunValue(items, item));
  const properties = schema.properties;
  if (!S.is(S.JsonObject)(value) || !properties) return value;
  const entries = new Map<string, Json>();
  for (const [key, item] of Object.entries(value))
    entries.set(key, defaultRunValue(properties[key] ?? {}, item));
  for (const [key, property] of Object.entries(properties))
    if (!Object.hasOwn(value, key) && property.default !== undefined)
      entries.set(key, defaultRunValue(property, property.default));
  return S.decodeUnknownSync(S.JsonObject)(Object.fromEntries(entries));
}

/** Every run source uses the same supported projection and instance validator. */
export function admitRunInput(
  definition: Pick<Graph, "input">,
  raw: Json,
): RunInputAdmission {
  const schema = parseProjection(definition.input);
  const input = defaultRunValue(schema, raw);
  if (!S.is(S.JsonObject)(input))
    return {
      kind: "invalid",
      issues: [
        {
          code: "invalid_input",
          path: "",
          message: "Run input must be an object",
        },
      ],
    };
  const result = new Validator(schema, "7").validate(input);
  return result.valid
    ? { kind: "accepted", input }
    : {
        kind: "invalid",
        issues: result.errors.map((error) => ({
          code: "invalid_input",
          path: error.instanceLocation,
          message: error.error,
        })),
      };
}
export function ports(
  schema: PortSchema,
): Readonly<Record<string, PortSchema>> {
  return schema.properties ?? {};
}

/** Only guaranteed object paths have a static type. The library owns Pointer spelling. */
export function portProjection(
  schema: PortSchema | undefined,
  path = "",
): PortSchema | undefined {
  if (schema === undefined) return undefined;
  if (path === "") return schema;
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const projections = branches.map((branch) => portProjection(branch, path));
    return projections.every((part) => part !== undefined)
      ? { anyOf: projections }
      : undefined;
  }
  const found = new Map<string, PortSchema>();
  const index = (part: PortSchema, at: string) => {
    found.set(at, part);
    for (const key of part.required ?? []) {
      const child =
        part.properties && Object.hasOwn(part.properties, key)
          ? part.properties[key]
          : undefined;
      if (child) index(child, `${at}/${escapePointer(key)}`);
    }
  };
  index(schema, "");
  return found.get(path);
}

/** A method receives its declared value; only the graph-facing view wraps scalars and unions. */
export function methodInputPorts(schema: PortSchema): PortSchema {
  return schema.type === "object" && !schema.anyOf && !schema.oneOf
    ? schema
    : {
        type: "object",
        properties: { value: schema },
        required: ["value"],
        additionalProperties: false,
      };
}

function completionBranches(schema: PortSchema): readonly PortSchema[] {
  const union = schema.anyOf ?? schema.oneOf;
  // Flatten only a union without sibling assertions; keep every declared constraint.
  return union &&
    Object.keys(schema).every((key) =>
      ["anyOf", "oneOf", "title", "description"].includes(key),
    )
    ? union.flatMap(completionBranches)
    : [schema];
}

function completionOutlets(
  schema: PortSchema,
): { ok: PortSchema; refused: PortSchema } | undefined {
  if (!schema.anyOf && !schema.oneOf) return undefined;
  const branches = completionBranches(schema);
  const refused = branches.filter(
    (part) => part.type === "object" && part.required?.includes("error"),
  );
  const ok = branches.filter((part) => !refused.includes(part));
  if (!ok.length || !refused.length) return undefined;
  const union = (parts: readonly PortSchema[]): PortSchema =>
    parts.length === 1 ? (parts[0] ?? {}) : { anyOf: [...parts] };
  return { ok: union(ok), refused: union(refused) };
}

/** Declared error-object unions expose whole completion records on mutually exclusive outlets. */
export function methodOutputPorts(
  schema: PortSchema,
): Readonly<Record<string, PortSchema>> {
  return completionOutlets(schema) ?? ports(methodInputPorts(schema));
}

export function methodInputValue(
  schema: PortSchema,
  values: Readonly<Record<string, Json>>,
): Json | undefined {
  return methodInputPorts(schema) === schema ? values : values.value;
}

export function methodOutputValues(
  schema: PortSchema,
  value: Json,
): Readonly<Record<string, Json>> | undefined {
  if (!accepts(schema, value)) return undefined;
  const outlets = completionOutlets(schema);
  if (outlets)
    return accepts(outlets.refused, value) ? { refused: value } : { ok: value };
  if (methodInputPorts(schema) !== schema) return { value };
  if (!S.is(S.JsonObject)(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => Object.hasOwn(ports(schema), key)),
  );
}
export type PortKind =
  | "text"
  | "number"
  | "bool"
  | "object"
  | "null"
  | "any"
  | "fungi:image"
  | "fungi:video"
  | "fungi:file"
  | { readonly list: PortKind };
export function portKind(schema: PortSchema): PortKind {
  if (
    schema.format === "fungi:image" ||
    schema.format === "fungi:video" ||
    schema.format === "fungi:file"
  )
    return schema.format;
  switch (schema.type) {
    case "string":
      return "text";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "bool";
    case "array":
      return { list: portKind(schema.items ?? {}) };
    case "object":
      return "object";
    case "null":
      return "null";
    default:
      return "any";
  }
}
/** Sound subset check, not a claim to decide arbitrary JSON Schema implication. */
export function assignable(source: PortSchema, target: PortSchema): boolean {
  if (source.anyOf || source.oneOf)
    // Ignoring source siblings widens the proof obligation, never the accepted values.
    return (source.anyOf ?? source.oneOf ?? []).every((part) =>
      assignable(part, target),
    );
  if (target.format && source.format !== target.format) return false;
  if (
    target.type === "string" &&
    (source.format === "fungi:image" ||
      source.format === "fungi:video" ||
      source.format === "fungi:file") &&
    source.format !== target.format
  )
    return false;
  // Literal values are decided by the maintained instance validator, including ranges and patterns.
  if (source.const !== undefined) return accepts(target, source.const);
  if (source.enum) return source.enum.every((value) => accepts(target, value));
  if (target.oneOf) return JSON.stringify(source) === JSON.stringify(target);
  if (target.anyOf) {
    const { anyOf, ...constraints } = target;
    return (
      assignable(source, constraints) &&
      anyOf.some((part) => assignable(source, part))
    );
  }
  if (target.const !== undefined || target.enum) return false;
  if (target.pattern && source.pattern !== target.pattern) return false;
  for (const key of ["exclusiveMinimum", "exclusiveMaximum"] as const)
    if (target[key] !== undefined && source[key] !== target[key]) return false;
  if (
    target.type &&
    source.type !== target.type &&
    !(source.type === "integer" && target.type === "number")
  )
    return false;
  for (const key of ["minimum", "minLength", "minItems"] as const)
    if (
      target[key] !== undefined &&
      (source[key] === undefined || source[key] < target[key])
    )
      return false;
  for (const key of ["maximum", "maxLength", "maxItems"] as const)
    if (
      target[key] !== undefined &&
      (source[key] === undefined || source[key] > target[key])
    )
      return false;
  if (target.items && !assignable(source.items ?? {}, target.items))
    return false;
  for (const key of target.required ?? [])
    if (!source.required?.includes(key)) return false;
  const src = ports(source);
  for (const [key, wanted] of Object.entries(ports(target))) {
    const supplied = src[key];
    if (
      supplied
        ? !assignable(supplied, wanted)
        : source.additionalProperties !== false
    )
      return false;
  }
  if (
    target.additionalProperties === false &&
    (source.additionalProperties !== false ||
      Object.keys(src).some((key) => !Object.hasOwn(ports(target), key)))
  )
    return false;
  return true;
}

import { Validator, type OutputUnit, type Schema } from "@cfworker/json-schema";
import { type Document, isMap, parseDocument, YAMLMap } from "yaml";

import schemaJson from "../../../../tools/review-config/schema.json";

// The same schema the Worker checks before it opens a PR (worker/config-edit.js); the workflow's
// validate_config stays the authority, and tests/test-review-config-schema-drift.py holds the two
// together (#78).
const SCHEMA = schemaJson as unknown as Schema;
const validator = new Validator(SCHEMA, "2020-12", false);

export type FieldKind = "enum" | "boolean" | "integer" | "string" | "list" | "yaml";

export interface ConfigField {
  path: string[];
  kind: FieldKind;
  description: string;
  options: string[];
  minimum?: number;
  /** The config_effective key the lane records for this field, when it records one. */
  effectiveKey: string | null;
}

interface SchemaNode {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  minimum?: number;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
}

function kindOf(node: SchemaNode): FieldKind {
  if (node.enum) return "enum";
  if (node.type === "boolean") return "boolean";
  if (node.type === "integer") return "integer";
  if (node.type === "string") return "string";
  if (node.type === "array" && node.items && (node.items.type === "string" || node.items.enum)) return "list";
  return "yaml";
}

const SECTIONS = ["review", "findings", "telemetry"] as const;

// config_effective is keyed by the lane's resolved names: review.* by their bare key, and
// telemetry.share as telemetry_share. findings.* is not recorded there.
function effectiveKeyFor(path: string[]): string | null {
  if (path[0] === "review") return path[1];
  if (path[0] === "telemetry" && path[1] === "share") return "telemetry_share";
  return null;
}

/** Every editable key, in schema order: extends, then review, findings, telemetry. */
export const CONFIG_FIELDS: ConfigField[] = (() => {
  const root = SCHEMA as unknown as SchemaNode;
  const fields: ConfigField[] = [];
  const add = (path: string[], node: SchemaNode) =>
    fields.push({
      path,
      kind: kindOf(node),
      description: node.description ?? "",
      options: (node.enum ?? []).filter((v): v is string => typeof v === "string"),
      ...(node.minimum !== undefined ? { minimum: node.minimum } : {}),
      effectiveKey: effectiveKeyFor(path),
    });
  add(["extends"], root.properties!.extends);
  for (const section of SECTIONS) {
    for (const [key, node] of Object.entries(root.properties![section].properties ?? {})) {
      add([section, key], node);
    }
  }
  return fields;
})();

function parse(text: string): Document {
  return parseDocument(text, { version: "1.1" });
}

/** The value at `path` in the file, or undefined when the file leaves it to a wider layer. */
export function readValue(text: string, path: string[]): unknown {
  const doc = parse(text);
  if (doc.errors.length) return undefined;
  const value: unknown = doc.getIn(path);
  return value && typeof value === "object" && "toJSON" in value ? (value as { toJSON(): unknown }).toJSON() : value;
}

/**
 * Sets or removes one key and keeps every comment and key the operator did not touch. YAML 1.1,
 * because the lane reads with PyYAML: a string `off` is written quoted.
 */
export function writeValue(text: string, path: string[], value: unknown): string {
  const doc = parse(text);
  if (doc.errors.length) throw new Error("the file does not parse, so no field can change it");
  if (!isMap(doc.contents)) doc.contents = new YAMLMap();
  if (!doc.has("version")) (doc.contents as YAMLMap).items.unshift(doc.createPair("version", 1));
  if (value === undefined) {
    doc.deleteIn(path);
    const parent = path.length > 1 ? doc.get(path[0]) : null;
    if (isMap(parent) && parent.items.length === 0) doc.delete(path[0]);
  } else {
    // setIn under YAML 1.1 would invent an !!omap for a missing parent.
    if (path.length > 1 && !isMap(doc.get(path[0]))) doc.set(path[0], new YAMLMap());
    doc.setIn(path, value);
  }
  return doc.toString();
}

// The validator also reports every enclosing schema that failed; keep the ones naming a key.
function leafErrors(errors: OutputUnit[]): string[] {
  const real = errors.filter((e) => !["properties", "items", "false"].includes(e.keyword));
  const leaves = real.filter(
    (e) => e.keyword !== "additionalProperties" || !real.some((o) => o !== e && o.instanceLocation.startsWith(`${e.instanceLocation}/`)),
  );
  return [...new Set(leaves.map((e) => `${e.instanceLocation.replace(/^#\/?/, "") || "(file)"}: ${e.error}`))];
}

export function validateConfigText(text: string): string[] {
  const doc = parse(text);
  if (doc.errors.length) return doc.errors.map((e) => e.message);
  const result = validator.validate(doc.toJS() ?? {});
  return result.valid ? [] : leafErrors(result.errors);
}

export function formatConfigValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** One line per key whose value differs, for the PR body. Nothing when the file does not parse. */
export function changedKeys(before: string, after: string): string[] {
  const a = parse(before);
  const b = parse(after);
  if (a.errors.length || b.errors.length) return [];
  const lines: string[] = [];
  for (const field of CONFIG_FIELDS) {
    const was = readValue(before, field.path);
    const now = readValue(after, field.path);
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      lines.push(`${field.path.join(".")}: ${formatConfigValue(was)} → ${formatConfigValue(now)}`);
    }
  }
  return lines;
}

export const EMPTY_CONFIG = "version: 1\n";

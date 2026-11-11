// R4: how SQL is made for the lake. Two facts shape this file (AWS Athena "parameterized queries" page, read 2026-10-30):
//  - execution parameters (?) work for SELECT, INSERT INTO, CTAS and UNLOAD only, and each value is a SQL literal;
//  - DELETE and MERGE cannot be parameterised.
// So: SELECT and INSERT bind every value as a parameter. DELETE takes values only from ids that match a strict allow-list
// (our own ids and hashes, never people's text), and anything else is refused. Identifiers (table and column names) come from the schema,
// never from callers.
import { createHash } from "node:crypto";
import { LAKE_NAMESPACE, LAKE_TABLES, lakeTable, type LakeColumn, type LakeTable } from "@agentx/cloud-contracts";
import { assertSafeId } from "./shared-types.js";

const TABLE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const HEX_HASH = /^[0-9a-f]{64}$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

export type LakeValue = string | number | boolean | null;

/** sha256 of "<system>\0<source id>": the lake column `source_hash`, so a delete by source needs no free text in SQL. */
export function sourceHash(system: string, sourceId: string): string {
  return createHash("sha256").update(`${system}\u0000${sourceId}`).digest("hex");
}

/** sha256 of the actor's source-native id (kept apart from source hashes by a prefix). */
export function actorSourceHash(system: string, actorSourceId: string): string {
  return createHash("sha256").update(`actor\u0000${system}\u0000${actorSourceId}`).digest("hex");
}

/** sha256 of a developer id (the lake never holds the id itself; an erase queues this hash). The same value as `recordDeveloperHash` in the contracts. */
export function developerIdHash(developerId: string): string {
  return createHash("sha256").update(`developer\u0000${developerId}`).digest("hex");
}

/** sha256 of a source place such as `slack:T1/C9` or `github:repo/123`. */
export function scopeHash(scope: string): string {
  return createHash("sha256").update(`scope\u0000${scope}`).digest("hex");
}

/** A string as a SQL literal. Quotes are doubled (Trino has no backslash escape); control characters are refused. */
export function sqlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("team-record lake: value has a control character");
  if (value.length > 100_000) throw new Error("team-record lake: value is too long");
  return `'${value.replaceAll("'", "''")}'`;
}

/** ISO-8601 UTC (with Z) to the text Athena casts to a timestamp. */
export function timestampText(iso: string): string {
  const match = ISO.exec(iso);
  if (match === null) throw new Error("team-record lake: timestamp is not ISO-8601 UTC");
  const [, y, mo, d, h, mi, s, frac] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) throw new Error("team-record lake: timestamp is not a real date");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${(frac ?? "0").padEnd(3, "0")}`;
}

const SQL_TYPE: Record<LakeColumn["type"], string> = { string: "VARCHAR", int: "INTEGER", long: "BIGINT", boolean: "BOOLEAN", timestamp: "TIMESTAMP" };

/** A typed execution parameter (a SQL literal). A null keeps the column's type so a batch of VALUES never has an `unknown` column. */
export function parameterFor(type: LakeColumn["type"], value: LakeValue): string {
  if (value === null) return `CAST(NULL AS ${SQL_TYPE[type]})`;
  switch (type) {
    case "string":
      if (typeof value !== "string") throw new Error("team-record lake: expected a string");
      return sqlString(value);
    case "timestamp":
      if (typeof value !== "string") throw new Error("team-record lake: expected a timestamp");
      return `CAST(${sqlString(timestampText(value))} AS TIMESTAMP)`;
    case "boolean":
      if (typeof value !== "boolean") throw new Error("team-record lake: expected a boolean");
      return value ? "true" : "false";
    case "int":
    case "long":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("team-record lake: expected a whole number");
      return type === "int" ? `CAST(${value} AS INTEGER)` : `CAST(${value} AS BIGINT)`;
  }
}

/** A parameter for a query value whose type the caller names (stats templates). */
export function stringParameter(value: string): string {
  return sqlString(value);
}
export function timestampParameter(iso: string): string {
  return `CAST(${sqlString(timestampText(iso))} AS TIMESTAMP)`;
}

export function tableRef(bucket: string, table: LakeTable["name"]): string {
  if (!TABLE_BUCKET.test(bucket)) throw new Error("team-record lake: table bucket name is not valid");
  lakeTable(table);
  return `"s3tablescatalog/${bucket}"."${LAKE_NAMESPACE}"."${table}"`;
}

export function columnNames(table: LakeTable["name"]): string[] {
  return lakeTable(table).columns.map((column) => column.name);
}

/** A literal for DELETE: only our own safe ids or a sha256 hash. Anything else is refused, so no person's text can reach a DELETE. */
export function deleteLiteral(value: string, kind: "id" | "hash"): string {
  if (kind === "hash") {
    if (!HEX_HASH.test(value)) throw new Error("team-record lake: not a source hash");
    return `'${value}'`;
  }
  assertSafeId(value, "lake delete id");
  return `'${value}'`;
}

/** Every column name a statement can name is in the schema: used by the schema test. */
export function allLakeColumns(): ReadonlySet<string> {
  return new Set(LAKE_TABLES.flatMap((table) => table.columns.map((column) => column.name)));
}

/** INSERT ... SELECT ... FROM VALUES ... WHERE NOT EXISTS, so re-running a batch never duplicates rows (Iceberg append is not idempotent). */
export function buildInsertIfAbsent(bucket: string, table: Exclude<LakeTable["name"], "lessons_history">, rows: ReadonlyArray<Record<string, LakeValue>>): { sql: string; parameters: string[] } {
  if (rows.length === 0) throw new Error("team-record lake: no rows to insert");
  const spec = lakeTable(table);
  const names = spec.columns.map((column) => column.name);
  const target = tableRef(bucket, table);
  const parameters: string[] = [];
  const tuples = rows.map((row) => {
    for (const key of Object.keys(row)) if (!names.includes(key)) throw new Error(`team-record lake: ${key} is not a column of ${table}`);
    const marks = spec.columns.map((column) => {
      const value = row[column.name] ?? null;
      if (value === null && column.required === true) throw new Error(`team-record lake: ${column.name} is required`);
      parameters.push(parameterFor(column.type, value));
      return "?";
    });
    return `(${marks.join(", ")})`;
  });
  const columnList = names.map((name) => `"${name}"`).join(", ");
  const sql =
    `INSERT INTO ${target} (${columnList}) ` +
    `SELECT ${names.map((name) => `s."${name}"`).join(", ")} FROM (VALUES ${tuples.join(", ")}) AS s(${columnList}) ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${target} t WHERE t."workspace_id" = s."workspace_id" AND t."id" = s."id")`;
  return { sql, parameters };
}

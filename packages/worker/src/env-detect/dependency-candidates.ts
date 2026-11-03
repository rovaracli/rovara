// Shared helpers of the dependency detectors (test services D1-D7): the image/driver name tables, safe names, and the merge that turns many sightings of one family into one candidate.
// Everything a detector puts in a candidate is a family id, a kind, a fixed word, a number or an environment variable NAME. A value read from a file (a password, a host, a token) is never copied.
import { looksLikeSecretValue, type TestEnvDependencyKind } from "@agentx/contracts";
import { DEPENDENCY_REFUSED_FIELDS, type DependencyCandidate, type DependencyEvidence, type DependencyHints, type DependencyStrength } from "./types.js";

export const MAX_EVIDENCE = 8;
export const MAX_CANDIDATES = 64;
const MAX_NAMES = 16;
const MAX_PORTS = 8;
const MAX_INIT_FILES = 4;
const STRENGTH_RANK: Record<DependencyStrength, number> = { declared: 3, used: 2, mentioned: 1 };

/** What each recognised family is. The family id is the catalog's: one entry per software, with every image or driver that stands for it listed in the tables below. */
export const FAMILY_KINDS: Readonly<Record<string, TestEnvDependencyKind>> = {
  postgres: "database", mysql: "database", mariadb: "database", mongodb: "database", redis: "cache", memcached: "cache", rabbitmq: "queue", kafka: "stream", elasticsearch: "search", opensearch: "search", smtp: "email",
};

export function kindOfFamily(family: string): TestEnvDependencyKind {
  if (family.startsWith("aws:")) return family === "aws:s3" ? "object_store" : family === "aws:sqs" || family === "aws:sns" ? "queue" : family === "aws:kinesis" ? "stream" : family === "aws:dynamodb" || family === "aws:rds" ? "database" : family === "aws:sagemaker-runtime" ? "model_endpoint" : family === "aws:ses" ? "email" : family === "aws:cognito-idp" ? "identity" : family === "aws:opensearch" || family === "aws:es" ? "search" : family === "aws:elasticache" ? "cache" : "cloud_api";
  if (family.startsWith("http:")) return "http_api";
  return FAMILY_KINDS[family] ?? "other";
}

/** An environment variable name that is safe to carry: upper-case, at most 64 characters, and not shaped like a key. */
export function safeEnvName(name: unknown): string | undefined {
  return typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(name) && !looksLikeSecretValue(name) ? name : undefined;
}

/** A compose service or similar name as a family-safe slug (lower-case, letters, digits and hyphens), or undefined. */
export function slug(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const value = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 39);
  return /^[a-z][a-z0-9-]{0,38}$/u.test(value) ? value.replace(/-+$/u, "") : undefined;
}

// ---- images

const IMAGE_NAMES: ReadonlyArray<{ names: readonly string[]; family: string }> = [
  { names: ["postgres", "postgresql", "postgis", "pgvector", "timescaledb"], family: "postgres" },
  { names: ["mysql"], family: "mysql" },
  { names: ["mariadb"], family: "mariadb" },
  { names: ["mongo", "mongodb", "mongodb-community-server"], family: "mongodb" },
  { names: ["redis", "redis-stack", "redis-stack-server", "valkey"], family: "redis" },
  { names: ["memcached"], family: "memcached" },
  { names: ["rabbitmq"], family: "rabbitmq" },
  { names: ["kafka", "cp-kafka", "cp-server", "redpanda"], family: "kafka" },
  { names: ["elasticsearch"], family: "elasticsearch" },
  { names: ["opensearch"], family: "opensearch" },
  { names: ["mailhog", "mailpit", "maildev"], family: "smtp" },
  { names: ["minio"], family: "aws:s3" },
];

/** What a container image reference stands for. Reads the NAME and the major version only: a registry, a tag suffix, a digest or a credential in the reference is dropped, never kept. */
export function familyFromImage(reference: unknown): { family: string; version?: string; localstack?: boolean } | undefined {
  if (typeof reference !== "string" || reference.length === 0 || reference.length > 300) return undefined;
  // `${NAME:-default}` takes its default; any other substitution stays unknown.
  const resolved = reference.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/gu, "$1");
  if (resolved.includes("$")) return undefined;
  const withoutDigest = resolved.split("@")[0]!;
  const parts = withoutDigest.split("/");
  const last = parts.at(-1)!;
  const colon = last.lastIndexOf(":");
  const name = (colon < 0 ? last : last.slice(0, colon)).toLowerCase();
  const tag = colon < 0 ? undefined : last.slice(colon + 1);
  const version = tag === undefined ? undefined : /^v?(\d{1,3})(?:[.-]|$)/u.exec(tag)?.[1];
  if (name === "localstack") return { family: "localstack", localstack: true, ...(version === undefined ? {} : { version }) };
  const match = IMAGE_NAMES.find((entry) => entry.names.includes(name));
  return match === undefined ? undefined : { family: match.family, ...(version === undefined ? {} : { version }) };
}

/** Services LocalStack names in `SERVICES`, as AWS service ids; unknown words are dropped. */
export function awsServicesFromList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter((part) => /^[a-z][a-z0-9-]{1,39}$/u.test(part)).map((part) => LOCALSTACK_ALIASES[part] ?? part))].slice(0, 24);
}
const LOCALSTACK_ALIASES: Record<string, string> = { ddb: "dynamodb", cognito: "cognito-idp", "sagemaker-runtime": "sagemaker-runtime", secretsmanager: "secretsmanager" };

// ---- constructing and merging

export function candidate(family: string, strength: DependencyStrength, evidence: DependencyEvidence, hints: DependencyHints = {}, kind?: TestEnvDependencyKind): DependencyCandidate {
  return { family, kind: kind ?? kindOfFamily(family), evidence: [evidence], strength, hints };
}

const union = <T>(left: readonly T[] | undefined, right: readonly T[] | undefined, max: number): T[] | undefined => {
  const merged = [...new Set([...(left ?? []), ...(right ?? [])])].slice(0, max);
  return merged.length === 0 ? undefined : merged;
};

function mergeHints(left: DependencyHints, right: DependencyHints): DependencyHints {
  const merged: DependencyHints = {};
  const version = left.version ?? right.version;
  if (version !== undefined) merged.version = version;
  const envNames = union(left.envNames, right.envNames, MAX_NAMES);
  if (envNames !== undefined) merged.envNames = envNames;
  const ports = union(left.ports, right.ports, MAX_PORTS);
  if (ports !== undefined) merged.ports = ports;
  if (left.hasHealthcheck === true || right.hasHealthcheck === true) merged.hasHealthcheck = true;
  const initFiles = union(left.initFiles, right.initFiles, MAX_INIT_FILES);
  if (initFiles !== undefined) merged.initFiles = initFiles;
  const dependsOn = union(left.dependsOn, right.dependsOn, MAX_NAMES);
  if (dependsOn !== undefined) merged.dependsOn = dependsOn;
  const refused = union(left.refused, right.refused, DEPENDENCY_REFUSED_FIELDS.length);
  if (refused !== undefined) merged.refused = refused;
  if (left.explicitEndpoint === true || right.explicitEndpoint === true) merged.explicitEndpoint = true;
  if (left.fakedByTests === true || right.fakedByTests === true) merged.fakedByTests = true;
  if (left.testcontainers === true || right.testcontainers === true) merged.testcontainers = true;
  const url = left.url ?? right.url;
  if (url !== undefined) merged.url = url;
  const keySchema = left.keySchema ?? right.keySchema;
  if (keySchema !== undefined) merged.keySchema = keySchema;
  const resource = left.resource ?? right.resource;
  if (resource !== undefined) merged.resource = resource;
  const seenBy = union(left.seenBy, right.seenBy, 8);
  if (seenBy !== undefined) merged.seenBy = seenBy;
  return merged;
}

/** One candidate per family: the strongest strength, the evidence of every sighting (at most 8, first seen first), and the hints combined. Order is first sighting. At most 64 families. */
export function mergeCandidates(list: readonly DependencyCandidate[]): DependencyCandidate[] {
  const byFamily = new Map<string, DependencyCandidate>();
  for (const item of list) {
    const existing = byFamily.get(item.family);
    if (existing === undefined) {
      if (byFamily.size >= MAX_CANDIDATES) continue;
      byFamily.set(item.family, { ...item, evidence: item.evidence.slice(0, MAX_EVIDENCE), hints: mergeHints(item.hints, {}) });
      continue;
    }
    const seen = new Set(existing.evidence.map((entry) => `${entry.path}:${String(entry.line)}`));
    for (const entry of item.evidence) if (existing.evidence.length < MAX_EVIDENCE && !seen.has(`${entry.path}:${String(entry.line)}`)) existing.evidence.push(entry);
    if (STRENGTH_RANK[item.strength] > STRENGTH_RANK[existing.strength]) existing.strength = item.strength;
    existing.hints = mergeHints(existing.hints, item.hints);
  }
  return [...byFamily.values()];
}

/** A repository-relative path built from a directory and a relative reference: no `..` out of the repository, nothing absolute, no backslash, no home or variable. Undefined otherwise. */
export function joinInside(directory: string, reference: string): string | undefined {
  if (reference.length === 0 || reference.length > 300 || reference.startsWith("/") || reference.startsWith("~") || reference.includes("\\") || reference.includes("$") || reference.includes("\0")) return undefined;
  const out: string[] = [];
  for (const part of [...(directory === "" ? [] : directory.split("/")), ...reference.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (out.length === 0) return undefined; out.pop(); continue; }
    out.push(part);
  }
  return out.length === 0 ? undefined : out.join("/");
}

export const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Folders whose files are never the project's own setup. */
export const DEPENDENCY_SKIP_DIRS = /(?:^|\/)(?:node_modules|dist|build|\.git|venv|\.venv|vendor|\.tox|__pycache__)\//u;

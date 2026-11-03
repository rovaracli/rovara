// Env and settings detector (test services D3; design test-services.md 3.2). Finds the settings that point code at a dependency: `DATABASE_URL`, `REDIS_URL`, `*_HOST`/`*_PORT`, `AMQP_URL`, `KAFKA_BROKERS`,
// `AWS_ENDPOINT_URL_*`, `*_API_KEY` and the like, in `.env*` files and in settings files (`settings.py`, `config/*.y*ml|json|toml|properties`, `application*.properties|y*ml`, `appsettings*.json`).
//
// What leaves this file is the variable NAME, a family, a line, and (for a connection URL) its scheme and HOST FAMILY (`local`, `private`, `cloud`, `unknown`). Never a value, a host name, a user, a password or a
// token. How that is kept:
//   - the user-information part of a URL is skipped by the pattern itself, never captured;
//   - a REAL env file (`.env`, `.env.local`, `.env.production`, ...) is read for names only: no value is looked at. Only the example / sample / template / test / ci / dist files are read for their URL values, because
//     those are written to be copied;
//   - a name must be an upper-case variable name and must not be shaped like a key (the contracts' secret-shape rule), or it is dropped;
//   - http(s) URLs are not read here: outside API hosts are the services detector's (D8).
// Nothing is run; a file is read only if the reader was given its path.
import { candidate, DEPENDENCY_SKIP_DIRS, kindOfFamily, mergeCandidates, safeEnvName, slug } from "./dependency-candidates.js";
import { lineOf, type DependencyCandidate, type DependencyHints, type Detector } from "./types.js";

const DOTENV = /(?:^|\/)\.env(?:\.[A-Za-z0-9_-]{1,32})?$/u;
const DOTENV_ENCRYPTED = /\.(?:enc|age|gpg|sops|vault)$/u;
/** The suffixes of env files written to be copied, so their values are read (for a URL's scheme and host family only). */
const COPYABLE_ENV = /\.(?:example|sample|template|dist|defaults?|test|ci)$/u;
const SETTINGS_FILE = /(?:^|\/)(?:settings(?:\/[A-Za-z0-9_]+)?\.py|config\/[^/]+\.(?:ya?ml|json|toml|properties)|application(?:-[A-Za-z0-9_]+)?\.(?:properties|ya?ml)|appsettings(?:\.[A-Za-z0-9_]+)?\.json)$/u;
export const ENV_CONFIG_MAX_FILES = 40;
const MAX_LINES = 2_000;

// ---- names

const NAME_RULES: ReadonlyArray<{ pattern: RegExp; family: string | ((match: RegExpExecArray) => string | undefined) }> = [
  { pattern: /^(?:POSTGRES|POSTGRESQL|PGHOST|PGPORT|PGUSER|PGDATABASE|PGPASSWORD|PGURL|PG_(?:HOST|PORT|USER|DATABASE|DB|URL|PASSWORD))(?:_|$)/u, family: "postgres" },
  { pattern: /^MYSQL(?:_|$)/u, family: "mysql" },
  { pattern: /^MARIADB(?:_|$)/u, family: "mariadb" },
  { pattern: /^MONGO(?:DB)?(?:_|$)/u, family: "mongodb" },
  { pattern: /^(?:REDIS|VALKEY)(?:_|$)/u, family: "redis" },
  { pattern: /^MEMCACHED?(?:_|$)/u, family: "memcached" },
  { pattern: /^(?:RABBITMQ|AMQP)(?:_|$)/u, family: "rabbitmq" },
  { pattern: /^KAFKA(?:_|$)/u, family: "kafka" },
  { pattern: /^(?:ELASTICSEARCH|ELASTIC_SEARCH|ES_(?:HOST|URL|ENDPOINT|NODES))(?:_|$)/u, family: "elasticsearch" },
  { pattern: /^OPENSEARCH(?:_|$)/u, family: "opensearch" },
  { pattern: /^SMTP(?:_|$)/u, family: "smtp" },
  { pattern: /^AWS_ENDPOINT_URL_([A-Z0-9_]{2,40})$/u, family: (match) => awsService(match[1]!) },
  { pattern: /^S3_(?:BUCKET|ENDPOINT|REGION|PREFIX)(?:_|$)/u, family: "aws:s3" },
  { pattern: /^SQS_/u, family: "aws:sqs" },
  { pattern: /^SNS_/u, family: "aws:sns" },
  { pattern: /^DYNAMO(?:DB)?_/u, family: "aws:dynamodb" },
  { pattern: /^KINESIS_/u, family: "aws:kinesis" },
  { pattern: /^SAGEMAKER_(?:RUNTIME_)?ENDPOINT/u, family: "aws:sagemaker-runtime" },
];
const AWS_SERVICE_ALIASES: Record<string, string> = { dynamodb_streams: "dynamodbstreams", cognito_identity_provider: "cognito-idp", sagemaker_runtime: "sagemaker-runtime" };
function awsService(suffix: string): string | undefined {
  const lower = suffix.toLowerCase();
  const id = AWS_SERVICE_ALIASES[lower] ?? lower.replace(/_/gu, "-");
  return /^[a-z][a-z0-9-]{1,39}$/u.test(id) ? `aws:${id}` : undefined;
}

/** Prefixes that say nothing about WHICH outside service a key belongs to. */
const GENERIC_PREFIXES = new Set(["api", "app", "auth", "secret", "service", "internal", "private", "public", "admin", "master", "access", "default", "base", "client", "server", "backend", "frontend", "web", "my", "your", "test", "dev", "prod", "api-key", "key", "token", "aws", "jwt", "session", "cookie", "encryption", "signing", "csrf", "django", "flask", "rails", "node", "database", "db", "cache", "queue", "storage", "redis"]);
const OUTSIDE_API = /^([A-Z][A-Z0-9]{1,24}(?:_[A-Z0-9]{2,24}){0,2})_(?:API_KEY|API_TOKEN|API_SECRET|API_URL|API_BASE_URL|API_BASE|API_HOST|BASE_URL)$/u;

/** The family a variable name stands for, or undefined. */
export function familyOfName(name: string): string | undefined {
  for (const rule of NAME_RULES) {
    const match = rule.pattern.exec(name);
    if (match === null) continue;
    return typeof rule.family === "string" ? rule.family : rule.family(match);
  }
  const outside = OUTSIDE_API.exec(name)?.[1];
  if (outside === undefined) return undefined;
  const family = slug(outside);
  return family === undefined || GENERIC_PREFIXES.has(family) ? undefined : family;
}

// ---- connection URLs

const SCHEME_FAMILIES: Record<string, string> = { postgres: "postgres", postgresql: "postgres", postgis: "postgres", mysql: "mysql", mysql2: "mysql", mariadb: "mariadb", mongodb: "mongodb", "mongodb+srv": "mongodb", redis: "redis", rediss: "redis", valkey: "redis", amqp: "rabbitmq", amqps: "rabbitmq" };
/** `scheme://[userinfo@]host`: the user information is matched and thrown away, never captured. */
const URL_PATTERN = /(?:jdbc:)?([a-z][a-z0-9+.-]{1,15}):\/\/(?:[^@/?#\s"'`]*@)?(\[[0-9A-Fa-f:.]+\]|[^:/?#\s"'`,;)>}]*)/gu;

export function hostFamily(host: string): "local" | "private" | "cloud" | "unknown" {
  const lower = host.toLowerCase();
  if (lower === "" || /[$<{*]/u.test(lower)) return "unknown";
  if (lower === "localhost" || lower === "[::1]" || lower === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(lower) || lower === "host.docker.internal") return "local";
  const octets = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/u.exec(lower);
  if (octets !== null) { const a = Number(octets[1]); const b = Number(octets[2]); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) ? "private" : "unknown"; }
  if (/\.(?:amazonaws\.com|amazonaws\.com\.cn|azure\.com|azure\.net|windows\.net|googleapis\.com|cloud\.google\.com|rds\.[a-z0-9.-]+|cache\.windows\.net|mongodb\.net|upstash\.io|cloud\.redislabs\.com)$/u.test(lower)) return "cloud";
  if (!lower.includes(".") || /\.(?:local|internal|svc|lan|cluster\.local|svc\.cluster\.local|home\.arpa)$/u.test(lower) || lower.startsWith("[")) return "private";
  return "unknown";
}

interface UrlReading { family: string; scheme: string; hostFamily: ReturnType<typeof hostFamily> }
/** Every connection URL (a database, cache or broker scheme) in a piece of text: its family, scheme and host family. */
export function connectionUrls(text: string): UrlReading[] {
  const found: UrlReading[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const scheme = match[1]!;
    const family = SCHEME_FAMILIES[scheme];
    if (family !== undefined) found.push({ family, scheme, hostFamily: hostFamily(match[2] ?? "") });
  }
  return found;
}

// ---- readers

function add(out: DependencyCandidate[], family: string, path: string, line: number, hints: DependencyHints): void {
  // A family no table knows came from a `<NAME>_API_KEY`-style setting: an outside API.
  const known = kindOfFamily(family);
  out.push(candidate(family, "used", { path, line }, { ...hints, seenBy: ["env"] }, known === "other" ? "http_api" : known));
}

const unquote = (value: string): string => { const trimmed = value.trim(); return /^(["']).*\1$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed; };

function readDotenv(path: string, text: string, out: DependencyCandidate[]): void {
  const copyable = COPYABLE_ENV.test(path);
  const lines = text.split("\n").slice(0, MAX_LINES);
  lines.forEach((raw, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(raw);
    if (match === null) return;
    const name = safeEnvName(match[1]);
    if (name === undefined) return;
    // A real env file: the name is all that is read. The value is not looked at.
    const url = copyable ? connectionUrls(unquote(match[2]!))[0] : undefined;
    const family = url?.family ?? familyOfName(name);
    if (family === undefined) return;
    add(out, family, path, index + 1, { envNames: [name], ...(url === undefined ? {} : { url: { scheme: url.scheme, hostFamily: url.hostFamily } }) });
  });
}

/** Settings files: URL literals, `${VAR}` / `os.environ.get("VAR")` names, and the few framework keys that name a database or cache. */
function readSettings(path: string, text: string, out: DependencyCandidate[]): void {
  for (const match of text.matchAll(URL_PATTERN)) {
    const family = SCHEME_FAMILIES[match[1]!];
    if (family !== undefined) add(out, family, path, lineOf(text, match.index), { url: { scheme: match[1]!, hostFamily: hostFamily(match[2] ?? "") } });
  }
  const names = new Map<string, number>();
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]{1,63})(?=[:}])/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const match of text.matchAll(/(?:environ(?:\.get)?|getenv|env(?:\.[a-z_]+)?|config)\(\s*['"]([A-Z][A-Z0-9_]{1,63})['"]/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const match of text.matchAll(/environ\[\s*['"]([A-Z][A-Z0-9_]{1,63})['"]\s*\]/gu)) names.set(match[1]!, lineOf(text, match.index));
  for (const [raw, line] of names) {
    const name = safeEnvName(raw);
    const family = name === undefined ? undefined : familyOfName(name);
    if (name !== undefined && family !== undefined) add(out, family, path, line, { envNames: [name] });
  }
  const keyed: ReadonlyArray<[RegExp, string]> = [
    [/django(?:\.contrib\.gis)?\.db\.backends\.(?:postgresql|postgis)/u, "postgres"],
    [/django\.db\.backends\.mysql/u, "mysql"],
    [/django_redis|django\.core\.cache\.backends\.redis/u, "redis"],
    [/django\.core\.cache\.backends\.(?:memcached|pymemcache)/u, "memcached"],
    [/^\s*spring\.(?:data\.)?redis\.[a-z.-]+\s*[=:]/mu, "redis"],
    [/^\s*spring\.rabbitmq\.[a-z.-]+\s*[=:]/mu, "rabbitmq"],
    [/^\s*spring\.kafka\.[a-z.-]+\s*[=:]/mu, "kafka"],
    [/^\s*spring\.data\.mongodb\.[a-z.-]+\s*[=:]/mu, "mongodb"],
    [/^\s*spring\.elasticsearch\.[a-z.-]+\s*[=:]/mu, "elasticsearch"],
  ];
  for (const [pattern, family] of keyed) {
    const match = pattern.exec(text);
    if (match !== null) add(out, family, path, lineOf(text, match.index), {});
  }
  if (/(?:^|\/)application[^/]*\.ya?ml$/u.test(path)) {
    // Spring settings in YAML are nested: `spring:` then `redis:` / `rabbitmq:` / `kafka:` / `data: mongodb:` below it.
    for (const [pattern, family] of [[/^\s{2,4}redis:\s*$/mu, "redis"], [/^\s{2,4}rabbitmq:\s*$/mu, "rabbitmq"], [/^\s{2,4}kafka:\s*$/mu, "kafka"], [/^\s{2,6}mongodb:\s*$/mu, "mongodb"], [/^\s{2,4}elasticsearch:\s*$/mu, "elasticsearch"]] as const) {
      const match = /^spring:/mu.test(text) ? pattern.exec(text) : null;
      if (match !== null) add(out, family, path, lineOf(text, match.index), {});
    }
  }
  const connection = /"ConnectionStrings"\s*:/u.exec(text);
  if (connection !== null) {
    // .NET: the names under ConnectionStrings say what each is. The strings themselves are not read.
    const block = text.slice(connection.index, connection.index + 2_000);
    for (const [pattern, family] of [[/"[^"]*(?:postgres|npgsql)[^"]*"\s*:/iu, "postgres"], [/"[^"]*mysql[^"]*"\s*:/iu, "mysql"], [/"[^"]*redis[^"]*"\s*:/iu, "redis"], [/"[^"]*mongo[^"]*"\s*:/iu, "mongodb"], [/"[^"]*(?:rabbit|amqp)[^"]*"\s*:/iu, "rabbitmq"]] as const) {
      const match = pattern.exec(block);
      if (match !== null) add(out, family, path, lineOf(text, connection.index + match.index), {});
    }
  }
}

export const detectEnvConfig: Detector = async ({ repo }) => {
  const files = repo.paths.filter((path) => !DEPENDENCY_SKIP_DIRS.test(path) && ((DOTENV.test(path) && !DOTENV_ENCRYPTED.test(path)) || SETTINGS_FILE.test(path))).slice(0, ENV_CONFIG_MAX_FILES);
  if (files.length === 0) return {};
  const found: DependencyCandidate[] = [];
  for (const path of files) {
    const text = await repo.read(path);
    if (text === undefined) continue;
    if (DOTENV.test(path)) readDotenv(path, text, found);
    else readSettings(path, text, found);
  }
  const dependencies = mergeCandidates(found);
  return dependencies.length === 0 ? {} : { dependencies };
};

// TC-1, binding ADDENDUM-1. Mirrored by contracts/shared/model-gateway-token.v1.json.
export const TASK_TOKEN_TYPE = "rovara-task+jwt";
export const TASK_TOKEN_AUDIENCE = "rovara-model-gateway";
export const TASK_TOKEN_ALGORITHM = "RS256";
export const TASK_TOKEN_SECONDS = 900;
export const TASK_KEY_PURPOSE = "task";
export const TASK_KEY_PURPOSE_MEMBER = "rovara_purpose";
export const TASK_TOKEN_CLAIMS = [
  {
    "name": "iss",
    "type": "string",
    "required": true
  },
  {
    "name": "aud",
    "type": "string",
    "required": true
  },
  {
    "name": "jti",
    "type": "UUID",
    "required": true
  },
  {
    "name": "iat",
    "type": "integer",
    "required": true
  },
  {
    "name": "nbf",
    "type": "integer",
    "required": true
  },
  {
    "name": "exp",
    "type": "integer",
    "required": true
  },
  {
    "name": "cid",
    "type": "string",
    "required": true
  },
  {
    "name": "pid",
    "type": "string",
    "required": true
  },
  {
    "name": "per",
    "type": "string",
    "required": false
  },
  {
    "name": "pay",
    "type": "Payer",
    "required": true
  },
  {
    "name": "tid",
    "type": "string",
    "required": true
  },
  {
    "name": "ws",
    "type": "UUID",
    "required": true
  },
  {
    "name": "op",
    "type": "UUID",
    "required": true
  },
  {
    "name": "stp",
    "type": "string",
    "required": true
  },
  {
    "name": "src",
    "type": "WorkOrigin",
    "required": false
  },
  {
    "name": "mdl",
    "type": "string[]",
    "required": true
  }
] as const;

export const WORK_ORIGINS = ["app", "cli", "mcp", "slack", "linear", "jira", "github_issue", "tracker", "offer", "test_run", "event", "schedule", "chain", "nightly", "automatic"] as const;
export const COMPANY = /^org_[0-9a-z]{20}$/u;
export const PROJECT = /^[a-z][a-z0-9-]{0,62}$/u;
export const PERSON = /^[a-f0-9]{64}$/u;
export const TASK = /^[A-Za-z0-9_.:-]{1,128}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const BUILTIN_AGENTS = new Set(["rovara-code", "ticket-triage", "root-cause-analyst", "code-reviewer", "deploy-reviewer", "service-reviewer"]);
export type Payer = { kind: "member"; developerId: string } | { kind: "project"; project: string } | { kind: "agent"; agentId: string } | { kind: "chain"; chainId: string };
export interface TaskClaims {
  iss: string; aud: typeof TASK_TOKEN_AUDIENCE; jti: string; iat: number; nbf: number; exp: number;
  cid: string; pid: string; per?: string; pay: Payer; tid: string; ws: string; op: string;
  stp: string; src?: typeof WORK_ORIGINS[number]; mdl: string[];
}
export const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
function payer(v: unknown): boolean {
  const p = record(v); if (p === undefined || Object.keys(p).length !== 2) return false;
  switch (p.kind) {
    case "member": return matches(p.developerId, PERSON);
    case "project": return matches(p.project, PROJECT);
    case "chain": return matches(p.chainId, /^chn_[0-9a-z]{20}$/u);
    case "agent": return typeof p.agentId === "string" && (BUILTIN_AGENTS.has(p.agentId) || /^agt_[0-9a-z]{20}$/u.test(p.agentId));
    default: return false;
  }
}
export function parseTaskClaims(value: unknown): TaskClaims | undefined {
  const c = record(value); if (c === undefined) return undefined;
  if (Object.keys(c).some((key) => !TASK_TOKEN_CLAIMS.some((f) => f.name === key))) return undefined;
  if (TASK_TOKEN_CLAIMS.some((f) => f.required && !Object.hasOwn(c, f.name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== TASK_TOKEN_AUDIENCE) return undefined;
  if (![c.jti, c.ws, c.op].every((v) => matches(v, UUID)) || ![c.iat, c.nbf, c.exp].every(whole)) return undefined;
  if (!matches(c.cid, COMPANY) || !matches(c.pid, PROJECT) || !matches(c.tid, TASK) || (c.per !== undefined && !matches(c.per, PERSON))) return undefined;
  if (!payer(c.pay) || !matches(c.stp, /^[a-z][a-z0-9_-]{0,63}$/u) || (c.src !== undefined && !WORK_ORIGINS.some((s) => s === c.src))) return undefined;
  if (!Array.isArray(c.mdl) || c.mdl.length < 1 || c.mdl.length > 16 || !c.mdl.every((v: unknown) => matches(v, MODEL))) return undefined;
  return c as unknown as TaskClaims;
}

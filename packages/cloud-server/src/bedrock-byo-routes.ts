// "Your own Bedrock" (DEC 238, slice 1): the company connects its OWN AWS account's Bedrock for its agents. Nothing secret is
// pasted: the company's AWS admin creates an invoke-only role that trusts Rovara's Bedrock broker role, only with this company's
// external id and its company id as the session name. Cloud asks the model gateway for the external id and the broker role (only
// the gateway may make them), the gateway tests the role (a canary company must be refused: otherwise "too open" and nothing is
// saved), and the store seals the connection in the company document (model-gateway product-keys.ts, provider "bedrock").
//
//   GET    /org/bedrock                    the connection (role, Region, models and each model's state), never a secret
//   GET    /org/bedrock/setup/:region      the company's external id, Rovara's broker role, the template, presets for the Region
//   POST   /org/bedrock/setup              {region, models, allowGlobal}: the one CloudShell command that creates the role
//   PUT    /org/bedrock                    {requestId, expectedRevision, roleArn, region, models, allowGlobal}: test and save
//   DELETE /org/bedrock                    {requestId, expectedRevision}: remove (7-day recovery window in the store)
//
// Who: company admins only (Code's access check made now), reads included. A change needs a fresh step-up and goes through the
// app's signed-write path. Each saved change is audited. The agents use the connection only when the admin also picks "your own
// Bedrock" under AI for your agents (agent-ai-routes.ts): one active source, never an automatic fallback.
import { recordCloudAction, type CloudAuditAction } from "./audit-log.js";
import { COMPANY_ID } from "./company-store.js";
import type { ProductAiErrorCode, ProductAiView } from "./product-ai-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp, STEP_UP_WINDOW_SECONDS } from "./step-up.js";

/** The company document of the product key store (model-gateway product-keys.ts PRODUCT_COMPANY_OWNER) and its one Bedrock source. */
export const BEDROCK_OWNER = "_company";
export const BEDROCK_SOURCE_ID = "src_bedrock";
export interface BedrockChoice { region: string; models: Record<string, string>; allowGlobal: boolean }
export interface BedrockSetupView { externalId: string; brokerRoleArn: string; templateUrl: string }
/** What the routes need from the deployment (scripts/cloud-lambda.ts wires the gateway's signed set-up call). Structural only. */
export interface BedrockBackend {
  /** The company's external id and Rovara's broker role (from the gateway), and the template's docs-site address. Undefined: unavailable. */
  setup(cid: string): Promise<BedrockSetupView | undefined>;
  /** The CloudShell command for this company and choice. Throws on a choice that is not valid. */
  command(setup: BedrockSetupView, cid: string, choice: BedrockChoice): { cloudShellUrl: string; command: string; stackName: string };
  /** The model picker's presets for a Region (agent model name to the Bedrock profile of its geography). */
  presets(region: string): Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REGION = /^(?:us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-[1-9]$/u;
const ROLE_ARN = /^arn:aws:iam::[0-9]{12}:role\/RovaraBedrockInvoke-[A-Za-z0-9+=,.@_-]{1,44}$/u;
const MODEL_NAME = /^claude-[a-z0-9-]{1,80}$/u;
const MODEL_ID = /^(?:[a-z]{2,4}\.|global\.)?anthropic\.claude-[a-z0-9-]{1,80}(?::\d{1,3})?$/u;
const BODY_BYTES_MAX = 4_096;
const MODELS_MAX = 8;
const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
/** Shown when a model is picked but not enabled yet in the company's AWS account. */
export const BEDROCK_NOT_ENABLED_STEPS = "Model not enabled yet in your AWS account. An AWS admin with AWS Marketplace rights opens the model once in the Amazon Bedrock console (Model catalog, then Open in playground). For Anthropic models before Claude Opus 4.7, also submit Anthropic's use-case form once. Then test the connection again.";
const WORDS = Object.freeze({
  off: refusal(501, "NOT_ON_CODE_YET", "Your own Bedrock isn't set up on this Cloud."),
  noCompany: refusal(403, "FORBIDDEN", "Your sign-in doesn't belong to a company Cloud knows."),
  forbidden: refusal(403, "FORBIDDEN", "Only a company admin can see or change the company's Bedrock connection."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  invalid: refusal(400, "CONFIG_INVALID", "This Bedrock connection is not valid. Check the role ARN, the Region and the models."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  stale: refusal(409, "CONFLICT", "The Bedrock connection changed. Refresh and try again."),
  notFound: refusal(404, "NOT_FOUND", "No Bedrock connection is saved for this company."),
  inRecovery: refusal(409, "CONFLICT", "This connection was removed less than 7 days ago. Ask an installation administrator to recover it."),
  tooOpen: refusal(400, "CONFIG_INVALID", "This AWS role would also trust another Rovara company, so it was not saved. Create it again with the setup command (it requires your company's external id and session name), then test again."),
  refused: refusal(400, "CONFIG_INVALID", "AWS refused Rovara for this role. Check the role ARN, and that the role was created with the setup command, then test again."),
  inUse: refusal(409, "CONFLICT", "This AWS role is already connected to another Rovara company. Create a role for this company with the setup command."),
  unavailable: refusal(503, "RUNTIME_UNAVAILABLE", "The Bedrock connection is unavailable right now. Nothing was saved. Try again."),
});
const ANSWER_OF: Partial<Record<ProductAiErrorCode | "aws_too_open" | "aws_refused" | "role_in_use", RouteAnswer>> = {
  invalid: WORDS.invalid, stale: WORDS.stale, not_found: WORDS.notFound, in_recovery: WORDS.inRecovery, forbidden: WORDS.forbidden, unavailable: WORDS.unavailable,
  aws_too_open: WORDS.tooOpen, aws_refused: WORDS.refused, role_in_use: WORDS.inUse,
};
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const exactly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

interface Admin { companyId: string; developerId: string; name: string }
async function admin(context: RouteContext, write: boolean): Promise<Admin | RouteAnswer> {
  const backend = context.productAi;
  if (backend?.bedrock === undefined) return WORDS.off;
  const access = await context.client.access(context.session);
  const said = (access as { companyId?: unknown }).companyId;
  let companyId: string;
  if (said !== undefined) {
    if (typeof said !== "string" || !COMPANY_ID.test(said)) return WORDS.noCompany;
    companyId = said;
  } else if (backend.companyId !== undefined && COMPANY_ID.test(backend.companyId)) companyId = backend.companyId;
  else return WORDS.noCompany;
  if (access.administrator !== true || !/^[a-f0-9]{64}$/u.test(access.developerId)) return WORDS.forbidden;
  if (write && freshStepUp(context.session.accessToken, context.now().getTime(), STEP_UP_WINDOW_SECONDS) === undefined) return WORDS.stepUp;
  return { companyId, developerId: access.developerId, name: access.displayName };
}
async function guarded<T>(run: () => Promise<T>): Promise<T | RouteAnswer> {
  try { return await run(); }
  catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && Object.hasOwn(ANSWER_OF, code) ? ANSWER_OF[code as keyof typeof ANSWER_OF]! : WORDS.unavailable;
  }
}
async function audited(context: RouteContext, who: Admin, action: CloudAuditAction): Promise<void> {
  if (context.audit === undefined) return;
  try {
    await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action, via: "web", subject: "agent_ai:bedrock_byo" }, context.now);
  } catch { console.log(JSON.stringify({ event: "cloud.audit_failed", action, companyId: who.companyId })); }
}
/** A model choice the form sends, checked as the store checks it (the store parses again: model-gateway bedrock-byo.ts). */
function choiceOf(body: Record<string, unknown>): BedrockChoice | undefined {
  const models = record(body.models);
  if (typeof body.region !== "string" || !REGION.test(body.region) || typeof body.allowGlobal !== "boolean" || models === undefined) return undefined;
  const entries = Object.entries(models);
  if (entries.length < 1 || entries.length > MODELS_MAX || !entries.every(([name, id]) => MODEL_NAME.test(name) && typeof id === "string" && MODEL_ID.test(id))) return undefined;
  return { region: body.region, models: Object.fromEntries(entries) as Record<string, string>, allowGlobal: body.allowGlobal };
}

/** The settings page's view: the connection (never a secret), each model's state in fixed words, and any removal window. */
function view(v: ProductAiView) {
  const source = v.sources.find((s) => s.provider === "bedrock") as (ProductAiView["sources"][number] & { bedrock?: { roleArn: string; region: string; models: Record<string, string>; allowGlobal: boolean; checks: Record<string, string>; checkedAt: number } }) | undefined;
  const b = source?.bedrock;
  const anyNotEnabled = b !== undefined && Object.values(b.checks).some((state) => state === "not_enabled");
  return {
    revision: v.revision, canChange: true,
    connection: b === undefined ? null : {
      connected: source!.hasKey && source!.available, connectedAt: source!.connectedAt, updatedAt: source!.updatedAt, ...(source!.warning === undefined ? {} : { refusedAt: source!.warning.at }),
      roleArn: b.roleArn, region: b.region, allowGlobal: b.allowGlobal, checkedAt: b.checkedAt,
      models: Object.entries(b.models).map(([name, id]) => ({ name, id, state: b.checks[id] ?? "unavailable" })),
      ...(anyNotEnabled ? { notEnabledSteps: BEDROCK_NOT_ENABLED_STEPS } : {}),
    },
    removedUntil: v.removed.find((r) => r.provider === "bedrock")?.recoverUntil ?? null,
    usage: "Your AWS account pays for these calls. Rovara counts them at AWS list price under your company's monthly limit; your AWS bill is the record.",
  };
}

async function readBedrock(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, false);
  if ("status" in who) return who;
  const backend = context.productAi!;
  const v = await guarded(() => backend.store.view(backend.issuer, who.companyId, BEDROCK_OWNER));
  return "status" in v ? v : ok(view(v));
}

async function readSetup(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, false);
  if ("status" in who) return who;
  const region = context.params[0] ?? "";
  if (!REGION.test(region)) return WORDS.invalid;
  const bedrock = context.productAi!.bedrock!;
  const setup = await bedrock.setup(who.companyId).catch(() => undefined);
  if (setup === undefined) return WORDS.unavailable;
  return ok({ ...setup, companyId: who.companyId, region, presets: bedrock.presets(region) });
}

async function postSetup(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, false);
  if ("status" in who) return who;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  const choice = body === undefined || !exactly(body, ["region", "models", "allowGlobal"]) ? undefined : choiceOf(body);
  if (choice === undefined) return WORDS.invalid;
  const bedrock = context.productAi!.bedrock!;
  const setup = await bedrock.setup(who.companyId).catch(() => undefined);
  if (setup === undefined) return WORDS.unavailable;
  let made;
  try { made = bedrock.command(setup, who.companyId, choice); } catch { return WORDS.invalid; }
  return ok({ ...setup, companyId: who.companyId, ...made });
}

async function putBedrock(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, true);
  if ("status" in who) return who;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || !exactly(body, ["requestId", "expectedRevision", "roleArn", "region", "models", "allowGlobal"])) return WORDS.invalid;
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision) || typeof body.roleArn !== "string" || !ROLE_ARN.test(body.roleArn)) return WORDS.invalid;
  const choice = choiceOf(body);
  if (choice === undefined) return WORDS.invalid;
  const key = JSON.stringify({ scheme: "assume_role", roleArn: body.roleArn, region: choice.region, models: choice.models, allowGlobal: choice.allowGlobal });
  const backend = context.productAi!;
  const current = await guarded(() => backend.store.view(backend.issuer, who.companyId, BEDROCK_OWNER));
  if ("status" in current) return current;
  const change = { iss: backend.issuer, cid: who.companyId, owner: BEDROCK_OWNER, requestId: body.requestId, expectedRevision: body.expectedRevision, actor: { id: who.developerId, role: "company_admin" as const } };
  const connected = current.sources.some((s) => s.sourceId === BEDROCK_SOURCE_ID && s.hasKey);
  // The store parses it again, asks the gateway to test it for THIS company (canaries included), and seals it.
  const v = await guarded(() => connected ? backend.store.rotate({ ...change, sourceId: BEDROCK_SOURCE_ID, key }) : backend.store.connect({ ...change, sourceId: BEDROCK_SOURCE_ID, provider: "bedrock", key }));
  if ("status" in v) return v;
  await audited(context, who, connected ? "agent_ai.bedrock.rotated" : "agent_ai.bedrock.connected");
  return ok(view(v));
}

async function removeBedrock(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context, true);
  if ("status" in who) return who;
  if (Buffer.byteLength(JSON.stringify(context.body) ?? "", "utf8") > BODY_BYTES_MAX) return WORDS.tooLarge;
  const body = record(context.body);
  if (body === undefined || !exactly(body, ["requestId", "expectedRevision"]) || typeof body.requestId !== "string" || !UUID.test(body.requestId) || !whole(body.expectedRevision)) return WORDS.invalid;
  const backend = context.productAi!;
  const v = await guarded(() => backend.store.remove({ iss: backend.issuer, cid: who.companyId, owner: BEDROCK_OWNER, requestId: body.requestId as string, expectedRevision: body.expectedRevision as number, actor: { id: who.developerId, role: "company_admin" }, sourceId: BEDROCK_SOURCE_ID }));
  if ("status" in v) return v;
  await audited(context, who, "agent_ai.bedrock.removed");
  return ok(view(v));
}

/** Whether the company's own Bedrock is connected (for "AI for your agents"); null when this Cloud can't tell. */
export async function bedrockConnected(context: RouteContext, companyId: string): Promise<boolean | null> {
  const backend = context.productAi;
  if (backend?.bedrock === undefined) return null;
  try {
    const v = await backend.store.view(backend.issuer, companyId, BEDROCK_OWNER);
    return v.sources.some((s) => s.provider === "bedrock" && s.hasKey && s.available);
  } catch { return null; }
}

/** Added to the route table with the product AI routes (the same store). */
export const BEDROCK_BYO_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/bedrock$/u, answer: readBedrock },
  { method: "GET", path: /^\/org\/bedrock\/setup\/([a-z0-9-]{1,32})$/u, answer: readSetup },
  { method: "POST", path: /^\/org\/bedrock\/setup$/u, answer: postSetup },
  { method: "PUT", path: /^\/org\/bedrock$/u, answer: putBedrock },
  { method: "DELETE", path: /^\/org\/bedrock$/u, answer: removeBedrock },
];

// Vercel (Plan 4 Task 24): `x-vercel-signature` is the hex HMAC-SHA1 of the raw body (Vercel's webhook documentation, "Securing webhooks": "The value of this header corresponds to
// the sha1 of the request body using your secret key"; the sample is `createHmac('sha1', secret).update(rawBody).digest('hex')`). The secret is the account webhook's secret shown
// when it was made, or an integration's client secret, pasted in by the person. SHA-1 is Vercel's choice and is accepted only as an HMAC with that secret (a SHA-256 value never
// matches). The documentation's envelope is `{ type, id, createdAt, region, payload }`, `id` being the delivery's id; `createdAt` is a date and time, which Vercel's legacy payload
// types as a number (milliseconds), so a number, a numeral or an ISO time is read. `payload.team.id` may be null (a personal account) and `payload.project.id` is in every deployment
// event. Only `deployment.succeeded` and `deployment.error` become events; others (created, canceled, project events) are ignored. A body is believed only for the hook's own team and
// project when the hook names them. The event's subject is the project (see `normalize`). Rovara's Vercel connection is read-only, so there is no actor to guard against.
import { z } from "zod";
import type { HookRecord, TriggerEvent } from "@rovara-code/contracts";
import { hmacHexEquals, type HookHeaders, type HookProvider, type Normalized } from "./types.js";
import { headerOf, httpsLinkOn, isoOfInstant, titleOf, valuesOf } from "./shared.js";

const WORDS = { "deployment.succeeded": "succeeded", "deployment.error": "failed" } as const;
type VercelType = keyof typeof WORDS;
const isType = (type: unknown): type is VercelType => type === "deployment.succeeded" || type === "deployment.error";

// The tenant is read first, from the parts every deployment event has; what the event itself says is read after, so a body that can't be read is ignored only for the hook's own team.
const TenantOf = z.object({ payload: z.object({
  team: z.object({ id: z.unknown().optional() }).passthrough().nullish(),
  project: z.object({ id: z.unknown().optional() }).passthrough().nullish(),
}).passthrough() }).passthrough();
const Delivery = z.object({ id: z.string().min(1).max(100), createdAt: z.unknown(), payload: z.object({
  deployment: z.object({ id: z.string().min(1).max(200), name: z.unknown().optional() }).passthrough(),
  links: z.object({ deployment: z.unknown().optional() }).passthrough().nullish(),
  target: z.unknown().optional(),
}).passthrough() }).passthrough();

function verify(raw: Buffer, headers: HookHeaders, secret: string): boolean {
  return hmacHexEquals("sha1", raw, secret, headerOf(headers, "x-vercel-signature") ?? "");
}

function normalize(body: unknown, _headers: HookHeaders, hook: HookRecord): Normalized {
  if (hook.source !== "vercel") return { tenantMismatch: true };
  const tenant = hook.tenant as { teamId?: string; projectId?: string };
  const type = (body as { type?: unknown } | null)?.type;
  if (!isType(type)) return { ignored: "not a deployment succeeded or failed" };
  const scope = TenantOf.safeParse(body);
  if (!scope.success) return { tenantMismatch: true };
  if (tenant.teamId !== undefined && scope.data.payload.team?.id !== tenant.teamId) return { tenantMismatch: true };
  if (tenant.projectId !== undefined && scope.data.payload.project?.id !== tenant.projectId) return { tenantMismatch: true };
  const delivery = Delivery.safeParse(body);
  const occurredAt = delivery.success ? isoOfInstant(delivery.data.createdAt) : undefined;
  if (!delivery.success || occurredAt === undefined) return { ignored: "a deployment that can't be read" };
  const { payload } = delivery.data;
  const deploymentId = payload.deployment.id;
  // The subject is the PROJECT, not the deployment: every deploy-fail, agent-push, deploy-fail round is a new deployment of the same project, so only a project-wide subject lets
  // Task 20's 30-minute subject guard see the loop. A body with no readable project id falls back to its deployment.
  const projectId = scope.data.payload.project?.id;
  const subjectId = typeof projectId === "string" && projectId !== "" && projectId.length <= 200 ? projectId : deploymentId;
  const name = typeof payload.deployment.name === "string" && payload.deployment.name.trim() !== "" ? payload.deployment.name : deploymentId;
  const url = httpsLinkOn(payload.links?.deployment, "vercel.com");
  const event: TriggerEvent = {
    source: "vercel", type, eventKey: `vercel:${delivery.data.id}`, occurredAt, project: hook.project,
    subject: { kind: "deployment", id: subjectId, title: titleOf(`${name}: deployment ${WORDS[type]}`, deploymentId), ...(url === undefined ? {} : { url }) },
    fields: { target: valuesOf([payload.target]) },
    actor: { kind: "unknown" },
  };
  return { events: [event] };
}

export const vercelProvider: HookProvider = { source: "vercel", secretOrigin: "vendor", auth: "hmac", verify, normalize };

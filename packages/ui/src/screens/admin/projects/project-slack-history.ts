import { z } from "zod";
import { ReviewedSlackUnbindBodySchema, ReviewedSlackApproveBodySchema, ProjectSlackTargetReaderSchema } from "@agentx/contracts/web";
const scopeSchema = z.object({ orgId: ReviewedSlackUnbindBodySchema.shape.expectedOrgId, developerId: z.string().regex(/^[a-f0-9]{64}$/), project: ProjectSlackTargetReaderSchema.shape.project }).strict();
const unlinkSchema = z.object({ reviewedAt: z.string().datetime(), body: ReviewedSlackUnbindBodySchema }).strict();
const bindSchema = z.discriminatedUnion("operation", [
 unlinkSchema.extend({ operation: z.literal("propose") }).strict(),
 z.object({ operation: z.literal("approve"), reviewedAt: z.string().datetime(), proposalExpiresAt: z.string().datetime(), body: ReviewedSlackApproveBodySchema.extend({ proposalId: z.string().uuid(), teamId: ProjectSlackTargetReaderSchema.shape.teamId, channelId: ProjectSlackTargetReaderSchema.shape.channelId }).strict() }).strict(),
]);
const decisionSchema = z.object({ operation: z.enum(["cancel", "reject"]), reviewedAt: z.string().datetime(), proposalExpiresAt: z.string().datetime(), body: ReviewedSlackApproveBodySchema.extend({ proposalId: z.string().uuid(), teamId: ProjectSlackTargetReaderSchema.shape.teamId, channelId: ProjectSlackTargetReaderSchema.shape.channelId }).strict() }).strict();
const requestSchema = z.union([unlinkSchema, bindSchema, decisionSchema]);
const historySchema = scopeSchema.extend({ version: z.literal(1), requests: z.array(requestSchema).max(10), selectedIndex: z.number().int() }).strict().superRefine((value, ctx) => {
 if (value.selectedIndex < (value.requests.length ? 0 : -1) || value.selectedIndex >= value.requests.length || (!value.requests.length && value.selectedIndex !== -1) || new Set(value.requests.map(row => row.body.requestId)).size !== value.requests.length || value.requests.some(row => row.body.expectedOrgId !== value.orgId)) ctx.addIssue({ code: "custom", message: "Invalid Slack request history." });
});
type Scope = z.infer<typeof scopeSchema>;
export type SlackRequest = z.infer<typeof unlinkSchema>;
export type SlackBindRequest = z.infer<typeof bindSchema>;
export type SlackDecisionRequest = z.infer<typeof decisionSchema>;
type Request = z.infer<typeof requestSchema>;
interface Storage { get(key: string): string | undefined; set(key: string, value: string): void }
const failure = () => new Error("Saved Slack requests could not be verified. Nothing was sent.");
export function slackRequestStorageKey(scope: Scope): string { const value = scopeSchema.parse(scope);return `project-slack:v1:${value.orgId}:${value.developerId}:${encodeURIComponent(value.project)}`; }
function readAll(storage: Storage, scope: Scope): { requests: Request[]; selectedIndex: number } {
 try {
  const raw = storage.get(slackRequestStorageKey(scope));if (raw === undefined) return { requests: [], selectedIndex: -1 };if (raw.length > 16384) throw failure();
  const value = historySchema.parse(JSON.parse(raw));if (value.orgId !== scope.orgId || value.developerId !== scope.developerId || value.project !== scope.project) throw failure();return { requests: value.requests, selectedIndex: value.selectedIndex };
 } catch { throw failure(); }
}
function write(storage: Storage, scope: Scope, history: ReturnType<typeof readAll>) {
 try { const value = historySchema.parse({ ...scope, version: 1, ...history }), raw = JSON.stringify(value), key = slackRequestStorageKey(scope);if (raw.length > 16384) throw failure();storage.set(key, raw);if (storage.get(key) !== raw) throw failure(); } catch { throw failure(); }
}
function retain(storage: Storage, scope: Scope, request: Request): void {
 const parsed = requestSchema.parse(request), history = readAll(storage, scope);if (parsed.body.expectedOrgId !== scope.orgId) throw failure();
 const index = history.requests.findIndex(row => row.body.requestId === parsed.body.requestId);
 if (index !== -1) { if (JSON.stringify(history.requests[index]) !== JSON.stringify(parsed)) throw failure();write(storage, scope, { ...history, selectedIndex: index }); }
 else { const requests = [...history.requests, parsed].slice(-10);write(storage, scope, { requests, selectedIndex: requests.length - 1 }); }
}
const isUnlink = (request: Request): request is SlackRequest => !("operation" in request);
const isBind = (request: Request): request is SlackBindRequest => "operation" in request && (request.operation === "propose" || request.operation === "approve");
const isDecision = (request: Request): request is SlackDecisionRequest => "operation" in request && (request.operation === "cancel" || request.operation === "reject");
function filtered<T extends Request>(storage: Storage, scope: Scope, predicate: (value: Request) => value is T) {
 const all = readAll(storage, scope), selected = all.requests[all.selectedIndex], requests = all.requests.filter(predicate);
 return { requests, selectedIndex: selected === undefined ? -1 : requests.findIndex(row => row.body.requestId === selected.body.requestId) };
}
export function readSlackRequests(storage: Storage, scope: Scope) { return filtered(storage, scope, isUnlink); }
export function readSlackBindRequests(storage: Storage, scope: Scope) { return filtered(storage, scope, isBind); }
export function retainSlackRequest(storage: Storage, scope: Scope, request: SlackRequest): void { retain(storage, scope, unlinkSchema.parse(request)); }
export function retainSlackBindRequest(storage: Storage, scope: Scope, request: SlackBindRequest): void { retain(storage, scope, bindSchema.parse(request)); }
function select<T extends Request>(storage: Storage, scope: Scope, index: number, predicate: (value: Request) => value is T): T {
 const all = readAll(storage, scope), request = all.requests.filter(predicate)[index];if (!Number.isInteger(index) || request === undefined) throw failure();
 write(storage, scope, { ...all, selectedIndex: all.requests.findIndex(row => row.body.requestId === request.body.requestId) });return request;
}
export function selectSlackRequest(storage: Storage, scope: Scope, index: number): SlackRequest { return select(storage, scope, index, isUnlink); }
export function selectSlackBindRequest(storage: Storage, scope: Scope, index: number): SlackBindRequest { return select(storage, scope, index, isBind); }
/** A 404 after receipt retention or proposal expiry never permits a resend. */
export function slackRequestCanResend(request: Request, now: number): boolean {
 const parsed = requestSchema.safeParse(request);if (!parsed.success || !Number.isFinite(now)) return false;const age = now - Date.parse(parsed.data.reviewedAt);
 return age >= 0 && age < 86400000 && (!("proposalExpiresAt" in parsed.data) || now < Date.parse(parsed.data.proposalExpiresAt));
}

export function readSlackDecisionRequests(storage: Storage, scope: Scope) { return filtered(storage, scope, isDecision); }
export function retainSlackDecisionRequest(storage: Storage, scope: Scope, request: SlackDecisionRequest): void { retain(storage, scope, decisionSchema.parse(request)); }
export function selectSlackDecisionRequest(storage: Storage, scope: Scope, index: number): SlackDecisionRequest { return select(storage, scope, index, isDecision); }

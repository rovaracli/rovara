import { z } from "zod";
import { ProjectAllowedWebsitesMutationBodySchema, ProjectAllowedWebsitesApprovalBodySchema, ProjectAllowedWebsitesDecisionBodySchema, ProjectAllowedWebsitesReviewReaderSchema } from "@agentx/cloud-contracts/web";

const scopeSchema = z.object({ orgId: ProjectAllowedWebsitesMutationBodySchema.shape.expectedOrgId, developerId: z.string().regex(/^[a-f0-9]{64}$/), project: ProjectAllowedWebsitesReviewReaderSchema.shape.project }).strict();
const requestSchema = z.union([
 z.object({ operation: z.enum(["save", "propose"]), body: ProjectAllowedWebsitesMutationBodySchema }).strict(),
 z.object({ operation: z.literal("approve"), proposalId: z.string().uuid(), body: ProjectAllowedWebsitesApprovalBodySchema }).strict(),
 z.object({ operation: z.enum(["cancel", "reject"]), proposalId: z.string().uuid(), body: ProjectAllowedWebsitesDecisionBodySchema }).strict(),
]);
const historySchema = scopeSchema.extend({ version: z.literal(1), requests: z.array(requestSchema).max(10), selectedIndex: z.number().int() }).strict().superRefine((value, ctx) => {
 if (value.selectedIndex < (value.requests.length ? 0 : -1) || value.selectedIndex >= value.requests.length || (!value.requests.length && value.selectedIndex !== -1) || new Set(value.requests.map(request => request.body.requestId)).size !== value.requests.length || value.requests.some(request => request.body.expectedOrgId !== value.orgId)) ctx.addIssue({ code: "custom", message: "Invalid request history." });
});
type Scope = z.infer<typeof scopeSchema>;
export type WebsiteRequest = z.infer<typeof requestSchema>;
interface Storage { get(key: string): string | undefined; set(key: string, value: string): void }
const failure = () => new Error("Saved website requests could not be verified. No request was sent.");
export function websiteRequestStorageKey(scope: Scope): string {
 const parsed = scopeSchema.parse(scope);
 return `allowed-websites:v1:${parsed.orgId}:${parsed.developerId}:${encodeURIComponent(parsed.project)}`;
}
export function readWebsiteRequests(storage: Storage, scope: Scope): { requests: WebsiteRequest[]; selectedIndex: number } {
 try {
  const raw = storage.get(websiteRequestStorageKey(scope));
  if (raw === undefined) return { requests: [], selectedIndex: -1 };
  const value = historySchema.parse(JSON.parse(raw));
  if (value.orgId !== scope.orgId || value.developerId !== scope.developerId || value.project !== scope.project) throw failure();
  return { requests: value.requests, selectedIndex: value.selectedIndex };
 } catch { throw failure(); }
}
function write(storage: Storage, scope: Scope, history: ReturnType<typeof readWebsiteRequests>): void {
 try {
  const value = historySchema.parse({ ...scope, version: 1, ...history });
  const key = websiteRequestStorageKey(scope), raw = JSON.stringify(value);
  storage.set(key, raw);
  if (storage.get(key) !== raw) throw failure();
 } catch { throw failure(); }
}
export function retainWebsiteRequest(storage: Storage, scope: Scope, request: WebsiteRequest): void {
 try {
  const parsed = requestSchema.parse(request), history = readWebsiteRequests(storage, scope);
  if (parsed.body.expectedOrgId !== scope.orgId) throw failure();
  const index = history.requests.findIndex(entry => entry.body.requestId === parsed.body.requestId);
  if (index !== -1) {
   if (JSON.stringify(history.requests[index]) !== JSON.stringify(parsed)) throw failure();
   write(storage, scope, { ...history, selectedIndex: index });
  } else {
   const requests = [...history.requests, parsed].slice(-10);
   write(storage, scope, { requests, selectedIndex: requests.length - 1 });
  }
 } catch { throw failure(); }
}
export function selectWebsiteRequest(storage: Storage, scope: Scope, index: number): WebsiteRequest {
 const history = readWebsiteRequests(storage, scope), request = history.requests[index];
 if (!Number.isInteger(index) || !request) throw failure();
 write(storage, scope, { ...history, selectedIndex: index });
 return request;
}

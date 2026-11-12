// Fixtures for the review groups screens (lane exp/review-groups): the server's three reads, as the contracts' own schemas parse them, and a stand-in for its routes.
import { ReviewGroupsViewSchema, TaskReviewViewSchema, REVIEW_CLAIM_APPROVAL_NOTE } from "@agentx/cloud-contracts/web";
import type { ApiRequest, ApiResponse } from "../../../packages/ui/src/host.js";
export const PRIYA = "a".repeat(64), MAYA = "b".repeat(64), OMAR = "c".repeat(64), LENA = "d".repeat(64), VIVI = "e".repeat(64);
export const GROUP_BACKEND = "rgp_" + "1".repeat(16), GROUP_PAYMENTS = "rgp_" + "2".repeat(16);
export const REVIEW_KEY = "f".repeat(64), TASK_ID = "11111111-1111-4111-8111-111111111111";
export const STALE = "This changed while you were looking. Reload and try again.";
export const error = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: { code, message } } });
export const groupsView = (overrides: Record<string, unknown> = {}) => ReviewGroupsViewSchema.parse({ revision: 3, canManage: false, groups: [
 { groupId: GROUP_BACKEND, name: "Backend", members: [{ developerId: PRIYA, name: "Priya", eligible: true }, { developerId: MAYA, name: "Maya", eligible: false }] },
 { groupId: GROUP_PAYMENTS, name: "Payments", members: [{ developerId: OMAR, name: "Omar", eligible: true }] },
], ...overrides });
export const members = { members: [
 { developerId: PRIYA, name: "Priya", role: "maintainer", source: "grant" }, { developerId: MAYA, name: "Maya", role: "contributor", source: "grant" },
 { developerId: OMAR, name: "Omar", role: "contributor", source: "grant" }, { developerId: LENA, name: "Lena", role: "contributor", source: "org_role" },
 { developerId: VIVI, name: "Vivi", role: "viewer", source: "grant" },
] };
export const reviewView = (overrides: Record<string, unknown> = {}) => TaskReviewViewSchema.parse({ waiting: true, reviewKey: REVIEW_KEY, pullRequests: [{ repositoryId: "acme/payments", number: 41, waitingSince: "2026-11-11T08:00:00.000Z" }], waitingSince: "2026-11-11T08:00:00.000Z", aged: false, ageHours: 3, revision: 4,
 claimableGroups: [{ groupId: GROUP_BACKEND, name: "Backend" }], canClaim: false, canRelease: false, canReassign: false, approvalNote: REVIEW_CLAIM_APPROVAL_NOTE, ...overrides });
export const claimOf = (overrides: Record<string, unknown> = {}) => ({ developerId: PRIYA, name: "Priya", groupId: GROUP_BACKEND, groupName: "Backend", claimedAt: "2026-11-11T09:00:00.000Z", hostSync: "requested", ...overrides });
/** A stand-in for the review routes. `calls` holds every request; each answer can be replaced. */
export function reviewServer(options: { groups?: unknown; review?: unknown; put?: (request: ApiRequest) => ApiResponse; post?: (request: ApiRequest) => ApiResponse; reviewStatus?: ApiResponse } = {}) {
 const calls: ApiRequest[] = [], state = { groups: options.groups ?? groupsView(), review: options.review ?? reviewView() };
 const handler = async (request: ApiRequest): Promise<ApiResponse> => {
  calls.push(request);
  if (request.path === "/v1/app/projects/payments/review-groups") return request.method === "PUT" ? (options.put?.(request) ?? { status: 200, body: state.groups }) : { status: 200, body: state.groups };
  if (request.path === "/v1/app/projects/payments/members") return { status: 200, body: members };
  if (request.path === "/v1/app/tasks/" + TASK_ID + "/review") return options.reviewStatus ?? { status: 200, body: state.review };
  if (request.path.startsWith("/v1/app/tasks/" + TASK_ID + "/review/")) return request.method === "POST" ? (options.post?.(request) ?? { status: 200, body: state.review }) : error(404, "NOT_FOUND", "Not found.");
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 };
 return { handler, calls, state, reviewCalls: () => calls.filter(call => call.path.includes("/review")), writes: () => calls.filter(call => call.method !== "GET") };
}

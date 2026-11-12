// The review screens' reads and writes (lane exp/review-groups, switch: review-flags.ts). Server side: packages/broker/src/review-groups/routes.ts; the shapes are in packages/cloud-contracts/src/app-review-groups.ts.
//   GET  /v1/app/projects/{p}/review-groups          the groups, their members and whether the caller may change them (anyone who can see the project)
//   PUT  /v1/app/projects/{p}/review-groups          the whole list, under the revision read (a maintainer, a browser session)
//   GET  /v1/app/projects/{p}/members                the people the picker offers (the existing project members read)
//   GET  /v1/app/tasks/{t}/review                    the waiting review, its claim, its age and what the caller may do
//   POST /v1/app/tasks/{t}/review/(claim|release|reassign)   under the claim's revision and the review's key (a browser session)
// The refusals are fixed texts from the server; the screens show them as they come.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectMembersResponseSchema, ReviewGroupsViewReaderSchema, TaskReviewViewReaderSchema, type ReviewClaimBody, type ReviewGroupInput, type ReviewGroupsBody, type ReviewReassignBody, type ReviewReleaseBody } from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export type { ReviewGroupInput };
/** What the readers give back: the contracts' forward-compatible shapes (an enum word this build does not know reads as "unknown"). */
export type ReviewGroupsView = ReturnType<typeof ReviewGroupsViewReaderSchema.parse>;
export type TaskReviewView = ReturnType<typeof TaskReviewViewReaderSchema.parse>;
/** A person the group picker may offer: a contributor or a maintainer of the project (the floor of their role, as the server's `mayReview` reads it). */
export interface ReviewCandidate { developerId: string; name: string }
export const reviewGroupsPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(project) + "/review-groups";
export const projectMembersPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(project) + "/members";
export const taskReviewPath = (taskId: string): string => "/v1/app/tasks/" + encodeURIComponent(taskId) + "/review";
export const reviewGroupsKey = (project: string) => ["project", project, "review-groups"] as const;
export const reviewMembersKey = (project: string) => ["project", project, "review-members"] as const;
export const taskReviewKey = (taskId: string) => ["task", taskId, "review"] as const;

export function createReviewApi(host: AppHost) {
 const api = createApiClient(host);
 return {
  groups: (project: string): Promise<ReviewGroupsView> => api.get(reviewGroupsPath(project), ReviewGroupsViewReaderSchema),
  saveGroups: (project: string, body: ReviewGroupsBody): Promise<ReviewGroupsView> => api.sendAnswer("PUT", reviewGroupsPath(project), body, ReviewGroupsViewReaderSchema),
  candidates: async (project: string): Promise<ReviewCandidate[]> => (await api.get(projectMembersPath(project), ProjectMembersResponseSchema)).members.filter(member => member.role === "maintainer" || member.role === "contributor").map(member => ({ developerId: member.developerId, name: member.name })),
  review: (taskId: string): Promise<TaskReviewView> => api.get(taskReviewPath(taskId), TaskReviewViewReaderSchema),
  claim: (taskId: string, body: ReviewClaimBody): Promise<TaskReviewView> => api.sendAnswer("POST", taskReviewPath(taskId) + "/claim", body, TaskReviewViewReaderSchema),
  release: (taskId: string, body: ReviewReleaseBody): Promise<TaskReviewView> => api.sendAnswer("POST", taskReviewPath(taskId) + "/release", body, TaskReviewViewReaderSchema),
  reassign: (taskId: string, body: ReviewReassignBody): Promise<TaskReviewView> => api.sendAnswer("POST", taskReviewPath(taskId) + "/reassign", body, TaskReviewViewReaderSchema),
 };
}
export function useReviewApi() { const host = useAppHost();return useMemo(() => createReviewApi(host), [host]); }

/** The groups of a project. Only ever mounted while the switch is on (review-flags.ts). */
export function useReviewGroups(project: string, enabled = true) {
 const api = useReviewApi();
 return useQuery({ queryKey: reviewGroupsKey(project), queryFn: () => api.groups(project), enabled, retry: false });
}
export function useReviewCandidates(project: string, enabled: boolean) {
 const api = useReviewApi();
 return useQuery({ queryKey: reviewMembersKey(project), queryFn: () => api.candidates(project), enabled, retry: false });
}
export function useTaskReview(taskId: string) {
 const api = useReviewApi();
 return useQuery({ queryKey: taskReviewKey(taskId), queryFn: () => api.review(taskId), retry: false });
}

// The v1.2 learning loop calls of the project page: the suggestions a project's corrections produced, and deciding them (design §6.2). The server decides who may, what is less safe and which standing counts; this file only sends and reads.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { LearningAcceptAnswerReaderSchema, LearningDismissAnswerReaderSchema, LearningReopenAnswerReaderSchema, LearningRuleRemoveAnswerReaderSchema, LearningViewAnswerReaderSchema, ProjectOverviewProjectSchema, LearningAcceptBodySchema, LearningDismissBodySchema, LearningRuleRemoveBodySchema } from "@agentx/contracts/web";
import type { z } from "zod";
import { useAppHost, type AppHost } from "../host.js";
import { isConfirmUrl } from "../text/links.js";
import { createApiClient } from "./client.js";

type ViewAnswer = ReturnType<typeof LearningViewAnswerReaderSchema.parse>;
export type LearningView = ViewAnswer;
export type SuggestionView = ViewAnswer["suggestions"][number];
export type RuleView = ViewAnswer["rules"][number];
export type DismissedView = ViewAnswer["dismissed"][number];
/** What a decision came to: it applied (`version` when the server says which), it waits for a second person (the confirmation page, when it is this site's), the rule was edited by hand, or an answer this build does not know. */
export type Decision = { kind: "applied"; version?: number } | { kind: "awaiting"; confirmUrl?: string; changes: string[] } | { kind: "needs_editor"; stage: string } | { kind: "done" };

const base = (project: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/learning";
/** The answer of Dismiss. The contract's reader wants a whole suggestion view, but the route answers `{ suggestion: { id, status } }` (broker/learning/decide.ts); both are read, because the screen only needs to know it worked. */
const DismissAnswerReader = { parse(value: unknown): unknown {
 const whole = LearningDismissAnswerReaderSchema.safeParse(value);
 if (whole.success) return whole.data;
 const body = typeof value === "object" && value !== null ? value as Record<string, unknown> : {}, suggestion = typeof body.suggestion === "object" && body.suggestion !== null ? body.suggestion as Record<string, unknown> : undefined;
 if (suggestion === undefined || typeof suggestion.id !== "string" || typeof suggestion.status !== "string") throw new Error("Unreadable dismiss answer");
 return { suggestion: { id: suggestion.id, status: suggestion.status } };
} };
const NEVER = { retry: "never" } as const;
type AcceptInput = Omit<z.input<typeof LearningAcceptBodySchema>, "requestId">;
type DismissInput = z.input<typeof LearningDismissBodySchema>;
type Answer = { outcome: string; version?: number; confirmUrl?: string; changes?: string[]; stage?: string };

/** The learning calls. Every write is sent once, from the browser session: a refusal is thrown as an `ApiError` for the screen to show, never retried here (`retry: "never"` stops the client's own repeat of a write that carries a request id). */
export function createLearningApi(host: AppHost) {
 const api = createApiClient(host);
 /** A 202 either reads as `needs_confirmation` (the shared reader) or, when the answer lists no changes, arrives as the answer itself; both become one shape, and a link is kept only if it is this site's approval page. */
 const decision = (result: Awaited<ReturnType<typeof api.send<Answer>>>): Decision => {
  if (result.kind === "needs_confirmation") return { kind: "awaiting", changes: result.changes, ...(result.confirmUrl === undefined ? {} : { confirmUrl: result.confirmUrl }) };
  if (result.kind === "needs_admin_approval") return { kind: "awaiting", changes: [] };
  const value = result.value;
  if (value.outcome === "published") return { kind: "applied", ...(typeof value.version === "number" ? { version: value.version } : {}) };
  if (value.outcome === "awaiting_approval") return { kind: "awaiting", changes: Array.isArray(value.changes) ? value.changes : [], ...(typeof value.confirmUrl === "string" && isConfirmUrl(value.confirmUrl, host.origin) ? { confirmUrl: value.confirmUrl } : {}) };
  if (value.outcome === "needs_editor" && typeof value.stage === "string") return { kind: "needs_editor", stage: value.stage };
  return { kind: "done" };
 };
 return {
  view: (project: string) => api.get(base(project), LearningViewAnswerReaderSchema),
  async accept(project: string, suggestionId: string, input: AcceptInput): Promise<Decision> {
   return decision(await api.send("POST", `${base(project)}/suggestions/${encodeURIComponent(suggestionId)}/accept`, LearningAcceptBodySchema.parse({ requestId: crypto.randomUUID(), ...input }), LearningAcceptAnswerReaderSchema as { parse(value: unknown): Answer }, NEVER));
  },
  async dismiss(project: string, suggestionId: string, input: DismissInput): Promise<void> {
   await api.send("POST", `${base(project)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`, LearningDismissBodySchema.parse(input), DismissAnswerReader, NEVER);
  },
  async reopen(project: string, suggestionId: string): Promise<void> {
   await api.send("POST", `${base(project)}/dismissed/${encodeURIComponent(suggestionId)}/reopen`, {}, LearningReopenAnswerReaderSchema, NEVER);
  },
  async removeRule(project: string, ruleId: string): Promise<Decision> {
   return decision(await api.send("POST", `${base(project)}/rules/${encodeURIComponent(ruleId)}/remove`, LearningRuleRemoveBodySchema.parse({ requestId: crypto.randomUUID() }), LearningRuleRemoveAnswerReaderSchema as { parse(value: unknown): Answer }, NEVER));
  },
 };
}
export function useLearningApi() { const host = useAppHost();return useMemo(() => createLearningApi(host), [host]); }
export const learningKey = (project: string) => ["learning", project] as const;
export function useLearning(project: string) { const api = useLearningApi();return useQuery({ queryKey: [...learningKey(project), "view"], queryFn: () => api.view(project) }); }

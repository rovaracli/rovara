// OWNER DECISION 18: what the plan panel and the feedback view read and send. Each read is checked field by field here (anything malformed is left out, never shown); each write goes to the app route
// that calls the old page's own server function, which checks who may.
import type { AppHost } from "../host.js";
import { createApiClient } from "./client.js";

const NEVER = { retry: "never" } as const;
const ANY = { parse: (value: unknown) => value };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? value as Record<string, unknown> : {});

import { isPanelDocument, type PanelDocument } from "../screens/session/panel-docs.js";

export type CommentTarget = { kind: "document" } | { kind: "claim" | "decision" | "check"; id: string };
export interface PanelClaim { id: string; text: string; children: PanelClaim[] }
export interface PanelDecision { id: string; claimId: string; question: string; recommended: string; options: Array<{ id: string; label: string; consequence: string }> }
export interface PanelView {
 document: PanelDocument;
 versions: Array<{ version: number; current: boolean; approved: boolean }>;
 current?: { version: number; approved: boolean } & ({ format: "structured"; title: string; why: Array<{ text: string; author: string }>; claims: PanelClaim[]; decisions: PanelDecision[]; risks: string[]; notChanging: string[] } | { format: "markdown"; markdown: string });
 /** Set when `current` holds an OLDER saved version (read-only); `currentVersion` is the version that is current now. */
 older?: { currentVersion: number };
 checks: Array<{ id: string; label: string }>;
 unverified: boolean;
 waiting: boolean;
 access: { canComment: boolean; canSuggest: boolean; canDecide: boolean; canAsk: boolean };
}
export interface PanelComment {
 id: string; parentId?: string; document: string; version: number; target: CommentTarget;
 author: { kind: "person" | "agentx"; name: string; owner: boolean; you: boolean };
 text: string; edited: boolean; deleted: boolean; sent: boolean; rev: number; remembered?: boolean; agentx?: string;
}
export interface PanelSuggestion { document: string; decisionId: string; optionId: string; name: string; you: boolean }

function claimsOf(value: unknown, depth = 0): PanelClaim[] {
 return depth > 3 ? [] : list(value).flatMap(raw => { const claim = obj(raw);return typeof claim.id === "string" && typeof claim.text === "string" ? [{ id: claim.id, text: claim.text, children: claimsOf(claim.children, depth + 1) }] : []; });
}

function targetOf(value: unknown): CommentTarget | undefined {
 const target = obj(value);
 if (target.kind === "document") return { kind: "document" };
 return (target.kind === "claim" || target.kind === "decision" || target.kind === "check") && typeof target.id === "string" ? { kind: target.kind, id: target.id } : undefined;
}

export function readPanelView(value: unknown): PanelView {
 const view = obj(value), access = obj(view.access), current = obj(view.current);
 const document = isPanelDocument(str(view.document)) ? str(view.document) as PanelDocument : "plan";
 let shown: PanelView["current"];
 if (typeof current.version === "number" && current.format === "structured") {
  shown = { version: current.version, approved: current.approved === true, format: "structured", title: str(current.title, "Untitled"),
   why: list(current.why).flatMap(raw => { const why = obj(raw);return typeof why.text === "string" ? [{ text: why.text, author: str(why.author, "Someone") }] : []; }),
   claims: claimsOf(current.claims),
   decisions: list(current.decisions).flatMap(raw => { const decision = obj(raw);
    if (typeof decision.id !== "string" || typeof decision.question !== "string") return [];
    return [{ id: decision.id, claimId: str(decision.claimId), question: decision.question, recommended: str(decision.recommended),
     options: list(decision.options).flatMap(rawOption => { const option = obj(rawOption);return typeof option.id === "string" && typeof option.label === "string" ? [{ id: option.id, label: option.label, consequence: str(option.consequence) }] : []; }) }]; }),
   risks: list(current.risks).filter((line): line is string => typeof line === "string"), notChanging: list(current.notChanging).filter((line): line is string => typeof line === "string") };
 } else if (typeof current.version === "number" && current.format === "markdown" && typeof current.markdown === "string") {
  shown = { version: current.version, approved: current.approved === true, format: "markdown", markdown: current.markdown };
 }
 return {
  document, ...(shown === undefined ? {} : { current: shown }), ...(typeof obj(view.older).currentVersion === "number" ? { older: { currentVersion: obj(view.older).currentVersion as number } } : {}),
  versions: list(view.versions).flatMap(raw => { const entry = obj(raw);return typeof entry.version === "number" ? [{ version: entry.version, current: entry.current === true, approved: entry.approved === true }] : []; }),
  checks: list(view.checks).flatMap(raw => { const check = obj(raw);return typeof check.id === "string" && typeof check.label === "string" ? [{ id: check.id, label: check.label }] : []; }),
  unverified: view.unverified === true, waiting: view.waiting === true,
  access: { canComment: access.canComment === true, canSuggest: access.canSuggest === true, canDecide: access.canDecide === true, canAsk: access.canAsk === true },
 };
}

export function readPanelComments(value: unknown): { comments: PanelComment[]; suggestions: PanelSuggestion[]; canRemember: boolean } {
 const body = obj(value);
 const comments = list(body.comments).flatMap((raw): PanelComment[] => {
  const item = obj(raw), author = obj(item.author), target = targetOf(item.target), learning = obj(item.learning);
  if (typeof item.id !== "string" || !UUID.test(item.id) || target === undefined || typeof item.version !== "number" || (author.kind !== "person" && author.kind !== "agentx")) return [];
  return [{ id: item.id, ...(typeof item.parentId === "string" && UUID.test(item.parentId) ? { parentId: item.parentId } : {}), document: str(item.document), version: item.version, target,
   author: { kind: author.kind, name: str(author.name, author.kind === "agentx" ? "Rovara" : "Someone"), owner: author.owner === true, you: author.you === true },
   text: str(item.text), edited: item.edited === true, deleted: item.deleted === true, sent: item.sent === true, rev: typeof item.rev === "number" ? item.rev : 1,
   ...(typeof learning.remembered === "boolean" ? { remembered: learning.remembered } : {}), ...(typeof item.agentx === "string" ? { agentx: item.agentx } : {}) }];
 });
 const suggestions = list(body.suggestions).flatMap((raw): PanelSuggestion[] => {
  const item = obj(raw);
  return typeof item.decisionId === "string" && typeof item.optionId === "string" ? [{ document: str(item.document), decisionId: item.decisionId, optionId: item.optionId, name: str(item.name, "Someone"), you: item.you === true }] : [];
 });
 return { comments, suggestions, canRemember: body.canRemember === true };
}

export function createPlanPanelApi(host: AppHost) {
 const api = createApiClient(host);
 const base = (taskId: string) => "/v1/app/tasks/" + encodeURIComponent(taskId);
 return {
  document: async (taskId: string, document: PanelDocument, version?: number) => readPanelView(await api.get(base(taskId) + "/documents/" + document + (version === undefined ? "" : "?version=" + String(version)), ANY)),
  comments: async (taskId: string) => readPanelComments(await api.get(base(taskId) + "/comments", ANY)),
  comment: (taskId: string, input: { document: PanelDocument; version: number; target: CommentTarget; parentId?: string; text: string; ask: boolean }) =>
   api.sendAnswer("POST", base(taskId) + "/comments", { requestId: crypto.randomUUID(), ...input }, ANY, NEVER),
  edit: (taskId: string, commentId: string, rev: number, text: string) => api.sendAnswer("POST", base(taskId) + "/comments/" + commentId + "/edit", { rev, text }, ANY, NEVER),
  remove: (taskId: string, commentId: string, rev: number) => api.sendAnswer("POST", base(taskId) + "/comments/" + commentId + "/delete", { rev }, ANY, NEVER),
  suggest: (taskId: string, document: PanelDocument, decisionId: string, optionId: string | null) => api.sendAnswer("POST", base(taskId) + "/suggestions", { document, decisionId, optionId }, ANY, NEVER),
  learn: (taskId: string, commentId: string, action: "remember" | "forget") => api.sendAnswer("POST", base(taskId) + "/comments/" + commentId + "/" + action, {}, ANY, NEVER),
  feedback: async (taskId: string) => obj(obj(await api.get(base(taskId) + "/workflow/feedback", ANY)).review),
  /** Retry review of a feedback review that did not finish: `started` is false when it had already been retried (nothing changed). */
  retryFeedback: async (taskId: string, reviewDigest: string) => ({ started: obj(await api.sendAnswer("POST", base(taskId) + "/workflow/feedback-retry", { reviewDigest }, ANY, NEVER)).started === true }),
  decideFeedback: (taskId: string, input: Record<string, unknown>) => api.sendAnswer("POST", base(taskId) + "/workflow/feedback-decision", { requestId: crypto.randomUUID(), ...input }, ANY, NEVER),
 };
}

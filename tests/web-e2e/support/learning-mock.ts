// The project's learning routes for the "Suggested rules" journey: the view, accept, dismiss, reopen and remove. State lives for one scenario. Bodies are parsed by the contract's strict schemas, as the real routes do.
import { LearningAcceptBodySchema, LearningDismissBodySchema, LearningReopenBodySchema, LearningRuleRemoveBodySchema, LearningViewAnswerSchema } from "@agentx/contracts/web";
import type { MockExchange } from "./how-we-work-mock.js";
interface Suggestion { id: string; stage: string; text: string; revision: number }
interface Rule { id: string; stage: string; text: string; status: "active" | "removed"; processVersion: number }
interface Dismissed { id: string; stage: string; at: string; kind: string; text: string }
let state = fresh();
function fresh() { return { suggestions: [{ id: "sug_build", stage: "build", text: "Add a test for every bug fix.", revision: 1 }, { id: "sug_plan", stage: "plan", text: "Name the files a plan will touch.", revision: 1 }] as Suggestion[], dismissed: [] as Dismissed[], rules: [] as Rule[], version: 2 }; }
export function resetLearning(): void { state = fresh(); }
const source = (taskId: string, label: string) => ({ kind: "comment", taskId, label, at: "2026-10-28T10:00:00.000Z", standing: "member", href: `/review/${taskId}/task` });
const view = () => LearningViewAnswerSchema.parse({
 settings: { prComments: "off", locked: false }, canDecide: true, skippedUnlinked: 0,
 suggestions: state.suggestions.map(item => ({ id: item.id, stage: item.stage, status: "open", proposedText: item.text, allFromOnePerson: false, lessSafe: false, lessSafeWords: [], overlaps: [], sources: [source("tsk_a", "Please add a test."), source("tsk_b", "Tests are missing again.")], revision: item.revision, sourceCount: 2, canDecide: true })),
 dismissed: state.dismissed.map(item => ({ id: item.id, stage: item.stage, dismissedAt: item.at, dismissKind: item.kind })),
 rules: state.rules.map(item => ({ id: item.id, stage: item.stage, text: item.text, status: item.status, processVersion: item.processVersion })),
});
const conflict = { error: { code: "AGENT_REVISION_CONFLICT", message: "This suggestion changed. Reload and try again." } };
/** Answers the learning routes of the `project` scenario; false when the request is not one of them. */
export async function learningMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
 const base = "/v1/web/projects/payments/learning";
 if (url.pathname === base && method === "GET") { json(200, view());return true; }
 const accept = new RegExp(`^${base}/suggestions/([A-Za-z0-9_-]+)/accept$`).exec(url.pathname), dismiss = new RegExp(`^${base}/suggestions/([A-Za-z0-9_-]+)/dismiss$`).exec(url.pathname), reopen = new RegExp(`^${base}/dismissed/([A-Za-z0-9_-]+)/reopen$`).exec(url.pathname), remove = new RegExp(`^${base}/rules/([A-Za-z0-9_-]+)/remove$`).exec(url.pathname);
 if (method !== "POST" || (accept === null && dismiss === null && reopen === null && remove === null)) return false;
 if (accept !== null) {
  const input = LearningAcceptBodySchema.parse(await body());record(input);
  const found = state.suggestions.find(item => item.id === accept[1]);
  if (found === undefined || found.revision !== input.expectedRevision) { json(409, conflict);return true; }
  state.version += 1;state.suggestions = state.suggestions.filter(item => item !== found);state.rules.push({ id: "rul_" + found.id, stage: input.stage, text: input.text, status: "active", processVersion: state.version });
  json(200, { outcome: "published", version: state.version });return true;
 }
 if (dismiss !== null) {
  const input = LearningDismissBodySchema.parse(await body());record(input);
  const found = state.suggestions.find(item => item.id === dismiss[1]);
  if (found === undefined || found.revision !== input.expectedRevision) { json(409, conflict);return true; }
  state.suggestions = state.suggestions.filter(item => item !== found);state.dismissed.push({ id: found.id, stage: found.stage, at: "2026-10-30T09:00:00.000Z", kind: input.dismissKind, text: found.text });
  json(200, { suggestion: { id: found.id, status: "dismissed" } });return true;
 }
 if (reopen !== null) {
  record(LearningReopenBodySchema.parse(await body()));
  const found = state.dismissed.find(item => item.id === reopen[1]);
  if (found === undefined) { json(404, { error: { code: "NOT_FOUND", message: "That suggestion is gone." } });return true; }
  state.dismissed = state.dismissed.filter(item => item !== found);state.suggestions.push({ id: found.id, stage: found.stage, text: found.text, revision: 3 });
  json(200, { reopened: true });return true;
 }
 const input = LearningRuleRemoveBodySchema.parse(await body());record(input);
 const rule = state.rules.find(item => item.id === remove![1]);
 if (rule === undefined || rule.status !== "active") { json(404, { error: { code: "NOT_FOUND", message: "That rule is gone." } });return true; }
 state.version += 1;rule.status = "removed";json(200, { outcome: "published", version: state.version });return true;
}

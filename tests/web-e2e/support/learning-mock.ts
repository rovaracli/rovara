// The project's learning routes for the "Suggested rules" journey: the view, accept, dismiss, reopen and remove. State lives for one scenario. Bodies are parsed by the contract's strict schemas, as the real routes do.
import { LearningCompanySettingsAnswerSchema, LearningCompanySettingsBodySchema, ProjectOverviewLearningSchema, LearningAcceptBodySchema, LearningDismissBodySchema, LearningReopenBodySchema, LearningRuleRemoveBodySchema, LearningViewAnswerSchema, LearningSettingsBodySchema, LearningProposalDecisionBodySchema } from "@agentx/contracts/web";
import type { MockExchange } from "./how-we-work-mock.js";
import { mockCellOrigin } from "./port.js";
interface Suggestion { id: string; stage: string; text: string; revision: number }
interface Rule { id: string; stage: string; text: string; status: "active" | "removed"; processVersion: number }
interface Dismissed { id: string; stage: string; at: string; kind: string; text: string }
let state = fresh();
// The company's master switch (for the project and the company page): on and chosen by the company, until a journey sets it with POST /__mock/learning-settings.
let company = freshCompany();
function freshCompany() { return { suggestions: "on" as "on" | "off", source: "company" as "company" | "install_default", revision: 1, corrections: 4 }; }
function fresh() { return { suggestions: [{ id: "sug_build", stage: "build", text: "Add a test for every bug fix.", revision: 1 }, { id: "sug_plan", stage: "plan", text: "Name the files a plan will touch.", revision: 1 }] as Suggestion[], dismissed: [] as Dismissed[], rules: [] as Rule[], version: 2, settings: { prComments: "off" as "on" | "off", locked: false, revision: 1, pending: undefined as string | undefined } }; }
export function resetLearning(): void { state = fresh();company = freshCompany(); }
/** The company has locked PR comment learning off (the lock row of the guardrails). */
export function lockLearning(): void { state.settings.locked = true; }
const settingsView = () => ({ prComments: state.settings.locked ? "off" as const : state.settings.prComments, locked: state.settings.locked, ...(state.settings.locked ? { lockedBy: "company" as const } : {}), revision: state.settings.revision, ...(state.settings.pending === undefined ? {} : { pendingProposal: { id: state.settings.pending } }) });
const off = () => ({ error: { code: "LEARNING_SUGGESTIONS_OFF", message: "Suggestions are off for this company." } });
const source = (taskId: string, label: string) => ({ kind: "comment", taskId, label, at: "2026-10-28T10:00:00.000Z", standing: "member", href: `/review/${taskId}/task` });
const view = () => LearningViewAnswerSchema.parse({
 settings: settingsView(), canDecide: true, skippedUnlinked: 0,
 ...(company.suggestions === "off" ? { suggestionsState: { state: "collecting", corrections: company.corrections } } : {}),
 suggestions: company.suggestions === "off" ? [] : state.suggestions.map(item => ({ id: item.id, stage: item.stage, status: "open", proposedText: item.text, allFromOnePerson: false, lessSafe: false, lessSafeWords: [], overlaps: [], sources: [source("tsk_a", "Please add a test."), source("tsk_b", "Tests are missing again.")], revision: item.revision, sourceCount: 2, canDecide: true })),
 dismissed: state.dismissed.map(item => ({ id: item.id, stage: item.stage, dismissedAt: item.at, dismissKind: item.kind })),
 rules: state.rules.map(item => ({ id: item.id, stage: item.stage, text: item.text, status: item.status, processVersion: item.processVersion })),
});
const conflict = { error: { code: "AGENT_REVISION_CONFLICT", message: "This suggestion changed. Reload and try again." } };
/** Answers the learning routes of the `project` scenario; false when the request is not one of them. */
export async function learningMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
 const base = "/v1/web/projects/payments/learning";
 if (url.pathname === base && method === "GET") { json(200, view());return true; }
 const accept = new RegExp(`^${base}/suggestions/([A-Za-z0-9_-]+)/accept$`).exec(url.pathname), dismiss = new RegExp(`^${base}/suggestions/([A-Za-z0-9_-]+)/dismiss$`).exec(url.pathname), reopen = new RegExp(`^${base}/dismissed/([A-Za-z0-9_-]+)/reopen$`).exec(url.pathname), remove = new RegExp(`^${base}/rules/([A-Za-z0-9_-]+)/remove$`).exec(url.pathname);
 // The settings: turning on waits for a second person (a proposal); turning off applies at once.
 if (url.pathname === base + "/settings" && method === "PUT") {
  const input = LearningSettingsBodySchema.parse(await body());record(input);
  if (state.settings.locked) { json(403, { error: { code: "FORBIDDEN", message: "Your company has turned this off." } });return true; }
  if (input.expectedRevision !== state.settings.revision) { json(409, { error: { code: "CHANGE_STALE", message: "Learning settings changed. Refresh before deciding." } });return true; }
  state.settings.revision += 1;
  if (input.prComments === "on") { state.settings.pending = "prop_1";json(200, { applied: false, proposalId: "prop_1" });return true; }
  state.settings.prComments = "off";state.settings.pending = undefined;json(200, { applied: true, settings: settingsView() });return true;
 }
 const settled = new RegExp(`^${base}/settings/proposals/([A-Za-z0-9_-]+)/decide$`).exec(url.pathname);
 if (settled !== null && method === "POST") {
  const input = LearningProposalDecisionBodySchema.parse(await body());record(input);
  if (state.settings.pending !== settled[1]) { json(409, { error: { code: "CHANGE_STALE", message: "Learning settings changed. Refresh before deciding." } });return true; }
  state.settings.revision += 1;state.settings.pending = undefined;if (input.decision === "approve") state.settings.prComments = "on";
  json(200, { settings: settingsView() });return true;
 }
 if (method !== "POST" || (accept === null && dismiss === null && reopen === null && remove === null)) return false;
 if (company.suggestions === "off" && (accept !== null || dismiss !== null || reopen !== null)) { json(409, off());return true; }
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

/** Answers GET and PUT /v1/web/org/learning-settings (any scenario) and the journey's POST /__mock/learning-settings, which sets the switch before the page opens. */
export async function learningSettingsMock({ url, method, body, json, record }: Pick<MockExchange, "url" | "method" | "body" | "json" | "record">): Promise<boolean> {
 const path = "/v1/web/org/learning-settings", answer = () => LearningCompanySettingsAnswerSchema.parse({ suggestions: company.suggestions, source: company.source, revision: company.revision, canChange: true });
 if (url.pathname === "/__mock/learning-settings" && method === "POST") { company = { ...company, ...(await body() as Partial<typeof company>) };json(200, { ok: true });return true; }
 if (url.pathname !== path) return false;
 if (method === "GET") { json(200, answer());return true; }
 if (method !== "PUT") return false;
 const input = LearningCompanySettingsBodySchema.parse(await body());record(input);
 if (input.expectedRevision !== company.revision) { json(409, { error: { code: "LEARNING_SETTINGS_CHANGED", message: "Changed." } });return true; }
 company = { ...company, suggestions: input.suggestions, source: "company", revision: company.revision + 1 };json(200, answer());return true;
}

/** The overview's learning block (3 of 12 corrections repeated, down from 40% last month, 2 repeats after a Build rule) and Home's one "Suggested rules" card, both for the `project` scenario. */
export const overviewLearning = () => ProjectOverviewLearningSchema.parse({ thisMonth: { repeats: 3, corrections: 12, enoughData: true }, lastMonthShare: 0.4, repeatsAfterRule: [{ ruleId: "rul_old", stage: "build", repeats: 2 }], ...(company.suggestions === "off" ? { suggestions: { state: "collecting", corrections: company.corrections } } : {}) });
export const ruleSuggestionCard = () => ({ cardId: "rule_suggestion:abc123", kind: "rule_suggestion" as const, title: "Suggested rules for \u201cpayments\u201d", reason: "2 suggested rules to review in \u201cpayments\u201d", at: "2026-10-29T12:00:00.000Z", buttons: [{ action: "open" as const, label: "Review", method: "GET" as const, href: mockCellOrigin() + "/app/projects/payments?tab=how-we-work" }] });
/** Home's cards for the `project` scenario: the server sends no rule_suggestion card while the company's suggestions are off. */
export const homeSuggestionCards = () => company.suggestions === "off" ? [] : [ruleSuggestionCard()];

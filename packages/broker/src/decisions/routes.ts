// Decision cards (Decisions D2): the routes and the SERVER-SIDE friction. A card is a projection (project.ts); these routes are where its rules are enforced, so no client can skip them:
//   GET  /v1/app/decisions                       the caller's cards (and the tabs of a Full pair)
//   POST /v1/app/decisions/{id}/evidence-opened  records that the caller opened the evidence of what they were shown (medium only)
//   POST /v1/app/decisions/{id}/approve          low: one request. medium: 409 (CHANGE_STALE) unless the evidence was opened, and opened as it is now. high: there is no approve route (404)
//   POST /v1/app/decisions/{id}/reject           a reason in one tap; never a way to approve
// One card, one request: there is no bulk route and a body with a list of ids is refused by the strict schema. The approve and reject DO NOT decide anything themselves: they call the existing
// endpoint through the injected `performer` (a plan decision, a merge press, a spend decision, ...), which checks the caller's live authority again. Mounting is one call (routeDecisionCards).
import {
  DECISION_CARDS_MAX, DecisionApproveBodySchema, DecisionCardIdSchema, DecisionEvidenceOpenedBodySchema, DecisionRejectBodySchema, agentXError,
  type DecisionAnswered, type DecisionCard, type DecisionCardsView, type DecisionEvidenceOpenedAnswer, type DecisionRejectReason, type DecisionTab, type DecisionTabId,
} from "@agentx/contracts";
import { StatusReply } from "../aws/status-reply.js";
import { cardDigest } from "./digest.js";
import { decisionMadeMeasure, type DecisionMeasure } from "./measures.js";
import { projectDecisionCards, type DecisionItem, type Projection } from "./project.js";
import type { DecisionLocks } from "./risk-tier.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

export interface DecisionCaller { orgId: string; developerId: string }

/** Where the pending items come from. `list` answers only what THIS caller may decide now (the source checks their live authority); a card that is not in it does not exist for them. */
export interface DecisionSources {
  list(caller: DecisionCaller): Promise<readonly DecisionItem[]>;
  locks(caller: DecisionCaller): Promise<DecisionLocks>;
}

/** What an approve or a reject does: the existing endpoint's own function. It may throw an `AgentXError`, which the route passes on. */
export interface DecisionPerformer {
  /** `subjectId` is the pending item to act on: the card's own, or for a tab the document that tab names. */
  approve(caller: DecisionCaller, card: DecisionCard, input: { requestId: string; subjectId: string; tab?: DecisionTabId | undefined }): Promise<void>;
  reject(caller: DecisionCaller, card: DecisionCard, input: { requestId: string; subjectId: string; reason: DecisionRejectReason; tab?: DecisionTabId | undefined }): Promise<void>;
}

export interface DecisionRouteDependencies {
  sources: DecisionSources;
  performer: DecisionPerformer;
  store: DecisionStore;
  now: () => number;
  /** Measure lines go here (METRIC style); a failure to log never changes an answer. */
  log?: ((measure: DecisionMeasure) => void) | undefined;
}

export interface DecisionRequest { method: string; pathname: string; searchParams: URLSearchParams; body: unknown }

const PATH = /^\/v1\/app\/decisions(?:\/([^/]+)\/(approve|reject|evidence-opened))?$/u;
const ISSUE = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): never => {
  const issue = error.issues[0];
  // Field names only: the values are the caller's.
  throw agentXError("CONFIG_INVALID", `${issue?.path.map(String).join(".") || "body"}: ${issue?.message ?? "invalid"}`);
};

async function project(deps: DecisionRouteDependencies, caller: DecisionCaller): Promise<Projection> {
  const [items, locks] = await Promise.all([deps.sources.list(caller), deps.sources.locks(caller)]);
  return projectDecisionCards(items, { locks });
}

/** The caller's pending card, with its tabs; NOT_FOUND for a card that is not theirs, not there, or not waiting. */
function pendingCard(projection: Projection, cardId: string): { card: DecisionCard; tabs: DecisionTab[] | undefined; subjectOf(tab?: DecisionTabId): string } {
  const card = projection.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined || card.status !== "pending") throw agentXError("NOT_FOUND", "This decision is no longer waiting for you.");
  const subjects = projection.tabSubjects[card.id];
  return { card, tabs: projection.tabs[card.id], subjectOf: (tab) => (tab === undefined || subjects === undefined ? card.id.slice(card.id.indexOf(":") + 1) : subjects[tab]) };
}

export const DECISION_OPEN_FIRST_MESSAGE = "Open the evidence first. It has changed or has not been opened.";
export const DECISION_FULL_PAGE_MESSAGE = "This decision is made on its own page. Open it to decide.";

const tabsPending = (tabs: readonly DecisionTab[] | undefined): DecisionTabId[] => (tabs ?? []).filter((tab) => !tab.approved).map((tab) => tab.id);

function emit(deps: DecisionRouteDependencies, measure: DecisionMeasure | undefined): void {
  if (measure === undefined) return;
  try { deps.log?.(measure); } catch { /* a measure never changes an answer */ }
}

/** The decision already happened (the existing endpoint decided it), so a failure to write its history row never turns the answer into an error. */
async function remember(deps: DecisionRouteDependencies, record: DecisionRecord): Promise<void> {
  try { await deps.store.recordDecision(record); } catch { /* history is best effort */ }
}

/** Handles the card routes; undefined for any other path (the caller goes on to its own routes). */
export async function routeDecisionCards(deps: DecisionRouteDependencies, caller: DecisionCaller, request: DecisionRequest): Promise<StatusReply | undefined> {
  const match = PATH.exec(request.pathname);
  if (match === null) return undefined;
  const [, rawId, action] = match;
  if (rawId === undefined || action === undefined) {
    if (request.method !== "GET") return undefined;
    const projection = await project(deps, caller);
    const view: DecisionCardsView = { cards: projection.cards.slice(0, DECISION_CARDS_MAX), total: projection.cards.length, tabs: {} };
    for (const card of view.cards) { const tabs = projection.tabs[card.id]; if (tabs !== undefined) view.tabs[card.id] = tabs; }
    return new StatusReply(200, view);
  }
  if (request.method !== "POST") return undefined;
  let id: string;
  try { id = decodeURIComponent(rawId); } catch { throw agentXError("NOT_FOUND", "This decision is no longer waiting for you."); }
  const parsedId = DecisionCardIdSchema.safeParse(id);
  if (!parsedId.success) throw agentXError("NOT_FOUND", "This decision is no longer waiting for you.");
  const cardId = parsedId.data;
  const nowIso = (): string => new Date(deps.now()).toISOString();
  const who = { orgId: caller.orgId, developerId: caller.developerId };

  if (action === "evidence-opened") {
    const body = DecisionEvidenceOpenedBodySchema.safeParse(request.body);
    if (!body.success) return ISSUE(body.error);
    const { card, tabs } = pendingCard(await project(deps, caller), cardId);
    if (card.risk === "high") throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    const tab = tabOf(request.searchParams.get("tab"), tabs);
    const recorded = card.friction.expandEvidenceFirst;
    if (recorded) await deps.store.recordEvidenceOpened({ ...who, cardId, tab }, cardDigest(card, tabs), nowIso());
    const answer: DecisionEvidenceOpenedAnswer = { cardId, opened: true, recorded };
    return new StatusReply(200, answer);
  }

  if (action === "approve") {
    const body = DecisionApproveBodySchema.safeParse(request.body);
    if (!body.success) return ISSUE(body.error);
    const { card, tabs, subjectOf } = pendingCard(await project(deps, caller), cardId);
    // High: there is no approve route for it, whatever the card or a client says.
    if (card.risk === "high" || !card.actions.some((action2) => action2.kind === "approve")) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
    if (tabs === undefined && body.data.tab !== undefined) throw agentXError("CONFIG_INVALID", "tab: this card has no tabs");
    if (tabs !== undefined && (body.data.tab === undefined || !tabsPending(tabs).includes(body.data.tab))) throw agentXError("CONFIG_INVALID", "tab: name a document that is still waiting");
    let openedAt: string | undefined;
    if (card.friction.expandEvidenceFirst) {
      openedAt = await deps.store.evidenceOpenedAt({ ...who, cardId, tab: body.data.tab }, cardDigest(card, tabs));
      if (openedAt === undefined) throw agentXError("CHANGE_STALE", DECISION_OPEN_FIRST_MESSAGE);
    }
    await deps.performer.approve(caller, card, { requestId: body.data.requestId, subjectId: subjectOf(body.data.tab), tab: body.data.tab });
    const decidedAt = nowIso();
    await remember(deps, { ...who, cardId, kind: card.kind, risk: card.risk, outcome: "approved", tab: body.data.tab, requestId: body.data.requestId, createdAt: card.createdAt, openedAt, decidedAt });
    emit(deps, decisionMadeMeasure(who, card, { outcome: "approved", createdAt: card.createdAt, at: decidedAt }));
    const answer: DecisionAnswered = { cardId, outcome: "approved", ...(body.data.tab === undefined ? {} : { tab: body.data.tab }), remainingTabs: tabsPending(tabs).filter((tab) => tab !== body.data.tab) };
    return new StatusReply(200, answer);
  }

  // reject
  const body = DecisionRejectBodySchema.safeParse(request.body);
  if (!body.success) return ISSUE(body.error);
  const { card, tabs, subjectOf } = pendingCard(await project(deps, caller), cardId);
  if (!card.actions.some((action2) => action2.kind === "reject") || !card.rejectReasons.includes(body.data.reason)) throw agentXError("NOT_FOUND", DECISION_FULL_PAGE_MESSAGE);
  // A card with tabs is rejected at the first document still waiting.
  const tab = tabs === undefined ? undefined : tabsPending(tabs)[0];
  await deps.performer.reject(caller, card, { requestId: body.data.requestId, subjectId: subjectOf(tab), reason: body.data.reason, tab });
  const decidedAt = nowIso();
  await remember(deps, { ...who, cardId, kind: card.kind, risk: card.risk, outcome: "rejected", reason: body.data.reason, tab, requestId: body.data.requestId, createdAt: card.createdAt, decidedAt });
  emit(deps, decisionMadeMeasure(who, card, { outcome: "rejected", createdAt: card.createdAt, at: decidedAt }));
  const answer: DecisionAnswered = { cardId, outcome: "rejected", ...(tab === undefined ? {} : { tab }), remainingTabs: tabsPending(tabs).filter((other) => other !== tab) };
  return new StatusReply(200, answer);
}

function tabOf(raw: string | null, tabs: readonly DecisionTab[] | undefined): DecisionTabId | undefined {
  if (tabs === undefined) {
    if (raw !== null) throw agentXError("CONFIG_INVALID", "tab: this card has no tabs");
    return undefined;
  }
  const found = tabs.find((tab) => tab.id === raw);
  if (found === undefined) throw agentXError("CONFIG_INVALID", "tab: name one of the card's tabs");
  return found.id;
}

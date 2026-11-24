// Lead 4 L4-U5 (setup-upkeep-plan.md step 3c): the "Setup needs repair" card on a project's setup page and its "Re-check setup" button, passed to Rovara Code as the signed-in person.
//
//   GET  /v1/app/projects/{p}/setup-repair           -> Code GET  /v1/app/projects/{p}/setup-check   { state, canManage, repair? }   (Code L4-P1 + L4-U5; any live role on the project reads)
//   POST /v1/app/projects/{p}/setup-repair/recheck   { requestId } -> Code POST /v1/app/projects/{p}/setup-check   (a person who manages the project's setup starts the plain check; no AI)
//
// Rules:
//   - Code decides who may read and who may start (its live company role and project grant); Cloud adds no rule that could widen that. Cloud refuses earlier only what cannot be valid: a malformed project name,
//     a query, a body that is not exactly `{ requestId }`.
//   - The answer is rebuilt field by field. The card's SENTENCE is rebuilt here from Code's exact template (`SETUP_REPAIR_SENTENCES.body`): only the check's own failing step is repository text, and it is taken from
//     Code's sentence only when that sentence matches the template exactly; anything else makes the whole read refused ("unreadable is refusal"). The actions are Code's two ids with Cloud's own labels, at most one,
//     and none for a person Code says may not act. NO DOLLAR FIGURE comes from Code; the cost words on the button are Cloud's own and are said on the page only.
//   - Code's refusals reach the app in Cloud's own fixed words, never Code's text or an echo of the browser's input. Until Code serves the read, its unknown-route 404 reads "isn't available yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done and where (action, project), never what the person wrote.
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-setup-repair.ts (a unit test pins the sentences against Code's).
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { Unreadable, need, plain, rec, scope, text, when } from "./wiki-routes.js";

export const SETUP_REPAIR_WORDS = Object.freeze({
  invalid: "the request is not valid",
  notFound: "project not found",
  notAllowed: "Only company owners and admins, or this project's admins, can re-check the project's setup.",
  notYet: "Setup repair isn't available on this Rovara yet.",
  unavailable: "The project's setup could not be read or checked just now. Try again.",
  busy: "A setup check is already running for this project. Wait for it to finish.",
  archivedOrOff: "Checking the project's setup isn't available for this company yet.",
});
const W = SETUP_REPAIR_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SETUP_REPAIR_ANSWERS = Object.freeze({
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notFound: answer(404, "NOT_FOUND", W.notFound),
  notAllowed: answer(403, "FORBIDDEN", W.notAllowed),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  busy: answer(409, "WORKSPACE_BUSY", W.busy),
  off: answer(503, "RUNTIME_UNAVAILABLE", W.archivedOrOff),
});
const A = SETUP_REPAIR_ANSWERS;

/** Code's card sentence (`setupRepairCardOf` body): the template Cloud matches, with the step in the middle. */
/** Code cuts the check's failing step at a fixed length, so it can end inside a bracket or hold a lone one: the step is whatever sits between the template's fixed words (one line, no control characters, at most 300 characters). */
// DEC 254zzz447: the tail is the OLD sentence ("Rovara cannot build on this project until it is fixed."; a Code from before "don't block work"), or the NEW one ("Work continues; ..."). Cloud shows its own words either way (`SETUP_REPAIR_SENTENCES`).
const OLD_TAIL = "Rovara cannot build on this project until it is fixed.";
const NEW_TAIL = "Work continues; results may be less reliable until setup is fixed.";
const BODY_STEP = /^The project's setup stopped working after recent code changes \(([^\p{Cc}\p{Cf}]{1,300})\)\.(?: Rovara cannot build on this project until it is fixed\.| Work continues; results may be less reliable until setup is fixed\.)$/u;
/** The check's failing step out of Code's card sentence, or `undefined` when the sentence is not exactly one of the two Code templates (the contract-drift text rules call this with Code's current sentence). */
export const setupRepairBodyStep = (body: unknown): string | undefined => (typeof body === "string" ? BODY_STEP.exec(body)?.[1] : undefined);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROJECT_FOR_PATH = /^[a-z][a-z0-9-]{0,62}$/u;
const STATES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
/** Code's `setup-check` card actions (core/setup-agent/repair-view.ts) with Cloud's own labels (Code says the same words: `SETUP_REPAIR_WORDS.fixSetup` / `.approveNewSetup`). The ONLY ids this read carries. */
export const SETUP_REPAIR_ACTIONS: Readonly<Record<string, string>> = Object.freeze({ fix_setup: "Fix setup", approve_new_setup: "Approve new setup" });
const ACTIONS = SETUP_REPAIR_ACTIONS;
/** What changed, in Code's fixed words (`setupDriftWords`): up to ten class words joined, so at most 212 characters (8 classes at once pass the old 160). Mirrored in contracts app-setup-repair.ts. */
export const SETUP_REPAIR_CHANGED_MAX = 240;

const flag = (value: unknown): boolean => need(typeof value === "boolean", value) as boolean;

/** The card inside Code's answer, rebuilt; throws `Unreadable` for anything that does not read. */
function repairAnswer(value: unknown): Record<string, unknown> {
  const r = rec(value);
  need(Object.keys(r).every((key) => ["title", "body", "changed", "at", "fixReady", "actions"].includes(key)), r);
  need(r["title"] === "Setup needs repair", r["title"]);
  const body = r["body"];
  const step = setupRepairBodyStep(body);
  need(step !== undefined && text(step, 300), body);
  need(r["changed"] === undefined || text(r["changed"], SETUP_REPAIR_CHANGED_MAX), r["changed"]);
  need(when(r["at"]), r["at"]);
  const fixReady = flag(r["fixReady"]);
  need(Array.isArray(r["actions"]) && r["actions"].length <= 1, r["actions"]);
  const actions = (r["actions"] as unknown[]).map((one) => {
    const a = rec(one);
    need(Object.keys(a).length === 2 && typeof a["id"] === "string" && a["id"] in ACTIONS && a["label"] === ACTIONS[a["id"]], a);
    // The action must fit the state: a fix waiting is approved, anything else is fixed.
    need(a["id"] === (fixReady ? "approve_new_setup" : "fix_setup"), a["id"]);
    return { id: a["id"], label: ACTIONS[a["id"] as string] };
  });
  return { step, ...(r["changed"] === undefined ? {} : { changed: r["changed"] }), at: new Date(Date.parse(r["at"] as string)).toISOString(), fixReady, actions };
}

// ---- the `repair` card of Code's `GET setup-agent` read (core/setup-agent/repair-draft.ts `readRepairView`): the admin card WITH the automatic draft's part in it
// Code sends it to people who manage the project's setup. The Setup tab does not read it (it works from the `setup-repair` card above and the run's `apply`), so it is checked here only so Cloud never passes on
// Code text it has not matched: a card that reads is forwarded rebuilt from its known fields with Cloud's own labels (no dollar figure); anything else is DROPPED from that answer (never a refusal of the read).
// States (a unit test pins each against the answers Code's own `readRepairView` gives, per Code version):
//   no_fix     the card's sentence [+ why the last draft failed]; actions fix_setup ("Fix setup (uses your AI, up to $N)") and edit_commands ("Edit commands myself")
//   drafting   the card's sentence + "Rovara is drafting a fix ..."; action edit_commands
//   fix_ready  "... Rovara drafted a fix and checked it on a fresh machine: it passes. N change(s)."; actions approve_setup ("Approve new setup") and see_changes ("See changes")
/** Code's fixed words after the card's sentence (`REPAIR_WORDS` in repair-draft.ts). */
export const SETUP_AGENT_REPAIR_WORDS = Object.freeze({
  drafting: "Rovara is drafting a fix for the setup. It will ask you to approve it. Nothing changes until you do.",
  failed: Object.freeze({
    run_failed: "Rovara tried to draft a fix but could not finish. Nothing was changed.",
    no_usable_fix: "Rovara drafted a fix but none of it could be used. Nothing was changed.",
    check_failed: "Rovara drafted a fix but it did not pass its check on a fresh machine. Nothing was changed.",
    upkeep_paused: "Rovara stopped drafting a fix because nightly upkeep reached its limit. Nothing was changed.",
  } as const),
  withdrawn: "Rovara stopped drafting a fix because automatic runs were switched off. Nothing was changed.",
});
/** The ids Code's `readRepairView` sends and the words Cloud shows for them. `approve_setup` is the same step as the `setup-check` card's `approve_new_setup` (approve the checked fix). */
export const SETUP_AGENT_REPAIR_ACTIONS: Readonly<Record<string, string>> = Object.freeze({ fix_setup: "Fix setup", edit_commands: "Edit commands myself", approve_setup: "Approve new setup", see_changes: "See changes" });
/** Code's closed list of change classes (`SETUP_WATCH_CLASSES` and `websites`, contracts setup-snapshot.ts). */
export const SETUP_AGENT_REPAIR_CLASSES = ["marker", "lockfile", "compose", "dockerfile", "devcontainer", "env_example", "version", "test_config", "ci", "websites"] as const;
/** The "Fix setup" label Code builds with its budget (`fixSetupLabel`): the figure is Code's and is never shown. */
export const SETUP_AGENT_FIX_LABEL = /^Fix setup \(uses your AI, up to \$\d{1,5}(?:\.\d{2})?\)$/u;
const WHAT = "The project's setup stopped working after recent code changes \\(([^\\p{Cc}\\p{Cf}]{1,300})\\)\\.";
const escaped = (words: string): string => words.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const READY_BODY = new RegExp(`^${WHAT} Rovara drafted a fix and checked it on a fresh machine: it passes\\. ([0-9]{1,4}) changes?\\.$`, "u");
const OTHER_SENTENCES = [...Object.values(SETUP_AGENT_REPAIR_WORDS.failed), SETUP_AGENT_REPAIR_WORDS.withdrawn, SETUP_AGENT_REPAIR_WORDS.drafting];
const OTHER_BODY = new RegExp(`^${WHAT} (?:${escaped(OLD_TAIL)}|${escaped(NEW_TAIL)})(?: (${OTHER_SENTENCES.map(escaped).join("|")}))?$`, "u");

/** Code's `repair` of the setup-agent read, rebuilt; throws `Unreadable` for anything that does not read. */
export function setupAgentRepairView(value: unknown): Record<string, unknown> {
  const r = rec(value);
  need(Object.keys(r).every((key) => ["title", "state", "body", "actions", "classes", "at", "candidateRevision", "changes", "failure"].includes(key)), r);
  need(r["title"] === "Setup needs repair", r["title"]);
  const state = r["state"];
  need(state === "fix_ready" || state === "drafting" || state === "no_fix", state);
  need(when(r["at"]), r["at"]);
  const classes = r["classes"];
  need(Array.isArray(classes) && classes.length <= SETUP_AGENT_REPAIR_CLASSES.length && classes.every((one) => (SETUP_AGENT_REPAIR_CLASSES as readonly unknown[]).includes(one)), classes);
  const body = r["body"];
  need(typeof body === "string" && body.length <= 900, body);
  const expected = state === "fix_ready" ? ["approve_setup", "see_changes"] : state === "drafting" ? ["edit_commands"] : ["fix_setup", "edit_commands"];
  const given = r["actions"];
  need(Array.isArray(given) && given.length === expected.length, given);
  const actions = (given as unknown[]).map((one, at) => {
    const a = rec(one);
    const id = expected[at] as string;
    need(Object.keys(a).length === 2 && a["id"] === id && typeof a["label"] === "string" && (id === "fix_setup" ? SETUP_AGENT_FIX_LABEL.test(a["label"]) : a["label"] === SETUP_AGENT_REPAIR_ACTIONS[id]), a);
    return { id, label: SETUP_AGENT_REPAIR_ACTIONS[id] };
  });
  const common = { title: "Setup needs repair", state, classes: [...(classes as string[])], at: new Date(Date.parse(r["at"] as string)).toISOString(), actions };
  if (state === "fix_ready") {
    const match = READY_BODY.exec(body as string);
    const count = Number(match?.[2]);
    const revision = r["candidateRevision"];
    need(match !== null && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 1 && r["changes"] === count && r["failure"] === undefined
      && (body as string).endsWith(` ${String(count)} change${count === 1 ? "" : "s"}.`), body);
    return { ...common, step: match?.[1], candidateRevision: revision, changes: count };
  }
  need(r["candidateRevision"] === undefined && r["changes"] === undefined, r);
  const match = OTHER_BODY.exec(body as string);
  need(match !== null, body);
  const suffix = match?.[2];
  const step = match?.[1];
  const failure = r["failure"];
  if (state === "drafting") { need(suffix === SETUP_AGENT_REPAIR_WORDS.drafting && failure === undefined, body); return { ...common, step }; }
  const words = failure === undefined ? undefined : failure === "withdrawn" ? SETUP_AGENT_REPAIR_WORDS.withdrawn : (SETUP_AGENT_REPAIR_WORDS.failed as Record<string, string>)[failure as string];
  need(suffix === words && (failure === undefined || words !== undefined), body);
  return { ...common, step, ...(failure === undefined ? {} : { failure }) };
}

/** Code's `GET setup-check` answer rebuilt into the app's view. The rest of Code's setup state (commit, failing step of a person's own check) is not passed on. */
export function setupRepairView(value: unknown): Record<string, unknown> {
  const v = rec(value);
  need(typeof v["status"] === "string" && (STATES as readonly string[]).includes(v["status"]), v["status"]);
  const canManage = flag(v["canManage"]);
  const repair = v["repair"] === undefined ? undefined : repairAnswer(v["repair"]);
  // A card without the right to act carries no action (Code never sends one; a contradiction is refused).
  need(repair === undefined || canManage || (repair["actions"] as unknown[]).length === 0, v["repair"]);
  return { state: v["status"], canManage, ...(repair === undefined ? {} : { repair }) };
}

/** Code's refusal in Cloud's words. Only Code's exact unknown-route 404 means "not on Code yet"; a missing project (or one the person cannot see) is the one uniform 404. */
export function setupRepairRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND" && message === "route not found") return A.notYet;
  if (error.status === 404) return A.notFound;
  if (error.status === 400) return A.invalid;
  if (error.status === 403) return A.notAllowed;
  if (error.status === 409) return A.busy;
  if (error.status === 503 || error.status === 501) return A.off;
  return A.unavailable;
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/setup-check`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.setup_repair", action, project })); };

/** The recheck body: exactly a request id; nothing else is sent on. */
export function recheckBody(body: unknown): { requestId: string } | undefined {
  if (!plain(body)) return undefined;
  const keys = Object.keys(body);
  const id = body["requestId"];
  return keys.length === 1 && typeof id === "string" && REQUEST_ID.test(id) ? { requestId: id } : undefined;
}

async function target(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  if ([...context.query.keys()].length > 0 || !PROJECT_FOR_PATH.test(at.project)) return { refusal: A.invalid };
  return at;
}

export const SETUP_REPAIR_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/setup-repair$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      let got: unknown;
      try { got = await context.client.json<unknown>(context.session, base(at.project)); } catch (error) { if (error instanceof CodeError) return setupRepairRefusal(error); throw error; }
      try { return { status: 200, body: setupRepairView(got) }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/setup-repair\/recheck$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      const sent = recheckBody(context.body);
      if (sent === undefined) return A.invalid;
      try { await context.client.json<unknown>(context.session, base(at.project), { method: "POST", body: sent }); } catch (error) { if (error instanceof CodeError) return setupRepairRefusal(error); throw error; }
      logged("recheck", at.project);
      return { status: 200, body: { started: true } };
    },
  },
];

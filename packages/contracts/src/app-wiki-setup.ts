// Lead 4 slice W6 (DEC 254zi, 254zza; designs-2026-11-17/project-wiki-ux.md section 4a and the demo's setup tab): the wiki panel on the project's setup page. The file map and the build
// controls, as Rovara Code serves them and as Cloud answers the app. Browser-safe: it imports only zod.
//
// MIRROR of the answers of Code's `packages/contracts/src/wiki-controls.ts` (local branch `pr/l4-wiki-controls` at fafd0ea13: WIKI_BUILD_ROUTES, WikiControlsViewSchema, WikiDeleteAnswerSchema), of
// `wiki-build.ts` (the fixed words) and of `wiki-file-map.ts` (WikiFileMapViewSchema, W0). Cloud's server (`packages/cloud-server/src/wiki-setup-routes.ts`) rebuilds each Code answer field by field into
// exactly these shapes, so the app reads them strictly. When W3/W4/W0's contract changes, change this file, that rebuild and tests/support/fake-code.ts together.
//
// Rules the shapes carry:
//   - NO DOLLAR FIGURE crosses Cloud. W4's `limits.budgetCents` and `summary.spentCents` are placeholders until the first measured build (DEC 254zi), and W0's forecast carries `price: "not_priced_yet"`.
//     The page shows PAGES and names no cap until a later lane prices the build on purpose. The server drops the dollar members and refuses a forecast that carries a price.
//   - Every sentence a person is told is one of Code's fixed sentences (an exact member of `WIKI_SETUP_CODE_WORDS`) or Cloud's own (`WIKI_SETUP_WORDS`); the app shows nothing else.
//   - The browser sends a request id and the one choice the person made, never a company, a person, a limit, a commit or a goal.
//   - "Nightly upkeep" (setup-upkeep-plan.md decision 2): ONE switch per project. Its monthly cap is a spend limit of the company (`upkeep_month`, Cloud's `/org/spend-limits/upkeep/<project>`, lead 4 L4-E).
//     The switch itself is read and written through Code's `GET`/`PUT /v1/app/projects/{p}/upkeep`: a SEAM that the nightly runner (L4-N1) supplies. Until Code serves it, Cloud answers 501 and the page says so.
import { z } from "zod";

const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);
const count = z.number().int().min(0).max(10_000_000);
const isoTime = z.string().datetime({ offset: false });

/** The route family Cloud serves the app, under a project (the app calls them as `/v1/app/projects/{p}/...`; Code serves the same paths). */
export const WIKI_SETUP_PATHS = {
  map: "wiki-map",
  build: "wiki-build",
  continue: "wiki-build/continue",
  stop: "wiki-build/stop",
  refresh: "wiki-build/refresh",
  agents: "wiki-build/agents",
  delete: "wiki-build/delete",
  upkeep: "upkeep",
} as const;

// ---- Bodies (strict; the app builds them with these) ---------------------------------------------------------------------------------------------------------------------------------

export const WIKI_NOTES_MAX_CHARS = 2_000;
export const WIKI_CHIPS_MAX = 200;
export const WikiStartBodySchema = z.object({
  requestId: z.string().uuid(),
  /** "Tell Rovara what matters": steers the order only; it never becomes wiki text. */
  notes: z.string().min(1).max(WIKI_NOTES_MAX_CHARS).regex(/^(?:[^\p{Cc}\p{Cf}]|\n)*$/u).optional(),
  /** The chips the person left on (by id), from the file map. */
  chipsOn: z.array(line(80)).max(WIKI_CHIPS_MAX).optional(),
}).strict();
export type WikiStartBody = z.infer<typeof WikiStartBodySchema>;
export const WikiRequestBodySchema = z.object({ requestId: z.string().uuid() }).strict();
export type WikiRequestBody = z.infer<typeof WikiRequestBodySchema>;
export const WikiSwitchBodySchema = z.object({ requestId: z.string().uuid(), on: z.boolean() }).strict();
export type WikiSwitchBody = z.infer<typeof WikiSwitchBodySchema>;
/** `PUT .../upkeep` (L4-W6b, DEC 254zzt option A): the project switch, plus `allowSystemRuns` on the setup step (one company owner or admin act: the company's consent AND the project switch). `allowSystemRuns: false` with `on: true` is not a request. */
export const WikiUpkeepBodySchema = z.object({ requestId: z.string().uuid(), on: z.boolean(), allowSystemRuns: z.boolean().optional() }).strict()
  .refine((body) => !(body.allowSystemRuns === false && body.on), { message: "the request is not valid" });
export type WikiUpkeepBody = z.infer<typeof WikiUpkeepBodySchema>;

// ---- The company's one control over nightly upkeep (L4-P3, owner 2026-11-17; Code `GET`/`PUT /v1/app/company/system-runs`) ---------------------------------------------------------------------

/** The company-level route (the app calls it as `/v1/app/company/system-runs`; Code serves the same path). A company owner or admin only. */
export const SYSTEM_RUNS_PATH = "/v1/app/company/system-runs" as const;
/**
 * `PUT`: allow (`allowed: true`, which Code only accepts right after a fresh sign-in: the answer is 403 `REAUTH_REQUIRED` otherwise) or withdraw (`allowed: false`, no fresh sign-in needed). Withdrawing stops nightly
 * runs for every project at once and leaves each project's own switch as it is.
 */
export const SystemRunsBodySchema = z.object({ requestId: z.string().uuid(), allowed: z.boolean() }).strict();
export type SystemRunsBody = z.infer<typeof SystemRunsBodySchema>;
/** `available`: nightly runs can happen on this Rovara; `allowed`: the company's own consent; `systemRunsOn`: both (what actually runs). */
export const SystemRunsViewSchema = z.object({ available: z.boolean(), allowed: z.boolean(), systemRunsOn: z.boolean() }).strict()
  .refine((view) => view.systemRunsOn === (view.available && view.allowed), { message: "systemRunsOn is available and allowed" });
export type SystemRunsView = z.infer<typeof SystemRunsViewSchema>;

// ---- Words ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Code's fixed sentences for the build controls and the file map (W3's WIKI_BUILD_WORDS, W4's WIKI_CONTROLS_WORDS, W0's refusals), word for word. */
export const WIKI_SETUP_CODE_WORDS = Object.freeze({
  busy: "Rovara is already building this project's wiki.",
  connectKey: "Connect an AI key to build the wiki.",
  notAllowed: "Only company owners and admins, or this project's admins, can build the wiki.",
  noRepositories: "This project has no repository Rovara can read, so there is nothing to build.",
  noMap: "Map the project's files first, then build the wiki.",
  nothingToContinue: "There is no stopped wiki build to continue.",
  raiseCap: "This wiki build already used its spending limit. Raise the limit, then continue.",
  built: "Wiki built.",
  budget_used: "The wiki build reached its spending limit. It kept the pages it finished.",
  pages_used: "The wiki build reached its page limit. It kept the pages it finished.",
  time_used: "The wiki build ran out of time. It kept the pages it finished.",
  stopped_by_person: "The wiki build was stopped. It kept the pages it finished.",
  needs_ai_key: "Connect an AI key to build the wiki. The pages already written are kept.",
  repo_unreadable: "Rovara could not read a repository at the commit it started from. It kept the pages it finished.",
  access_lost: "The person who started the wiki build can no longer build it. It kept the pages it finished.",
  infrastructure: "The wiki build could not go on. Try again; finished pages are kept.",
  projectNotFound: "project not found",
  unreadable: "The project's wiki could not be read just now. Try again.",
  unavailable: "Building the wiki isn't available for this company yet.",
  auditUnavailable: "The record of this change could not be written, so nothing was done. Try again.",
  nothingToRefresh: "Every page is up to date, so there is nothing to refresh.",
  buildFirst: "Build the wiki first, then refresh it.",
  deleteWhileRunning: "Stop the wiki build, then delete the wiki.",
  deleted: "The wiki was deleted.",
  mapNotAllowed: "Only company owners and admins, or this project's admins, can map a project's files.",
  mapUnavailable: "The project's files could not be mapped just now. Try again.",
  archived: "This project is archived. Restore it to start new work.",
} as const satisfies Record<string, string>);

/** Cloud's own sentences for this panel. */
export const WIKI_SETUP_WORDS = Object.freeze({
  invalid: "the request is not valid",
  notYet: "Building the wiki isn't available on this Rovara yet.",
  unavailable: "The wiki build could not be read just now. Try again.",
  notSetUp: "Building the wiki isn't set up for this company yet.",
  upkeepNotAllowed: "Only company owners and admins, or this project's admins, can change nightly upkeep.",
  upkeepNotYet: "Nightly upkeep isn't available on this Rovara yet.",
  upkeepUnavailable: "Nightly upkeep could not be read or changed just now. Try again.",
  upkeepNeedsConsent: "A company admin must allow nightly upkeep first.",
  upkeepConsentNotAllowed: "Only company owners and admins can allow nightly upkeep for the company.",
  // L4-P3 (owner 2026-11-17): allowing needs a fresh sign-in (Code's step-up); the company's own control is for owners and admins.
  needsSignIn: "Confirm it's you again, then try once more.",
  systemRunsNotAllowed: "Only company owners and admins can see or change nightly upkeep for the company.",
});
export const WIKI_SETUP_SENTENCES: ReadonlySet<string> = new Set([...Object.values(WIKI_SETUP_CODE_WORDS), ...Object.values(WIKI_SETUP_WORDS)]);

// ---- The file map (W0) ---------------------------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_SETUP_CHIP_KINDS = ["write_first", "skip_old", "skip_generated"] as const;
export const WIKI_SETUP_REPO_STATUSES = ["ok", "partial", "unavailable"] as const;
export const WikiSetupChipSchema = z.object({
  id: line(80), kind: z.enum(WIKI_SETUP_CHIP_KINDS), repo: line(100), path: line(300),
  /** "Write these first?" or "Skip?" followed by the folder, as a person reads it. */
  label: line(200),
  defaultOn: z.boolean(),
}).strict();
export type WikiSetupChip = z.infer<typeof WikiSetupChipSchema>;

export const WikiSetupRepoSchema = z.object({
  name: line(100),
  status: z.enum(WIKI_SETUP_REPO_STATUSES),
  /** "partial: <reason>" when the map is not whole. */
  partial: line(300).optional(),
  unavailable: line(200).optional(),
  files: count,
  skipped: z.object({ generated: count, vendored: count, lockfiles: count, assets: count, secret: count }).strict(),
  /** Generated and vendored folders that were skipped (paths only). */
  skippedFolders: z.array(line(300)).max(20),
  /** Pages a wiki would write for this repository: the repository page plus module pages. */
  pages: z.object({ modules: count, modulesCapped: z.boolean() }).strict(),
}).strict();
export type WikiSetupRepo = z.infer<typeof WikiSetupRepoSchema>;

/** The forecast is PAGES. No dollar amount is carried (there is no price yet). */
export const WikiSetupMapSchema = z.object({
  computedAt: isoTime,
  complete: z.boolean(),
  repositoriesOmitted: count,
  repositories: z.array(WikiSetupRepoSchema).max(20),
  chips: z.array(WikiSetupChipSchema).max(WIKI_CHIPS_MAX),
  forecast: z.object({ repositories: count, files: count, pages: count, pagesCapped: z.boolean(), complete: z.boolean() }).strict(),
}).strict();
export type WikiSetupMap = z.infer<typeof WikiSetupMapSchema>;

/** `GET` and `POST /v1/app/projects/{p}/wiki-map`. `canManage`: this person may make a map and build. */
export const WikiSetupMapViewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), canManage: z.boolean() }).strict(),
  z.object({ status: z.literal("ready"), canManage: z.boolean(), map: WikiSetupMapSchema }).strict(),
]);
export type WikiSetupMapView = z.infer<typeof WikiSetupMapViewSchema>;

// ---- The build controls (W4) -----------------------------------------------------------------------------------------------------------------------------------------------

export const WIKI_SETUP_END_WORDS = ["built", "budget_used", "pages_used", "time_used", "stopped_by_person", "needs_ai_key", "repo_unreadable", "access_lost", "infrastructure"] as const;
export const WIKI_SETUP_AI_KEY_STATES = ["connected", "missing", "unknown"] as const;
const pages = z.number().int().min(0).max(10_000);

/** The state every control answers with (start, continue, stop, refresh and the agents switch too). No dollar figure, no task id, no commit. */
export const WikiSetupBuildSchema = z.object({
  status: z.enum(["none", "running", "built", "stopped"]),
  /** The most pages one build writes. */
  limits: z.object({ pages: z.number().int().min(1).max(300) }).strict(),
  startedAt: isoTime.optional(),
  stop: z.enum(WIKI_SETUP_END_WORDS).optional(),
  /** One of Code's fixed sentences about how the build ended. */
  message: z.string().max(300).optional(),
  summary: z.object({ pagesPlanned: pages, pagesWritten: pages, pagesKeptFromEarlier: pages, claimsKept: count, claimsDropped: count }).strict().optional(),
  canContinue: z.boolean().optional(),
  stoppedBy: z.object({ name: line(200), at: isoTime }).strict().optional(),
  canManage: z.boolean(),
  aiKey: z.enum(WIKI_SETUP_AI_KEY_STATES),
  /** The fixed sentence shown with Build when no AI key is connected. */
  connectKey: z.string().max(200).optional(),
  agents: z.object({ on: z.boolean() }).strict(),
  wiki: z.object({ pages, refreshPages: pages }).strict(),
}).strict();
export type WikiSetupBuild = z.infer<typeof WikiSetupBuildSchema>;

export const WikiSetupDeleteAnswerSchema = z.object({ deleted: z.literal(true), message: z.string().max(300), view: WikiSetupBuildSchema }).strict();
export type WikiSetupDeleteAnswer = z.infer<typeof WikiSetupDeleteAnswerSchema>;

// ---- Nightly upkeep --------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The monthly cap as Code states it (L4-W6b): `monthlyUsd` is the number Code read from the gateway, or `null` where Code has no read (the page then says "Set in Spending limits" and invents no figure);
 * `canRaise` is true only for a live company owner or admin.
 */
export const WikiSetupUpkeepCapSchema = z.object({ monthlyUsd: z.number().min(0).max(1_000_000).nullable(), canRaise: z.boolean() }).strict();
export type WikiSetupUpkeepCap = z.infer<typeof WikiSetupUpkeepCapSchema>;

/**
 * `GET` and `PUT /v1/app/projects/{p}/upkeep` (Code L4-P2, DEC 254zzt option A "two locks"): the one switch and the consent behind it. Off until a person turns it on.
 *   enabled              the PROJECT's switch.
 *   canManage            this person may turn the project switch on or off.
 *   available            (DEC 254zzl P0) the operator's ceiling covers this company; the switch and its cap show only when it is true (absent or false: only the "isn't available" line is drawn).
 *   systemRunsOn         EFFECTIVE system runs: the ceiling AND the company's consent (what really runs). The project switch counts only while this is true.
 *   canEnableSystemRuns  a live company owner or admin, with the ceiling on: this person may give the company's consent (the one setup choice).
 *   cap                  the monthly cap as Code states it.
 * The last three are absent from a Code that has the project switch only (L4-N1): the page then shows the plain switch to whoever `canManage`, as before.
 */
export const WikiSetupUpkeepSchema = z.object({
  enabled: z.boolean(), canManage: z.boolean(), available: z.boolean().optional(),
  systemRunsOn: z.boolean().optional(), canEnableSystemRuns: z.boolean().optional(), cap: WikiSetupUpkeepCapSchema.optional(),
  /** L4-U5: nightly upkeep is paused now and why (Code tells managers only; the page says it in `UPKEEP_PAUSE_SENTENCES`). */
  paused: z.object({ reason: z.enum(["no_budget", "monthly_limit", "cost_too_high"]), month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u) }).strict().optional(),
}).strict();
export type WikiSetupUpkeep = z.infer<typeof WikiSetupUpkeepSchema>;

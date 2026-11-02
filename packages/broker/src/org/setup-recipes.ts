// Setup and test health SH29 (design setup-test-health.md, section 7; owner decisions Q2 and Q11; DECISIONS M8): company setup recipes and company locks.
//
// A company recipe is the generic part of a confirmed project setup (SH4), kept per company. It is only ever a PROPOSAL for a new project whose fingerprint matches: it never applies, runs or approves anything by
// itself, and the project still proves and confirms it. This module holds the AUTHORITY around that, and nothing else:
//   - a project maintainer may PROPOSE a recipe from a confirmed project setup (status `proposed`: not offered to anyone);
//   - only a company admin, with a fresh sign-in, may APPROVE it (pinned to the exact revision and digest the admin saw), write one directly, change who it is offered to, or revoke it;
//   - "offer only to these projects" is a plain list of project names (Q11, no groups yet); without it a recipe is offered to every project of the company;
//   - company LOCKS (setup agent off, lower limits, hosts only from the company list, dev container images only from a list, nightly health on, host approver admin) can only make projects STRICTER (M8): `applyCompanyLocks`
//     takes the stricter of the project's value and the lock, per field, and never the looser one;
//   - no repository name is ever stored: a body that names the repository it came from is refused, not edited.
//
// Not wired: no route, no table, no switch (`sp`, SH36). The store is an interface (`SetupRecipeStore`); the DynamoDB adapter and the routes are wiring (see the lane report). Everything is keyed by the company id the caller
// proves; nothing is read across companies. Nothing here touches the egress list: a recipe's `approvedHosts` are RECORDS of what the admin approved; making them company allow-list entries goes through the egress change plan.
import {
  OrgIdSchema, RelativeWorkspacePathSchema, SetupRecipeBodySchema, canonicalJson, redactSecrets, SetupRecipeIdSchema, agentXError, recipeFits, recipeNamesRepository, setupFingerprint, setupRecipeDigest,
  type OrgId, type ProjectCommand, type SetupFingerprintInput, type SetupRecipeBody, type TestEnvironmentBody,
} from "@agentx/contracts";
import { createHash } from "node:crypto";
import { isFreshSignIn, type SessionRecord } from "../developer/store.js";
import type { TransactItem } from "../audit/outbox.js";
import { decideSecondPersonApproval, type ApprovalDecision, type ApprovalDecisionInput } from "./second-person-approval.js";
import { z } from "zod";

// ---- bounds
/** A company holds this many recipes at most, in any status. */
export const SETUP_RECIPES_MAX_PER_ORG = 200;
/** Recipes waiting for an admin, at most (a maintainer cannot fill the admin's queue without bound). */
export const SETUP_RECIPES_MAX_PROPOSED = 50;
export const SETUP_RECIPE_SCOPE_MAX_PROJECTS = 100;

export const projectHash = (orgId: string, project: string): string => createHash("sha256").update(`${orgId}\n${project}`, "utf8").digest("hex").slice(0, 32);
const DeveloperId = z.string().regex(/^[a-f0-9]{64}$/u);
const ProjectName = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u);

// ---- records
/**
 * "Offer only to these projects" (Q11). WIRING NOTE: the list holds the project NAMES as the test callers give them; at wiring it must hold project IDs, so a renamed project or one with the same name in
 * another company cannot inherit or lose an offer. `recipeOfferedTo` compares the string it is given with the list; pass the id then.
 */
export const RecipeScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company") }).strict(),
  /** "Offer only to these projects": a plain list of project names, not a team. */
  z.object({ kind: z.literal("projects"), projects: z.array(ProjectName).min(1).max(SETUP_RECIPE_SCOPE_MAX_PROJECTS) }).strict(),
]);
export type RecipeScope = z.infer<typeof RecipeScopeSchema>;

export type RecipeStatus = "proposed" | "approved" | "revoked";

export interface StoredRecipe {
  orgId: OrgId;
  recipeId: string;
  /** Starts at 1; every change (approval, scope, revoke) adds one. The value source is `recipe:<id>@<revision>`. */
  revision: number;
  status: RecipeStatus;
  body: SetupRecipeBody;
  /** sha256 of the body: what an approval pins. */
  bodyDigest: string;
  fingerprint: string;
  scope: RecipeScope;
  /** A hash of the project a maintainer proposed it from (so the same proposal is not stored twice); absent when an admin wrote it. The project's name itself is not kept here. */
  proposedFromProjectHash?: string;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  updatedAt: string;
}

export type RecipeAuditAction = "recipe_proposed" | "recipe_created" | "recipe_approved" | "recipe_revoked" | "recipe_scope_changed" | "locks_changed" | "locks_change_proposed" | "locks_change_approved";
/** What the audit ledger gets: ids, digests and fixed words only. Never the recipe's text. */
export interface RecipeAuditEntry {
  action: RecipeAuditAction;
  orgId: OrgId;
  actor: string;
  at: string;
  proof: "fresh_sign_in" | "project_maintainer";
  recipeId?: string;
  revision?: number;
  bodyDigest?: string;
  /** Locks actions: the digests of the locks before and after, and whether the change loosened them. */
  previousDigest?: string;
  nextDigest?: string;
  loosened?: boolean;
  /** Locks approval: how the second-person rule was met. */
  approvalMode?: ApprovalDecision["mode"];
  /**
   * The membership generation the decision was made against. WIRING: the adapter commits with `secondPersonMembershipCondition(membershipVersion)` on the org META in the same transaction, and pins both
   * people's live member/developer/grant records, as `second-person-approval.ts` requires.
   */
  membershipVersion?: number;
}

export interface SetupRecipeRowStore {
  getRecipe(orgId: OrgId, recipeId: string): Promise<StoredRecipe | undefined>;
  /**
   * The company's recipes, at most `limit`, only those in `statuses` when given. The filter matters: revoked recipes are kept as history and must not hide the live ones from the cap.
   * DynamoDB adapter notes (wiring): (1) the cap is enforced by an org counter item of live (proposed + approved) recipes, incremented with a condition in the SAME transaction as the new recipe, because a
   * count-then-write races; (2) the dedupe of a repeated proposal is a deterministic key (project hash + body digest) written with `attribute_not_exists`, not a list scan; (3) `listRecipes` pages with
   * `LastEvaluatedKey` and never returns a partial page as if it were everything. The in-memory store used in tests has none of these races.
   */
  listRecipes(orgId: OrgId, limit: number, statuses?: readonly RecipeStatus[]): Promise<StoredRecipe[]>;
  /** Writes `next` and the audit entry together or neither, only while the stored revision is `expectedRevision` (null: no row yet). False when the row changed meanwhile. */
  commitRecipe(next: StoredRecipe, expectedRevision: number | null, audit: RecipeAuditEntry): Promise<boolean>;
  /** The ids of live rows that exist but do not read back (a damaged or unknown-shaped row). They are never offered or approved; an admin can still remove them (`revokeDamagedRecipe`), which frees their counter slot. */
  unreadableIds?(orgId: OrgId): Promise<string[]>;
  /** Revokes a live row that exists but does not read back, with its counter slot, dedupe marker and an audit entry in one transaction. False when there is no such row. */
  revokeUnreadable?(orgId: OrgId, recipeId: string, audit: RecipeAuditEntry): Promise<boolean>;
}

/**
 * The company locks' store. The company's setup locks are OWNED by lane su-musts (one row, one store, one admin route, the setup.locks_* audit actions); this lane has no adapter for it. The interface stays so the shared
 * decider below (`setCompanyLocks`, `approveLocksChange`, `isLoosening`) can be driven by that store, and the in-memory test store implements it.
 */
export interface SetupLocksStore {
  getLocks(orgId: OrgId): Promise<StoredLocks | undefined>;
  /**
   * As `commitRecipe`. `conditions` are the DynamoDB ConditionChecks of the approval evidence (org membership version, both people's live records): the adapter puts them in the SAME transaction as the write, and
   * a failed one makes this return false (the caller then answers CHANGE_STALE). The parameter is REQUIRED so an adapter cannot ignore it by omission: a caller with nothing to fence passes an explicit empty list (a proposal or a stricter change), and an approval always passes the evidence's non-empty list.
   */
  commitLocks(next: StoredLocks, expectedRevision: number | null, audit: RecipeAuditEntry, conditions: readonly TransactItem[]): Promise<boolean>;
}
export type SetupRecipeStore = SetupRecipeRowStore & SetupLocksStore;

/**
 * What the recipe code reads of the company's locks: only the dev container image list, through su-musts' store (`getCompanySetupLocks`). Absent (su-musts not merged): no lock. A store that throws makes the caller
 * offer nothing (fail closed).
 */
export interface CompanyLocksReader { getCompanySetupLocks(orgId: OrgId): Promise<{ devcontainerImages?: readonly string[] | undefined } | undefined> }

// ---- company locks (M8: stricter only)
/** The setup agent's limits (design 3.2), each with the design's maximum. */
export const SETUP_LIMIT_MAXIMA = { commands: 120, sameStepTries: 5, wallClockMinutes: 120, spendUsd: 20, hostAsks: 10 } as const;
export type SetupLimits = { [K in keyof typeof SETUP_LIMIT_MAXIMA]: number };
const LIMIT_KEYS = Object.keys(SETUP_LIMIT_MAXIMA) as Array<keyof SetupLimits>;
const limitField = (key: keyof SetupLimits) => z.number().min(1).max(SETUP_LIMIT_MAXIMA[key]);

const ImageReference = SetupRecipeBodySchema.shape.devcontainerBaseImage.unwrap();

export const CompanySetupLocksSchema = z.object({
  /** The setup agent may not run in any project of the company. */
  setupAgentOff: z.literal(true).optional(),
  /** Lower limits: a project's limit is the smaller of its own and this. */
  limits: z.object({
    commands: limitField("commands").optional(), sameStepTries: limitField("sameStepTries").optional(), wallClockMinutes: limitField("wallClockMinutes").optional(),
    spendUsd: limitField("spendUsd").optional(), hostAsks: limitField("hostAsks").optional(),
  }).strict().optional(),
  /** A project may use only hosts on the company list. */
  hostsOnlyFromCompanyList: z.literal(true).optional(),
  /** Dev container base images only from this list (an empty list allows none). */
  devcontainerImages: z.array(ImageReference).max(50).optional(),
  /** Nightly health is on for every project. */
  nightlyHealthOn: z.literal(true).optional(),
  /** New hosts are approved by an admin, never by a maintainer. */
  hostApprover: z.literal("admin").optional(),
  /**
   * Turns OFF the sole-owner exception for loosening these locks (owner, 2026-11-01, "One-admin companies"). Absent means the exception is ON: a company whose only eligible admin is the proposer may approve
   * their own loosening after the 24 hour cool-off. With this set, a loosening always needs a second, different admin. Removing this lock is itself a loosening.
   */
  noSoleOwnerException: z.literal(true).optional(),
}).strict();
export type CompanySetupLocks = z.infer<typeof CompanySetupLocksSchema>;

/** A change that LOOSENS the locks waits here for a different admin (owner choice A, the 2026-10-31 tier-0 rule applied to locks). */
export interface PendingLocksChange { locks: CompanySetupLocks; digest: string; proposedBy: string; proposedAt: string }
export interface StoredLocks { orgId: OrgId; revision: number; locks: CompanySetupLocks; updatedBy: string; updatedAt: string; pending?: PendingLocksChange }

const locksDigest = (locks: CompanySetupLocks | undefined): string => createHash("sha256").update(canonicalJson(locks ?? {}), "utf8").digest("hex");

/**
 * Whether `next` is looser than `prev` for any field: a lock removed, a limit raised or removed, a lock turned off (`setupAgentOff`, `hostsOnlyFromCompanyList`, `nightlyHealthOn`), the image list widened or
 * removed, or `hostApprover` going from admin back to maintainer. With nothing set before, nothing can loosen.
 */
export function isLoosening(prev: CompanySetupLocks | undefined, next: CompanySetupLocks): boolean {
  if (prev === undefined) return false;
  for (const flag of ["setupAgentOff", "hostsOnlyFromCompanyList", "nightlyHealthOn", "hostApprover", "noSoleOwnerException"] as const) if (prev[flag] !== undefined && next[flag] === undefined) return true;
  for (const key of LIMIT_KEYS) {
    const before = prev.limits?.[key];
    const after = next.limits?.[key];
    if (before !== undefined && (after === undefined || after > before)) return true;
  }
  if (prev.devcontainerImages !== undefined) {
    if (next.devcontainerImages === undefined) return true;
    const allowed = new Set(prev.devcontainerImages);
    if (next.devcontainerImages.some((image) => !allowed.has(image))) return true;
  }
  return false;
}

/** The setup settings a project has, as far as locks reach. */
export interface ProjectSetupSettings {
  setupAgentEnabled: boolean;
  limits: SetupLimits;
  hostsOnlyFromCompanyList: boolean;
  /** undefined: any image the project's other rules allow. */
  devcontainerImages: readonly string[] | undefined;
  nightlyHealthEnabled: boolean;
  hostApprover: "admin" | "maintainer";
}

/**
 * The project's settings with the company's locks applied. Per field the STRICTER value wins, so a lock never loosens a project (M8): a lock that is weaker than the project's own value changes nothing, and a missing lock
 * changes nothing.
 */
export function applyCompanyLocks(project: ProjectSetupSettings, locks: CompanySetupLocks | undefined): ProjectSetupSettings {
  const lock = locks ?? {};
  const limits = { ...project.limits };
  for (const key of LIMIT_KEYS) {
    const cap = lock.limits?.[key];
    if (cap !== undefined) limits[key] = Math.min(project.limits[key], cap);
  }
  let images: readonly string[] | undefined = project.devcontainerImages;
  if (lock.devcontainerImages !== undefined) {
    const allowed = new Set(lock.devcontainerImages);
    images = project.devcontainerImages === undefined ? [...allowed] : project.devcontainerImages.filter((image) => allowed.has(image));
  }
  return {
    setupAgentEnabled: project.setupAgentEnabled && lock.setupAgentOff !== true,
    limits,
    hostsOnlyFromCompanyList: project.hostsOnlyFromCompanyList || lock.hostsOnlyFromCompanyList === true,
    devcontainerImages: images,
    nightlyHealthEnabled: project.nightlyHealthEnabled || lock.nightlyHealthOn === true,
    hostApprover: lock.hostApprover === "admin" ? "admin" : project.hostApprover,
  };
}

// ---- authority
export interface RecipeCaller {
  orgId: OrgId;
  developerId: string;
  /** The caller's session (the route's authenticated `DeveloperCaller.sessionId`). Freshness is read from the stored session, never from the request. */
  sessionId: string;
}

export interface SetupRecipeDeps {
  store: SetupRecipeRowStore;
  /** The locks store (su-musts' store when merged; the in-memory one in tests). Only `setCompanyLocks` and `approveLocksChange` use it; without it they refuse. */
  locksStore?: SetupLocksStore | undefined;
  /** Live company owner or admin, read now (wire `requireLiveCompanyAdmin`). Throws FORBIDDEN. */
  requireAdmin(caller: { orgId: OrgId; developerId: string }): Promise<void>;
  /**
   * Every name the repositories go by (full names `owner/name`, short names, directory names), read by the broker from its own records: the project's when `project` is given, the whole company's when not.
   * The request never supplies this list. An empty list for a project refuses the share (a project with no repository has no setup to share).
   */
  repositoryNamesOf(orgId: OrgId, project?: string): Promise<readonly string[]>;
  /**
   * The server-side evidence `decideSecondPersonApproval` needs, with the conditions that fence it at commit: wire `readSecondPersonApprovalEvidence` (org/second-person-evidence.ts) with `{ orgId, proposerId,
   * approverId }`. The decision input must name these two people, or the approval is refused.
   */
  approvalEvidence(scope: { orgId: OrgId; proposerId: string; approverId: string }): Promise<{ decisionInput: ApprovalDecisionInput; conditions: TransactItem[] }>;
  /** The stored session record of the caller (`SESSION#<id>`), or undefined. Wire the same read as `requireFreshSignInForExport`. */
  readSession(sessionId: string): Promise<Pick<SessionRecord, "authTime" | "developerId" | "revokedAt"> | undefined>;
  /** The caller may maintain this project (wire the project role check). Throws FORBIDDEN. */
  requireProjectMaintainer(caller: { orgId: OrgId; developerId: string }, project: string): Promise<void>;
  /** Hosts a company must never approve (IP literals, pastes, shorteners, raw object storage, the production deny list): the host-ask list of SH12. */
  isHostRefused(host: string): boolean;
  now(): Date;
  /** 20 random lower-case hex characters. */
  newRecipeSuffix(): string;
}

const forbidden = () => agentXError("FORBIDDEN", "Live company owner or admin access is required.");
const reauth = () => agentXError("REAUTH_REQUIRED", "Sign in again to confirm this company change.");
const stale = () => agentXError("CHANGE_STALE", "That recipe changed. Refresh before continuing.");
const invalid = (message: string) => agentXError("CONFIG_INVALID", message);

function validCaller(caller: RecipeCaller): void {
  if (!OrgIdSchema.safeParse(caller.orgId).success || !DeveloperId.safeParse(caller.developerId).success) throw forbidden();
}

/**
 * Admin now, then a stored session of the SAME person, not revoked, whose interactive sign-in is fresh by the platform's one rule (`isFreshSignIn`). The admin check comes first and reads nothing else.
 */
async function requireFreshAdmin(deps: SetupRecipeDeps, caller: RecipeCaller): Promise<void> {
  validCaller(caller);
  await deps.requireAdmin({ orgId: caller.orgId, developerId: caller.developerId });
  const session = typeof caller.sessionId === "string" && caller.sessionId.length > 0 && caller.sessionId.length <= 200 ? await deps.readSession(caller.sessionId) : undefined;
  if (session === undefined || session.developerId !== caller.developerId || session.revokedAt !== undefined || !isFreshSignIn(session, deps.now().getTime())) throw reauth();
}

const iso = (deps: SetupRecipeDeps): string => deps.now().toISOString();

/** Whether redaction would change anything in the body: a credential in a URL, a flag value, a key-shaped string. A recipe is shared text, so it must hold none. */
/**
 * An npm/Yarn auth setting given a value: the key (`_authToken`, `_auth`, `_password`, `npmAuthToken`, `npmAuthIdent`, `YARN_NPM_AUTH_TOKEN`, `YARN_NPM_AUTH_IDENT`) anywhere in an argument, then separators (space, quote,
 * `=`, `:`) and a non-empty value in the same argument (`//h/:_authToken=abc`, `_authToken = abc`, `npmAuthToken: abc`, `"//h/:_authToken"=abc`, `sh -c "npm config set //h/:_authToken abc"`), or the key ending the
 * argument (with or without a trailing `=`) and the NEXT argument as the value (`config set //h/:_authToken abc`, `_authToken=` then `abc`). The value need not look like a key. A key with nothing after it
 * and no argument after it (`npm config get //h/:_authToken`) names a setting without giving it a value.
 */
const AUTH_KEY = /(?<![A-Za-z0-9])(?:_authToken|_auth|_password|npmAuthToken|npmAuthIdent|YARN_NPM_AUTH_TOKEN|YARN_NPM_AUTH_IDENT)(?![A-Za-z0-9_])/giu;
function setsAuthValue(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    for (const match of arg.matchAll(AUTH_KEY)) {
      const rest = arg.slice(match.index + match[0].length);
      const separators = /^[\s"'=:]*/u.exec(rest)?.[0] ?? "";
      const value = rest.slice(separators.length);
      if (separators.length > 0 && value.length > 0) return true;
      if (value.length === 0 && index + 1 < args.length) return true;
    }
    return false;
  });
}

const holdsSecret = (body: SetupRecipeBody): boolean =>
  canonicalJson(redactSecrets(body)) !== canonicalJson(body)
  || [...body.setupCommands, ...body.updateCommands, ...body.checks.map((check) => check.command)].some((command) => setsAuthValue(command.args));

/** Parses a body, refuses a credential, refuses a host the host-ask list refuses, and refuses a body that names the repositories it came from. */
function checkedBody(deps: SetupRecipeDeps, input: unknown, repositoryNames: readonly string[]): SetupRecipeBody {
  const parsed = SetupRecipeBodySchema.safeParse(input);
  if (!parsed.success) throw invalid("That recipe is not valid. Check its commands, hosts and image.");
  if (holdsSecret(parsed.data)) throw invalid("A recipe cannot hold a password, token or key.");
  if (parsed.data.approvedHosts.some((host) => deps.isHostRefused(host))) throw invalid("A recipe cannot approve that kind of host.");
  if (recipeNamesRepository(parsed.data, repositoryNames)) throw invalid("A recipe cannot name a repository. Remove the name and share again.");
  return parsed.data;
}

function newRecipe(deps: SetupRecipeDeps, caller: RecipeCaller, body: SetupRecipeBody, scope: RecipeScope, status: RecipeStatus, project: string | undefined): StoredRecipe {
  const now = iso(deps);
  const recipeId = SetupRecipeIdSchema.parse(`rcp_${deps.newRecipeSuffix()}`);
  return {
    orgId: caller.orgId, recipeId, revision: 1, status, body, bodyDigest: setupRecipeDigest(body), fingerprint: setupFingerprint(body.match), scope,
    ...(project === undefined ? {} : { proposedFromProjectHash: projectHash(caller.orgId, project) }), createdBy: caller.developerId, createdAt: now,
    ...(status === "approved" ? { approvedBy: caller.developerId, approvedAt: now } : {}), updatedAt: now,
  };
}

const auditOf = (deps: SetupRecipeDeps, caller: RecipeCaller, action: RecipeAuditAction, proof: RecipeAuditEntry["proof"], recipe?: StoredRecipe): RecipeAuditEntry => ({
  action, orgId: caller.orgId, actor: caller.developerId, at: iso(deps), proof,
  ...(recipe === undefined ? {} : { recipeId: recipe.recipeId, revision: recipe.revision, bodyDigest: recipe.bodyDigest }),
});

async function load(deps: SetupRecipeDeps, caller: RecipeCaller, recipeId: string): Promise<StoredRecipe> {
  const found = SetupRecipeIdSchema.safeParse(recipeId).success ? await deps.store.getRecipe(caller.orgId, recipeId) : undefined;
  // A stored row that names another company is no row: a store bug never leaks across companies.
  if (found === undefined || found.orgId !== caller.orgId) throw agentXError("NOT_FOUND", "That recipe was not found.");
  return found;
}

const LIVE: readonly RecipeStatus[] = ["proposed", "approved"];

async function ensureRoom(deps: SetupRecipeDeps, orgId: OrgId, status: RecipeStatus): Promise<StoredRecipe[]> {
  // Revoked recipes are history: only the live ones (proposed and approved) count toward the cap.
  const all = await deps.store.listRecipes(orgId, SETUP_RECIPES_MAX_PER_ORG + 1, LIVE);
  if (all.length >= SETUP_RECIPES_MAX_PER_ORG) throw invalid("This company has reached its limit of live setup recipes. Revoke one first.");
  if (status === "proposed" && all.filter((recipe) => recipe.status === "proposed").length >= SETUP_RECIPES_MAX_PROPOSED) throw invalid("Too many recipes are waiting for an admin. Ask an admin to review them.");
  return all;
}

// ---- operations

export interface ProposeInput {
  project: string;
  body: unknown;
  scope?: RecipeScope;
}

/**
 * "Share as company recipe": a maintainer of a project proposes the generic part of a confirmed setup. It is stored as `proposed` and offered to nobody until an admin approves it. The same proposal twice (the same project and
 * the same body) answers the first one.
 */
export async function proposeRecipe(deps: SetupRecipeDeps, caller: RecipeCaller, input: ProposeInput): Promise<StoredRecipe> {
  validCaller(caller);
  const project = ProjectName.safeParse(input.project);
  if (!project.success) throw invalid("Name the project to share from.");
  await deps.requireProjectMaintainer({ orgId: caller.orgId, developerId: caller.developerId }, project.data);
  const names = await deps.repositoryNamesOf(caller.orgId, project.data);
  if (names.length === 0) throw invalid("That project has no repository to share a setup from.");
  const body = checkedBody(deps, input.body, names);
  const scope = RecipeScopeSchema.safeParse(input.scope ?? { kind: "company" });
  if (!scope.success) throw invalid("That project list is not valid.");
  const digest = setupRecipeDigest(body);
  const all = await ensureRoom(deps, caller.orgId, "proposed");
  const same = all.find((recipe) => recipe.status === "proposed" && recipe.proposedFromProjectHash === projectHash(caller.orgId, project.data) && recipe.bodyDigest === digest);
  if (same !== undefined) return same;
  const recipe = newRecipe(deps, caller, body, scope.data, "proposed", project.data);
  if (!await deps.store.commitRecipe(recipe, null, auditOf(deps, caller, "recipe_proposed", "project_maintainer", recipe))) throw stale();
  return recipe;
}

/** An admin writes a recipe directly: it is approved by the same act (company admin, fresh sign-in). */
export async function createRecipeAsAdmin(deps: SetupRecipeDeps, caller: RecipeCaller, input: { body: unknown; scope?: RecipeScope }): Promise<StoredRecipe> {
  await requireFreshAdmin(deps, caller);
  // Checked against every repository name of the company, read here: an admin's recipe is as generic as a maintainer's.
  const body = checkedBody(deps, input.body, await deps.repositoryNamesOf(caller.orgId));
  const scope = RecipeScopeSchema.safeParse(input.scope ?? { kind: "company" });
  if (!scope.success) throw invalid("That project list is not valid.");
  await ensureRoom(deps, caller.orgId, "approved");
  const recipe = newRecipe(deps, caller, body, scope.data, "approved", undefined);
  if (!await deps.store.commitRecipe(recipe, null, auditOf(deps, caller, "recipe_created", "fresh_sign_in", recipe))) throw stale();
  return recipe;
}

/** The admin approves exactly the revision and body they saw: a recipe edited or replaced since is refused (CHANGE_STALE). The hosts are checked again against the host-ask list. */
export async function approveRecipe(deps: SetupRecipeDeps, caller: RecipeCaller, input: { recipeId: string; expectedRevision: number; expectedDigest: string }): Promise<StoredRecipe> {
  await requireFreshAdmin(deps, caller);
  const current = await load(deps, caller, input.recipeId);
  if (current.status !== "proposed") throw agentXError("CHANGE_STALE", "Only a recipe that is waiting for approval can be approved.");
  if (current.revision !== input.expectedRevision || current.bodyDigest !== input.expectedDigest || setupRecipeDigest(current.body) !== current.bodyDigest) throw stale();
  if (current.body.approvedHosts.some((host) => deps.isHostRefused(host))) throw invalid("A recipe cannot approve that kind of host.");
  const now = iso(deps);
  const next: StoredRecipe = { ...current, status: "approved", revision: current.revision + 1, approvedBy: caller.developerId, approvedAt: now, updatedAt: now };
  if (!await deps.store.commitRecipe(next, current.revision, auditOf(deps, caller, "recipe_approved", "fresh_sign_in", next))) throw stale();
  return next;
}

/** Stops a recipe being offered. It is kept (the history of what was approved), and projects that already used it keep their own confirmed setups. */
export async function revokeRecipe(deps: SetupRecipeDeps, caller: RecipeCaller, input: { recipeId: string; expectedRevision: number }): Promise<StoredRecipe> {
  await requireFreshAdmin(deps, caller);
  const current = await load(deps, caller, input.recipeId);
  if (current.revision !== input.expectedRevision) throw stale();
  if (current.status === "revoked") return current;
  const next: StoredRecipe = { ...current, status: "revoked", revision: current.revision + 1, updatedAt: iso(deps) };
  if (!await deps.store.commitRecipe(next, current.revision, auditOf(deps, caller, "recipe_revoked", "fresh_sign_in", next))) throw stale();
  return next;
}

/** Removes a row that exists but is damaged, so it stops holding a place in the company's caps. An admin with a fresh sign-in; the same audit as a revoke. NOT_FOUND when there is no such unreadable row. */
export async function revokeDamagedRecipe(deps: SetupRecipeDeps, caller: RecipeCaller, input: { recipeId: string }): Promise<void> {
  await requireFreshAdmin(deps, caller);
  if (!SetupRecipeIdSchema.safeParse(input.recipeId).success || deps.store.revokeUnreadable === undefined) throw agentXError("NOT_FOUND", "That recipe was not found.");
  const entry: RecipeAuditEntry = { ...auditOf(deps, caller, "recipe_revoked", "fresh_sign_in"), recipeId: input.recipeId, revision: 1, bodyDigest: "0".repeat(64) };
  if (!await deps.store.revokeUnreadable(caller.orgId, input.recipeId, entry)) throw agentXError("NOT_FOUND", "That recipe was not found.");
}

/** "Offer only to these projects" (or back to the whole company). The body is untouched. */
export async function setRecipeScope(deps: SetupRecipeDeps, caller: RecipeCaller, input: { recipeId: string; expectedRevision: number; scope: RecipeScope }): Promise<StoredRecipe> {
  await requireFreshAdmin(deps, caller);
  const scope = RecipeScopeSchema.safeParse(input.scope);
  if (!scope.success) throw invalid("That project list is not valid.");
  const current = await load(deps, caller, input.recipeId);
  // Only a live recipe has a scope to change; a revoked row is history and is never rewritten.
  if (current.status !== "proposed" && current.status !== "approved") throw agentXError("CHANGE_STALE", "Only a recipe that is waiting or offered can be scoped.");
  if (current.revision !== input.expectedRevision) throw stale();
  const next: StoredRecipe = { ...current, scope: scope.data, revision: current.revision + 1, updatedAt: iso(deps) };
  if (!await deps.store.commitRecipe(next, current.revision, auditOf(deps, caller, "recipe_scope_changed", "fresh_sign_in", next))) throw stale();
  return next;
}

/** Whether a recipe is offered to a project by its scope. */
export const recipeOfferedTo = (recipe: Pick<StoredRecipe, "scope">, project: string): boolean => recipe.scope.kind === "company" || recipe.scope.projects.includes(project);

export interface OfferedRecipe { recipeId: string; revision: number; bodyDigest: string; body: SetupRecipeBody }

/**
 * The approved recipes that fit a project: offered to it by scope, fingerprint equal to its repository's, and not against the company's locks (a recipe whose dev container image is not on the lock's list is not offered).
 * Server-side use only (the proposal builder, SH30). It is not a user route: a screen that lists recipes needs its own authority check. Newest first.
 */
export async function offeredRecipes(deps: Pick<SetupRecipeDeps, "store"> & { locks?: CompanyLocksReader | undefined }, input: { orgId: OrgId; project: string; repository: SetupFingerprintInput }): Promise<OfferedRecipe[]> {
  if (!OrgIdSchema.safeParse(input.orgId).success) return [];
  const [recipes, locks] = await Promise.all([deps.store.listRecipes(input.orgId, SETUP_RECIPES_MAX_PER_ORG, ["approved"]), deps.locks?.getCompanySetupLocks(input.orgId)]);
  const images = locks?.devcontainerImages;
  return recipes
    .filter((recipe) => recipe.orgId === input.orgId && recipe.status === "approved" && recipeOfferedTo(recipe, input.project) && recipeFits(recipe.body, input.repository)
      && (images === undefined || recipe.body.devcontainerBaseImage === undefined || images.includes(recipe.body.devcontainerBaseImage)))
    .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : left.recipeId < right.recipeId ? -1 : 1))
    .map((recipe) => ({ recipeId: recipe.recipeId, revision: recipe.revision, bodyDigest: recipe.bodyDigest, body: recipe.body }));
}

/** The hosts the admin has approved through recipes, as a sorted set: what SH30 may show as "already approved by your company". Not an allow-list change (that goes through the egress plan). */
export async function companyApprovedHosts(deps: Pick<SetupRecipeDeps, "store">, orgId: OrgId): Promise<string[]> {
  if (!OrgIdSchema.safeParse(orgId).success) return [];
  const recipes = await deps.store.listRecipes(orgId, SETUP_RECIPES_MAX_PER_ORG, ["approved"]);
  return [...new Set(recipes.filter((recipe) => recipe.orgId === orgId && recipe.status === "approved").flatMap((recipe) => recipe.body.approvedHosts))].sort();
}

/** The company's locks, or none. Server-side use. */
export async function readCompanyLocks(deps: Pick<SetupRecipeDeps, "locksStore">, orgId: OrgId): Promise<StoredLocks | undefined> {
  if (!OrgIdSchema.safeParse(orgId).success) return undefined;
  if (deps.locksStore === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Company setup locks are not available here.");
  const found = await deps.locksStore.getLocks(orgId);
  return found?.orgId === orgId ? found : undefined;
}

const locksOf = (deps: Pick<SetupRecipeDeps, "locksStore">): SetupLocksStore => {
  if (deps.locksStore === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Company setup locks are not available here.");
  return deps.locksStore;
};

/** Said out loud where a locks write has nothing to fence: a pending proposal or a stricter change changes nothing about who approves. */
const NO_CONDITIONS: readonly TransactItem[] = [];

export type SetLocksResult = { status: "applied"; locks: StoredLocks } | { status: "needs_second_admin"; locks: StoredLocks };

/**
 * Sets the company's locks (admin, fresh sign-in, against the revision the admin saw). A change that only makes projects STRICTER applies at once. A change that LOOSENS anything (`isLoosening`) does not apply: it is
 * stored as a pending change, and a DIFFERENT admin with a fresh sign-in approves it with `approveLocksChange` (owner choice A, the safer default until the owner says otherwise: the 2026-10-31 rule that any
 * loosening of an approval setting needs a second person). Any applied change clears a pending one, and a new loosening proposal replaces it.
 */
export async function setCompanyLocks(deps: SetupRecipeDeps, caller: RecipeCaller, input: { locks: unknown; expectedRevision: number | null }): Promise<SetLocksResult> {
  await requireFreshAdmin(deps, caller);
  const parsed = CompanySetupLocksSchema.safeParse(input.locks);
  if (!parsed.success) throw invalid("Those company locks are not valid.");
  const current = await readCompanyLocks(deps, caller.orgId);
  if ((current?.revision ?? null) !== input.expectedRevision) throw stale();
  const now = iso(deps);
  const revision = (current?.revision ?? 0) + 1;
  const previousDigest = locksDigest(current?.locks);
  const nextDigest = locksDigest(parsed.data);
  const loosened = isLoosening(current?.locks, parsed.data);
  if (loosened && current !== undefined) {
    const next: StoredLocks = { ...current, revision, updatedBy: caller.developerId, updatedAt: now, pending: { locks: parsed.data, digest: nextDigest, proposedBy: caller.developerId, proposedAt: now } };
    if (!await locksOf(deps).commitLocks(next, current.revision, { ...auditOf(deps, caller, "locks_change_proposed", "fresh_sign_in"), revision, previousDigest, nextDigest, loosened: true }, NO_CONDITIONS)) throw stale();
    return { status: "needs_second_admin", locks: next };
  }
  const next: StoredLocks = { orgId: caller.orgId, revision, locks: parsed.data, updatedBy: caller.developerId, updatedAt: now };
  if (!await locksOf(deps).commitLocks(next, current?.revision ?? null, { ...auditOf(deps, caller, "locks_changed", "fresh_sign_in"), revision, previousDigest, nextDigest, loosened: false }, NO_CONDITIONS)) throw stale();
  return { status: "applied", locks: next };
}

/**
 * Approves the pending loosening the admin saw (pinned to the row's revision and the change's digest; fresh sign-in; live admin). The approver must be a DIFFERENT eligible admin than the proposer, EXCEPT through the
 * existing sole-owner exception (`decideSecondPersonApproval`): the proposer is the only eligible person and nobody eligible left or was removed in the last 24 hours, else SOLE_OWNER_COOL_OFF (with `availableAt`) or
 * SECOND_PERSON_REQUIRED. When the company has set `noSoleOwnerException`, the exception is not available at all. The audit entry says which way the rule was met.
 */
export async function approveLocksChange(deps: SetupRecipeDeps, caller: RecipeCaller, input: { expectedRevision: number; expectedDigest: string }): Promise<StoredLocks> {
  await requireFreshAdmin(deps, caller);
  const current = await readCompanyLocks(deps, caller.orgId);
  if (current?.pending === undefined) throw agentXError("CHANGE_STALE", "There is no company lock change waiting for approval.");
  if (current.revision !== input.expectedRevision || current.pending.digest !== input.expectedDigest || locksDigest(current.pending.locks) !== current.pending.digest) throw stale();
  const proposerId = current.pending.proposedBy;
  if (proposerId === caller.developerId && current.locks.noSoleOwnerException === true) throw Object.assign(agentXError("FORBIDDEN", "Another admin must approve a change that loosens company locks."), { soleOwner: { available: false, availableAt: null, reasonCode: "EXCEPTION_OFF" } });
  const evidence = await deps.approvalEvidence({ orgId: caller.orgId, proposerId, approverId: caller.developerId });
  if (evidence.decisionInput.proposerId !== proposerId || evidence.decisionInput.approverId !== caller.developerId || evidence.conditions.length === 0) throw stale();
  const decision = decideSecondPersonApproval(evidence.decisionInput);
  const revision = current.revision + 1;
  const next: StoredLocks = { orgId: caller.orgId, revision, locks: current.pending.locks, updatedBy: caller.developerId, updatedAt: iso(deps) };
  const entry: RecipeAuditEntry = {
    ...auditOf(deps, caller, "locks_change_approved", "fresh_sign_in"), revision, previousDigest: locksDigest(current.locks), nextDigest: current.pending.digest, loosened: true,
    approvalMode: decision.mode, membershipVersion: decision.membershipVersion,
  };
  // The evidence conditions commit with the write: a second admin added, or either person changed, since the read refuses it.
  if (!await locksOf(deps).commitLocks(next, current.revision, entry, evidence.conditions)) throw stale();
  return next;
}

// ---- share from a project

export interface ProjectSetupShareInput {
  environment: TestEnvironmentBody;
  /** The project's id of the repository whose setup is shared (the environment's `repos[].repositoryId`). */
  repositoryId: string;
  /** The repository's directory in the workspace, as the environment's command `cwd`s start with it (a command directory is never `.`, so a repository always has one). */
  repositoryDir: string;
  label: string;
  buildSystems: readonly string[];
  toolchains: ReadonlyArray<{ tool: string; version: string }>;
  updateCommands?: readonly ProjectCommand[];
  approvedHosts: readonly string[];
  devcontainerBaseImage?: string;
  /** From `markerFilesOf` and the project's registry hosts. */
  match: SetupFingerprintInput;
}

/**
 * The generic part of a confirmed project setup, as a recipe body: working directories become `{repo}` templates, and a command that runs outside the repository's directory stops the share (it would carry the workspace's
 * layout). The environment's `env` variables stay with the project (a variable may hold anything). Pure; the result is a body for `proposeRecipe`, which still checks it.
 */
export function recipeBodyFromProjectSetup(input: ProjectSetupShareInput): { ok: true; body: SetupRecipeBody } | { ok: false; reason: "repository_not_in_environment" | "command_outside_repository" | "path_outside_repository" | "invalid_recipe" } {
  const repo = input.environment.repos.find((item) => item.repositoryId === input.repositoryId);
  if (repo === undefined) return { ok: false, reason: "repository_not_in_environment" };
  const dir = RelativeWorkspacePathSchema.safeParse(input.repositoryDir.replace(/\/+$/u, ""));
  if (!dir.success) return { ok: false, reason: "command_outside_repository" };
  let outside = false;
  let pathOutside = false;
  /** A report, coverage or SARIF path is relative to the workspace in the environment; in a recipe it is `{repo}/<path>`. */
  const pathTemplate = (workspacePath: string): string => {
    if (workspacePath.startsWith(`${dir.data}/`)) return `{repo}/${workspacePath.slice(dir.data.length + 1)}`;
    pathOutside = true;
    return "{repo}/x";
  };
  const template = (command: ProjectCommand): { cwd: string; executable: string; args: string[]; timeoutSeconds: number } => {
    let cwd: string | undefined;
    if (command.cwd === dir.data) cwd = "{repo}";
    else if (command.cwd.startsWith(`${dir.data}/`)) cwd = `{repo}/${command.cwd.slice(dir.data.length + 1)}`;
    if (cwd === undefined) { outside = true; cwd = "{repo}"; }
    return { cwd, executable: command.executable, args: [...command.args], timeoutSeconds: command.timeoutSeconds };
  };
  const candidate = {
    schemaVersion: 1,
    label: input.label,
    buildSystems: [...input.buildSystems],
    toolchains: [...input.toolchains],
    setupCommands: repo.setupCommands.map(template),
    updateCommands: (input.updateCommands ?? []).map(template),
    checks: repo.checks.map((check) => ({
      id: check.id, label: check.label, kind: check.kind, command: template(check.command),
      ...(check.reportPath === undefined ? {} : { reportPath: pathTemplate(check.reportPath) }), ...(check.coveragePath === undefined ? {} : { coveragePath: pathTemplate(check.coveragePath) }),
      ...(check.sarifPath === undefined ? {} : { sarifPath: pathTemplate(check.sarifPath) }), ...(check.selectArgs === undefined ? {} : { selectArgs: check.selectArgs }),
    })),
    approvedHosts: [...input.approvedHosts],
    ...(input.devcontainerBaseImage === undefined ? {} : { devcontainerBaseImage: input.devcontainerBaseImage }),
    match: { markerFiles: [...input.match.markerFiles], registryHosts: [...input.match.registryHosts] },
  };
  if (outside) return { ok: false, reason: "command_outside_repository" };
  if (pathOutside) return { ok: false, reason: "path_outside_repository" };
  const parsed = SetupRecipeBodySchema.safeParse(candidate);
  return parsed.success ? { ok: true, body: parsed.data } : { ok: false, reason: "invalid_recipe" };
}

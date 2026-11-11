// Company rules (G-04, decision 85): the two-way link between the rules in Rovara (home) and ONE Markdown file in a repository the company connects (its company meta repository). The file is the format Rovara Code reads, so Code keeps
// reading it. Both directions go through the code host's own port (`CodeHost`), the way the lessons file does (`lessons/repo-file-*`), and its guards are the lessons' guards (`guardTarget`: the repository at the address must be the one
// whose id was pinned at connect time).
//   FROM the repository: a look reads the file on the default branch's head. A file that differs from the version in force and was not handled before becomes a PENDING PROPOSAL (`source: "repo"`) with the diff the page shows.
//     It is never approved by the look: a company admin approves it with a fresh sign-in, like any change. A file Rovara cannot read (a line that is not a heading or bullet, too big, over the limits) is a problem shown on the
//     page, never a partial import. The same edit is never proposed twice (`handledFileDigest`).
//   TO the repository: an approved version is written back as a PULL REQUEST (a branch `rovara/company-rules-<12 hex>` and the one connected path), never a push to the default branch. A write-back is owed after an approval, after a
//     rejected repository edit (Rovara is home: the file is put back to the version in force) and when the connected file is missing. One pull request is open at a time; a newer version updates its branch.
//   Nothing a look finds is trusted as authority: the file's text is data that goes through the same checks as a typed proposal (`readRulesFile` -> `normalizeRules`). A host that fails is "try again later", never a change.
//   Every write of the sync row is conditional on the revision read; a pass that loses a race stops quietly and the next pass starts again.
import { createHash, randomBytes } from "node:crypto";
import { COMPANY_RULES_DEFAULT_FILE_PATH, COMPANY_RULES_PROPOSAL_TTL_MS, GitBranchNameSchema, OrgIdSchema, agentXError, COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditCompanyRules, auditOccurrence } from "../audit/events.js";
import { guardTarget, headOf, readOwnPr, type RepoFileTarget } from "../lessons/repo-file-host.js";
import { COMPANY_RULES_BRANCH_PREFIX, PATH_PROBLEM_WORDS, companyRulesPathProblem } from "./path.js";
import { COMPANY_RULES_FILE_MAX_BYTES, readRulesFile, renderRulesFile, rulesDigest, type Rule } from "./rules.js";
import { proposalExpired, proposedEvent, type CompanyRulesCaller } from "./service.js";
import type { CompanyRulesStore, ProposalRecord, SyncRecord, VersionRecord } from "./store.js";

/** What the sync needs of the broker: whether the company's GitHub connection reaches a repository (and its id), and the host and scope to call it with. Provider-neutral beyond that (decision 51). */
export interface CompanyRulesRepositories {
  /** Throws GITHUB_NOT_CONNECTED when the company's connection does not reach `owner/name`. */
  connect(orgId: OrgId, owner: string, name: string): Promise<{ repositoryId: number; url: string }>;
  target(orgId: OrgId, repository: { url: string; repositoryId: number; name: string }): RepoFileTarget;
}

export interface SyncDeps {
  store: CompanyRulesStore;
  repos: CompanyRulesRepositories;
  now(): number;
  requireAdmin(caller: CompanyRulesCaller): Promise<void>;
  requireFreshSignIn(caller: CompanyRulesCaller): Promise<void>;
  log?: (event: string, fields: Record<string, string | number>) => void;
  /** For tests: the 12 hex digits of a new branch's name. */
  randomHex?: () => string;
}

type Problem = NonNullable<SyncRecord["problem"]>;
const READ_TIMEOUT_MS = 8_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const member = (caller: CompanyRulesCaller) => ({ kind: "member", id: caller.developerId }) as const;

export const SYNC_WORDS = {
  pullRequestTitle: (version: number): string => `Rovara: company rules, version ${String(version)}`,
  pullRequestBody: (version: number, path: string): string => [
    `Rovara's approved company rules, version ${String(version)}, written to \`${path}\`.`,
    "",
    "An admin approved this version in Rovara (Settings, Company rules). The version stays in force in Rovara whether or not this pull request is merged.",
    "If you edit this file instead, the edit comes back to Rovara as a proposal that an admin approves. Rovara changes this file only through a pull request like this one.",
  ].join("\n"),
  commit: (version: number): string => `Rovara: company rules, version ${String(version)}`,
  imported: (path: string, revision: string): string => `Edited in ${path} at ${revision.slice(0, 7)}`,
} as const;

const parseRepository = (value: string): { owner: string; name: string } => {
  const [owner, name, ...extra] = value.split("/");
  if (owner === undefined || name === undefined || extra.length > 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/u.test(name) || name === "." || name === "..") throw agentXError("CONFIG_INVALID", "Name the repository as owner/name.");
  return { owner, name };
};

function eventOf(orgId: OrgId, action: "company_rules.sync_connected" | "company_rules.sync_disconnected" | "company_rules.written_back", at: string, actor: AuditEventInput["actor"], parts: string[], facts: Record<string, string | number>, details?: Record<string, string>): AuditEventInput {
  return { ...auditCompanyRules({ orgId, action, actor, occurredAt: at, occurrence: auditOccurrence(...parts), facts }), ...(details === undefined ? {} : { details: [{ subject: "org", fields: details }] }) };
}

const placeOf = (repositoryId: number): string => `github:repo/${String(repositoryId)}`;
const targetOf = (deps: SyncDeps, orgId: OrgId, sync: SyncRecord): RepoFileTarget => guardTarget(deps.repos.target(orgId, { url: sync.repositoryUrl, repositoryId: sync.repositoryId, name: sync.repositoryName }));

/** A proposal id nobody can guess and the same inputs always give: the same repository edit against the same version is the same proposal, so a pass that died half way never makes two. */
export function repoProposalId(orgId: string, fileDigest: string, baseVersion: number): string {
  const hex = createHash("sha256").update(`company-rules-repo\n${orgId}\n${fileDigest}\n${String(baseVersion)}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Connects (or replaces the connection to) the file. A live admin with a recent sign-in. The first look at the file follows (`runSyncPass`); its failure never undoes the connection. */
export async function connectSync(deps: SyncDeps, caller: CompanyRulesCaller, input: { repository: string; path?: string | undefined; branch?: string | undefined }): Promise<void> {
  await deps.requireAdmin(caller);
  await deps.requireFreshSignIn(caller);
  const { owner, name } = parseRepository(input.repository);
  const path = input.path ?? COMPANY_RULES_DEFAULT_FILE_PATH;
  const problem = companyRulesPathProblem(path);
  if (problem !== undefined) throw agentXError("CONFIG_INVALID", PATH_PROBLEM_WORDS[problem]);
  if (input.branch !== undefined && !GitBranchNameSchema.safeParse(input.branch).success) throw agentXError("CONFIG_INVALID", "That branch name is not valid.");
  const pinned = await deps.repos.connect(caller.orgId, owner, name);
  const full = `${owner}/${name}`;
  const target = deps.repos.target(caller.orgId, { url: pinned.url, repositoryId: pinned.repositoryId, name: full });
  let identity;
  try { identity = await target.host.repositoryIdentity(target.repository, target.scope); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not reach the repository. Try again."); }
  if (identity === undefined || String(identity.id) !== String(pinned.repositoryId)) throw agentXError("GITHUB_NOT_CONNECTED", `Rovara can't reach ${full} through your organization's GitHub connection.`);
  const branch = input.branch ?? identity.defaultBranch;
  if (branch === undefined) throw agentXError("CONFIG_INVALID", "Name the branch: the repository's default branch could not be read.");
  const earlier = await deps.store.sync(caller.orgId);
  const at = iso(deps.now());
  const next: SyncRecord = { revision: (earlier?.revision ?? 0) + 1, repositoryName: full, repositoryUrl: pinned.url, repositoryId: pinned.repositoryId, path, branch, connectedBy: caller.developerId, connectedAt: at, fileState: "never_checked" };
  const event = eventOf(caller.orgId, "company_rules.sync_connected", at, member(caller), [at, "sync_connected"], { place: placeOf(pinned.repositoryId) }, { repository: full, path });
  if (await deps.store.writeSync({ orgId: caller.orgId, next, expectedRevision: earlier?.revision ?? 0, events: [event] }) === "conflict") throw agentXError("CHANGE_STALE", "The connection changed meanwhile. Reload and try again.");
  await runSyncPass(deps, caller.orgId).catch(() => undefined);
}

export async function disconnectSync(deps: SyncDeps, caller: CompanyRulesCaller): Promise<void> {
  await deps.requireAdmin(caller);
  const earlier = await deps.store.sync(caller.orgId);
  if (earlier === undefined) return;
  const at = iso(deps.now());
  const event = eventOf(caller.orgId, "company_rules.sync_disconnected", at, member(caller), [at, "sync_disconnected"], { place: placeOf(earlier.repositoryId) }, { repository: earlier.repositoryName, path: earlier.path });
  if (await deps.store.writeSync({ orgId: caller.orgId, next: null, expectedRevision: earlier.revision, events: [event] }) === "conflict") throw agentXError("CHANGE_STALE", "The connection changed meanwhile. Reload and try again.");
}

/** A write-back is owed (an approval, a rejected repository edit): marks it and tries once. Never throws: the next pass, the hourly job or the admin's "sync now" tries again. */
export async function oweWriteBack(deps: SyncDeps, orgId: OrgId): Promise<void> {
  try {
    const sync = await deps.store.sync(orgId);
    if (sync === undefined) return;
    const head = await deps.store.head(orgId);
    if (head.latestVersion === 0) return;
    // A pull request that has not ended carries the version it was made for and keeps it: the pass brings it to the version in force. One that ended (merged or closed) is history, and what is owed is a new pull request.
    const prior = sync.writeBack;
    const keep = prior !== undefined && prior.number !== undefined && prior.state !== "merged" && prior.state !== "closed";
    if (!(keep && prior.state === "open")) {
      const at = iso(deps.now());
      const next: SyncRecord = { ...sync, writeBack: keep ? { ...prior, state: "waiting", updatedAt: at } : { version: head.latestVersion, state: "waiting", updatedAt: at } };
      if (await deps.store.writeSync({ orgId, next, expectedRevision: sync.revision }) === "conflict") return;
    }
    await runSyncPass(deps, orgId);
  } catch (error) {
    deps.log?.("company_rules.write_back_deferred", { error: error instanceof Error ? error.name : "unknown" });
  }
}

interface Look {
  state: SyncRecord["fileState"]; problem?: Problem; text?: string; rules?: Rule[]; revision?: string; checkedAt: string;
}

/** One read of the file on the connected branch's head. A failure is a problem to show, never a change. */
async function look(deps: SyncDeps, target: RepoFileTarget, sync: SyncRecord): Promise<Look> {
  const checkedAt = iso(deps.now());
  let identity;
  try { identity = await target.host.repositoryIdentity(target.repository, target.scope); } catch { return { state: "unreadable", problem: "host_unavailable", checkedAt }; }
  if (identity === undefined || String(identity.id) !== String(sync.repositoryId)) return { state: "unreadable", problem: "repository_changed", checkedAt };
  let revision: string;
  try { revision = await target.host.baseBranchHead(target.repository, sync.branch, target.scope); } catch { return { state: "unreadable", problem: "host_unavailable", checkedAt }; }
  let text: string | undefined;
  try { text = await target.host.fileAtRevision(target.repository, sync.path, revision, target.scope, { maxBytes: COMPANY_RULES_FILE_MAX_BYTES, timeoutMs: READ_TIMEOUT_MS }); } catch (error) {
    // A file over the size cap is refused by the host with CONFIG_INVALID; any other failure is "try again later".
    const refused = (error as { code?: unknown } | null)?.code === "CONFIG_INVALID";
    return { state: "unreadable", problem: refused ? "file_too_large" : "host_unavailable", revision, checkedAt };
  }
  if (text === undefined) return { state: "missing", revision, checkedAt };
  const read = readRulesFile(text);
  if (!read.ok) return { state: "unreadable", problem: read.problem, revision, checkedAt };
  return { state: "differs", text, rules: read.rules, revision, checkedAt };
}

const pendingOf = async (deps: SyncDeps, orgId: OrgId, headPending: string | undefined): Promise<ProposalRecord | undefined> => {
  if (headPending === undefined) return undefined;
  const found = await deps.store.proposal(orgId, headPending);
  return found !== undefined && found.state === "pending" ? found : undefined;
};

/** The revision the sync row has now: every write of it moves it by one, and a pass that writes twice must carry the new number to its second write. */
interface Revision { value: number }

/**
 * One pass: look at the file, turn a new edit into a proposal, and carry out a write-back that is owed. Returns quietly when nothing is connected or when a race is lost. Throws nothing a caller must handle except a store fault.
 */
export async function runSyncPass(deps: SyncDeps, orgId: OrgId): Promise<void> {
  if (!OrgIdSchema.safeParse(orgId).success) return;
  const sync = await deps.store.sync(orgId);
  if (sync === undefined) return;
  const target = targetOf(deps, orgId, sync);
  const seen = await look(deps, target, sync);
  const head = await deps.store.head(orgId);
  const current: VersionRecord | undefined = head.latestVersion === 0 ? undefined : await deps.store.version(orgId, head.latestVersion);
  if (head.latestVersion > 0 && current === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
  let fileDigest: string | undefined;
  let state: SyncRecord["fileState"] = seen.state;
  if (seen.rules !== undefined) {
    fileDigest = rulesDigest(seen.rules);
    // A file with no rules in a company with no rules agrees with it (nothing to clear, nothing to import).
    state = current === undefined ? (seen.rules.length === 0 ? "match" : "differs") : fileDigest === current.digest ? "match" : "differs";
  }
  let next: SyncRecord = { ...sync, lastCheckedAt: seen.checkedAt, fileState: state };
  delete next.problem; delete next.fileDigest; delete next.fileRules;
  if (seen.revision !== undefined) next.lastCheckedRevision = seen.revision;
  if (seen.problem !== undefined) next.problem = seen.problem;
  if (fileDigest !== undefined && seen.rules !== undefined) { next.fileDigest = fileDigest; next.fileRules = seen.rules; }
  if (state === "match" && current !== undefined) { next.syncedDigest = current.digest; next.syncedRules = current.rules; }
  // A match ends what was owed: an open pull request has merged (or the file was fixed by hand); anything else owed is no longer.
  if (state === "match" && next.writeBack !== undefined) {
    if (next.writeBack.state === "open") next.writeBack = { ...next.writeBack, state: "merged", updatedAt: seen.checkedAt }; else delete next.writeBack;
  }
  if (state === "missing" && current !== undefined && next.writeBack === undefined) next.writeBack = { version: current.version, state: "waiting", updatedAt: seen.checkedAt };

  // From the repository: an edit nobody handled yet becomes a proposal.
  if (state === "differs" && seen.rules !== undefined && seen.revision !== undefined && fileDigest !== undefined && fileDigest !== sync.handledFileDigest) {
    const waiting = await pendingOf(deps, orgId, head.pendingProposalId);
    const now = deps.now();
    const expired = waiting !== undefined && proposalExpired(waiting, now);
    if (waiting !== undefined && !expired && waiting.digest === fileDigest) next.handledFileDigest = fileDigest;
    // A waiting proposal from a person is left alone: the edit is proposed after it is decided.
    else if (waiting === undefined || expired || waiting.source === "repo") {
      const id = repoProposalId(orgId, fileDigest, head.latestVersion);
      if (await deps.store.proposal(orgId, id) !== undefined) next.handledFileDigest = fileDigest;
      else {
        const proposal: ProposalRecord = {
          proposalId: id, state: "pending", baseVersion: head.latestVersion, source: "repo", rules: seen.rules, digest: fileDigest, note: SYNC_WORDS.imported(sync.path, seen.revision),
          proposedBy: { kind: "repo" }, proposedAt: seen.checkedAt, expiresAt: iso(now + COMPANY_RULES_PROPOSAL_TTL_MS), repoRevision: seen.revision,
        };
        const outcome = expired ? "expired" as const : "cancelled" as const;
        const events = [
          ...(waiting === undefined ? [] : [auditCompanyRules({ orgId, action: `company_rules.${outcome}`, actor: { kind: "system", id: "rovara" }, occurredAt: seen.checkedAt, occurrence: auditOccurrence(waiting.proposalId, outcome), facts: { proposalId: waiting.proposalId, source: waiting.source, digest: waiting.digest } })]),
          proposedEvent(orgId, proposal, "company_rules.repo_proposed"),
        ];
        // A lost race (someone proposed first) leaves the edit unhandled: it is looked at again at the next pass.
        if (await deps.store.createProposal({ orgId, proposal, expectedBase: head.latestVersion, ...(waiting === undefined ? {} : { replacing: waiting, replacingOutcome: outcome }), events }) === "ok") next.handledFileDigest = fileDigest;
      }
    }
  }

  const revision: Revision = { value: sync.revision };
  // To the repository: a write-back that is owed.
  if (current !== undefined && next.writeBack !== undefined && next.writeBack.state !== "merged" && state !== "match" && state !== "unreadable") next = await writeBack(deps, orgId, target, next, current, seen, revision);
  if (await deps.store.writeSync({ orgId, next, expectedRevision: revision.value }) === "conflict") deps.log?.("company_rules.sync_pass_lost_race", {});
}

const failedWith = (sync: SyncRecord, wb: NonNullable<SyncRecord["writeBack"]>, current: VersionRecord, problem: Problem, at: string): SyncRecord =>
  ({ ...sync, problem: sync.problem ?? problem, writeBack: { ...wb, version: current.version, state: "failed", updatedAt: at } });

async function writeBack(deps: SyncDeps, orgId: OrgId, target: RepoFileTarget, sync: SyncRecord, current: VersionRecord, seen: Look, revision: Revision): Promise<SyncRecord> {
  const wb = sync.writeBack!;
  const at = iso(deps.now());
  if (target.host.commitFiles === undefined) return failedWith(sync, wb, current, "no_pull_request_support", at);
  const content = renderRulesFile(current.rules, current.version);
  const opened = (branch: string, head: string, ref: { id: string; url: string }): SyncRecord => {
    const number = Number(ref.id);
    return { ...sync, writeBack: { version: current.version, state: "open", branch, head, ...(Number.isSafeInteger(number) && number > 0 ? { number } : {}), ...(ref.url.startsWith("https://") ? { url: ref.url } : {}), updatedAt: at } };
  };
  const written = (head: string): AuditEventInput => eventOf(orgId, "company_rules.written_back", at, { kind: "system", id: "rovara" }, [String(current.version), head, "written_back"], { version: current.version, revision: head, state: "open" });
  try {
    // A pull request of ours is recorded: bring its branch to the version in force, or learn how it ended.
    if (wb.number !== undefined && wb.branch !== undefined) {
      const found = await readOwnPr(target, String(wb.number), wb.branch);
      if (found.kind === "read" && found.ours === true) {
        const state = found.details.state;
        if (state === "merged" || state === "closed") {
          // How it ended is shown. An older pull request that ended is history: a pull request for the version in force is made below.
          if (wb.version >= current.version) return { ...sync, writeBack: { ...wb, state, updatedAt: at } };
        } else {
          if (wb.version === current.version) return { ...sync, writeBack: { ...wb, state: "open", updatedAt: at } };
          const result = await target.host.commitFiles({ repository: target.repository, branch: wb.branch, baseBranch: sync.branch, message: SYNC_WORDS.commit(current.version), files: [{ path: sync.path, content }], fromBase: false, expectedHead: found.details.headRevision, previous: [{ path: sync.path, content: await fileOnBranch(target, wb.branch, sync.path) }] }, target.scope);
          await target.host.updateChangeRequest({ repository: target.repository, id: String(wb.number), url: wb.url ?? "" }, { title: SYNC_WORDS.pullRequestTitle(current.version), body: SYNC_WORDS.pullRequestBody(current.version, sync.path) }, target.scope).catch(() => undefined);
          const done: SyncRecord = { ...sync, writeBack: { ...wb, version: current.version, state: "open", head: result.revision, updatedAt: at } };
          if (await deps.store.writeSync({ orgId, next: done, expectedRevision: revision.value, events: [written(result.revision)] }) === "conflict") return sync;
          revision.value += 1;
          return { ...done, revision: revision.value };
        }
      } else if (found.kind !== "gone") {
        // Not ours or unreadable: nothing is done to it, and the next pass tries again. Only a pull request that is gone is replaced.
        return { ...sync, writeBack: { ...wb, updatedAt: at } };
      }
    }
    if (wb.state === "closed" && wb.version === current.version) return sync;
    // A branch recorded by an earlier pass that died before it recorded the pull request: if it holds the file we owe, the pull request is made for it; otherwise it is left and a new branch is used.
    if (wb.branch !== undefined && wb.number === undefined) {
      const there = await headOf(target, wb.branch);
      if (there !== undefined && await fileOnBranch(target, wb.branch, sync.path) === content) {
        const reconciled = await target.host.reconcileChangeRequest({ repository: target.repository, sourceBranch: wb.branch, targetBranch: sync.branch, title: SYNC_WORDS.pullRequestTitle(current.version), body: SYNC_WORDS.pullRequestBody(current.version, sync.path) }, target.scope);
        return opened(wb.branch, there, reconciled.ref);
      }
    }
    let branch: string | undefined;
    for (let attempt = 0; attempt < 5 && branch === undefined; attempt += 1) {
      const candidate = `${COMPANY_RULES_BRANCH_PREFIX}${deps.randomHex?.() ?? randomBytes(6).toString("hex")}`;
      if (await headOf(target, candidate) === undefined) branch = candidate;
    }
    if (branch === undefined || seen.revision === undefined) return failedWith(sync, wb, current, "host_unavailable", at);
    // The branch name is recorded BEFORE anything is written to the host, so a pass that dies after the write finds its own branch.
    const recorded: SyncRecord = { ...sync, writeBack: { version: current.version, state: "waiting", branch, updatedAt: at } };
    if (await deps.store.writeSync({ orgId, next: recorded, expectedRevision: revision.value }) === "conflict") return sync;
    revision.value += 1;
    const committed = await target.host.commitFiles({ repository: target.repository, branch, baseBranch: sync.branch, message: SYNC_WORDS.commit(current.version), files: [{ path: sync.path, content }], fromBase: true, baseRevision: seen.revision, previous: [{ path: sync.path, content: seen.text ?? null }] }, target.scope);
    const pull = await target.host.reconcileChangeRequest({ repository: target.repository, sourceBranch: branch, targetBranch: sync.branch, title: SYNC_WORDS.pullRequestTitle(current.version), body: SYNC_WORDS.pullRequestBody(current.version, sync.path) }, target.scope);
    const done = opened(branch, committed.revision, pull.ref);
    if (await deps.store.writeSync({ orgId, next: done, expectedRevision: revision.value, events: [written(committed.revision)] }) === "conflict") return recorded;
    revision.value += 1;
    return { ...done, revision: revision.value };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes(COMMIT_CONFLICT_MESSAGE)) return { ...sync, writeBack: { ...wb, state: "waiting", updatedAt: at } };
    if (message.includes(COMMIT_SYMLINK_MESSAGE)) return failedWith(sync, wb, current, "file_unreadable", at);
    deps.log?.("company_rules.write_back_failed", { error: error instanceof Error ? error.name : "unknown" });
    return failedWith(sync, wb, current, /\bHTTP 40[34]\b/u.test(message) ? "no_write_access" : "host_unavailable", at);
  }
}

/** The file's text on a branch of ours, or null when there is none. */
async function fileOnBranch(target: RepoFileTarget, branch: string, path: string): Promise<string | null> {
  const head = await target.host.branchHead(target.repository, branch, target.scope);
  return (await target.host.fileAtRevision(target.repository, path, head, target.scope, { maxBytes: COMPANY_RULES_FILE_MAX_BYTES, timeoutMs: READ_TIMEOUT_MS })) ?? null;
}

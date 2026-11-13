// Test services, slice 3 (s3-fakes-store): the routes for a hand-written fake (a FixtureSet v2) and its review. Behind `tx`: with it off, or where the install has no fixture store, every path here is not found, as any
// unknown path. The project is a browser route family: a token (an API or CLI token) is refused. All of these are the project's maintainers' (a member may read a review); an org owner or admin counts as a maintainer.
//   POST /v1/app/projects/{name}/fixtures                         { set }  submit a hand-written set (origin `written`). Stored pending after the parse, the size bound and the data scan; a finding stores nothing.
//   GET  /v1/app/projects/{name}/fixtures/{digest}                the review card: counts, schema, three redacted sample pairs, the scan result, ignored paths, faults, and the `approve_fixture_set` item.
//   POST /v1/app/projects/{name}/fixtures/{digest}/approve        {}   then `/reject` and `/withdraw`: each is ONE decision on ONE digest, made with a `verifiedFixtureDecision` this file mints from the SESSION.
// What the request never decides: the org (the session's), the role (read live for the session's person), the sign-in time (the session record's `authTime`), and `schemaSynth` (the project's approved environment:
// any dependency backed by this set, or by the same dependency id, whose fake answers unmatched requests from the schema). The production deny list is the same approved environment's. An environment that cannot be read
// is an error, never an empty list.
// H1: a set belongs to ONE PROJECT. Its row, its store id and its object key name the project it was submitted for; every path above reads and decides only the set of the project in the URL (the role is read for that
// project), so a maintainer of project B cannot read, approve, reject or withdraw project A's set by its digest. A set of another project, of another org and a digest nobody holds are answered alike (`answer set not found`).
// The schemaSynth flag, the production list and the sign-in rule are computed from the ROW's project (which is the URL's, or the row was not found).
import { routeEnvOf } from "../../org/feature-rollout.js";
import { z } from "zod";
import { auditOccurrence, auditProjectFixtureSetDecided } from "../../audit/events.js";
import { recordAuditEventDurably } from "../../audit/flush.js";
import { FixtureSetSchema, agentXError, projectAllows, type TestEnvironmentBody } from "@rovara-code/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import type { SessionRecord } from "../../developer/store.js";
import { readApprovedTestEnvironment } from "../../org/test-environment.js";
import { fixtureSetCardItem, verifiedFixtureDecision, type FixtureDecisionAction, type FixtureDenyFor, type FixtureRecord, type FixtureStore } from "../../test-env/fixture-store.js";
import { testServicesEnabled } from "../../test-env/test-services-switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { bodyError } from "./common.js";
import { jsonBody } from "./organization.js";
import { visibleProjectRoles } from "./project-list.js";
import { testEnvStoreOf } from "./test-environment.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const FIXTURE_PATH = /^\/v1\/app\/projects\/([^/]+)\/fixtures(?:\/([a-f0-9]{64})(?:\/(approve|reject|withdraw))?)?$/u;
export const FIXTURE_BROWSER_MESSAGE = "Use a live browser session for a project's answer sets.";
export const isFixturePath = (pathname: string): boolean => FIXTURE_PATH.test(pathname);

const SubmitBodySchema = z.object({ set: z.unknown() }).strict();
const DecisionBodySchema = z.object({}).strict();

/** The words a refusal of the store is shown as. Fixed text: nothing of the set or of another org. */
function refused(reason: string): Error {
  switch (reason) {
    case "invalid": return agentXError("CONFIG_INVALID", "This is not a valid answer set.");
    case "too_large": return agentXError("CONFIG_INVALID", "This answer set is too large.");
    case "data_guard": return agentXError("CONFIG_INVALID", "This answer set holds personal data, a credential, or something the company marked as production, so it was not stored.");
    case "digest_mismatch": return agentXError("CHANGE_STALE", "The stored answer set is not the one this id names. Submit it again.");
    case "already_decided": return agentXError("CHANGE_STALE", "This answer set was already decided.");
    case "not_approved": return agentXError("CHANGE_STALE", "Only an approved answer set can be withdrawn.");
    case "fresh_sign_in_required": return agentXError("REAUTH_REQUIRED", "Sign in again to approve this answer set.");
    case "unauthorised": return agentXError("FORBIDDEN", "Only a project maintainer can decide on an answer set.");
    default: return agentXError("NOT_FOUND", "answer set not found");
  }
}

/** True when this environment backs a dependency with a fake that makes up answers for the set (by its digest, or by the dependency id the set is for). */
export function environmentSynthesisesFor(dependencies: readonly object[] | undefined, digest: string, dependencyId: string): boolean {
  for (const dependency of (dependencies ?? []) as ReadonlyArray<Record<string, unknown>>) {
    for (const backing of Object.values(dependency)) {
      if (backing === null || typeof backing !== "object" || Array.isArray(backing)) continue;
      const slot = backing as { kind?: unknown; unmatched?: unknown; fixtureSetRef?: unknown };
      if (slot.kind === "fake" && slot.unmatched === "schema_synth" && (slot.fixtureSetRef === digest || dependency.id === dependencyId)) return true;
    }
  }
  return false;
}

const signedInAtOf = async (deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<Date | undefined> => {
  const session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`);
  const at = session?.authTime === undefined ? Number.NaN : Date.parse(session.authTime);
  return Number.isFinite(at) ? new Date(at) : undefined;
};

export async function routeFixtures(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = routeEnvOf(deps)): Promise<StatusReply | undefined> {
  // The path first: a request for any other path reads no gated switch (TE-A1).
  const match = FIXTURE_PATH.exec(url.pathname);
  if (match === null || deps.fixtureStore === undefined || !testServicesEnabled(env)) return undefined;
  const digest = match[2];
  const action = match[3] as FixtureDecisionAction | undefined;
  const wanted = digest === undefined ? "POST" : action === undefined ? "GET" : "POST";
  if (request.method !== wanted) return undefined;
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", FIXTURE_BROWSER_MESSAGE);
  let project: string;
  try { project = decodeURIComponent(match[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "project not found"); }
  // The role is read live for the authenticated person; a person with no role on the project learns nothing about it.
  const role = (await visibleProjectRoles(deps, caller, project)).get(project);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const maintainer = projectAllows(role, "edit_settings");
  if (wanted === "POST" && !maintainer) throw agentXError("FORBIDDEN", "Only a project maintainer can add or decide on an answer set.");
  const orgId = caller.orgId;
  // The approved environment of a PROJECT: its deny list scans a set, and its dependencies say whether the set is used with `schema_synth`. Unreadable is an error, never an empty list. It is asked for the project of the ROW.
  const environmentOf = async (rowProject: string): Promise<TestEnvironmentBody | undefined> => (await readApprovedTestEnvironment(testEnvStoreOf(deps), orgId, rowProject))?.environment;
  const denyFor: FixtureDenyFor = async (denyOrg, denyProject) => {
    if (denyOrg !== orgId) throw new Error("the production list is asked for the session's org only");
    return (await environmentOf(denyProject))?.prodDeny ?? { accountIds: [], hosts: [], arnPrefixes: [] };
  };
  const store: FixtureStore = deps.fixtureStore(denyFor);
  const base = `/v1/app/projects/${encodeURIComponent(project)}/fixtures`;
  const reviewOf = async (wantedDigest: string): Promise<StatusReply> => {
    const found = await store.review(orgId, project, wantedDigest);
    if (!found.ok) throw refused(found.reason);
    // The row's project is what the card, the flag and the list below are about (the store answered for this project only; this is the second look).
    if (found.record.project !== project) throw refused("not_found");
    const schemaSynth = environmentSynthesisesFor((await environmentOf(found.record.project))?.dependencies, wantedDigest, found.record.dependencyId);
    const card = fixtureSetCardItem({ record: found.record, review: found.review, project: found.record.project, openPath: `${base}/${wantedDigest}`, schemaSynth });
    return new StatusReply(200, { status: found.record.status, review: found.review, card, canDecide: maintainer });
  };

  if (digest === undefined) {
    const parsed = SubmitBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw bodyError(parsed.error);
    // A hand-written set is `written`: a recording is made by the recorder, with its own provenance, and never through here.
    const set = FixtureSetSchema.safeParse(parsed.data.set);
    if (!set.success || set.data.origin !== "written") throw refused("invalid");
    const stored = await store.submit(orgId, project, set.data, { actor: caller.developerId, recordedFrom: "written" });
    if (!stored.ok) throw refused(stored.reason);
    logDeveloperEvent({ event: "developer.fixture_set_submitted", orgId, project, digest: stored.record.digest, created: String(stored.created) });
    const reply = await reviewOf(stored.record.digest);
    return new StatusReply(stored.created ? 201 : 200, reply.body);
  }
  if (action === undefined) return reviewOf(digest);

  const body = DecisionBodySchema.safeParse(jsonBody(request));
  if (!body.success) throw bodyError(body.error);
  // The set of THIS project only: a digest held by another project (or org) reads as one nobody holds, and nothing below is computed from anything but the row's own project.
  const held = await store.record(orgId, project, digest);
  if (!held.ok || held.record.project !== project) throw refused("not_found");
  const decision = verifiedFixtureDecision({
    orgId, project: held.record.project, actor: caller.developerId, role, action, digest, signedInAt: await signedInAtOf(deps, caller),
    schemaSynth: environmentSynthesisesFor((await environmentOf(held.record.project))?.dependencies, digest, held.record.dependencyId),
  });
  if (decision === undefined) throw refused("unauthorised");
  const done: { ok: true; record: FixtureRecord } | { ok: false; reason: string } = await (action === "approve" ? store.approve(orgId, project, digest, decision) : action === "reject" ? store.reject(orgId, project, digest, decision) : store.withdraw(orgId, project, digest, decision));
  if (!done.ok) throw refused(done.reason);
  logDeveloperEvent({ event: `developer.fixture_set_${action}`, orgId, project, digest, status: done.record.status });
  // M1: the decision is on the Audit Ledger (who, which org, which project, which digest; never the set). It is made durable after the decision stands: if the ledger cannot take it the caller is told, and the decision stays.
  await recordAuditEventDurably(deps, auditProjectFixtureSetDecided({
    orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: done.record.decidedAt ?? done.record.withdrawnAt ?? new Date().toISOString(),
    occurrence: auditOccurrence(digest, action, String(done.record.version)), projectName: project, decision: action === "approve" ? "approved" : action === "reject" ? "rejected" : "withdrawn", digest,
  }));
  return new StatusReply(200, { status: done.record.status, digest });
}

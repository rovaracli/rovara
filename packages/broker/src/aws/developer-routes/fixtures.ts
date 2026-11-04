// Test services, slice 3 (s3-fakes-store): the routes for a hand-written fake (a FixtureSet v2) and its review. Behind `tx`: with it off, or where the install has no fixture store, every path here is not found, as any
// unknown path. The project is a browser route family: a token (an API or CLI token) is refused. All of these are the project's maintainers' (a member may read a review); an org owner or admin counts as a maintainer.
//   POST /v1/app/projects/{name}/fixtures                         { set }  submit a hand-written set (origin `written`). Stored pending after the parse, the size bound and the data scan; a finding stores nothing.
//   GET  /v1/app/projects/{name}/fixtures/{digest}                the review card: counts, schema, three redacted sample pairs, the scan result, ignored paths, faults, and the `approve_fixture_set` item.
//   POST /v1/app/projects/{name}/fixtures/{digest}/approve        {}   then `/reject` and `/withdraw`: each is ONE decision on ONE digest, made with a `verifiedFixtureDecision` this file mints from the SESSION.
// What the request never decides: the org (the session's), the role (read live for the session's person), the sign-in time (the session record's `authTime`), and `schemaSynth` (the project's approved environment:
// any dependency backed by this set, or by the same dependency id, whose fake answers unmatched requests from the schema). The production deny list is the same approved environment's. An environment that cannot be read
// is an error, never an empty list.
import { z } from "zod";
import { FixtureSetSchema, agentXError, projectAllows, type TestEnvProdDeny } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import type { SessionRecord } from "../../developer/store.js";
import { readApprovedTestEnvironment } from "../../org/test-environment.js";
import { fixtureSetCardItem, verifiedFixtureDecision, type FixtureDecisionAction, type FixtureRecord, type FixtureStore } from "../../test-env/fixture-store.js";
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

export async function routeFixtures(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!testServicesEnabled(env) || deps.fixtureStore === undefined) return undefined;
  const match = FIXTURE_PATH.exec(url.pathname);
  if (match === null) return undefined;
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
  // The project's approved environment: its deny list scans the set, and its dependencies say whether the set is used with `schema_synth`. Unreadable is an error (the store asks for the list at every scan).
  const environment = (await readApprovedTestEnvironment(testEnvStoreOf(deps), caller.orgId, project))?.environment;
  const deny: TestEnvProdDeny = environment?.prodDeny ?? { accountIds: [], hosts: [], arnPrefixes: [] };
  const store: FixtureStore = deps.fixtureStore(() => Promise.resolve(deny));
  const orgId = caller.orgId;
  const base = `/v1/app/projects/${encodeURIComponent(project)}/fixtures`;
  const reviewOf = async (wantedDigest: string): Promise<StatusReply> => {
    const found = await store.review(orgId, wantedDigest);
    if (!found.ok) throw refused(found.reason);
    const schemaSynth = environmentSynthesisesFor(environment?.dependencies, wantedDigest, found.record.dependencyId);
    const card = fixtureSetCardItem({ record: found.record, review: found.review, project, openPath: `${base}/${wantedDigest}`, schemaSynth });
    return new StatusReply(200, { status: found.record.status, review: found.review, card, canDecide: maintainer });
  };

  if (digest === undefined) {
    const parsed = SubmitBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw bodyError(parsed.error);
    // A hand-written set is `written`: a recording is made by the recorder, with its own provenance, and never through here.
    const set = FixtureSetSchema.safeParse(parsed.data.set);
    if (!set.success || set.data.origin !== "written") throw refused("invalid");
    const stored = await store.submit(orgId, set.data, { actor: caller.developerId, recordedFrom: "written" });
    if (!stored.ok) throw refused(stored.reason);
    logDeveloperEvent({ event: "developer.fixture_set_submitted", orgId, project, digest: stored.record.digest, created: String(stored.created) });
    const reply = await reviewOf(stored.record.digest);
    return new StatusReply(stored.created ? 201 : 200, reply.body);
  }
  if (action === undefined) return reviewOf(digest);

  const body = DecisionBodySchema.safeParse(jsonBody(request));
  if (!body.success) throw bodyError(body.error);
  const held = await store.record(orgId, digest);
  if (!held.ok) throw refused(held.reason);
  const decision = verifiedFixtureDecision({
    orgId, actor: caller.developerId, role, action, digest, signedInAt: await signedInAtOf(deps, caller),
    schemaSynth: environmentSynthesisesFor(environment?.dependencies, digest, held.record.dependencyId),
  });
  if (decision === undefined) throw refused("unauthorised");
  const done: { ok: true; record: FixtureRecord } | { ok: false; reason: string } = await (action === "approve" ? store.approve(orgId, digest, decision) : action === "reject" ? store.reject(orgId, digest, decision) : store.withdraw(orgId, digest, decision));
  if (!done.ok) throw refused(done.reason);
  logDeveloperEvent({ event: `developer.fixture_set_${action}`, orgId, project, digest, status: done.record.status });
  return new StatusReply(200, { status: done.record.status, digest });
}

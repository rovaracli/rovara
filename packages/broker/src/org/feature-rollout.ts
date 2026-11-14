// Company rollout gates (TE-A1): the store, the gate and the answers built from them.
//
// EFFECTIVE = the install's switch is exactly "1" AND the company's gate is on (`effectiveFeature`). The install switch is the emergency off for everyone and is never changed here; a company's gate off is instant for that company.
// The existing install readers (`proofEvidenceEnabled`, `verifyResultsEnabled`, `testEnvironmentEnabled`, `testServicesEnabled`) keep reading the install's variables as they always did. They are wrapped by the environment they are given:
// `companyGatedEnv` returns that environment with each gated variable forced to "0" for a company whose gate is not on, so every reader called with it answers for the company. A caller that has a company calls it once and
// hands the result on; a caller with no company in hand keeps the install's answer and is listed, with the reason, in tests/contract/feature-rollout-readers.test.ts.
//
// ONE ROW per company: `ORG#<org>` / `FEATURE_ROLLOUT` (orgFeatureRolloutKey), a map of known gate names to on/off and a `revision` that fences every write. Absent until the company first changes something: every gate takes its catalog
// default (on for the four features that have an install switch, so a missing row follows the install switch; off for the three not built yet). A stored value that is not the boolean true reads as off. A name outside the closed list
// (contracts/feature-rollout.ts) is never stored and never sent.
//
// A READ THAT FAILS is handled by the caller's choice (`onReadFailure`): "off" (the default: every gated feature off, fail closed, for what only shows something) or "throw" (for a path that starts or keeps work, so its queue or
// caller tries again instead of silently doing less). A temporary AWS error (a throttle) is rethrown AS ITSELF, marked as a gate failure, so every caller that already retries a throttle (the first task's queuing, the HTTP 503
// answer) retries this one and never records the work as failed; any other failure is RUNTIME_UNAVAILABLE in fixed words. The per-request dispatch makes an `unavailableEnv`: a gated route answers 503 RUNTIME_UNAVAILABLE the moment
// it reads a gated switch (never the catalog default, which could turn a company's explicit off into on), and a route that reads none is untouched. Each logs without the company's data. A row that is there but cannot be read counts as
// off for what it cannot read.
//
// ONE READ A REQUEST: a request makes a `GateReader` (`createGateReader`) and puts it on the dependencies it hands on (`gates`); every helper below reads a company once through it. There is no cache between requests, so a change
// is the next request's read.
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  BROKER_SETTINGS, ROLLOUT_FEATURE_CATALOG, ROLLOUT_FEATURE_NAMES, isRolloutFeatureName, orgFeatureRolloutKey, rolloutGateOn,
  type AuditEventInput, type FeatureRolloutAnswer, type RolloutFeatureName,
} from "@agentx/cloud-contracts";
import { agentXError, liveInteractionFlagOn, type OrgId } from "@rovara-code/contracts";
import { isTemporaryAwsError } from "../aws/broker-shared.js";
import { auditCompanyFeatureRolloutChanged, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { logDeveloperEvent } from "../developer/log.js";

type Item = Record<string, unknown>;
export interface FeatureRolloutDeps {
  documentClient: { send(command: never): Promise<unknown> };
  tableName: string;
  now(): number;
  audit?: AuditRuntime | undefined;
  /** This request's reader (`createGateReader`): a company is read once through it. Absent: every ask reads the table. */
  gates?: GateReader | undefined;
}

/** A company's gates, read once for as long as the reader lives (one request). A failed read is not remembered. */
export interface GateReader { read: (orgId: OrgId) => Promise<FeatureRolloutSettings> }

export function createGateReader(deps: FeatureRolloutDeps): GateReader {
  const known = new Map<OrgId, Promise<FeatureRolloutSettings>>();
  return {
    read(orgId) {
      const found = known.get(orgId);
      if (found !== undefined) return found;
      const reading = readFeatureRolloutFresh({ documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now() }, orgId);
      known.set(orgId, reading);
      reading.catch(() => { if (known.get(orgId) === reading) known.delete(orgId); });
      return reading;
    },
  };
}

/** The variable of each gate's install switch. A gate that is not here (the lanes not built yet) has no install switch: its company gate is its whole switch. */
export const ROLLOUT_INSTALL_VARIABLE: Readonly<Partial<Record<RolloutFeatureName, string>>> = {
  proofEvidence: BROKER_SETTINGS.proofEvidence.variable,
  verifyResults: BROKER_SETTINGS.verifyResults.variable,
  testEnvironment: BROKER_SETTINGS.testEnvironment.variable,
  testServices: BROKER_SETTINGS.testServices.variable,
};
const GATED_VARIABLES = Object.entries(ROLLOUT_INSTALL_VARIABLE) as Array<[RolloutFeatureName, string]>;

/** Whether the install's own switch for a gate is on: exactly "1". A gate with no install switch has nothing to hold it back, so its install side is on. */
export function installSwitchOn(name: RolloutFeatureName, env: Record<string, string | undefined> = process.env): boolean {
  const variable = ROLLOUT_INSTALL_VARIABLE[name];
  return variable === undefined || liveInteractionFlagOn(env[variable]);
}

/** The truth table: the install's switch exactly "1" AND the company's gate on (`stored` is what the company has stored for the name: absent takes the default, only the boolean true is on). */
export function effectiveFeature(name: RolloutFeatureName, stored: unknown, env: Record<string, string | undefined> = process.env): boolean {
  return installSwitchOn(name, env) && rolloutGateOn(name, stored);
}

/** What a company has stored. `revision` is 0 while there is no usable record. `gates` holds only the stored values; a name that is absent takes its default. */
export interface FeatureRolloutSettings {
  gates: Readonly<Partial<Record<RolloutFeatureName, boolean>>>;
  revision: number;
  changedAt?: string;
  /** Set only when a row exists whose `revision` is present but not a whole number of 1 or more: what is stored there, so the next write can replace exactly that row. */
  unreadableRevision?: { value: unknown };
  /** True when the row is there but cannot be read: every gate reads as off, and the next change starts from nothing stored. */
  unreadable?: true;
  /** Known names whose stored value is not a boolean: each reads as off but is not carried into the next write. */
  malformed?: readonly RolloutFeatureName[];
}

const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const send = <T>(deps: FeatureRolloutDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;
const allStoredOff = (): Partial<Record<RolloutFeatureName, boolean>> => Object.fromEntries(ROLLOUT_FEATURE_NAMES.map((name) => [name, false]));

/**
 * The company's settings from its stored item (or none). No item: nothing stored, so every gate takes its default. A known name whose value is not a boolean counts as stored off. A row whose revision does not read (or has none) is
 * UNREADABLE as a whole: every gate reads as off at revision 0, and `unreadableRevision` says what is stored so an admin's next change replaces the row instead of being locked out.
 */
export function settingsFromItem(item: Item | undefined): FeatureRolloutSettings {
  if (item === undefined) return { gates: {}, revision: 0 };
  if (!(typeof item.revision === "number" && Number.isInteger(item.revision) && item.revision >= 1)) {
    return { gates: allStoredOff(), revision: 0, unreadable: true, ...(item.revision === undefined ? {} : { unreadableRevision: { value: item.revision } }) };
  }
  const readable = typeof item.gates === "object" && item.gates !== null && !Array.isArray(item.gates);
  if (!readable && item.gates !== undefined) return { gates: allStoredOff(), revision: item.revision, unreadable: true, ...(typeof item.changedAt === "string" ? { changedAt: item.changedAt } : {}) };
  const stored = readable ? item.gates as Record<string, unknown> : {};
  const gates: Partial<Record<RolloutFeatureName, boolean>> = {}, malformed: RolloutFeatureName[] = [];
  for (const [name, value] of Object.entries(stored)) {
    if (!isRolloutFeatureName(name)) continue;
    gates[name] = value === true;
    if (typeof value !== "boolean") malformed.push(name);
  }
  return { gates, revision: item.revision, ...(typeof item.changedAt === "string" ? { changedAt: item.changedAt } : {}), ...(malformed.length > 0 ? { malformed } : {}) };
}

/** The company's settings straight from the table (a consistent read). A write reads this way, never through a request's reader. */
export async function readFeatureRolloutFresh(deps: FeatureRolloutDeps, orgId: OrgId): Promise<FeatureRolloutSettings> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: orgFeatureRolloutKey(orgId), ConsistentRead: true }));
  return settingsFromItem(found.Item);
}

/** The company's settings: through this request's reader when the dependencies carry one, else straight from the table. */
export const readFeatureRollout = (deps: FeatureRolloutDeps, orgId: OrgId): Promise<FeatureRolloutSettings> => deps.gates === undefined ? readFeatureRolloutFresh(deps, orgId) : deps.gates.read(orgId);

/** What a read that fails does (see the header). */
export type GateReadFailure = "off" | "throw";
const UNREADABLE_WORDS = "This company's settings could not be read. Try again.";
const GATE_FAILURE = Symbol.for("rovara.featureRollout.gateReadFailed");

/** What `onReadFailure: "throw"` throws for a failed read: the temporary AWS error itself (marked), or RUNTIME_UNAVAILABLE in fixed words. */
function gateReadError(error: unknown): unknown {
  if (isTemporaryAwsError(error)) {
    Object.defineProperty(error, GATE_FAILURE, { value: true, enumerable: false });
    return error;
  }
  return agentXError("RUNTIME_UNAVAILABLE", UNREADABLE_WORDS);
}

/** Whether an error is the one a gate read that failed gives with `onReadFailure: "throw"` (so a caller can let it through to its retry instead of treating it as its own failure). */
export const isGateUnavailable = (error: unknown): boolean => typeof error === "object" && error !== null
  && ((error as Record<symbol, unknown>)[GATE_FAILURE] === true || ((error as { code?: unknown }).code === "RUNTIME_UNAVAILABLE" && typeof (error as { message?: unknown }).message === "string" && (error as Error).message.endsWith(UNREADABLE_WORDS)));

/**
 * The environment a company's code reads its install switches from: every gated variable that is not on for this company is "0". Nothing is read when the install has none of them on. No company turns every gated variable off.
 * A read that fails does what `onReadFailure` says: "off" (the default), "throw" (RUNTIME_UNAVAILABLE) or "default" (the catalog default). The environment given is not changed.
 */
export async function companyGatedEnv(deps: FeatureRolloutDeps, orgId: OrgId | undefined, env: NodeJS.ProcessEnv = process.env, options: { onReadFailure?: GateReadFailure } = {}): Promise<NodeJS.ProcessEnv> {
  const installOn = GATED_VARIABLES.filter(([, variable]) => liveInteractionFlagOn(env[variable]));
  if (installOn.length === 0) return env;
  let settings: FeatureRolloutSettings | undefined;
  if (orgId !== undefined) {
    try { settings = await readFeatureRollout(deps, orgId); }
    catch (error) {
      logDeveloperEvent({ event: "developer.feature_rollout_read_failed" });
      if (options.onReadFailure === "throw") throw gateReadError(error);
    }
  }
  const gated: NodeJS.ProcessEnv = { ...env };
  for (const [name, variable] of installOn) {
    // A failed read (with "off") or no company at all: nothing is on.
    const on = settings !== undefined && rolloutGateOn(name, settings.gates[name]);
    if (!on) gated[variable] = "0";
  }
  return gated;
}

/**
 * The environment of a request whose gate read failed: reading a gated switch (`PROOF_EVIDENCE_ENABLED`, `VERIFY_RESULTS_ENABLED`, `TEST_ENVIRONMENT_ENABLED`, `TEST_SERVICES_ENABLED`) throws RUNTIME_UNAVAILABLE (a 503) and logs one counter
 * line (`developer.feature_rollout_unavailable`, the gate's name, nothing else); every other variable reads as it did, and a spread of it is safe. So a gated route fails instead of guessing a company's choice, and a route that
 * reads no gated switch is untouched.
 */
export function unavailableEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gateOf = new Map<string, RolloutFeatureName>(GATED_VARIABLES.map(([name, variable]) => [variable, name]));
  const rest: NodeJS.ProcessEnv = { ...env };
  for (const variable of gateOf.keys()) delete rest[variable];
  return new Proxy(rest, {
    get(target, property) {
      const gate = typeof property === "string" ? gateOf.get(property) : undefined;
      if (gate === undefined) return Reflect.get(target, property) as string | undefined;
      logDeveloperEvent({ event: "developer.feature_rollout_unavailable", gate });
      throw agentXError("RUNTIME_UNAVAILABLE", UNREADABLE_WORDS);
    },
  });
}

/** The environment a route reads its install switches from: the one the request was given (the caller's company's, `companyGatedEnv`), else the process's. */
export const routeEnvOf = (deps: { env?: NodeJS.ProcessEnv | undefined }): NodeJS.ProcessEnv => deps.env ?? process.env;

/** Whether one feature is on for one company: the install's switch exactly "1" AND the company's gate on. No company, or a failed read, is off. */
export async function companyFeatureOn(deps: FeatureRolloutDeps, orgId: OrgId | undefined, name: RolloutFeatureName, env: NodeJS.ProcessEnv = process.env, options: { onReadFailure?: GateReadFailure } = {}): Promise<boolean> {
  if (orgId === undefined || !installSwitchOn(name, env)) return false;
  try { return rolloutGateOn(name, (await readFeatureRollout(deps, orgId)).gates[name]); }
  catch (error) {
    logDeveloperEvent({ event: "developer.feature_rollout_read_failed" });
    if (options.onReadFailure === "throw") throw gateReadError(error);
    return false;
  }
}

/** The answer of the admin route: every gate with the company's choice and whether the install's switch lets it take effect. */
export function adminAnswerOf(settings: FeatureRolloutSettings, env: Record<string, string | undefined> = process.env): FeatureRolloutAnswer {
  return {
    revision: settings.revision,
    features: ROLLOUT_FEATURE_CATALOG.map((entry) => ({ name: entry.name, label: entry.label, summary: entry.summary, wired: entry.wired, enabled: rolloutGateOn(entry.name, settings.gates[entry.name]), installOn: installSwitchOn(entry.name, env) })),
    ...(settings.changedAt === undefined ? {} : { changedAt: settings.changedAt }),
  };
}

/** `true` or `false` stores the company's choice for that gate; null removes its stored choice (back to the default); absent leaves it as it is. */
export type FeatureRolloutChange = Readonly<Partial<Record<RolloutFeatureName, boolean | null | undefined>>>;

/**
 * Writes a change. `expectedRevision` is what the caller read (0 while there is no record): the write is conditioned on it, so a stale one is CHANGE_STALE. The audit event goes in the SAME transaction; with no ledger the change is
 * refused (AUDIT_UNAVAILABLE). Writing the value already in force still moves the revision, so a double click is never a change the audit cannot see. The row is keyed by the caller's checked company only.
 */
export async function writeFeatureRollout(deps: FeatureRolloutDeps, input: { orgId: OrgId; developerId: string; expectedRevision: number; change: FeatureRolloutChange }): Promise<FeatureRolloutSettings> {
  const current = await readFeatureRolloutFresh(deps, input.orgId);
  if (current.revision !== input.expectedRevision) throw agentXError("CHANGE_STALE", "Someone else changed this. Reload and try again.");
  const gates: Partial<Record<RolloutFeatureName, boolean>> = current.unreadable === true ? {} : { ...current.gates };
  for (const name of current.malformed ?? []) delete gates[name];
  for (const name of ROLLOUT_FEATURE_NAMES) {
    const wanted = input.change[name];
    if (wanted === null) delete gates[name];
    else if (wanted !== undefined) gates[name] = wanted;
  }
  const turnedOn = ROLLOUT_FEATURE_NAMES.filter((name) => !rolloutGateOn(name, current.gates[name]) && rolloutGateOn(name, gates[name]));
  const turnedOff = ROLLOUT_FEATURE_NAMES.filter((name) => rolloutGateOn(name, current.gates[name]) && !rolloutGateOn(name, gates[name]));
  const revision = current.revision + 1;
  const at = new Date(deps.now()).toISOString();
  const event: AuditEventInput = auditCompanyFeatureRolloutChanged({
    orgId: input.orgId, actor: auditActorOf(input.developerId), occurredAt: at, occurrence: auditOccurrence(input.orgId, String(revision), at), revision, turnedOn, turnedOff,
  });
  const pending = deps.audit === undefined ? undefined : auditPending({ audit: deps.audit }, event)[0]?.Put;
  if (pending === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
  const write = {
    Update: {
      TableName: deps.tableName, Key: orgFeatureRolloutKey(input.orgId),
      // Update, not Put: a field a newer writer added stays.
      UpdateExpression: "SET entityType = :type, orgId = :org, #gates = :gates, #revision = :next, changedAt = :at, changedBy = :by",
      // The fence holds the revision the caller read. Revision 0 is "no usable row": no row, a row with no revision, or a row whose stored revision is malformed, which is replaced only while that same raw value is still stored.
      ConditionExpression: input.expectedRevision !== 0 ? "#revision = :expected" : current.unreadableRevision === undefined ? "attribute_not_exists(pk) OR attribute_not_exists(#revision)" : "#revision = :raw",
      ExpressionAttributeNames: { "#gates": "gates", "#revision": "revision" },
      ExpressionAttributeValues: { ":type": "FEATURE_ROLLOUT", ":org": input.orgId, ":gates": gates, ":next": revision, ":at": at, ":by": input.developerId, ...(input.expectedRevision !== 0 ? { ":expected": input.expectedRevision } : current.unreadableRevision === undefined ? {} : { ":raw": current.unreadableRevision.value }) },
    },
  };
  try { await send(deps, new TransactWriteCommand({ TransactItems: [write, { Put: pending }] })); }
  catch (error) {
    if (isCancellation(error)) throw agentXError("CHANGE_STALE", "Someone else changed this. Reload and try again.");
    throw error;
  }
  await flushAuditEvents(deps.audit === undefined ? {} : { audit: deps.audit }, [event]);
  return { gates, revision, changedAt: at };
}

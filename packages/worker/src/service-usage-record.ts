// The usage record of a run's test services (test services, slice 1, s1-sealed T1; design test-services.md 8.1 and 12; deferred check TS-SEAL-1). What the worker reports after a round: for each dependency whether it was
// started and answers, how long it took and how many times it was put back; and what the program tried to reach that nobody listed, as a registrable domain and a count.
//
// WHY UNKNOWN NAMES ARE REDUCED (TS-SEAL-1): the sealed name server records every name the program asked for, and the program chooses that text. The run's connection variables hold secrets (a per-run password), so a
// program that read one can ask for `<password>.attacker.test`, and the name server stores it lower-cased. A person reading the record, or the evidence pack that carries it, must never see that name. This module
// therefore NEVER passes a name on. For each recorded name it:
//   1. withholds the name when the case-insensitive service redactor changes it, or changes it once its separators (`.`, `-`, `_`) are removed or it is upper-cased: a secret split over labels is still a secret, and the
//      part of it that falls in the registrable domain would show;
//   2. otherwise keeps only the registrable domain (the public suffix plus one label, `registrableDomain` of the contracts' public suffix list), and withholds that too when the redactor changes it, when it is not a host
//      the contract accepts (`hostProblem`), or when it looks like a key in either case (`looksLikeSecretValue`);
//   3. adds the counts up per registrable domain and keeps at most USAGE_UNKNOWN_DOMAINS_MAX of them, most asked first. Everything else (single-label names, withheld names, the rest over the cap, the name server's own
//      `dropped` and `unrecorded` counts) is added to `otherCount`, which names nothing.
// Residual, accepted: a program that wants to leak a value can still encode it in WHICH registrable domains it asks for (a handful of short domains); a per-run password of a database that is removed when the run ends is
// not worth more than that, and the cap bounds it.
//
// The record's shape is the broker contract's `TestServicesUsageRecordSchema` (contracts/src/test-services-usage.ts, s1-broker T1) field for field. s1-broker had not landed when this was written, so the types below are
// local copies; once it is merged, replace them with the contract's types and parse the record with the schema in the tests (the limits here are the schema's).
import { hostProblem, looksLikeSecretValue, registrableDomain } from "@agentx/contracts";
import { readSealedDnsRecord, type SealedDnsRecord } from "./check-sandbox.js";
import type { ServiceRedactor } from "./service-env.js";
import type { ResetOutcome, ServiceSession } from "./service-runner.js";
import type { DockerCli } from "./swebench/containers.js";

/** The schema version of the record (the contract's `TEST_SERVICES_USAGE_SCHEMA_VERSION`). */
export const USAGE_SCHEMA_VERSION = 1;
/** The contract's limits (`TEST_SERVICES_USAGE_LIMITS`). */
export const USAGE_LIMITS = { dependencies: 16, unknownDomains: 50, count: 1_000_000_000, startMs: 86_400_000, resets: 100_000 } as const;
/** The most registrable domains one record names. */
export const USAGE_UNKNOWN_DOMAINS_MAX = USAGE_LIMITS.unknownDomains;
/** The longest wait for one dependency's health question when the record is built. */
export const USAGE_HEALTH_LIMIT_MS = 5_000;

/** Why a dependency is not healthy, or failed after it was: fixed words (the contract's `TEST_SERVICES_START_FAILURES`). */
export type UsageFailure = "pull_failed" | "start_failed" | "not_healthy" | "seed_failed" | "reset_failed";

export interface DependencyUsageRecord {
  /** The dependency's id (the plan's, never a secret). */
  id: string;
  /** A helper for it was started in this run. */
  started: boolean;
  /** It answered its health question when the record was built. False when it was not started, when it did not answer in time, and when the session was already stopped. */
  healthy: boolean;
  /** Milliseconds the run's helpers took to become healthy (the launcher starts them level by level and does not time them one by one, so a run with several dependencies reports the whole start for each, unless the caller timed them). 0 when not started. */
  startMs: number;
  /** How many times a successful `reset` put it back during the run. 0 when not started. */
  resetCount: number;
  /** Present when it is not healthy (the caller's word, else `start_failed` for one never started and `not_healthy` for one that did not answer), and for a healthy one only `seed_failed` or `reset_failed`. */
  failure?: UsageFailure;
}

export interface UnknownDomainCount {
  /** The public suffix plus one label (`attacker.test`). Never a full name, never anything the redactor changes, always a host the contract accepts. */
  domain: string;
  /** How many address lookups of names under it the sealed name server counted. At least 1. */
  count: number;
}

export interface UnknownCalls {
  /** Names nobody listed that the program tried to reach, most asked first, at most USAGE_UNKNOWN_DOMAINS_MAX. */
  domains: UnknownDomainCount[];
  /** Lookups the record cannot name: single-label names, withheld names, domains over the cap, and the name server's own `dropped` and `unrecorded` counts. */
  otherCount: number;
}

export interface ServiceUsageRecord {
  schemaVersion: typeof USAGE_SCHEMA_VERSION;
  dependencies: DependencyUsageRecord[];
  unknownCalls: UnknownCalls;
}

export interface ServiceUsageRecordInput {
  /** The dependency ids the task's plan named, in order (at most USAGE_LIMITS.dependencies are recorded). One with no helper in the session is `started: false`. */
  planned: readonly string[];
  /** The run's session. Absent when the run's start failed: then nothing is `started`. */
  session?: Pick<ServiceSession, "helpers" | "probe">;
  /** Milliseconds each dependency took to start, by id, or one number for the whole start. Absent: 0. */
  startMs?: ReadonlyMap<string, number> | number;
  /** Successful resets by id (`countResets` gives them). Absent: 0. */
  resetCounts?: ReadonlyMap<string, number>;
  /** What the caller knows went wrong, by id (a seed that failed, an image that did not pull). Used for a dependency that is not healthy, and for a healthy one only when it is `seed_failed` or `reset_failed`. */
  failures?: ReadonlyMap<string, UsageFailure>;
  /** The sealed name server's record, as `readSealedDnsRecord` returned it, or where to read it. Absent: the round had no sealed name server, so no names. */
  dns?: SealedDnsRecord | { docker: DockerCli; dnsHelperName: string };
  /** The run's redactor (`createServiceRedactor(helperSecretValues(...))`). Required: a record is never built without one. */
  redactor: ServiceRedactor;
  healthLimitMs?: number;
}

const clamp = (value: number | undefined, max: number): number => (value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : 0);

/**
 * True when the text is safe to show: the redactor leaves it alone as it is, with its separators taken out (a secret split over labels), and in upper case (the name server lower-cases what it records, and the
 * contracts' general credential rule, an AWS key id for one, is case-sensitive).
 */
function isShowable(text: string, redactor: ServiceRedactor): boolean {
  const joined = text.replace(/[._-]/gu, "");
  return [text, joined, text.toUpperCase(), joined.toUpperCase()].every((form) => redactor.text(form) === form);
}

/** A registrable domain that may be shown: showable, a host the contract accepts, and not shaped like a key in either case. */
function isShowableDomain(domain: string, redactor: ServiceRedactor): boolean {
  return isShowable(domain, redactor) && hostProblem(domain) === undefined && !looksLikeSecretValue(domain) && !looksLikeSecretValue(domain.toUpperCase());
}

/** The registrable domains of the recorded names with their counts, and how many lookups could not be named (TS-SEAL-1: see the top of the file). */
export function reduceUnknownNames(record: SealedDnsRecord, redactor: ServiceRedactor): UnknownCalls {
  const counts = new Map<string, number>();
  let other = clamp(record.dropped, USAGE_LIMITS.count) + clamp(record.unrecorded, USAGE_LIMITS.count);
  for (const row of record.unknown) {
    const queries = clamp(row.queries, USAGE_LIMITS.count);
    if (queries === 0) continue;
    const name = row.name.toLowerCase();
    const domain = isShowable(name, redactor) ? registrableDomain(name) : undefined;
    if (domain === undefined || !isShowableDomain(domain, redactor)) {
      other += queries;
      continue;
    }
    counts.set(domain, (counts.get(domain) ?? 0) + queries);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [, count] of ranked.slice(USAGE_UNKNOWN_DOMAINS_MAX)) other += count;
  return {
    domains: ranked.slice(0, USAGE_UNKNOWN_DOMAINS_MAX).map(([domain, count]) => ({ domain, count: Math.min(count, USAGE_LIMITS.count) })),
    otherCount: Math.min(other, USAGE_LIMITS.count),
  };
}

/**
 * Builds the record. Never throws for a dependency that cannot be asked (it is `healthy: false`) or a name server that cannot be read (no names). Call it while the run's services are still up: the health question
 * and the name server's file are both read now.
 */
export async function buildServiceUsageRecord(input: ServiceUsageRecordInput): Promise<ServiceUsageRecord> {
  const started = new Set((input.session?.helpers ?? []).map((helper) => helper.id));
  const limit = input.healthLimitMs ?? USAGE_HEALTH_LIMIT_MS;
  const startMsOf = (id: string): number => clamp(typeof input.startMs === "number" ? input.startMs : input.startMs?.get(id), USAGE_LIMITS.startMs);
  const dependencies: DependencyUsageRecord[] = [];
  for (const id of input.planned.slice(0, USAGE_LIMITS.dependencies)) {
    const isStarted = started.has(id);
    const healthy = isStarted && input.session !== undefined ? await input.session.probe(id, limit).then((answer) => answer === true, () => false) : false;
    const told = input.failures?.get(id);
    const failure: UsageFailure | undefined = healthy ? (told === "seed_failed" || told === "reset_failed" ? told : undefined) : told ?? (isStarted ? "not_healthy" : "start_failed");
    dependencies.push({
      id, started: isStarted, healthy,
      startMs: isStarted ? startMsOf(id) : 0,
      resetCount: isStarted ? clamp(input.resetCounts?.get(id), USAGE_LIMITS.resets) : 0,
      ...(failure === undefined ? {} : { failure }),
    });
  }
  const dns = input.dns === undefined ? undefined : "unknown" in input.dns ? input.dns : await readSealedDnsRecord(input.dns.docker, input.dns.dnsHelperName).catch(() => undefined);
  return { schemaVersion: USAGE_SCHEMA_VERSION, dependencies, unknownCalls: dns === undefined ? { domains: [], otherCount: 0 } : reduceUnknownNames(dns, input.redactor) };
}

/**
 * Counts the resets a run does: the returned session is the given one with `reset` wrapped, and `resets` holds the successful ones by dependency id. Hand the returned session to `seedRun`, `freshHelpers` and
 * `resetForNextCheck` (service-reset.ts), and `resets` to `buildServiceUsageRecord`. A reset that throws is not counted.
 */
export function countResets<S extends Pick<ServiceSession, "reset">>(session: S): { session: S; resets: ReadonlyMap<string, number> } {
  const resets = new Map<string, number>();
  const counted = Object.create(session, {
    reset: {
      value: async (id: string, signal?: AbortSignal): Promise<ResetOutcome> => {
        const outcome = await session.reset(id, signal);
        resets.set(id, (resets.get(id) ?? 0) + 1);
        return outcome;
      },
    },
  }) as S;
  return { session: counted, resets };
}

// Company domain verification: the lookup of the verification record. The broker asks the DNS the install already uses (Node's resolver, which on Lambda is the VPC resolver) for two things about one
// name, `_rovara-verify.<domain>`: whether it is an alias (CNAME), and its TXT records. It never follows an alias to another host (a record behind a CNAME is "indirect", not read), never asks
// for any other name, and is bounded twice: the resolver's own timeout and tries, and a deadline over the whole lookup after which it is cancelled.
//
// A lookup that fails (timeout, server failure, refusal) is "unavailable". It is never "absent": a flaky name server must not start the clock that makes a domain lost.
import { Resolver } from "node:dns/promises";
import { COMPANY_DOMAIN_RECORD_LABEL } from "@agentx/cloud-contracts";
import { normalizeCompanyDomain } from "./normalize.js";

export type TxtLookup =
  | { kind: "records"; records: readonly string[] }
  /** The name does not exist or has no TXT data. */
  | { kind: "absent" }
  /** The name is an alias; the record must be on the name itself. */
  | { kind: "indirect" }
  /** The lookup itself failed. */
  | { kind: "unavailable" };

export interface TxtResolver {
  /** `name` must be exactly `verificationRecordName(domain)` for a normalised domain. */
  lookupTxt(name: string): Promise<TxtLookup>;
}

/** The part of Node's resolver this uses (so a test can stand in for the network). */
export interface DnsClient {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  cancel(): void;
}

export const verificationRecordName = (domain: string): string => `${COMPANY_DOMAIN_RECORD_LABEL}.${domain}`;

/** Each query waits this long for a server, and tries this many times: a lookup is at most about 4 seconds a query. */
const QUERY_TIMEOUT_MS = 2_000;
const QUERY_TRIES = 2;
/** The whole lookup (both queries) is cancelled after this long. */
const DEADLINE_MS = 6_000;
const MAX_RECORDS = 50;
const MAX_RECORD_CHARS = 1_024;
const ABSENT_CODES = new Set(["ENODATA", "ENOTFOUND"]);

const codeOf = (error: unknown): string | undefined => (typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined);

/** True when `name` is exactly `_rovara-verify.` and a domain that is already in its normalised form. */
function isRecordName(name: string): boolean {
  const prefix = `${COMPANY_DOMAIN_RECORD_LABEL}.`;
  if (!name.startsWith(prefix)) return false;
  const domain = name.slice(prefix.length);
  const normalised = normalizeCompanyDomain(domain);
  return normalised.ok && normalised.domain === domain;
}

export function nodeTxtResolver(options: { make?: () => DnsClient; deadlineMs?: number } = {}): TxtResolver {
  const make = options.make ?? ((): DnsClient => new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: QUERY_TRIES }));
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
  return {
    async lookupTxt(name) {
      if (!isRecordName(name)) throw new Error("lookupTxt: not a verification record name");
      const dns = make();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<TxtLookup>((resolve) => {
        timer = setTimeout(() => {
          try { dns.cancel(); } catch { /* the lookup is over either way */ }
          resolve({ kind: "unavailable" });
        }, deadlineMs);
      });
      const look = async (): Promise<TxtLookup> => {
        try {
          const aliases = await dns.resolveCname(name);
          if (aliases.length > 0) return { kind: "indirect" };
        } catch (error) {
          const code = codeOf(error);
          if (code === undefined || !ABSENT_CODES.has(code)) return { kind: "unavailable" };
        }
        try {
          const chunks = await dns.resolveTxt(name);
          const records = chunks.slice(0, MAX_RECORDS).map((parts) => parts.join("").slice(0, MAX_RECORD_CHARS));
          return records.length === 0 ? { kind: "absent" } : { kind: "records", records };
        } catch (error) {
          const code = codeOf(error);
          return code !== undefined && ABSENT_CODES.has(code) ? { kind: "absent" } : { kind: "unavailable" };
        }
      };
      try {
        return await Promise.race([look(), expired]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

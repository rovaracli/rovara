// Company domain verification (owner decision 2026-11-02): one stored form for a domain, and no form that could stand for somebody else's name.
//
// A domain is stored in ASCII (punycode for an international name), lower-case, without a trailing dot. It is refused when it is
//   - not a host name at all (a scheme, path, port, user, wildcard, space, underscore, empty label, a label of 64 characters or more, a name of more than 253);
//   - an IP address in any spelling (dotted, short, hex, decimal, IPv6);
//   - a public suffix (`com`, `co.uk`, `github.io`) or a single label: a whole registry is nobody's company;
//   - a lookalike: typed in a form the standard maps to a different name (fullwidth letters, a dotted capital I), or with a label that mixes
//     Latin, Cyrillic, Greek, Armenian or Cherokee letters (the classic homograph).
// An all-Cyrillic copy of a Latin name cannot be told from the real one by script alone; it is a different domain (a different punycode), so it is held to its own DNS and never matches the real one.
import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";
import { isPublicSuffix } from "@rovara-code/contracts";

export type DomainRefusal = "not_a_name" | "ip_address" | "public_suffix" | "lookalike";
export type NormalizedDomain = { ok: true; domain: string } | { ok: false; reason: DomainRefusal };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_NAME = 253;
/** Anything a host name cannot hold, or that turns a name into a URL or address (the standard's URL parser would let `a.com/x` through as `a.com`). */
const NOT_NAME_CHARACTER = /[\s\p{Cc}\\/:@?#*_%[\]()<>"'`,;=+!$&^|{}~]/u;
const CONFUSABLE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u, /\p{Script=Armenian}/u, /\p{Script=Cherokee}/u] as const;

const refuse = (reason: DomainRefusal): NormalizedDomain => ({ ok: false, reason });

/** A last label that an address parser would read as a number (`4`, `0x7f`): so the whole name is an address, not a name. */
const looksNumeric = (label: string): boolean => /^(?:\d+|0x[0-9a-f]*)$/u.test(label);

const mixesScripts = (label: string): boolean => CONFUSABLE_SCRIPTS.filter((script) => script.test(label)).length > 1;
/** A Latin letter with a combining mark the standard form could not compose (`i` and a dot above, from a dotted capital I): no real name is spelled so. */
const strayMark = (label: string): boolean => /\p{M}/u.test(label) && /\p{Script=Latin}/u.test(label);

export function normalizeCompanyDomain(input: string): NormalizedDomain {
  if (typeof input !== "string") return refuse("not_a_name");
  let text = input.trim();
  if (text.endsWith(".")) text = text.slice(0, -1);
  if (text === "") return refuse("not_a_name");
  // An address is told apart first: `[::1]` and `::1` hold characters a name cannot, and are still an address, not "not a name".
  const unbracketed = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  if (isIP(unbracketed) !== 0) return refuse("ip_address");
  if (NOT_NAME_CHARACTER.test(text)) return refuse("not_a_name");

  const ascii = [...text].every((character) => character.charCodeAt(0) < 0x80);
  const typed = ascii ? text.toLowerCase() : text.normalize("NFC").toLowerCase();
  const stored = ascii ? typed : domainToASCII(typed);
  if (stored === "" || stored.length > MAX_NAME) return refuse("not_a_name");
  const labels = stored.split(".");
  if (!labels.every((label) => LABEL.test(label))) return refuse("not_a_name");
  // `xx--` in the third and fourth places is reserved; only the punycode prefix is real, and it must decode.
  if (labels.some((label) => label.slice(2, 4) === "--" && !label.startsWith("xn--"))) return refuse("not_a_name");
  const shown = domainToUnicode(stored);
  if (labels.some((label) => label.startsWith("xn--")) && (shown === "" || shown === stored)) return refuse("not_a_name");
  // What was typed must be the name that is stored: a different Unicode form that maps onto it (fullwidth letters) is a lookalike. (The sharp s is a letter of its own in the current standard: `faß.de` is not `fass.de`.)
  if (!ascii && shown !== typed) return refuse("lookalike");
  if (shown.split(".").some((label) => mixesScripts(label) || strayMark(label))) return refuse("lookalike");

  if (looksNumeric(labels[labels.length - 1]!)) return refuse("ip_address");
  if (labels.length < 2) return refuse(isPublicSuffix(stored) ? "public_suffix" : "not_a_name");
  if (isPublicSuffix(stored)) return refuse("public_suffix");
  return { ok: true, domain: stored };
}

/**
 * The domain of a sign-in address (the part after its last `@`), normalised; or of a bare domain when it has no `@`. Undefined when there is none or it is one of the refused forms:
 * a person at a lookalike or an address's domain never counts as a company's.
 */
export function normalizeEmailDomain(emailOrDomain: string): string | undefined {
  if (typeof emailOrDomain !== "string") return undefined;
  const at = emailOrDomain.lastIndexOf("@");
  const part = at === -1 ? emailOrDomain : emailOrDomain.slice(at + 1);
  const result = normalizeCompanyDomain(part);
  return result.ok ? result.domain : undefined;
}

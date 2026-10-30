// Learning v2 text guards (controls C6, C7, C12). Pure code: what a lesson may never ask for, and what always sends a lesson to two people.
import { cleanLessonText, redactText } from "@agentx/contracts";

/** Free text from a person or a system, made safe for a model and for storage: secrets redacted, hidden characters and markup removed, bounded. */
export function cleanForLearning(text: string, maxChars: number): string {
  return cleanLessonText(redactText(text), maxChars);
}

/**
 * Text that asks for a change to tools, permissions, domains, budgets, models, approvals or checks' authority. A lesson is advice: it has no field for
 * these and its text may not request them either (P8). Matching is broad on purpose; a refused lesson only costs a person a re-word.
 */
const CAPABILITY_REQUESTS: readonly RegExp[] = [
  /\b(grant|give|enable|allow|add|unlock|permit)\b[^.\n]{0,40}\b(tools?|permissions?|access|domains?|hosts?|websites?|network|egress|commands?|shell|credentials?|secrets?)\b/iu,
  /\b(allowed?\s*domains?|allowedDomains|allow-?list|egress)\b/iu,
  /\b(increase|raise|lift|remove|bump|change|set)\b[^.\n]{0,30}\b(budget|spend(ing)?\s*(limit|cap)|limit|cap|quota)\b/iu,
  /\b(change|switch|use|swap|pick)\b[^.\n]{0,20}\b(the\s+)?(model|models)\b/iu,
  /\b(auto-?approve|approve\s+automatically|without\s+(an?\s+)?approval|skip\s+(the\s+)?approvals?|bypass\s+(the\s+)?approvals?|no\s+approval\s+needed)\b/iu,
  /\b(run|execute)\b[^.\n]{0,20}\b(any|arbitrary|unrestricted)\b[^.\n]{0,20}\bcommands?\b/iu,
  /^\s*(tools|grants|commands|allowedDomains|permissions|allowed-tools)\s*:/imu,
];
export function requestsCapabilityChange(...texts: readonly string[]): boolean {
  return texts.some((text) => CAPABILITY_REQUESTS.some((pattern) => pattern.test(text)));
}

/**
 * Words that put a lesson in front of two people (tier 2): tests, checks, CI, coverage, security, auth, secrets, permissions, dependencies, network or
 * domains, skipping or disabling anything, and approvals. Over-escalation is accepted in the pilot (design Q12); the word list is reviewed weekly.
 */
const ESCALATION: readonly RegExp[] = [
  /\b(tests?|testing|test\s+suites?|unit\s+tests?|integration\s+tests?|e2e|flaky|coverage|assert(ion)?s?|mock(s|ing)?)\b/iu,
  /\b(checks?|checking|ci|pipelines?|lint(er|ing)?|typecheck(ing)?|build\s+gates?|gates?)\b/iu,
  /\b(security|secure|auth|authn|authz|authentication|authorization|authori[sz]e[sd]?|secrets?|credentials?|tokens?|passwords?|api[-\s]?keys?|encrypt\w*|crypto\w*|tls|ssl|certificates?|verify\s*=\s*false|sandbox(es|ed)?|vulnerab\w*|cve)\b/iu,
  /\b(permissions?|privileges?|roles?|iam|acl|access\s+control|admin)\b/iu,
  /\b(dependenc(y|ies)|packages?\s+versions?|lockfiles?|upgrade|downgrade|npm|pip|supply\s+chain)\b/iu,
  /\b(network|domains?|hosts?|egress|firewall|proxy|proxies|urls?|endpoints?\s+allow)\b/iu,
  /\b(skip(s|ped|ping)?|disabl(e|es|ed|ing)|bypass(es|ed|ing)?|ignor(e|es|ed|ing)|turn(s|ed|ing)?\s+off|suppress(es|ed|ing)?|no\s+need\s+to|needn'?t|don'?t\s+(need|have)\s+to|override|workaround)\b/iu,
  /\b(approv\w*|reviewers?|code\s+review|sign-?offs?|rubber-?stamp\w*)\b/iu,
];
export function hasEscalationWords(...texts: readonly string[]): boolean {
  return texts.some((text) => ESCALATION.some((pattern) => pattern.test(text)));
}

/** Words that flip a rule's direction, for the curator's "opposite polarity" check. */
const POSITIVE = /\b(always|must|use|prefer|do|enable|require|add|keep)\b/iu;
const NEGATIVE = /\b(never|avoid|don'?t|do\s+not|must\s+not|disable|remove|stop|without|instead\s+of)\b/iu;
export function polarity(text: string): "positive" | "negative" | "none" {
  // A negation anywhere flips the direction of the advice ("never use X" contains "use"), so it wins.
  return NEGATIVE.test(text) ? "negative" : POSITIVE.test(text) ? "positive" : "none";
}
/** True when exactly one of two texts carries a negation, so that a high embedding similarity cannot be trusted to mean "the same advice". */
export function oppositePolarity(a: string, b: string): boolean {
  return (polarity(a) === "negative") !== (polarity(b) === "negative");
}

/** A quoted, forwarded or pasted block inside a person's text carries the trust of its author, which is unknown here: treat it as an outsider's (C3). */
const QUOTED: readonly RegExp[] = [
  /^\s*>/mu, /(^|\n)\s*-{2,}\s*(original|forwarded)\s+message/iu, /\bforwarded\s+message\b/iu, /(^|\n)\s*(from|sent|to|subject)\s*:.*\n\s*(from|sent|to|subject|date)\s*:/iu,
  /\b(they|he|she|someone|\w+)\s+(said|wrote|asked)\s*:\s*["“]/iu, /\bfwd?:\s/iu,
];
export function looksQuoted(text: string): boolean {
  return QUOTED.some((pattern) => pattern.test(text));
}

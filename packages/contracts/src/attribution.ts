// Enterprise foundations, task I3: who a change was made for. Rovara writes to a code host as a service identity the customer owns; a person's own account is not
// the author. So every write says whose request it was and who approved the plan: a trailer on the commit, and lines in the change request's description.
//
// What this carries is what the company already shows its people: a display name (never an email address) and a short reference to the person (the first 16
// characters of the Rovara person id, enough to find them in the audit log, not the id itself). Nothing here comes from the host, a model or a request body: the
// broker builds it from its own records (`broker/src/attribution`), and a person who has been erased, or has left, is never named: the line says "a former member".
//
// The text is built here, once, so that the commit and the description say the same thing and a forged line cannot pass as Rovara's: `withAttributionTrailers`
// removes any reserved trailer a message already carries before it adds the real ones.
import { z } from "zod";

/** A name as it is written to a host: letters, marks, digits, spaces and . , ' - only. No markup, mention, link, address, quote, newline or control character can be in it. */
const NAME = /^[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N} .,'’-]{0,78}[\p{L}\p{M}\p{N}.])?$/u;
export const ATTRIBUTION_NAME_MAX = 80;
/** The reference to a person: the first 16 characters of the Rovara person id. */
export const ATTRIBUTION_REF_LENGTH = 16;

export const AttributionPersonSchema = z.union([
  z.object({
    state: z.literal("named"),
    name: z.string().min(1).max(ATTRIBUTION_NAME_MAX).regex(NAME).refine((name) => !/ {2}/u.test(name), "one space between words"),
    ref: z.string().regex(/^[a-f0-9]{16}$/u),
  }).strict(),
  // A person who has been erased, or is no longer a member, or whose record could not be read: no name, no reference.
  z.object({ state: z.literal("former") }).strict(),
]);
export type AttributionPerson = z.infer<typeof AttributionPersonSchema>;

export const ActingAttributionSchema = z.object({
  /** Whose request the work was. Absent when no member asked (an automatic run). */
  requester: AttributionPersonSchema.optional(),
  /** Who approved the plan. Absent when no person did. */
  approver: AttributionPersonSchema.optional(),
  /** Where an authorized person finds the audit record of this change. https only, no credentials. */
  auditUrl: z.string().max(2_048).refine((value) => {
    try { const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === ""; } catch { return false; }
  }, "an https link without credentials").optional(),
}).strict();
export type ActingAttribution = z.infer<typeof ActingAttributionSchema>;

/** The reserved trailer tokens. A message never keeps one of these from anywhere but Rovara. */
export const ATTRIBUTION_TRAILER_TOKENS = ["Requested-by", "Approved-by"] as const;

const FORMER = "a former member";
const personText = (person: AttributionPerson): string => (person.state === "named" ? `${person.name} (rovara-person ${person.ref})` : FORMER);
const personName = (person: AttributionPerson): string => (person.state === "named" ? person.name : FORMER);

/** The trailer lines, `Requested-by` first. Empty when the attribution names no one. The value is checked again here, so a hand-built object cannot carry a forged line. */
export function attributionTrailers(attribution: ActingAttribution): string[] {
  const checked = ActingAttributionSchema.parse(attribution);
  return [
    ...(checked.requester === undefined ? [] : [`Requested-by: ${personText(checked.requester)}`]),
    ...(checked.approver === undefined ? [] : [`Approved-by: ${personText(checked.approver)}`]),
  ];
}

const RESERVED = new RegExp(`^(?:${ATTRIBUTION_TRAILER_TOKENS.join("|")})\\s*:`, "iu");
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*\s*:\s/u;

/**
 * The commit message with the attribution trailers at its end, in the message's own trailer block when it ends with one (git's rule: the last paragraph, every line a trailer).
 * Any line that already claims a reserved trailer is removed first, so a title or a model's text cannot pose as the requester. Idempotent. No attribution: the message as it was.
 */
export function withAttributionTrailers(message: string, attribution: ActingAttribution | undefined): string {
  if (attribution === undefined) return message;
  const trailers = attributionTrailers(attribution);
  if (trailers.length === 0) return message;
  const kept = message.replace(/\r\n?/gu, "\n").split("\n").filter((line) => !RESERVED.test(line.trimStart()));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  const lastBreak = kept.lastIndexOf("");
  const lastParagraph = kept.slice(lastBreak + 1);
  const endsWithTrailers = lastBreak > 0 && lastParagraph.length > 0 && lastParagraph.every((line) => TRAILER_LINE.test(line));
  return `${[...kept, ...(endsWithTrailers || kept.length === 0 ? [] : [""]), ...trailers].join("\n")}\n`;
}

/** The lines for the change request's description: who asked, who approved the plan, where the audit record is. Empty when the attribution names no one. */
export function attributionBodyLines(attribution: ActingAttribution | undefined): string[] {
  if (attribution === undefined) return [];
  const checked = ActingAttributionSchema.parse(attribution);
  if (checked.requester === undefined && checked.approver === undefined) return [];
  return [
    ...(checked.requester === undefined ? [] : [`Requested by: ${personName(checked.requester)}`]),
    ...(checked.approver === undefined ? [] : [`Plan approved by: ${personName(checked.approver)}`]),
    ...(checked.auditUrl === undefined ? [] : [`Audit record: ${checked.auditUrl}`]),
  ];
}

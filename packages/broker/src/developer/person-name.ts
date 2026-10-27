// Release 0.4.16: a person's email is never their name to anyone else. The email-code ("cloud") sign-in has no name for a person and the provider
// falls back to their address; every name that is shown to another person goes through here first. A real name stays as it is, a name that holds an
// address keeps the rest, and a name that is an address (or nothing) becomes the placeholder "Member" with eight characters of a hash of the person's id:
// stable (the same person reads the same on every screen), different for two people, and it tells nobody anything about the person.
//
// The email's local part is deliberately not used as the placeholder: "omar.diaz" is the person's real name in most companies, so it would show a name
// the person never chose to share, and a personal address ("ravi1987") can identify someone outside the company.
import { createHash } from "node:crypto";
import { containsEmailAddress, emailSafeName, isPlaceholderDisplayName, isReservedDisplayName, withoutEmailAddresses } from "@agentx/contracts";

export { isPlaceholderDisplayName };

/** The name a person without a real name shows as: "Member" and eight characters of a hash of their developer id. */
export function placeholderDisplayName(developerId: string): string {
  // A display helper fails safe: with no id to hash (an old or partial record) the placeholder is the plain word.
  if (typeof developerId !== "string" || developerId === "") return "Member";
  return `Member ${createHash("sha256").update(developerId).digest("hex").slice(0, 8)}`;
}

/** The name to show for a person: the stored name without any email address in it, else the placeholder. */
export function safeDisplayName(name: string | undefined, developerId: string): string {
  const safe = typeof name === "string" ? emailSafeName(name) : undefined;
  // A name shaped like a placeholder is nobody's but the placeholder maker's: a person's own stays, any other is no name.
  if (safe !== undefined && isReservedDisplayName(safe) && safe !== placeholderDisplayName(developerId)) return placeholderDisplayName(developerId);
  return safe ?? placeholderDisplayName(developerId);
}

/** An organization name as it is shown: the default name a first sign-in made from an email address ("ravi@example.com's team") reads as "New team". Any other name is as stored. */
export function safeOrgName(name: string): string {
  return containsEmailAddress(name) ? "New team" : name;
}

/**
 * The sign-in record with its name made safe to show: a name that holds an email address is the name without it, or the placeholder when nothing else is left. Any other
 * stored name (an empty one included, which callers already show as "a member" or "Someone") is read as stored. Everything else in the record is as stored.
 */
export function readableDeveloper<T extends { developerId: string; displayName: string }>(record: T): T {
  if (!containsEmailAddress(record.displayName)) return record;
  return { ...record, displayName: safeDisplayName(record.displayName, record.developerId) };
}

/** The default name of the org a person's first sign-in starts: "Maya's team", or "New team" for someone with no real name (the owner renames it). */
export function defaultTeamName(displayName: string, developerId: string): string {
  const name = safeDisplayName(displayName, developerId);
  return isPlaceholderDisplayName(name) ? "New team" : `${name}'s team`;
}

/** A line of stored text (a timeline entry such as "Maya shared this session") without any email address in it. Text with none is returned as it is. */
export function textWithoutEmails(text: string, developerId?: string): string {
  if (!containsEmailAddress(text)) return text;
  const stripped = withoutEmailAddresses(text);
  return stripped === "" ? (developerId === undefined ? "A member" : placeholderDisplayName(developerId)) : stripped;
}

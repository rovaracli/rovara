// UX1 (platform UX slice 1, "First day"): an invite can be emailed as well as copied. The email goes only to the address the invite is written for (whose
// sign-in must verify that same address to use it), through the install's existing sign-in notice sender: the same SES identity, region and
// `ses:SendEmail` grant as the linked-method and GitHub-connected notices (DEVELOPER_NOTICE_EMAIL_FROM, `ownerNotice`). No other sender exists: where none is
// configured the invite stays copy-only and the app says so. Nothing here logs an address, a name or the link.
import { createHash } from "node:crypto";
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { orgScoped, type OrgId } from "@agentx/contracts";
import { takeRateAt } from "../developer/page-comments.js";
import { NOTICE_SEND_TIMEOUT_MS, type IdentityNoticeDependencies } from "../developer/identity-notice.js";

export type InviteEmailOutcome = "sent" | "not_set_up" | "failed" | "limited";

/**
 * UX1 review I2: the shared notice sender must not become an open mailer for a self-serve company. Each company may email at most this many invites a
 * UTC day, and any one address at most once a day; past either the invite is still made and its link returned (copy it), and nothing is sent.
 */
export const INVITE_EMAILS_PER_ORG_PER_DAY = 50;
const DAY_MS = 86_400_000;

/** Takes one email from the address's daily slot, then one from the company's. Counters are keyed by the address's hash, never the address. */
export async function takeInviteEmailAllowance(deps: Parameters<typeof takeRateAt>[0], orgId: OrgId, to: string): Promise<boolean> {
  const recipient = createHash("sha256").update(to.trim().toLowerCase()).digest("hex");
  if (!await takeRateAt(deps, { pk: orgScoped(orgId, "INVITE_EMAIL_RECIPIENT_DAY"), sk: recipient }, 1, DAY_MS)) return false;
  return takeRateAt(deps, { pk: orgScoped(orgId, "INVITE_EMAIL_DAY"), sk: "company" }, INVITE_EMAILS_PER_ORG_PER_DAY, DAY_MS);
}

/** Whether this install can email an invite: its sign-in notice sender is configured. */
export const inviteEmailAvailable = (notice: IdentityNoticeDependencies | undefined): notice is IdentityNoticeDependencies & { ses: NonNullable<IdentityNoticeDependencies["ses"]>; from: string } =>
  notice !== undefined && notice.ses !== undefined && notice.from !== undefined && notice.from !== "";

/** A name a person chose, on one line and at most 100 characters: control characters (a line break in a subject, say) become spaces. */
const oneLine = (text: string) => [...text].map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char)).join("").replace(/\s+/g, " ").trim().slice(0, 100);
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

export interface InviteEmail { to: string; orgName: string; inviterName: string; role: "admin" | "member"; inviteUrl: string; expiresAt: string }

/** A fixed subject: the names are chosen by the company, so none of them goes in it (UX1 review I2). */
export const INVITE_EMAIL_SUBJECT = "You're invited to join a company on Rovara";
/** A name the company chose, on one line and in quotes, so it reads as a name and never as Rovara's own words. Its own double quotes become single. */
const quoted = (text: string, fallback: string) => `"${(oneLine(text) || fallback).replaceAll('"', "'")}"`;

/** The email's text. The link is the invite itself: it works once, for this address, until it expires. */
export function inviteEmailText(input: InviteEmail): string {
  const day = new Date(input.expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "");
  return `${quoted(input.inviterName, "Someone")} invited you to join the company ${quoted(input.orgName, "their team")} on Rovara as ${input.role === "admin" ? "an admin" : "a member"}.\n\n`
    + `Open this link to join: ${input.inviteUrl}\n\n`
    + `Sign in with this email address. The link works once and expires on ${day}. If you weren't expecting this invite, you can ignore this email.`;
}

/** Sends one invite. Never throws: a failure is `failed` (the link still works and can be copied), a missing sender `not_set_up`. */
export async function sendInviteEmail(notice: IdentityNoticeDependencies | undefined, input: InviteEmail): Promise<InviteEmailOutcome> {
  if (!inviteEmailAvailable(notice)) return "not_set_up";
  const text = inviteEmailText(input);
  const html = text.split("\n\n").map((paragraph) => `<p>${escapeHtml(paragraph).replace(escapeHtml(input.inviteUrl), `<a href="${escapeHtml(input.inviteUrl)}">${escapeHtml(input.inviteUrl)}</a>`)}</p>`).join("");
  try {
    await notice.ses.send(new SendEmailCommand({
      FromEmailAddress: notice.from,
      Destination: { ToAddresses: [input.to] },
      Content: { Simple: { Subject: { Data: INVITE_EMAIL_SUBJECT, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
    }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
    notice.log({ event: "org.invite_email_sent" });
    return "sent";
  } catch (error) {
    notice.log({ event: "org.invite_email_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

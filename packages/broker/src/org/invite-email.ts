// UX1 (platform UX slice 1, "First day"): an invite can be emailed as well as copied. The email goes only to the address the invite is written for (whose
// sign-in must verify that same address to use it), through the install's existing sign-in notice sender: the same SES identity, region and
// `ses:SendEmail` grant as the linked-method and GitHub-connected notices (DEVELOPER_NOTICE_EMAIL_FROM, `ownerNotice`). No other sender exists: where none is
// configured the invite stays copy-only and the app says so. Nothing here logs an address, a name or the link.
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { NOTICE_SEND_TIMEOUT_MS, type IdentityNoticeDependencies } from "../developer/identity-notice.js";

export type InviteEmailOutcome = "sent" | "not_set_up" | "failed";

/** Whether this install can email an invite: its sign-in notice sender is configured. */
export const inviteEmailAvailable = (notice: IdentityNoticeDependencies | undefined): notice is IdentityNoticeDependencies & { ses: NonNullable<IdentityNoticeDependencies["ses"]>; from: string } =>
  notice !== undefined && notice.ses !== undefined && notice.from !== undefined && notice.from !== "";

/** A name a person chose, on one line and at most 100 characters: control characters (a line break in a subject, say) become spaces. */
const oneLine = (text: string) => [...text].map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char)).join("").replace(/\s+/g, " ").trim().slice(0, 100);
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

export interface InviteEmail { to: string; orgName: string; inviterName: string; role: "admin" | "member"; inviteUrl: string; expiresAt: string }

export const inviteEmailSubject = (input: Pick<InviteEmail, "orgName" | "inviterName">) => `${oneLine(input.inviterName) || "Someone"} invited you to join ${oneLine(input.orgName) || "their team"} on Rovara`;

/** The email's text. The link is the invite itself: it works once, for this address, until it expires. */
export function inviteEmailText(input: InviteEmail): string {
  const day = new Date(input.expiresAt).toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, "");
  return `${oneLine(input.inviterName) || "Someone"} invited you to join ${oneLine(input.orgName) || "their team"} on Rovara as ${input.role === "admin" ? "an admin" : "a member"}.\n\n`
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
      Content: { Simple: { Subject: { Data: inviteEmailSubject(input), Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } } } },
    }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
    notice.log({ event: "org.invite_email_sent" });
    return "sent";
  } catch (error) {
    notice.log({ event: "org.invite_email_failed", error: error instanceof Error ? error.name : "unknown" });
    return "failed";
  }
}

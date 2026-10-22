// packages/broker/src/developer/join-page.ts
// Plan 2, Task 5: the words of the invite join pages. Each function returns a PageSpec, which server.ts renders with its page() (the
// same escaping, CSP and HTML_HEADERS as every other page of the sign-in server); nothing here builds HTML, so every string is escaped
// exactly once, there. None of these pages shows an invite token, an email address (only a masked one) or an id.
import type { JoinResultRecord } from "./store.js";

export interface PageSpec {
  statusCode: number;
  title: string;
  paragraphs: string[];
  links?: Array<{ href: string; label: string }>;
}

/** "priya@acme.dev" becomes "p•••@acme.dev": the first character and the domain, enough to recognize the address and not to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const first = Array.from(email.slice(0, at))[0] ?? "";
  return `${first}•••${email.slice(at)}`;
}

/** "an admin" or "a member": how a role reads in "invited you to join Acme as <role>" and "You're now <role> of Acme". */
export const roleInSentence = (role: "admin" | "member"): string => (role === "admin" ? "an admin" : "a member");

export interface InviteView {
  orgName: string;
  role: "admin" | "member";
  inviterName: string;
  /** The address the invite is for, already masked; absent for an invite anyone may use. */
  maskedEmail?: string;
}

/** An invite no one has used or let expire (200): who invited you, to what, and the way in. */
export function openInvitePage(invite: InviteView, startUrl: string, pageUrl: string): PageSpec {
  return {
    statusCode: 200,
    title: `Join ${invite.orgName} on Rovara`,
    paragraphs: [
      `${invite.inviterName} invited you to join ${invite.orgName} as ${roleInSentence(invite.role)}.`,
      ...(invite.maskedEmail === undefined ? [] : [`This invite is for ${invite.maskedEmail}.`]),
      `Using the terminal? Run: agentx login --invite ${pageUrl}`,
    ],
    links: [{ href: startUrl, label: `Join ${invite.orgName}` }],
  };
}

export const expiredInvitePage = (inviterName: string): PageSpec =>
  ({ statusCode: 410, title: "This invite has expired", paragraphs: [`Ask ${inviterName} to send you a new invite.`] });

export const usedInvitePage = (inviterName: string): PageSpec =>
  ({ statusCode: 410, title: "This invite was already used", paragraphs: [`Ask ${inviterName} for a new invite if you still need one.`] });

/** An unknown or malformed invite (404). Says nothing about which. */
export const unknownInvitePage = (): PageSpec =>
  ({ statusCode: 404, title: "This invite link isn't valid", paragraphs: ["Check that you copied the whole link, or ask for a new invite."] });

/** The done page for a browser that did not start the join, or whose result is gone (400). One answer for both, so a request id tells nothing. */
export const otherBrowserPage = (): PageSpec =>
  ({ statusCode: 400, title: "This page belongs to another browser", paragraphs: ["Open the invite link again."] });

/** The join page's sign-in could not continue in this browser (the callback came without the browser's own cookie). */
export const joinExpiredPage = (): PageSpec =>
  ({ statusCode: 400, title: "This invite sign-in expired", paragraphs: ["Open the invite link again and sign in."] });

/** What the person sees once the sign-in has ended, by outcome. `cellUrl` is the sign-in server's URL without `/v1/auth`. */
export function joinDonePage(result: JoinResultRecord, cellUrl: string): PageSpec {
  switch (result.outcome) {
    case "joined":
      return {
        statusCode: 200,
        title: `You joined ${result.orgName}`,
        paragraphs: [`You're now ${roleInSentence(result.role)} of ${result.orgName}.`, `Next: in your terminal, run agentx login ${cellUrl}`],
      };
    case "ALREADY_IN_ORG": {
      const current = result.currentOrgName ?? "your organization";
      return {
        statusCode: 200,
        title: `You're already in ${current}`,
        paragraphs: [
          `For now, a person can belong to one Rovara organization. To join ${result.invitedOrgName}, sign in with a different email address, or ask an owner of ${current} to remove you.`,
          `If ${current} is a team you made by mistake and no one else is in it, run agentx org leave, then open this invite again.`,
        ],
      };
    }
    case "INVITE_WRONG_EMAIL":
      return {
        statusCode: 200,
        title: "This invite is for a different email",
        paragraphs: [`It was sent to ${result.maskedEmail ?? "another address"}. Sign in with that address, or ask ${result.inviterName} for an invite to yours.`],
      };
    case "INVITE_INVALID":
      return { statusCode: 200, title: "This invite can no longer be used", paragraphs: [`Ask ${result.inviterName} for a new invite.`] };
  }
}

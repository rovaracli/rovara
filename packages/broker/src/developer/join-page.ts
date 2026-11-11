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
  /** A one-field email form (POST, so the address is in no URL) the page carries; server.ts renders it. */
  form?: { action: string; hidden: Record<string, string>; prompt: string; field: string; button: string };
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

/**
 * An invite no one has used or let expire (200): who invited you, to what, and the way in. A browser page (UX1): no terminal commands; the CLI reads the
 * JSON form of the same address (`agentx login --invite`).
 */
export function openInvitePage(invite: InviteView, startUrl: string, emailForm?: { action: string; invite: string }): PageSpec {
  return {
    statusCode: 200,
    title: `Join ${invite.orgName} on Rovara`,
    paragraphs: [
      `${invite.inviterName} invited you to join ${invite.orgName} as ${roleInSentence(invite.role)}.`,
      ...(invite.maskedEmail === undefined ? ["Sign in on the next page to join. No new company is created."] : [`This invite is for ${invite.maskedEmail}. Sign in with that address on the next page to join.`]),
    ],
    links: [{ href: startUrl, label: `Join ${invite.orgName}` }],
    // Where there is no self sign-up (new companies by invitation only), a person with no account asks for a code at their email address here.
    ...(emailForm === undefined ? {} : {
      form: { action: emailForm.action, hidden: { invite: emailForm.invite }, prompt: "New to Rovara? Enter your email address and use the sign-in code we send you.", field: "email", button: "Continue with email" },
    }),
  };
}

/** UX1: the way back into Rovara from a page that can't go on: the sign-up page, where a person chooses to create a company or join one. */
const TO_ROVARA = { href: "/app/signup", label: "Go to Rovara" };

export const expiredInvitePage = (inviterName: string): PageSpec =>
  ({ statusCode: 410, title: "This invite has expired", paragraphs: [`Invites last seven days. Ask ${inviterName} to send you a new invite from Administration, Invites.`], links: [TO_ROVARA] });

export const usedInvitePage = (inviterName: string): PageSpec =>
  ({ statusCode: 410, title: "This invite was already used", paragraphs: [`Each invite works once. If you already joined, open Rovara and sign in. Otherwise ask ${inviterName} for a new invite.`], links: [{ href: "/app", label: "Open Rovara" }] });

/** An unknown or malformed invite (404). Says nothing about which. */
export const unknownInvitePage = (): PageSpec =>
  ({ statusCode: 404, title: "This invite link isn't valid", paragraphs: ["Check that you copied the whole link, or ask the person who invited you for a new invite."], links: [TO_ROVARA] });

/** The done page for a browser that did not start the join, or whose result is gone (400). One answer for both, so a request id tells nothing. */
export const otherBrowserPage = (): PageSpec =>
  ({ statusCode: 400, title: "This page belongs to another browser", paragraphs: ["Open the invite link again in this browser to finish joining."], links: [{ href: "/app", label: "Open Rovara" }] });

/** The join page's sign-in could not continue in this browser (the callback came without the browser's own cookie). */
export const joinExpiredPage = (): PageSpec =>
  ({ statusCode: 400, title: "This invite sign-in expired", paragraphs: ["Open the invite link again and sign in within ten minutes. The invite itself still works."], links: [TO_ROVARA] });

/**
 * What the person sees once the sign-in has ended, by outcome. `appOrigin` is the origin the app is served from (the sign-in server's own). A join that
 * worked never shows this page: the browser goes straight into the app (server.ts); "joined" is kept for a result read some other way.
 */
export function joinDonePage(result: JoinResultRecord, appOrigin: string): PageSpec {
  switch (result.outcome) {
    case "joined":
      return {
        statusCode: 200,
        title: `You joined ${result.orgName}`,
        paragraphs: [`You're now ${roleInSentence(result.role)} of ${result.orgName}.`],
        links: [{ href: `${appOrigin}/app/welcome?joined=1`, label: "Open Rovara" }],
      };
    case "ALREADY_IN_ORG": {
      // UX1: a clear choice, not a dead end. Keep the company they have, or leave it (the account menu opens on its Leave step) and open the invite again.
      const current = result.currentOrgName ?? "your organization";
      return {
        statusCode: 200,
        title: `You're already in ${current}`,
        paragraphs: [
          `A person belongs to one Rovara company at a time. You can keep using ${current}, or leave it and then open this invite again to join ${result.invitedOrgName}.`,
          `If you are the last owner of ${current}, leaving closes it. The invite stays valid until it expires.`,
        ],
        links: [{ href: `${appOrigin}/app`, label: `Keep using ${current}` }, { href: `${appOrigin}/app?account=leave`, label: `Leave ${current} to join ${result.invitedOrgName}` }],
      };
    }
    case "INVITE_WRONG_EMAIL":
      return {
        statusCode: 200,
        title: "This invite is for a different email",
        paragraphs: [`It was sent to ${result.maskedEmail ?? "another address"}. Open the invite again and sign in with that address, or ask ${result.inviterName} for an invite to yours.`],
        links: [TO_ROVARA],
      };
    case "INVITE_INVALID":
      return { statusCode: 200, title: "This invite can no longer be used", paragraphs: [`It expired, was revoked or was already used. Ask ${result.inviterName} for a new invite.`], links: [TO_ROVARA] };
  }
}

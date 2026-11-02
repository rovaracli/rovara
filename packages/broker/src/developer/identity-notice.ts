// packages/broker/src/developer/identity-notice.ts
// Plan 2, Task 8: when a sign-in method is linked to an existing account by its verified email, the account's address is told, so a
// person who did not do it can remove it at once. Sent through Amazon SES from the cloud sign-in's sender (ses:SendEmail on that
// sender's identity). Nothing here reads or logs a token; the logs carry the provider only, never an address or a login.
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { DeveloperSignInMethod } from "@agentx/contracts";
import type { GithubConnectedNotice, GithubRequestReminder } from "../org/github-connect-support.js";

export const IDENTITY_NOTICE_SUBJECT = "A new way to sign in to your Rovara account";
/** How long a send may take; a sign-in is waiting on it, inside the function's 15 s, so a slow SES call must not use that budget up. */
export const NOTICE_SEND_TIMEOUT_MS = 2500;
/** A login (only GitHub has one): letters, digits and hyphens, at most 39 characters. Anything else is left out of the email rather than quoted in it. */
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const PROVIDER_LABEL: Record<DeveloperSignInMethod, string> = { github: "GitHub", cloud: "Email code", slack: "Slack", oidc: "Company sign-in", saml: "Company SAML sign-in" };

export interface IdentityNoticeDependencies {
  /** Without it, or without `from`, nothing is sent. */
  ses: Pick<SESv2Client, "send"> | undefined;
  /** The SES sender, `Name <address>` or an address (DEVELOPER_NOTICE_EMAIL_FROM); empty or absent when no SES sender is configured. */
  from: string | undefined;
  log: (entry: Record<string, unknown>) => void;
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** The notice's one sentence, for the email's text and (escaped) HTML. */
function noticeText(input: { provider: DeveloperSignInMethod; login?: string; cellUrl: string }): string {
  const login = input.login !== undefined && GITHUB_LOGIN.test(input.login) ? ` ${input.login}` : "";
  return `${PROVIDER_LABEL[input.provider]} account${login} can now sign in to your Rovara account. If this was you, there is nothing to do. `
    + `If it wasn't, remove it now: run agentx signin unlink ${input.provider}, or sign in at ${input.cellUrl} and remove it from your account.`;
}

/**
 * Emails `to` that a new sign-in method can now sign in to their account. "skipped" when no SES sender is configured. A send that SES
 * refuses or that times out throws; the caller decides it never fails a sign-in.
 */
export async function sendIdentityLinkedNotice(
  deps: IdentityNoticeDependencies,
  input: { to: string; provider: DeveloperSignInMethod; login?: string; cellUrl: string },
): Promise<"sent" | "skipped"> {
  if (deps.ses === undefined || deps.from === undefined || deps.from === "") {
    deps.log({ event: "signin.identity_link_notice_skipped", provider: input.provider, reason: "no_sender" });
    return "skipped";
  }
  const text = noticeText(input);
  await deps.ses.send(new SendEmailCommand({
    FromEmailAddress: deps.from,
    Destination: { ToAddresses: [input.to] },
    Content: { Simple: {
      Subject: { Data: IDENTITY_NOTICE_SUBJECT, Charset: "UTF-8" },
      Body: {
        Text: { Data: text, Charset: "UTF-8" },
        Html: { Data: `<p>${escapeHtml(text)}</p>`, Charset: "UTF-8" },
      },
    } },
  }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
  deps.log({ event: "signin.identity_linked", provider: input.provider });
  return "sent";
}

/**
 * Plan 3, Task 21a-presence (PF8): the notice that an email-code sign-in was added to an account only so a person present could confirm
 * decisions (a member who had only ever signed in with GitHub). The sentence is pinned; what follows tells the account how to undo it.
 */
export const DECIDE_NOTICE_SENTENCE = "Rovara added an email-code sign-in to your account, used to confirm decisions.";
export async function sendDecideSignInAddedNotice(deps: IdentityNoticeDependencies, input: { to: string; cellUrl: string }): Promise<"sent" | "skipped"> {
  if (deps.ses === undefined || deps.from === undefined || deps.from === "") {
    deps.log({ event: "signin.decide_notice_skipped", reason: "no_sender" });
    return "skipped";
  }
  const text = `${DECIDE_NOTICE_SENTENCE} If this was you, there is nothing to do. `
    + `If it wasn't, remove it now: run agentx signin unlink cloud, or sign in at ${input.cellUrl} and remove it from your account.`;
  await deps.ses.send(new SendEmailCommand({
    FromEmailAddress: deps.from,
    Destination: { ToAddresses: [input.to] },
    Content: { Simple: {
      Subject: { Data: IDENTITY_NOTICE_SUBJECT, Charset: "UTF-8" },
      Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: `<p>${escapeHtml(text)}</p>`, Charset: "UTF-8" } },
    } },
  }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
  deps.log({ event: "signin.decide_sign_in_added" });
  return "sent";
}

// Plan 2, Task 14: when a GitHub organization is connected to a Rovara org because its GitHub admin approved a request, each owner of the org
// is told, because the GitHub admin who approved never saw which Rovara org asked. Same sender and the same skip rule as the notice above.

/** Letters, digits and hyphens only: a login that GitHub issued, checked again before it is put in a link. */
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** A name a person chose, on one line and no longer than 100 characters: control characters (a line break in a subject, say) are dropped. */
const oneLine = (text: string) => [...text].map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char)).join("").replace(/\s+/g, " ").trim().slice(0, 100);

export const githubConnectedNoticeSubject = (account: string, orgName: string) => `GitHub organization ${account} connected to ${oneLine(orgName)} on Rovara`;

/** The notice's text: the GitHub organization (login and address), the requester, the approver and the Rovara org, then how to undo it. */
export function githubConnectedNoticeText(input: GithubConnectedNotice): string {
  const { accountLogin: account } = input;
  const requester = input.requester.email === undefined ? oneLine(input.requester.name) : `${oneLine(input.requester.name)} (${oneLine(input.requester.email)})`;
  return `${requester} asked to connect the GitHub organization ${account} (https://github.com/${account}) to your Rovara organization ${oneLine(input.orgName)}. `
    + `${input.approverLogin}, an admin of ${account} on GitHub, approved it. Rovara can now work in the repositories ${account} gave it access to. `
    + `If this isn't the GitHub organization you expected, remove it with agentx github disconnect ${account}.`;
}

/**
 * Emails one owner that a GitHub organization was connected to their Rovara organization through a request. "skipped" when no SES sender is
 * configured, or when a login is not one GitHub could have issued (nothing is quoted from it). A refused or timed-out send throws; the caller
 * logs it by name and the connection stands. The logs carry no address and no login.
 */
export async function sendGithubConnectedNotice(deps: IdentityNoticeDependencies, input: GithubConnectedNotice): Promise<"sent" | "skipped"> {
  if (deps.ses === undefined || deps.from === undefined || deps.from === "") {
    deps.log({ event: "github.connected_notice_skipped", reason: "no_sender" });
    return "skipped";
  }
  if (!GITHUB_ACCOUNT.test(input.accountLogin) || !GITHUB_ACCOUNT.test(input.approverLogin)) {
    deps.log({ event: "github.connected_notice_skipped", reason: "invalid_login" });
    return "skipped";
  }
  const text = githubConnectedNoticeText(input);
  await deps.ses.send(new SendEmailCommand({
    FromEmailAddress: deps.from,
    Destination: { ToAddresses: [input.to] },
    Content: { Simple: {
      Subject: { Data: githubConnectedNoticeSubject(input.accountLogin, input.orgName), Charset: "UTF-8" },
      Body: {
        Text: { Data: text, Charset: "UTF-8" },
        Html: { Data: `<p>${escapeHtml(text)}</p>`, Charset: "UTF-8" },
      },
    } },
  }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
  deps.log({ event: "github.connected_notice_sent" });
  return "sent";
}

// Plan 2, Task 14 Step 6: one reminder to the requester two days after they asked their GitHub admin, if it is still waiting.

export const GITHUB_REQUEST_REMINDER_SUBJECT = "Your GitHub admin hasn't approved Rovara yet";

export function githubRequestReminderText(input: GithubRequestReminder): string {
  const target = input.requestedAccountLogin !== undefined && GITHUB_ACCOUNT.test(input.requestedAccountLogin) ? input.requestedAccountLogin : "your GitHub organization";
  const expires = new Date(input.expiresAt).toISOString().slice(0, 10);
  return `You asked an admin of ${target} to approve Rovara 2 days ago, and it's still waiting. The request expires on ${expires}. `
    + "Remind them, or ask them to run agentx github connect themselves.";
}

/** Emails the requester their one reminder. "skipped" when no SES sender is configured; a failed send throws and the sweep logs its name. */
export async function sendGithubRequestReminder(deps: IdentityNoticeDependencies, input: GithubRequestReminder): Promise<"sent" | "skipped"> {
  if (deps.ses === undefined || deps.from === undefined || deps.from === "") {
    deps.log({ event: "github.request_reminder_skipped", reason: "no_sender" });
    return "skipped";
  }
  const text = githubRequestReminderText(input);
  await deps.ses.send(new SendEmailCommand({
    FromEmailAddress: deps.from,
    Destination: { ToAddresses: [input.to] },
    Content: { Simple: {
      Subject: { Data: GITHUB_REQUEST_REMINDER_SUBJECT, Charset: "UTF-8" },
      Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: `<p>${escapeHtml(text)}</p>`, Charset: "UTF-8" } },
    } },
  }), { abortSignal: AbortSignal.timeout(NOTICE_SEND_TIMEOUT_MS) });
  deps.log({ event: "github.request_reminder_sent" });
  return "sent";
}

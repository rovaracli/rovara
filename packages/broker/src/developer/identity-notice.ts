// packages/broker/src/developer/identity-notice.ts
// Plan 2, Task 8: when a sign-in method is linked to an existing account by its verified email, the account's address is told, so a
// person who did not do it can remove it at once. Sent through Amazon SES from the cloud sign-in's sender (ses:SendEmail on that
// sender's identity). Nothing here reads or logs a token; the logs carry the provider only, never an address or a login.
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import type { DeveloperSignInMethod } from "@agentx/contracts";

export const IDENTITY_NOTICE_SUBJECT = "A new way to sign in to your Rovara account";
/** How long a send may take; a sign-in is waiting on it. */
const SEND_TIMEOUT_MS = 5000;
/** A login (only GitHub has one): letters, digits and hyphens, at most 39 characters. Anything else is left out of the email rather than quoted in it. */
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const PROVIDER_LABEL: Record<DeveloperSignInMethod, string> = { github: "GitHub", cloud: "Email code", slack: "Slack", oidc: "Company sign-in" };

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
  }), { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  deps.log({ event: "signin.identity_linked", provider: input.provider });
  return "sent";
}

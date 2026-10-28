import { SERVER_PAGE_ICON, serverPageCss } from "@agentx/design-tokens";
// Plan 2, Task 13: the pages a person sees at the end of "agentx github connect": GitHub sends their browser to the callback, and the
// callback answers with one of these. Every value that came from GitHub or from a name a person chose is escaped; the policy allows
// only this page's own style and a form back to the same origin. Nothing here is a secret: the confirmation token travels in a cookie.
import { randomBytes } from "node:crypto";
import { GITHUB_INSTALLATION_TAKEN_MESSAGE, githubInstallRequestCopy } from "@agentx/contracts";
import { escapeHtml, safeResponse, type WebResponse } from "../aws/web-session.js";

export type ConnectPageKind = "confirm" | "connected" | "connected_trial_used" | "cancelled" | "requested" | "not_linked" | "not_yours" | "not_allowed" | "unattributed" | "taken" | "expired";

export interface ConnectPageData {
  /** The GitHub account (login) the installation is on. */
  accountLogin?: string;
  /** The Rovara organization it would connect to. */
  orgName?: string;
  /** The connect attempt's id (the state's hash), posted back by the confirm form. */
  connectId?: string;
  /** An owner of the Rovara organization, named in the message to give the GitHub admin (the waiting page). */
  ownerName?: string;
}

/** The form's address: the same origin as the page, which the policy's `form-action 'self'` also requires. */
export const GITHUB_CONFIRM_PATH = "/v1/github/install/confirm";

interface PageCopy { status: number; title: string; body: string[]; form?: boolean; code?: string }

function copyFor(kind: ConnectPageKind, data: ConnectPageData): PageCopy {
  const account = data.accountLogin ?? "this GitHub account";
  const org = data.orgName ?? "your organization";
  switch (kind) {
    case "confirm":
      return {
        status: 200, title: `Connect ${account} to ${org}?`, form: true,
        body: [`Rovara will be able to read and write the repositories you gave it access to in ${account}, for everyone in ${org}.`],
      };
    case "connected":
      return { status: 200, title: "GitHub connected", body: [`${account} is now connected to ${org}.`], code: `agentx project create --repository ${account}/<repository>` };
    case "connected_trial_used":
      return {
        status: 200, title: "GitHub connected",
        body: [`${account} is now connected to ${org}.`, "Your free trial stays locked: this GitHub account already started a trial for another organization."],
        code: `agentx project create --repository ${account}/<repository>`,
      };
    case "cancelled":
      return { status: 200, title: "Nothing was connected", body: ["Run agentx github connect again if you change your mind."] };
    case "requested": {
      const waiting = githubInstallRequestCopy("waiting", { orgName: data.orgName, ownerName: data.ownerName });
      return { status: 200, title: waiting.title, body: waiting.lines };
    }
    case "not_linked":
      return {
        status: 403, title: "Sign in to Rovara with this GitHub account first",
        body: ["This connect link was started by someone else in Rovara, or your GitHub account isn't linked to your Rovara account. Sign in with GitHub (agentx login, then choose GitHub), then run agentx github connect yourself."],
      };
    case "taken":
      return { status: 409, title: GITHUB_INSTALLATION_TAKEN_MESSAGE, body: [] };
    case "not_yours":
      return {
        status: 403, title: "Only the account's owner or an admin of the GitHub organization can connect it",
        body: [`Ask an admin of ${account} on GitHub to run agentx github connect.`],
      };
    case "not_allowed":
      return {
        status: 403, title: "Nothing was connected",
        body: [`The Rovara organization ${org} was closed, or you are no longer its owner or admin. Ask an owner or admin of ${org} to run agentx github connect.`],
      };
    case "unattributed":
      // GitHub's "request" callback came back with no user authorization code, so Rovara cannot say who asked and records nothing.
      return {
        status: 403, title: "Rovara couldn't confirm who asked",
        body: ["GitHub did not tell Rovara who sent the request, so Rovara recorded nothing and will not connect anything when it is approved. Ask your GitHub admin to run agentx github connect."],
      };
    case "expired":
      return { status: 410, title: "This connect link has expired. Run agentx github connect again.", body: [] };
  }
}

const STYLE = serverPageCss() + "h1{line-height:1.2;font-size:var(--rv-font-xxl)}code{padding:.15rem .4rem;border:1px solid var(--rv-border);border-radius:var(--rv-radius-sm);overflow-wrap:anywhere}button{margin:.35rem .5rem .35rem 0;background:var(--rv-bg-raised);color:var(--rv-text)}main{background:var(--rv-bg-raised);border:1px solid var(--rv-border);border-radius:var(--rv-radius-lg)}";

/**
 * One page, as a private response (no store, a nonce-only policy). The referrer policy is `same-origin`, not `no-referrer`: with
 * `no-referrer` a browser sends `Origin: null` on the confirm form's post, which the strict Origin check on the confirm route refuses.
 * Nothing is sent to another origin either way.
 */
export function githubConnectPage(kind: ConnectPageKind, data: ConnectPageData = {}): WebResponse {
  const copy = copyFor(kind, data);
  const nonce = randomBytes(18).toString("base64url");
  const title = escapeHtml(copy.title);
  const form = copy.form === true && data.connectId !== undefined
    ? `<form method="post" action="${GITHUB_CONFIRM_PATH}"><input type="hidden" name="connect" value="${escapeHtml(data.connectId)}"><button type="submit" name="decision" value="connect">Connect</button><button type="submit" name="decision" value="cancel">Cancel</button></form>`
    : "";
  const appStatus = kind === "connected" ? "connected" : kind === "connected_trial_used" ? "trial_used" : kind === "requested" ? "requested" : undefined;
  const appLink = appStatus === undefined ? "" : `<p><a href="/app/onboard?github=${appStatus}">Continue in Rovara</a></p>`;
  const next = copy.code === undefined ? "" : `<p>Next: <code>${escapeHtml(copy.code)}</code></p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${SERVER_PAGE_ICON}<style nonce="${nonce}">${STYLE}</style></head><body><main><h1>${title}</h1>${copy.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${form}${appLink}${next}</main></body></html>`;
  const response = safeResponse(copy.status, html, nonce);
  return { ...response, headers: { ...response.headers, "referrer-policy": "same-origin" } };
}

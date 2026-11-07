import { SERVER_PAGE_ICON, serverPageCss } from "@agentx/design-tokens";
// Plan 2, Task 13: the pages a person sees at the end of connecting GitHub (from the web app or "agentx github connect"): GitHub sends their browser to the callback, and the
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
  /** Where the person started connecting; the buttons go back there. Fixed values; onboarding when absent. */
  returnTo?: "/app/onboard" | "/app/admin/connections";
}

/** The form's address: the same origin as the page, which the policy's `form-action 'self'` also requires. */
export const GITHUB_CONFIRM_PATH = "/v1/github/install/confirm";

/** `links`: buttons to the next step, always same-origin app pages (UX1: a browser page shows buttons and next steps, never a terminal command). */
interface PageCopy { status: number; title: string; body: string[]; form?: boolean; links?: Array<{ href: string; label: string }> }

// UX3: the buttons go back to where the person started: the Connections page, or onboarding. Two fixed places; nothing from a request is ever an address.
const fromConnections = (data: ConnectPageData) => data.returnTo === "/app/admin/connections";
const BACK = (data: ConnectPageData) => ({ href: fromConnections(data) ? "/app/admin/connections?open=github" : "/app/onboard", label: "Back to Rovara" });
const CHOOSE_REPOSITORIES = (data: ConnectPageData, status: string) => ({ href: fromConnections(data) ? "/app/admin/connections?open=github" : `/app/onboard?github=${status}`, label: "Continue in Rovara" });

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
      return { status: 200, title: "GitHub connected", body: [`${account} is now connected to ${org}.`, fromConnections(data) ? "Next, check the connection in Rovara." : "Next, choose the repositories this workspace works on."], links: [CHOOSE_REPOSITORIES(data, "connected")] };
    case "connected_trial_used":
      return {
        status: 200, title: "GitHub connected",
        body: [`${account} is now connected to ${org}.`, "Your free trial stays locked: this GitHub account already started a trial for another organization."],
        links: [CHOOSE_REPOSITORIES(data, "trial_used")],
      };
    case "cancelled":
      return { status: 200, title: "Nothing was connected", body: ["You can connect GitHub again from Rovara whenever you're ready."], links: [BACK(data)] };
    case "requested": {
      const waiting = githubInstallRequestCopy("waiting", { orgName: data.orgName, ownerName: data.ownerName });
      return { status: 200, title: waiting.title, body: waiting.lines, links: [CHOOSE_REPOSITORIES(data, "requested")] };
    }
    case "not_linked":
      return {
        status: 403, title: "Link this GitHub account to your Rovara account first",
        body: ["This connect link was started by someone else in Rovara, or your GitHub account isn't linked to your Rovara account yet. In Rovara, choose Link your GitHub account, then connect GitHub again."],
        links: [{ href: fromConnections(data) ? "/app/admin/connections?open=github" : "/app/onboard?github=not_linked", label: "Link your GitHub account" }],
      };
    case "taken":
      return { status: 409, title: GITHUB_INSTALLATION_TAKEN_MESSAGE, body: [], links: [BACK(data)] };
    case "not_yours":
      return {
        status: 403, title: "Only the account's owner or an admin of the GitHub organization can connect it",
        body: [`Choose a GitHub account you own, or ask an admin of ${account} on GitHub to approve Rovara's request.`],
        links: [BACK(data)],
      };
    case "not_allowed":
      return {
        status: 403, title: "Nothing was connected",
        body: [`The Rovara organization ${org} was closed, or you are no longer its owner or admin. Ask an owner or admin of ${org} to connect GitHub from Rovara.`],
        links: [{ href: "/app", label: "Open Rovara" }],
      };
    case "unattributed":
      // GitHub's "request" callback came back with no user authorization code, so Rovara cannot say who asked and records nothing.
      return {
        status: 403, title: "Rovara couldn't confirm who asked",
        body: ["GitHub did not tell Rovara who sent the request, so Rovara recorded nothing and will not connect anything when it is approved. Connect GitHub again from Rovara and send the request from there."],
        links: [BACK(data)],
      };
    case "expired":
      return { status: 410, title: "This connect link has expired", body: ["Connect links last 15 minutes. Start again from Rovara."], links: [BACK(data)] };
  }
}

const STYLE = serverPageCss() + "h1{line-height:1.2;font-size:var(--rv-font-xxl)}code{padding:.15rem .4rem;border:1px solid var(--rv-border);border-radius:var(--rv-radius-sm);overflow-wrap:anywhere}button{margin:.35rem .5rem .35rem 0;background:var(--rv-bg-raised);color:var(--rv-text)}main{background:var(--rv-bg-raised);border:1px solid var(--rv-border);border-radius:var(--rv-radius-lg)}a.rv-next{display:inline-flex;align-items:center;min-height:44px;padding:.5rem 1rem;border:1px solid var(--rv-border-strong);border-radius:var(--rv-radius-sm);text-decoration:none;color:var(--rv-accent-text)}";

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
  const links = (copy.links ?? []).map((link) => `<p><a class="rv-next" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${SERVER_PAGE_ICON}<style nonce="${nonce}">${STYLE}</style></head><body><main><h1>${title}</h1>${copy.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}${form}${links}</main></body></html>`;
  const response = safeResponse(copy.status, html, nonce);
  return { ...response, headers: { ...response.headers, "referrer-policy": "same-origin" } };
}

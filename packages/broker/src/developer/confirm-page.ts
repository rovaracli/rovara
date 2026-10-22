// Plan 3, Task 21a-presence (R66, R67): the words and shape of the confirmation page, `GET /v1/app/approve/{id}`. Like Plan 2's join page it
// is built here once, escaped once, and nothing on it is a secret except its own CSRF token (derived from the session cookie, shown only to
// the browser that holds it). Plan 7 restyles it.
//
// Headers: the shared sign-in page policy (`default-src 'none'`, own inline style only, no frames, no base) with `form-action 'self'`
// instead of `'none'` so its form can post, plus `X-Frame-Options: DENY`. The referrer policy is `same-origin`, NOT `no-referrer`: with
// `no-referrer` a browser sends `Origin: null` on the form's post, which the strict Origin check refuses. Nothing is sent to another
// origin either way.
import type { ConfirmView } from "./decide-kinds.js";

export interface PageResponse { statusCode: number; headers: Record<string, string>; body: string }

export const CONFIRM_PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
/** Control and format characters (bidi overrides, zero-width, escape) are shown as [U+XXXX], never rendered; line breaks and tabs stay. */
const visible = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`));
const text = (value: string) => escape(visible(value));

const STYLE = "body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}"
  + "dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}"
  + "pre{padding:.75rem;border:1px solid #888;border-radius:.5rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}"
  + "button{font:inherit;padding:.6rem 1rem;margin:.5rem .5rem .5rem 0;border-radius:.4rem;cursor:pointer}a.method{display:inline-block;margin:.5rem 0}";

function shell(statusCode: number, title: string, main: string): PageResponse {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${text(title)}</title>`
    + `<style>${STYLE}</style></head><body><main><h1>${text(title)}</h1>${main}</main></body></html>`;
  return { statusCode, headers: { ...CONFIRM_PAGE_HEADERS }, body };
}
const paragraphs = (lines: string[]) => lines.map((line) => `<p>${text(line)}</p>`).join("");

/** The exact call, pretty-printed: every argument, as text. */
function callBlock(call: NonNullable<ConfirmView["call"]>): string {
  let printed: string;
  try {
    printed = JSON.stringify(call.arguments, null, 2) ?? "null";
  } catch {
    printed = "(the arguments could not be shown)";
  }
  return `<h2>The exact call</h2><dl><dt>Connector</dt><dd>${text(call.connector)}</dd><dt>Tool</dt><dd>${text(call.tool)}</dd></dl><pre>${text(printed)}</pre>`;
}

/** An open approval: what will happen, then Approve and Decline in a POST form carrying the CSRF token. */
export function confirmPage(view: ConfirmView, input: { approvalId: string; csrf: string }): PageResponse {
  const facts = view.facts.length === 0 ? "" : `<dl>${view.facts.map((fact) => `<dt>${text(fact.label)}</dt><dd>${text(fact.value)}</dd>`).join("")}</dl>`;
  const form = `<form method="post" action="/v1/app/approve/${escape(input.approvalId)}">`
    + `<input type="hidden" name="csrf" value="${escape(input.csrf)}">`
    + `<button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="decline">Decline</button></form>`;
  return shell(200, view.title, `${paragraphs(view.paragraphs ?? [])}${facts}${view.call === undefined ? "" : callBlock(view.call)}${form}`);
}

export const decidedPage = (words: string, how: "decided" | "expired" = "decided"): PageResponse => shell(409, how === "expired" ? "This request expired" : "Already decided", paragraphs([words]));
export const forbiddenPage = (words: string): PageResponse => shell(403, "You can't decide this", paragraphs([words]));
export const notFoundPage = (): PageResponse => shell(404, "Approval not found", paragraphs(["This approval was not found. Open it again from Rovara."]));
export const resultPage = (title: string, message: string): PageResponse => shell(200, title, paragraphs([message]));
export const refusedPage = (statusCode: number, title: string, words: string): PageResponse => shell(statusCode, title, paragraphs([words]));
/** The session ended or never was fresh (a post that arrived late): the way back in. */
export const reauthPage = (signInUrl: string): PageResponse =>
  shell(401, "Confirm again", `${paragraphs(["Your confirmation expired, so nothing was decided. Sign in again to continue."])}<a class="method" href="${escape(signInUrl)}">Sign in again</a>`);

// Plan approval from Cloud (PrepLabsAI/Rovara-cloud#1, phase 2b): `GET /v1/app/approve/plan-{session}` is the confirmation page the
// session's approval banner links to, and its form posts back to the same address. The decision goes to Rovara Code's
// `workflow/decision`, bound to the workflow revision and the plan's digest the page showed, so a plan that changed in between is
// refused by Code rather than approved. Code also decides who may approve; this page only shows and sends.
//
// Page safety: nothing from the task is rendered unescaped; the page has its own strict policy (no frames, its own inline style, form
// and fetch to this origin only, and one fixed script carrying a fresh nonce); the form carries the session's CSRF token, and the post
// must come from this origin.
//
// The script: behind CloudFront the function URL takes only signed requests, and a signed POST needs its body's SHA-256 in
// x-amz-content-sha256 (Lambda takes no unsigned payload), which a plain form post can't send. So the form posts through fetch with
// that header, the same form fields and the same origin check; without the script (or Web Crypto) the plain form post still works
// wherever the function is reached directly (locally).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CodeError, type CodeClient } from "./code-client.js";
import { waitingPlan, type CodeTask } from "./session-view.js";
import { CORE_ACTION_WORDS, isCoreNotYet, planDecidedOnCard } from "./core-task-actions.js";
import type { CodeSession } from "./sessions.js";
import type { WorkSessionStore } from "./work-sessions.js";

export const APPROVAL_PATH = /^\/v1\/app\/approve\/plan-(ses_[0-9a-z]{20})$/u;

const escape = (text: string) => text.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
  // Control and format characters (bidi overrides, zero-width), but for tabs and line breaks, are shown as [U+XXXX], never rendered.
  .replace(/(?![\t\n])[\p{Cc}\p{Cf}]/gu, (character) => `[U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // same-origin, not no-referrer: with no-referrer a browser sends `Origin: null` on the form's post, which the origin check refuses.
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * Posts the approval form through fetch with the body's SHA-256 (see the top of this file). Fixed text: nothing from the task or the
 * request is in it. On an answer it shows the page Cloud sent (or follows the redirect to the session).
 */
export const APPROVAL_FORM_SCRIPT = "(()=>{const f=document.querySelector('form'),s=globalThis.crypto&&crypto.subtle;if(!f||!s)return;let busy=false;"
  + "f.addEventListener('submit',async(e)=>{e.preventDefault();if(busy)return;busy=true;try{const d=new FormData(f);const b=e.submitter;if(b&&b.name)d.set(b.name,b.value);"
  + "const body=new URLSearchParams(d).toString();const h=Array.from(new Uint8Array(await s.digest('SHA-256',new TextEncoder().encode(body))),(x)=>x.toString(16).padStart(2,'0')).join('');"
  + "const r=await fetch(location.pathname,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/x-www-form-urlencoded','x-amz-content-sha256':h},body});"
  + "if(r.redirected){location.assign(r.url);return;}const p=new DOMParser().parseFromString(await r.text(),'text/html');document.title=p.title;document.body.replaceWith(p.body);"
  + "}catch{const m=document.createElement('p');m.textContent=\"Couldn't send your decision. Try again.\";f.after(m);}finally{busy=false;}});})();";

export function page(status: number, title: string, body: string, script?: string): { status: number; headers: Record<string, string>; body: string } {
  const nonce = script === undefined ? undefined : randomBytes(16).toString("base64");
  return {
    status,
    headers: nonce === undefined ? PAGE_HEADERS : {
      ...PAGE_HEADERS,
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
      + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1b2230}h1{font-size:1.4rem}p.muted{color:#5d6778}`
      + `form{display:grid;gap:.75rem;margin-top:1.5rem}textarea{font:inherit;min-height:5rem}button{font:inherit;padding:.5rem 1rem;cursor:pointer}.row{display:flex;gap:.75rem;flex-wrap:wrap}</style>`
      + `</head><body>${body}${nonce === undefined ? "" : `<script nonce="${nonce}">${script}</script>`}</body></html>`,
  };
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface ApprovalContext {
  client: CodeClient;
  session: CodeSession;
  work: WorkSessionStore;
  origin: string;
}

/** The page for a person who isn't signed in to Cloud, or whose Rovara sign-in ended. */
export const signInPage = () => page(401, "Sign in", "<h1>Sign in to Rovara Cloud</h1><p><a href=\"/app\">Sign in</a>, then open the approval again.</p>");

/**
 * GET shows the plan's approval; POST sends the decision. Answers a full HTTP response (a page or a redirect). Throws SignInEnded for the
 * handler to sign the person out.
 */
export async function approvalRoute(
  context: ApprovalContext, sessionId: string, method: string, headers: Record<string, string | undefined>, form: URLSearchParams | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const record = await context.work.get(sessionId);
  if (record === undefined) return page(404, "Not found", "<h1>This approval isn't here</h1><p>The session doesn't exist, or you can't see it.</p>");
  const sessionLink = `/s/${record.sessionId}`;
  try {
    const { task } = await context.client.json<{ task: CodeTask }>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}`, { headers: { "x-agentx-task-view": "2" } });
    const plan = waitingPlan(task);
    if (plan === undefined) return page(409, "Nothing to approve", `<h1>Nothing to approve now</h1><p>This task's plan isn't waiting for review.</p><p><a href="${sessionLink}">Back to the session</a></p>`);
    // Code lets only the task's owner decide; anyone else is told who can.
    if (record.owner.developerId !== context.session.access.developerId) {
      return page(403, "Not yours to decide", `<h1>Only ${escape(record.owner.name)} can decide this plan</h1><p>They own the session. <a href="${sessionLink}">Back to the session</a></p>`);
    }
    // A core task's plan is decided on its decision card, with Code's own digest and risk rules (audit 2026-11-18 item 6): the core takes no decision from this page.
    const onCard = page(200, "Decide on the session page", `<h1>Decide this plan on its card</h1><p>${escape(CORE_ACTION_WORDS.planOnCard)}</p><p><a href="${sessionLink}">Open the session</a></p>`);
    if (method === "GET" && await planDecidedOnCard(context.client, context.session, record.taskId)) return onCard;
    if (method === "GET") {
      return page(200, "Approve the plan",
        `<h1>Approve the plan</h1><p><strong>${escape(task.title || "Task")}</strong> in ${escape(task.project)}</p>`
        + `<p class="muted">Plan version ${String(plan.version)}. Read it on the <a href="${sessionLink}">session page</a> before you decide.</p>`
        + `<form method="post"><input type="hidden" name="csrf" value="${escape(context.session.csrf)}"><input type="hidden" name="revision" value="${String(plan.revision)}"><input type="hidden" name="digest" value="${escape(plan.digest)}">`
        + `<label for="reason">What should change (needed only for Request changes)</label><textarea id="reason" name="reason" maxlength="500"></textarea>`
        + `<div class="row"><button type="submit" name="decision" value="APPROVE">Approve</button><button type="submit" name="decision" value="REQUEST_CHANGES">Request changes</button></div></form>`,
        APPROVAL_FORM_SCRIPT);
    }
    // POST: from this origin, with this session's CSRF token, for the plan the page showed.
    if (headers.origin !== new URL(context.origin).origin) return page(403, "Refused", "<h1>Refused</h1><p>Open the approval from Rovara Cloud and try again.</p>");
    if (form === undefined || !sameText(form.get("csrf") ?? "", context.session.csrf)) return page(403, "Refused", "<h1>Refused</h1><p>Refresh the page and try again.</p>");
    // Only after the post is known to be this page's own: Code is asked whether the plan is on a card.
    if (await planDecidedOnCard(context.client, context.session, record.taskId)) return onCard;
    const decision = form.get("decision");
    if (decision !== "APPROVE" && decision !== "REQUEST_CHANGES") return page(400, "Choose", "<h1>Choose Approve or Request changes</h1>");
    const reason = (form.get("reason") ?? "").trim();
    if (decision === "REQUEST_CHANGES" && reason === "") return page(400, "Say what should change", `<h1>Say what should change</h1><p><a href="/v1/app/approve/plan-${record.sessionId}">Back</a></p>`);
    if (Number(form.get("revision")) !== plan.revision || form.get("digest") !== plan.digest) {
      return page(409, "The plan changed", `<h1>The plan changed</h1><p>A newer plan is waiting. <a href="/v1/app/approve/plan-${record.sessionId}">Review it</a>.</p>`);
    }
    try {
      await context.client.json(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/workflow/decision`, {
        method: "POST",
        body: { requestId: randomUUID(), expectedRevision: plan.revision, decision, reason: decision === "APPROVE" ? (reason || "Approved in Rovara Cloud") : reason, artifactDigest: plan.digest },
      });
    } catch (error) {
      // Code says the task is the core's (its card was not listed a moment ago): nothing was decided, and the card is where it is decided.
      if (isCoreNotYet(error)) return page(409, "Not decided", `<h1>This plan can't be decided here yet</h1><p>${escape(CORE_ACTION_WORDS.planNotHere)}</p><p><a href="${sessionLink}">Back to the session</a></p>`);
      throw error;
    }
    return { status: 303, headers: { location: sessionLink, "cache-control": "no-store" }, body: "" };
  } catch (error) {
    if (error instanceof CodeError) {
      // A dispatched decision's missing answer is not a refusal or proof that nothing was recorded.
      if (method === "POST" && error.status >= 500) return page(503, "Decision outcome unknown", `<h1>Decision outcome unknown</h1><p>The decision's outcome is unknown. Check the session before trying again.</p><p><a href="${sessionLink}">Check the session</a></p>`);
      const message = (error.body as { error?: { message?: unknown } } | undefined)?.error?.message;
      return page(error.status === 404 ? 404 : 409, "Rovara Code refused", `<h1>${method === "GET" ? "Rovara Code didn't show this plan" : "Rovara Code didn't take the decision"}</h1><p>${escape(typeof message === "string" ? message : "Try again from the session page.")}</p><p><a href="${sessionLink}">Back to the session</a></p>`);
    }
    throw error;
  }
}

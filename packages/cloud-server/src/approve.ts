// Plan approval from Cloud (PrepLabsAI/Rovara-cloud#1, phase 2b): `GET /v1/app/approve/plan-{session}` is the confirmation page the
// session's approval banner links to, and its form posts back to the same address. The decision goes to Rovara Code's
// `workflow/decision`, bound to the workflow revision and the plan's digest the page showed, so a plan that changed in between is
// refused by Code rather than approved. Code also decides who may approve; this page only shows and sends.
//
// Page safety: nothing from the task is rendered unescaped; the page has its own strict policy (no scripts, no frames, its own inline
// style, form to this origin only); the form carries the session's CSRF token, and the post must come from this origin.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { CodeError, type CodeClient } from "./code-client.js";
import { waitingPlan, type CodeTask } from "./session-view.js";
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

export function page(status: number, title: string, body: string): { status: number; headers: Record<string, string>; body: string } {
  return {
    status, headers: PAGE_HEADERS,
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>`
      + `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1b2230}h1{font-size:1.4rem}p.muted{color:#5d6778}`
      + `form{display:grid;gap:.75rem;margin-top:1.5rem}textarea{font:inherit;min-height:5rem}button{font:inherit;padding:.5rem 1rem;cursor:pointer}.row{display:flex;gap:.75rem;flex-wrap:wrap}</style>`
      + `</head><body>${body}</body></html>`,
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
    if (method === "GET") {
      return page(200, "Approve the plan",
        `<h1>Approve the plan</h1><p><strong>${escape(task.title || "Task")}</strong> in ${escape(task.project)}</p>`
        + `<p class="muted">Plan version ${String(plan.version)}. Read it on the <a href="${sessionLink}">session page</a> before you decide.</p>`
        + `<form method="post"><input type="hidden" name="csrf" value="${escape(context.session.csrf)}"><input type="hidden" name="revision" value="${String(plan.revision)}"><input type="hidden" name="digest" value="${escape(plan.digest)}">`
        + `<label for="reason">What should change (needed only for Request changes)</label><textarea id="reason" name="reason" maxlength="500"></textarea>`
        + `<div class="row"><button type="submit" name="decision" value="APPROVE">Approve</button><button type="submit" name="decision" value="REQUEST_CHANGES">Request changes</button></div></form>`);
    }
    // POST: from this origin, with this session's CSRF token, for the plan the page showed.
    if (headers.origin !== new URL(context.origin).origin) return page(403, "Refused", "<h1>Refused</h1><p>Open the approval from Rovara Cloud and try again.</p>");
    if (form === undefined || !sameText(form.get("csrf") ?? "", context.session.csrf)) return page(403, "Refused", "<h1>Refused</h1><p>Refresh the page and try again.</p>");
    const decision = form.get("decision");
    if (decision !== "APPROVE" && decision !== "REQUEST_CHANGES") return page(400, "Choose", "<h1>Choose Approve or Request changes</h1>");
    const reason = (form.get("reason") ?? "").trim();
    if (decision === "REQUEST_CHANGES" && reason === "") return page(400, "Say what should change", `<h1>Say what should change</h1><p><a href="/v1/app/approve/plan-${record.sessionId}">Back</a></p>`);
    if (Number(form.get("revision")) !== plan.revision || form.get("digest") !== plan.digest) {
      return page(409, "The plan changed", `<h1>The plan changed</h1><p>A newer plan is waiting. <a href="/v1/app/approve/plan-${record.sessionId}">Review it</a>.</p>`);
    }
    await context.client.json(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/workflow/decision`, {
      method: "POST",
      body: { requestId: randomUUID(), expectedRevision: plan.revision, decision, reason: decision === "APPROVE" ? (reason || "Approved in Rovara Cloud") : reason, artifactDigest: plan.digest },
    });
    return { status: 303, headers: { location: sessionLink, "cache-control": "no-store" }, body: "" };
  } catch (error) {
    if (error instanceof CodeError) {
      const message = (error.body as { error?: { message?: unknown } } | undefined)?.error?.message;
      return page(error.status === 404 ? 404 : 409, "Rovara Code refused", `<h1>${method === "GET" ? "Rovara Code didn't show this plan" : "Rovara Code didn't take the decision"}</h1><p>${escape(typeof message === "string" ? message : "Try again from the session page.")}</p><p><a href="${sessionLink}">Back to the session</a></p>`);
    }
    throw error;
  }
}

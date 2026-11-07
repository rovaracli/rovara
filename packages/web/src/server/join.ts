// UX1 (platform UX slice 1, "First day"): the app's own origin answers an invite link, `/join#invite=<token>`, so a join never depends on the hand-copied
// rovara.dev forwarder or its one hard-coded cell. The token rides in the fragment, which a browser never sends to a server: this tiny page reads it and
// moves on to the sign-in server's invite page on the SAME origin (`/v1/auth/join?invite=`), so the join's sign-in cookie belongs to the app's host. A
// private install's `?invite=` form is moved on at once. Nothing here stores, logs or echoes a token; a malformed one is refused before it is used.
import { randomBytes } from "node:crypto";
import { HSTS } from "./headers.js";
import type { AppResponse } from "./assets.js";

/** An invite token: 32 random bytes, base64url without padding (the broker's INVITE_TOKEN_PATTERN). */
export const JOIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const JOIN_TARGET = "/v1/auth/join?invite=";

const base = { "strict-transport-security": HSTS, "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };

export function joinResponse(rawQueryString: string | undefined): AppResponse {
  const query = new URLSearchParams(rawQueryString ?? "");
  const token = query.get("invite");
  if (token !== null && JOIN_TOKEN_PATTERN.test(token)) return { statusCode: 302, headers: { ...base, location: JOIN_TARGET + token }, body: "" };
  const nonce = randomBytes(18).toString("base64url");
  // The script is the page's only code: read the fragment, check its shape, replace this page (so Back does not return to it). The words for a broken link
  // are already in the page; the script only shows them. A nonce and Trusted Types keep anything else from running.
  const script = `(function(){var m=/^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash);if(m){location.replace(${JSON.stringify(JOIN_TARGET)}+m[1]);return;}document.getElementById("opening").hidden=true;document.getElementById("broken").hidden=false;})();`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Join Rovara</title>`
    + `<style nonce="${nonce}">body{font-family:system-ui,sans-serif;margin:0;padding:clamp(1rem,4vw,3rem);color:#1f2328;background:#f6f7f9}main{max-width:36rem;margin:0 auto;padding:clamp(1rem,4vw,2rem);background:#fff;border:1px solid #d0d7de;border-radius:12px}a{display:inline-flex;align-items:center;min-height:44px;padding:.5rem 1rem;border:1px solid #8c959f;border-radius:6px;text-decoration:none;color:#0b57d0}@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}main{background:#161b22;border-color:#30363d}a{color:#79b8ff;border-color:#6e7681}}</style></head>`
    + `<body><main><p><strong>Rovara</strong></p><div id="opening"><h1>Opening your invite</h1><noscript><p>This page needs JavaScript to read your invite link. Turn it on and open the link again.</p></noscript></div>`
    + `<div id="broken" hidden><h1>This invite link isn't complete</h1><p>Check that you copied the whole link, or ask the person who invited you for a new invite.</p><p><a href="/app/signup">Go to Rovara</a></p></div>`
    + `<script nonce="${nonce}">${script}</script></main></body></html>`;
  return {
    statusCode: 200,
    headers: { ...base, "content-type": "text/html; charset=utf-8", "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'` },
    body,
  };
}

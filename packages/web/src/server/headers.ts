export const HSTS = "max-age=31536000; includeSubDomains";
export interface AppEnvironment { assetOrigin: string; realtimeHttpHost: string; realtimeWsHost: string }
export function assetOrigin(value: string): string {
 if (value === "") return "";
 const url = new URL(value);
 if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("Invalid web hosting configuration.");
 return url.origin;
}
const hostSource = (protocol: string, host: string) => /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && !host.includes("..") ? ` ${protocol}://${host}` : "";
// Not "same-origin": the approval pages the app opens as popups send "same-origin", and two same-origin documents with the same value share
// one browsing context group, so script in the app could still reach a popup and press Approve. "same-origin-allow-popups" keeps the app
// out of any cross-origin opener's group, while a popup that sends "same-origin" no longer matches it and is cut off from its opener.
// tests/web-e2e/decide-popup.e2e.ts is the proof.
export const APP_OPENER_POLICY = "same-origin-allow-popups";
// WebKit builds every native <select> with an inline style attribute of its own, `text-overflow:inherit`, and counts it against the page's
// style-src-attr, so each <select> logged a CSP violation in WebKit and Safari (Firefox and Chromium do not). The attribute is the engine's,
// not ours: React writes its styles through the CSSOM, which CSP allows. Instead of 'unsafe-inline', allow only that one exact string by
// its hash (the base64 SHA-256 of "text-overflow:inherit"). Any other style attribute stays blocked, and the e2e CSP guard still fails on
// one. tests/contract/web-app-handler.test.ts pins the hash. Revisit when WebKit stops doing it.
export const WEBKIT_SELECT_STYLE_HASH = "sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw=";
export function appHeaders(env: AppEnvironment, nonce: string): Record<string, string> {
 if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Invalid response nonce.");
 const origin = assetOrigin(env.assetOrigin), extra = origin === "" ? "" : ` ${origin}`;
 return {
  "strict-transport-security": HSTS,
  "content-security-policy": `default-src 'none'; script-src 'self'${extra}; style-src 'self'${extra} 'nonce-${nonce}'; style-src-attr 'unsafe-hashes' '${WEBKIT_SELECT_STYLE_HASH}'; img-src 'self' data:${extra}; font-src ${origin || "'self'"}; connect-src 'self'${hostSource("https", env.realtimeHttpHost)}${hostSource("wss", env.realtimeWsHost)}; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`,
  "x-frame-options": "DENY", "cross-origin-opener-policy": APP_OPENER_POLICY, "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "permissions-policy": "camera=(), microphone=(), geolocation=()",
 };
}

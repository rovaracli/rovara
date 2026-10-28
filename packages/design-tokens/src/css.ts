import { TOKENS } from "./tokens.js";
function declarations(theme: "light" | "dark"): string {
 const colors = Object.entries(TOKENS[theme]).map(([key, value]) => `--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${value};`).join("");
 return `${colors}color-scheme:${theme};`;
}
export function tokensCss(): string {
 const common = TOKENS.space.map((value, index) => `--rv-space-${index}:${String(value)}px;`).join("") + Object.entries(TOKENS.radius).map(([key, value]) => `--rv-radius-${key}:${String(value)}px;`).join("") + Object.entries(TOKENS.font.sizes).map(([key, value]) => `--rv-font-${key}:${String(value)}px;`).join("") + `--rv-font-ui:${TOKENS.font.ui};--rv-font-mono:${TOKENS.font.mono};--rv-motion-fast:120ms;--rv-motion-normal:200ms;`;
 return `:root{${common}${declarations("light")}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${declarations("dark")}}}:root[data-theme="dark"]{${declarations("dark")}}`;
}
/**
 * Firefox asks for /favicon.ico on any page that names no icon and checks that request against the page's `img-src`. Our server pages
 * send `default-src 'none'`, so each one logged a CSP violation for a favicon nobody serves. Every server page names this empty data: icon
 * instead, and its policy allows `img-src data:` and nothing wider: the page still cannot load an image from any network address.
 */
export const SERVER_PAGE_ICON = '<link rel="icon" href="data:,">';
/**
 * The shared base style of the pages the broker serves. `pre: false` leaves out the global `pre` rule (wrapped, padded, bordered), for a page that styles its own
 * code blocks: the task page scrolls a code block sideways and wraps only evidence code and document text, so a global wrap rule would reflow every block.
 */
export function serverPageCss(options: { readonly pre?: boolean } = {}): string {
 const preRule = options.pre === false ? "" : "pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--rv-font-mono);padding:16px;border:1px solid var(--rv-border)}";
 return tokensCss() + `*{box-sizing:border-box}body{margin:0;background:var(--rv-bg);color:var(--rv-text);font:var(--rv-font-lg)/1.6 var(--rv-font-ui)}main{max-width:48rem;margin:clamp(1rem,6vh,4rem) auto;padding:var(--rv-space-5)}a{color:var(--rv-accent-text)}button,input,select,textarea{font:inherit}button,.rv-primary,.rv-secondary{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 16px;border:1px solid var(--rv-border-strong);border-radius:var(--rv-radius-sm)}.rv-primary{background:var(--rv-accent);color:var(--rv-on-accent)}.rv-secondary{background:var(--rv-bg-raised);color:var(--rv-text)}:focus-visible{outline:2px solid var(--rv-focus);outline-offset:3px}${preRule}input,textarea{max-width:100%;background:var(--rv-bg-raised);color:var(--rv-text)}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:8px}dd{margin:0;overflow-wrap:anywhere}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}`;
}

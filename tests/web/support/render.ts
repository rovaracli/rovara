import { createElement, type ReactElement } from "react";
import { afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
// jsdom has no layout/scroll implementation; real scrolling is covered by the Chromium journeys.
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;
// jsdom has no Web Locks API; the Merge section takes its cross-tab claim from it (and offers no in-app merge without it). This is a faithful in-memory exclusive lock: `ifAvailable` calls back with null while it is held.
if (!("locks" in navigator)) {
  const held = new Set<string>();
  Object.defineProperty(navigator, "locks", { configurable: true, writable: true, value: { async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
    if (held.has(name)) { if (options.ifAvailable === true) return callback(null); throw new Error("this test lock shim only supports ifAvailable"); }
    held.add(name);
    try { return await callback({ name, mode: "exclusive" }); } finally { held.delete(name); }
  } } });
}
afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-theme"); });
export function renderUi(element: ReactElement, options: { theme?: "light" | "dark"; host?: unknown } = {}) {
 document.documentElement.setAttribute("data-theme", options.theme ?? "light");
 return render(createElement("div", { "data-theme": options.theme ?? "light" }, element));
}

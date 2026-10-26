import { createElement, type ReactElement } from "react";
import { afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
// jsdom has no layout/scroll implementation; real scrolling is covered by the Chromium journeys.
if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => undefined;
afterEach(() => { cleanup(); document.documentElement.removeAttribute("data-theme"); });
export function renderUi(element: ReactElement, options: { theme?: "light" | "dark"; host?: unknown } = {}) {
 document.documentElement.setAttribute("data-theme", options.theme ?? "light");
 return render(createElement("div", { "data-theme": options.theme ?? "light" }, element));
}

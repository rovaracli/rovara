import { createElement, type ReactElement } from "react";
import { render } from "@testing-library/react";
export function renderUi(element: ReactElement, options: { theme?: "light" | "dark"; host?: unknown } = {}) {
 return render(createElement("div", { "data-theme": options.theme ?? "light" }, element));
}

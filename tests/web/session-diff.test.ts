// @vitest-environment jsdom
import { createElement } from "react";
import { expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DiffView } from "../../packages/ui/src/screens/session/DiffView.js";

it("renders hostile patch lines as literal text with accessible change words", () => {
 const patch = '+</pre><script>alert(1)</script>\n-old value\n context';
 const result = render(createElement(DiffView, { diff: { files: [{ path: "src/file.ts", status: "modified", additions: 1, deletions: 1, patch }], pullRequest: { repository: "acme/app", number: 42, url: "https://github.com/acme/app/pull/42" } } }));
 expect(screen.getByText('</pre><script>alert(1)</script>')).toBeTruthy();
 expect(result.container.querySelector("script")).toBeNull();
 expect(screen.getByText("Added line")).toBeTruthy();
 expect(screen.getByText("Removed line")).toBeTruthy();
 cleanup();
});

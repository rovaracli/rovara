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
 expect(result.container.querySelector("pre")?.tabIndex).toBe(0);
 expect(screen.getByText("Added line")).toBeTruthy();
 expect(screen.getByText("Removed line")).toBeTruthy();
 cleanup();
});

it("offers a safe GitHub link for omitted patches and no invented patch", () => {
 const result = render(createElement(DiffView, { diff: { files: [{ path: "image.png", status: "added", additions: 0, deletions: 0, patchOmitted: "binary" }], pullRequest: { repository: "app", number: 42, url: "https://github.com/acme/app/pull/42" } } }));
 expect(screen.getByRole("link", { name: "Open on GitHub" }).getAttribute("rel")).toBe("noopener noreferrer");expect(result.container.querySelector("pre")).toBeNull();cleanup();
});

it("passes accessibility checks in both themes", async () => {
 const { expectNoAxeViolations } = await import("./support/axe.js");
 for (const theme of ["light", "dark"]) {
 document.documentElement.setAttribute("data-theme", theme);
 const result = render(createElement(DiffView, { diff: { files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "+new\n-old" }], pullRequest: { repository: "app", number: 1, url: "https://github.com/acme/app/pull/1" } } }));
 await expectNoAxeViolations(result.container);cleanup();
 }
});

it("uses the exact before-PR explanation beside the actual file list", async () => {
 const { ChangesTab } = await import("../../packages/ui/src/screens/session/ChangesTab.js");
 const { workspaceFixture } = await import("./support/workspace-fixture.js");
 const { workspaceTask } = await import("../../packages/ui/src/screens/session/workspace-types.js");
 const session = workspaceFixture();const task = workspaceTask(session)!;
 render(createElement(ChangesTab, { session, task: { ...task, pullRequests: [] } }));
 expect(screen.getByText("The full diff appears once the pull request is open.")).toBeTruthy();expect(screen.getByText("src/refund.ts")).toBeTruthy();cleanup();
});

it("never links an omitted patch to a non-GitHub destination", () => {
 render(createElement(DiffView, { diff: { files: [{ path: "a", status: "added", additions: 0, deletions: 0 }], pullRequest: { repository: "app", number: 1, url: "https://github.com.foreign.example/acme/app/pull/1" } } }));
 expect(screen.queryByRole("link")).toBeNull();cleanup();
});

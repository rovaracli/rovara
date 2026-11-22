// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EvidenceViewReaderSchema } from "@agentx/contracts/web";
import { taskCaptureViewItems } from "../../packages/ui/src/screens/session/task-capture-evidence.js";
import { EvidenceCaptureSelection } from "../../packages/ui/src/screens/session/task-capture-evidence.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const artifact = (sha256: string, state: "available" | "expired" | "withheld", href?: string) => ({
 kind: "jpeg" as const, sha256, bytes: 128, retentionClass: "evidence-std" as const, state,
 ...(href === undefined ? {} : { href }),
});
const capturesFor = (before: ReturnType<typeof artifact>[], after: ReturnType<typeof artifact>[]) => {
 const evidence = EvidenceViewReaderSchema.parse({
  schemaVersion: 1, candidateDigest: "d".repeat(64), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
  checks: [], selection: { method: "full", selected: 0, total: 0 }, api: [], browser: [{ scenarioId: "checkout", strip: { before, after } }], notTested: [],
 });
 return taskCaptureViewItems(evidence.browser, link => link.href);
};

it("keeps the exact selected screenshot while the same task evidence rerenders", async () => {
 const captures = capturesFor([artifact("a".repeat(64), "available", "/v1/app/evidence/a.jpg")], [artifact("b".repeat(64), "available", "/v1/app/evidence/b.jpg")]);
 const ui = render(h(EvidenceCaptureSelection, { captures }));
 const before = screen.getByRole("button", { name: "checkout · before" });
 fireEvent.click(before);
 expect(before.getAttribute("aria-pressed")).toBe("true");
 ui.rerender(h(EvidenceCaptureSelection, { captures }));
 expect(screen.getByRole("button", { name: "checkout · before" }).getAttribute("aria-pressed")).toBe("true");
 expect(screen.getByRole("img", { name: "checkout, before screenshot" }).getAttribute("src")).toBe("/v1/app/evidence/a.jpg");
 await expectNoAxeViolations(ui.container);
});

it("creates viewer selections from the authorized scenario, side, and artifact identity", () => {
 const items = capturesFor([artifact("a".repeat(64), "available", "/v1/app/evidence/a.jpg")], [artifact("b".repeat(64), "available", "/v1/app/evidence/b.jpg"), artifact("c".repeat(64), "expired")]);
 expect(items.map(item => ({ captureId: item.captureId, side: item.side, pageLabel: item.pageLabel, viewportLabel: item.viewportLabel, ...(item.href === undefined ? {} : { href: item.href }), alt: item.alt }))).toEqual([
  { captureId: `checkout:before:${"a".repeat(64)}:0`, side: "before", pageLabel: "checkout", viewportLabel: "Recorded capture", href: "/v1/app/evidence/a.jpg", alt: "checkout, before screenshot" },
  { captureId: `checkout:after:${"b".repeat(64)}:0`, side: "after", pageLabel: "checkout, screenshot 1", viewportLabel: "Recorded capture", href: "/v1/app/evidence/b.jpg", alt: "checkout, after screenshot 1" },
  { captureId: `checkout:after:${"c".repeat(64)}:1`, side: "after", pageLabel: "checkout, screenshot 2", viewportLabel: "Recorded capture", alt: "checkout, after screenshot 2" },
 ]);
});

it("does not turn an unavailable artifact into a served capture", () => {
 const items = capturesFor([artifact("a".repeat(64), "available", "/v1/app/evidence/a.jpg")], [artifact("b".repeat(64), "withheld")]);
 expect(items[1]?.href).toBeUndefined();
});

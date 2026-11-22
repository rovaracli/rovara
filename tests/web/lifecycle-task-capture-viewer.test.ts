// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCaptureViewer, type TaskCaptureViewItem } from "../../packages/ui/src/screens/session/TaskCaptureViewer.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";

afterEach(cleanup);

const captures: TaskCaptureViewItem[] = [
 { captureId: "before-desktop", side: "before", pageLabel: "Payment detail", viewportLabel: "Desktop, 1280 by 800", href: "/v1/app/evidence/before.jpg", alt: "Payment page before the change" },
 { captureId: "after-desktop", side: "after", pageLabel: "Payment detail", viewportLabel: "Desktop, 1280 by 800", href: "/v1/app/evidence/after.jpg", alt: "Payment page after the change" },
 { captureId: "before-phone", side: "before", pageLabel: "Payment detail", viewportLabel: "Phone, 390 by 844", href: "/v1/app/evidence/before-phone.jpg", alt: "Payment page before the change on a phone" },
 { captureId: "after-phone", side: "after", pageLabel: "Payment detail", viewportLabel: "Phone, 390 by 844", alt: "Payment page after the change on a phone" },
];

it("renders the selected capture with its before/after and viewport labels", async () => {
 const view = render(h(TaskCaptureViewer, { captures, selectedCaptureId: "after-desktop", onSelectCapture: vi.fn(), onClose: vi.fn() }));
 expect(screen.getByRole("heading", { name: "Payment detail · after · Desktop, 1280 by 800" })).toBeTruthy();
 expect(screen.getByRole("img", { name: "Payment page after the change" }).getAttribute("src")).toBe("/v1/app/evidence/after.jpg");
 expect(screen.getByRole("button", { name: "After" }).getAttribute("aria-pressed")).toBe("true");
 expect(screen.getByRole("button", { name: "Desktop, 1280 by 800" }).getAttribute("aria-pressed")).toBe("true");
 await expectNoAxeViolations(view.container);
 view.unmount();
});

it("returns selection changes to the owner and closes through Back", () => {
 const onSelectCapture = vi.fn(), onClose = vi.fn();
 render(h(TaskCaptureViewer, { captures, selectedCaptureId: "after-desktop", onSelectCapture, onClose }));
 fireEvent.click(screen.getByRole("button", { name: "Before" }));
 expect(onSelectCapture).toHaveBeenCalledWith("before-desktop");
 fireEvent.click(screen.getByRole("button", { name: "Phone, 390 by 844" }));
 expect(onSelectCapture).toHaveBeenLastCalledWith("after-phone");
 fireEvent.click(screen.getByRole("button", { name: /Back to the screenshots/u }));
 expect(onClose).toHaveBeenCalledOnce();
});

it("F5 shows a neutral unavailable capture without inventing a timeout", async () => {
 const missing = captures.map(capture => capture.captureId === "after-phone" ? { ...capture, href: undefined } : capture);
 const view = render(h(TaskCaptureViewer, { captures: missing, selectedCaptureId: "after-phone", onSelectCapture: vi.fn(), onClose: vi.fn() }));
 expect(screen.getByRole("region", { name: "Capture unavailable" }).textContent).toContain("Capture unavailable · advisory");
 expect(view.container.textContent).not.toContain("timed out");
 expect(view.container.querySelector("img")).toBeNull();
 await expectNoAxeViolations(view.container);
});

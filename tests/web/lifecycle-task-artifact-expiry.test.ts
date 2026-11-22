// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactLinkSchema } from "@agentx/contracts/web";
import { EvidenceArtifactExpiryView } from "../../packages/ui/src/screens/session/EvidenceArtifactExpiryView.js";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/ui-task-artifact-expiry/expired-artifact-link.json"), "utf8")) as { expired: unknown; withheld: unknown };

afterEach(cleanup);

describe("task evidence artifact expiry", () => {
  it("uses the real artifact-link reader and shows the approved expired-link notice", () => {
    const link = ArtifactLinkSchema.parse(fixture.expired);
    render(createElement(EvidenceArtifactExpiryView, { link, prefix: "Sample 2" }));

    expect(screen.getByRole("region", { name: "Sample 2" }).textContent).toBe(
      "Sample 2This evidence link expired. An expired link does not show whether the check passed. Request a new authorized evidence link.",
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers re-read only through the authorized parent slot for this exact link", () => {
    const link = ArtifactLinkSchema.parse(fixture.expired);
    const requestNewLink = vi.fn();
    render(createElement(EvidenceArtifactExpiryView, { link, prefix: "Step 4", onRequestNewLink: requestNewLink }));

    screen.getByRole("button", { name: "Request a new link" }).click();
    expect(requestNewLink).toHaveBeenCalledExactlyOnceWith(link);
  });

  it("keeps withheld artifacts distinct from expired links", () => {
    const link = ArtifactLinkSchema.parse(fixture.withheld);
    render(createElement(EvidenceArtifactExpiryView, { link, prefix: "Sample 1" }));

    expect(screen.getByRole("region", { name: "Sample 1" }).textContent).toContain("was not kept");
    expect(screen.queryByText(/expired/i)).toBeNull();
  });

  it("uses the generic fallback for an unreadable artifact", () => {
    render(createElement(EvidenceArtifactExpiryView, { prefix: "Step 3" }));

    expect(screen.getByRole("region", { name: "Step 3" }).textContent).toContain(
      "This evidence link is unavailable. Its check result is shown separately.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

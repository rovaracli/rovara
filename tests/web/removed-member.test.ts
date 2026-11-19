// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/dom";
import { CodeClient, LocalSessionStore, LocalWorkSessionStore, createCloudHandler } from "../../packages/cloud-server/src/index.js";
import { expectNoAxeViolations } from "./support/axe.js";

it("offers an accessible sign-in link after a refused sign-in without revealing company or sign-in details", async () => {
  const store = new LocalSessionStore(undefined, { environment: {} });
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "rovara-cloud", clientSecret: "test", redirectUri: "https://cloud.example.test/callback", scopes: "projects:members", fetch });
  const handle = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "private-company-id", name: "PRIVATE_COMPANY", plan: "test" }, callbackPath: "/callback", secureCookies: true });
  await store.putPending("private-state", { verifier: "private-verifier", returnTo: "/app/projects/private-project", at: Date.now() });
  const result = await handle({ method: "GET", path: "/callback", query: new URLSearchParams({ state: "private-state", error: "access_denied", error_description: "PRIVATE_PROVIDER_TEXT" }), headers: {} });
  expect(result!.status).toBe(400);
  expect(result!.headers["content-type"]).toBe("text/html; charset=utf-8");
  const page = new DOMParser().parseFromString(result!.body, "text/html");
  document.body.innerHTML = page.body.innerHTML;
  try {
    expect(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href")).toBe("/app");
    expect(screen.getByText("You're no longer a member of this company. Ask an admin to invite you again.")).toBeTruthy();
    for (const value of ["private-company-id", "PRIVATE_COMPANY", "private-project", "private-state", "private-verifier", "PRIVATE_PROVIDER_TEXT", "access_denied"]) expect(result!.body).not.toContain(value);
    expect(fetch).not.toHaveBeenCalled();
    await expectNoAxeViolations(document.body);
  } finally { document.body.innerHTML = ""; }
});

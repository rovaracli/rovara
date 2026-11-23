// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { mount } from "./mount.js";

it("mounts account at its canonical leaf with observed account and link facts", async () => {
 // G5 ship: the GitHub landing words and ?github=connect now belong to /app/account/github (see account-setup-mount.test.ts), so this page is opened without them.
 const f = mount("/app/account");
 expect(await screen.findByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
 expect(await screen.findByText("Priya")).toBeTruthy();
 expect(await screen.findByText("priya-dev")).toBeTruthy();
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(document.body.textContent).not.toContain("Your GitHub account is connected. Rovara can now");
 f.close();
});
it("mounts existing key metadata at the automation-key leaf", async () => {
 const f = mount("/app/account/automation-keys");
 expect(await screen.findByText("Nightly CI")).toBeTruthy();
 for (const status of ["Active", "Expired", "Revoked"]) expect(screen.getByText(status)).toBeTruthy();
 expect(screen.getByRole("link", { name: "Account" }).getAttribute("href")).toBe("/app/account");
 f.close();
});
it("mounts a display-only name slot without a name form", async () => {
 const f = mount("/app/work");
 expect(await screen.findByRole("heading", { name: "Your name" })).toBeTruthy();
 expect(screen.getByText("Priya")).toBeTruthy();
 expect(document.querySelector("form,input")).toBeNull(); f.close();
});

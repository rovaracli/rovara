// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { mount } from "./mount.js";

// G1 SHIP: this file used to prove "no write controls anywhere". The live pages' actions are restored (company-admin-mount.test.ts proves each one), so what stays
// provable here is that mounting and reading again never WRITE, and that only the one settings file holds write calls.
it.each([["/app/admin", "Acme"], ["/app/admin/settings", "Company settings"], ["/app/admin/audit", "Audit"]])("sends only GET on mount and when read again at %s", async (path, title) => {
 const app = await mount(path);
 await screen.findByRole("heading", { level: 1, name: title });
 const retry = await screen.findByRole("button", { name: /^Read .* again$/ });
 fireEvent.click(retry);
 await screen.findByRole("button", { name: /^Read .* again$/ });
 expect(app.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 app.close();
});
it("the project page working-branches panel reads only: mounting writes nothing", async () => {
 const app = await mount("/app/admin/projects/payments");
 await screen.findByRole("heading", { level: 2, name: "Working branches" });
 expect(app.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 app.close();
});
// Dependency guard: of the rebuilt page files, only the settings screen may call a write (send / sendAnswer); the others stay read-only views.
it("only the settings screen holds write calls", () => {
 const dir = resolve("packages/ui/src/screens/company-admin-read"), writers: string[] = [];
 for (const name of readdirSync(dir).filter(file => /\.tsx?$/.test(file))) if (/\.(send|sendAnswer)\(|useMutation/.test(readFileSync(resolve(dir, name), "utf8"))) writers.push(name);
 expect(writers).toEqual(["CompanySettingsReadScreen.tsx"]);
 expect(readdirSync(dir)).not.toContain("upkeep-held.ts");
});

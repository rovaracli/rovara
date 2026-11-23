// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { mount } from "./test-support.js";
import { reply } from "./fixtures.js";
it("mounts the setup slot at the unchanged project URL and only reads scope/build", async () => {
 const f = mount("/app/projects/web", reply, undefined, "setup");
 await screen.findByRole("heading", { name: "What the wiki is built from" });
 await screen.findByText("3 of 8 planned pages written");
 expect(f.calls.filter(r => r.path.includes("wiki-")).map(r => r.path).sort()).toEqual(["/v1/app/projects/web/wiki-build", "/v1/app/projects/web/wiki-map"]);
 expect(screen.queryByRole("button", { name: /build/i })).toBeNull(); f.close();
});
it("does not turn Home answer reads into a submission or history route", async () => {
 const f = mount("/app/projects/web", reply, undefined, "answer");
 await screen.findByText("Existing answer: Can't tell yet."); // The nav read says whether this deployment offers answers; nothing else is read and nothing is sent.
 expect(f.calls.map(r => r.path).sort()).toEqual(["/v1/app/me", "/v1/app/nav"]); expect(f.calls.every(r => r.method === "GET")).toBe(true); f.close();
});
it("searches titles and summaries locally for one character, and switches to served retired skills without writes", async () => {
 const f = mount("/app/projects/web?tab=wiki");
 fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "q" } });
 await screen.findByText("No pages match this search."); expect(f.calls.some(r => r.path.includes("/search"))).toBe(false); f.close();
 const skills = mount("/app/projects/web?tab=skills"); await screen.findByText("old-retries");
 expect(screen.getByRole("heading", { name: "Retired" })).toBeTruthy(); expect(skills.calls.every(r => r.method === "GET")).toBe(true); skills.close();
});

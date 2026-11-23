// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { mount } from "./test-support.js";
import { corrections, detail, reply } from "./fixtures.js";

it("a stored scope refusal overrides otherwise successful cached snapshots", async () => {
 const f = mount();
 try {
  await screen.findByRole("link", { name: "Product overview" });
  const key = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === "index")!.queryKey;
  await act(async () => { f.client.setQueryData([...key.slice(0, -1), "denied"], new ApiError(404, "NOT_FOUND", "private")); });
  await screen.findByRole("heading", { name: "Access ended" });
  expect(screen.queryByRole("link", { name: "Product overview" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "web" })).toBeNull();
 } finally { f.close(); }
});

it.each(["disputed", "gaps"])("corrections permission refusal prevents the %s read", async view => {
 const f = mount("/app/projects/web?tab=wiki&view=" + view, r => r.path.endsWith("/corrections") ? { status: 200, body: { ...corrections, you: { ...corrections.you, seeDisputed: false } } } : reply(r));
 try {
  await screen.findByText("This list isn't available to you.");
  expect(f.calls.some(r => /\/(gaps|disputed)$/.test(r.path))).toBe(false);
  expect(screen.queryByText("How are retries handled?")).toBeNull();
  expect(screen.queryByText("Check the retry policy")).toBeNull();
 } finally { f.close(); }
});

it("invalid page identifiers issue no page, source or correction request for that identifier", async () => {
 const f = mount("/app/projects/web?tab=wiki&page=..%2Fsecret");
 try {
  await screen.findByText("Page unavailable.");
  expect(f.calls.some(r => /secret|%2F|%2f/.test(r.path))).toBe(false);
 } finally { f.close(); }
});

it("invalid project identifiers never reach a project resource read", async () => {
 const f = mount("/app/projects/..%2Fsecret?tab=wiki");
 try {
  await screen.findByText("Project unavailable.");
  expect(f.calls.every(r => r.path === "/v1/app/me")).toBe(true);
 } finally { f.close(); }
});

it("a permission refresh never starts a corrections read using the cached grant", async () => {
 let delayed = false, release!: (value: ReturnType<typeof reply>) => void;
 const f = mount(undefined, r => delayed && r.path.endsWith("/corrections") ? new Promise(resolve => { release = resolve; }) : reply(r));
 try {
  await screen.findByRole("link", { name: "Disputed sections" });
  delayed = true;
  let pending!: Promise<void>;
  await act(async () => { pending = f.client.refetchQueries({ predicate: q => String(q.queryKey.at(-1)).startsWith("permission:") }); });
  await act(async () => { await f.router.navigate("/app/projects/web?tab=wiki&view=gaps"); });
  await screen.findByText("Loading the latest read…");
  expect(f.calls.some(r => /\/(gaps|disputed)$/.test(r.path))).toBe(false);
  await act(async () => { release({ status: 200, body: { ...corrections, you: { ...corrections.you, seeDisputed: false } } }); await pending; });
  await screen.findByText("This list isn't available to you.");
  expect(f.calls.some(r => /\/(gaps|disputed)$/.test(r.path))).toBe(false);
 } finally { f.close(); }
});

it("retired detail never advertises a waiting version from its retained active-version field", async () => {
 const f = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills/safe-retries") ? { status: 200, body: { ...detail, skill: { ...detail.skill, retired: true } } } : reply(r));
 try {
  fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  await screen.findByText(detail.skill.content);
  expect(screen.getByText(/^Skill · retired · Read from Rovara/)).toBeTruthy();
  expect(screen.queryByText("Text of this version: Can't tell yet.")).toBeNull();
 } finally { f.close(); }
});

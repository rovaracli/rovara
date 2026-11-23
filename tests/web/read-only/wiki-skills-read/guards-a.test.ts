// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { WikiIndexResponseSchema } from "@agentx/contracts/web";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { AppHostProvider } from "../../../../packages/ui/src/host.js";
import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { ApiError } from "../../../../packages/ui/src/api/errors.js";
import { Scope, useRead, failed } from "../../../../packages/ui/src/screens/wiki-skills-read/read-model.js";
import { ReadState } from "../../../../packages/ui/src/screens/wiki-skills-read/ReadState.js";
import { readClock } from "../../../../packages/ui/src/screens/wiki-skills-read/parts.js";
import { mount } from "./test-support.js";
import { corrections, detail, fixtureHost, index, page, reply, sources } from "./fixtures.js";

it.each(["page", "sources", "corrections", "skill"])("subject guard refuses a valid response for the wrong %s", async kind => {
 const f = mount(kind === "skill" ? "/app/projects/web?tab=skills" : "/app/projects/web?tab=wiki&page=overview", r => {
  if (kind === "page" && r.path.endsWith("/pages/overview")) return { status: 200, body: { ...page, page: { ...page.page, pageId: "other" } } };
  if (kind === "sources" && r.path.endsWith("/sources")) return { status: 200, body: { ...sources, pageId: "other" } };
  if (kind === "corrections" && r.path.endsWith("/corrections")) return { status: 200, body: { ...corrections, pageId: "other" } };
  if (kind === "skill" && r.path.endsWith("/skills/safe-retries")) return { status: 200, body: { ...detail, skill: { ...detail.skill, name: "other" } } };
  return reply(r);
 });
 try {
  if (kind === "skill") fireEvent.click((await screen.findAllByRole("button", { name: "Open safe-retries" }))[0]!);
  if (kind === "sources" || kind === "corrections") await screen.findByText("Couldn't read " + (kind === "sources" ? "the source files" : "the corrections") + " just now. Earlier information is hidden.");
  else await screen.findByRole("alert");
  expect(f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === ({ page: "page:overview", sources: "sources:overview", corrections: "corrections:overview", skill: "skill:safe-retries" }[kind]))?.state.data).toBeUndefined();
 } finally { f.close(); }
});

it("a sibling success issued before refusal cannot refill the denied scope", async () => {
 let release!: (value: ReturnType<typeof reply>) => void, delayed = false;
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => delayed && r.path.endsWith("/sources") ? new Promise(resolve => { release = resolve; }) : delayed && r.path.endsWith("/pages/overview") ? { status: 403, body: {} } : reply(r));
 try {
  await screen.findByText("Private page text: requests enter the API.");
  delayed = true;
  let pending!: Promise<void>;
  await act(async () => { pending = f.client.refetchQueries({ predicate: q => q.queryKey.at(-1) === "sources:overview" }); });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => { await f.client.refetchQueries({ predicate: q => q.queryKey.at(-1) === "page:overview" }); });
  await screen.findByRole("heading", { name: "Access ended" });
  await act(async () => { release({ status: 200, body: sources }); await pending; });
  expect(f.client.getQueryCache().findAll().filter(q => String(q.queryKey.at(-1)).includes(":" )).every(q => q.state.data === undefined)).toBe(true);
  expect(screen.queryByText("Private page text: requests enter the API.")).toBeNull();
 } finally { f.close(); }
});

it("identity refusal purges only resource scopes, retaining unrelated host metadata", async () => {
 let denied = false;
 const f = mount(undefined, r => denied && r.path === "/v1/app/me" ? { status: 403, body: {} } : reply(r));
 try {
  await screen.findByRole("link", { name: "Product overview" });
  const key = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === "identity")!.queryKey;
  const other = [...key.slice(0, 2), "metadata"];
  f.client.setQueryData(other, { independent: true });
  denied = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
  await screen.findByRole("heading", { name: "Access ended" });
  expect(f.client.getQueryData(other)).toEqual({ independent: true });
  const resource = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === "index")!;
  expect(resource.state.data).toBeUndefined();
  expect(f.client.getQueryData([...resource.queryKey.slice(0, -1), "denied"])).toBeTruthy();
 } finally { f.close(); }
});

it("useRead projects cached refused data away before its consumer can see it", async () => {
 const client = createQueryClient(), fixture = fixtureHost();
 const key = ["g3", "projection", "company", "person", "web"];
 const queryKey = [...key, "index"];
 client.setQueryData(queryKey, index);
 function Probe() {
  const read = useRead("index", "wiki", WikiIndexResponseSchema, false);
  return h("p", {}, read.data === undefined ? "hidden" : "Private probe data");
 }
 const ui = renderUi(h(AppHostProvider, { host: fixture.host, children: h(QueryClientProvider, { client, children: h(Scope.Provider, { value: { key, project: "web" }, children: h(Probe, {}) }) }) }));
 try {
  await screen.findByText("Private probe data");
  await act(async () => { client.getQueryCache().find({ queryKey })!.setState({ status: "error", error: new ApiError(403, "FORBIDDEN", "private"), fetchFailureCount: 1 }); });
  await screen.findByText("hidden");
  expect(screen.queryByText("Private probe data")).toBeNull();
 } finally { ui.unmount(); client.clear(); }
});

it.each([
 { name: "access", error: new ApiError(403, "FORBIDDEN", "private"), isError: true, failureCount: 1, data: {}, isPending: false, isFetching: false, quiet: false, label: "Access ended" },
 { name: "quiet access", error: new ApiError(404, "NOT_FOUND", "private"), isError: true, failureCount: 1, data: {}, isPending: false, isFetching: false, quiet: true, label: "Access ended" },
 { name: "unavailable", error: new ApiError(501, "NOT_ON_CODE_YET", "private"), isError: true, failureCount: 1, data: undefined, isPending: false, isFetching: false, quiet: false, label: "Can't tell yet. This read isn't available here yet." },
 { name: "quiet unavailable", error: new ApiError(501, "NOT_ON_CODE_YET", "private"), isError: true, failureCount: 1, data: undefined, isPending: false, isFetching: false, quiet: true, label: "Can't tell yet." },
 { name: "pending", error: null, isError: false, failureCount: 0, data: {}, isPending: true, isFetching: false, quiet: false, label: "Loading the latest read…" },
 { name: "refetching", error: null, isError: false, failureCount: 0, data: {}, isPending: false, isFetching: true, quiet: false, label: "Loading the latest read…" },
 { name: "missing", error: null, isError: false, failureCount: 0, data: undefined, isPending: false, isFetching: false, quiet: false, label: "Can't tell yet." },
 { name: "quiet missing", error: null, isError: false, failureCount: 0, data: undefined, isPending: false, isFetching: false, quiet: true, label: "Can't tell yet." },
])("ReadState $name never exposes child facts", async input => {
 const read = { ...input, dataUpdatedAt: Date.now(), refetch() {} };
 const ui = renderUi(h(ReadState, { read, quiet: input.quiet, children: h("p", {}, "Private child facts") }));
 try { expect(screen.getByText(input.label)).toBeTruthy(); expect(screen.queryByText("Private child facts")).toBeNull(); }
 finally { ui.unmount(); }
});

it("read helpers preserve successful and transient facts but hide access-ended facts", () => {
 const read = { isError: false, failureCount: 0, error: null as unknown, data: {}, dataUpdatedAt: Date.now() };
 expect(failed(read)).toBe(false);
 expect(failed({ ...read, isError: true, error: new ApiError(503, "UNAVAILABLE", "offline") })).toBe(false);
 expect(failed({ ...read, isError: true, error: new ApiError(401, "AUTH_REQUIRED", "private") })).toBe(true);
 expect(failed({ ...read, data: undefined })).toBe(true);
 expect(readClock(0)).toBeUndefined();
 expect(readClock(-1)).toBeUndefined();
 expect(readClock(Number.NaN)).toBeUndefined();
 expect(readClock(Number.POSITIVE_INFINITY)).toBeUndefined();
 expect(readClock(read.dataUpdatedAt)).toBe(new Date(read.dataUpdatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
});

it.each([
 { isPending: false, isFetching: false, isError: false, failureCount: 0, expected: true },
 { isPending: true, isFetching: false, isError: false, failureCount: 0, expected: false },
 { isPending: false, isFetching: true, isError: false, failureCount: 0, expected: false },
 { isPending: false, isFetching: true, isError: true, failureCount: 1, expected: true },
])("header confirmation follows the current read state $isPending/$isFetching/$isError", input => {
 const read = { ...input, data: {}, error: input.isError ? new ApiError(503, "UNAVAILABLE", "offline") : null, dataUpdatedAt: Date.now(), refetch() {} };
 const ui = renderUi(h(ReadState, { read, header: (confirmed: boolean) => h("p", {}, "confirmed=" + String(confirmed)), children: "facts" }));
 try { expect(screen.getByText("confirmed=" + String(input.expected))).toBeTruthy(); }
 finally { ui.unmount(); }
});
it("failureReason access signal has the same refusal boundary as the final error", () => {
 const read = { isPending: false, isFetching: false, isError: false, failureCount: 1, error: null, failureReason: new ApiError(404, "NOT_FOUND", "private"), data: {}, dataUpdatedAt: Date.now(), refetch() {} };
 const ui = renderUi(h(ReadState, { read, children: "Private child facts" }));
 try { expect(screen.getByText("Access ended")).toBeTruthy(); expect(screen.queryByText("Private child facts")).toBeNull(); }
 finally { ui.unmount(); }
});

// @vitest-environment jsdom
// The plan approval page's one script (packages/cloud-server/src/approve.ts): behind CloudFront the function URL takes only signed
// requests, and a signed POST needs its body's SHA-256 in x-amz-content-sha256, so the form posts through fetch with that header.
import { createHash } from "node:crypto";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_FORM_SCRIPT } from "../../packages/cloud-server/src/approve.js";

// tests/unit has no DOM types: the few parts of jsdom's window this test touches.
interface Element { textContent: string | null; click(): void }
interface TestWindow {
  document: { body: Element & { innerHTML: string }; title: string; querySelector(selector: string): Element | null };
  history: { replaceState(data: null, unused: string, url: string): void };
  location: { pathname: string; assign(url: string): void };
}
const dom = globalThis as unknown as TestWindow & typeof globalThis;
const { document } = dom;

const FORM = `<form method="post"><input type="hidden" name="csrf" value="c&amp;1"><input type="hidden" name="revision" value="4">`
  + `<textarea name="reason">Keep the héading</textarea><button type="submit" name="decision" value="APPROVE">Approve</button>`
  + `<button type="submit" name="decision" value="REQUEST_CHANGES">Request changes</button></form>`;

function mount(answer: () => Promise<Response>) {
  document.body.innerHTML = FORM;
  dom.history.replaceState(null, "", "/v1/app/approve/plan-ses_aaaaaaaaaaaaaaaaaaaa");
  const fetch = vi.fn(answer);
  vi.stubGlobal("fetch", fetch);
  const assign = vi.fn();
  vi.spyOn(dom, "location", "get").mockReturnValue({ ...dom.location, pathname: "/v1/app/approve/plan-ses_aaaaaaaaaaaaaaaaaaaa", assign });
  // The page's fixed script, run as the browser runs it: at the page's top level.
  runInThisContext(APPROVAL_FORM_SCRIPT);
  return { fetch, assign };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const press = async (value: string) => { document.querySelector(`button[value="${value}"]`)!.click(); await settle(); };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ""; });

describe("the approval page's form script", () => {
  it("posts the pressed decision and the form's fields with the body's SHA-256, then follows Cloud's redirect", async () => {
    const answered = Object.defineProperty(new Response("", { status: 200 }), "redirected", { value: true });
    Object.defineProperty(answered, "url", { value: "https://cloud.example/s/ses_aaaaaaaaaaaaaaaaaaaa" });
    const { fetch, assign } = mount(async () => answered);
    await press("REQUEST_CHANGES");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(path).toBe("/v1/app/approve/plan-ses_aaaaaaaaaaaaaaaaaaaa");
    const body = init.body as string;
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ csrf: "c&1", revision: "4", reason: "Keep the héading", decision: "REQUEST_CHANGES" });
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", "x-amz-content-sha256": createHash("sha256").update(body, "utf8").digest("hex") });
    expect(assign).toHaveBeenCalledExactlyOnceWith("https://cloud.example/s/ses_aaaaaaaaaaaaaaaaaaaa");
  });

  it("shows the page Cloud answered with when it isn't a redirect", async () => {
    mount(async () => new Response("<!doctype html><html><head><title>The plan changed</title></head><body><h1>The plan changed</h1></body></html>", { status: 409 }));
    await press("APPROVE");
    expect(document.title).toBe("The plan changed");
    expect(document.querySelector("h1")?.textContent).toBe("The plan changed");
    expect(document.querySelector("form")).toBeNull();
  });

  it("says it couldn't send, with fixed words, when the request fails", async () => {
    mount(async () => { throw new TypeError("network detail that must not show"); });
    await press("APPROVE");
    expect(document.body.textContent).toContain("Couldn't send your decision. Try again.");
    expect(document.body.textContent).not.toContain("network detail");
  });
});

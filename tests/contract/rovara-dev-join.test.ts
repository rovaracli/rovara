// Plan 2, Task 6: the rovara.dev/join forwarder. web/rovara-dev-join is the reviewed source of three static files that are copied
// to site/join/ in the rovara-dev GitHub Pages repo. The invite rides in the URL fragment (never sent to GitHub Pages); join.js
// takes it out of the address bar first, checks its shape, reads the cell's address from the same origin and sends the browser there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { parseHtml } from "../support/fake-dom.js";

const DIR = join(import.meta.dirname, "..", "..", "web", "rovara-dev-join");
const html = readFileSync(join(DIR, "index.html"), "utf8");
const script = readFileSync(join(DIR, "join.js"), "utf8");
const TOKEN = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U-_";
const CELL = "https://abc.execute-api.us-west-2.amazonaws.com";

interface Run { replaced: string[]; history: Array<[unknown, string, string | undefined]>; fetched: string[]; message: string; events: string[] }

/** Runs join.js in a sandbox the way a browser would at https://rovara.dev/join/<search><hash>. */
async function run(options: { hash?: string; search?: string; cell?: unknown; cellStatus?: number; fetchFails?: boolean } = {}): Promise<Run> {
  const document = parseHtml(html);
  const events: string[] = [];
  const replaced: string[] = [];
  const history: Run["history"] = [];
  const fetched: string[] = [];
  const location = { hash: options.hash ?? "", search: options.search ?? "", pathname: "/join/", replace: (url: string) => { events.push("replace"); replaced.push(url); } };
  const sandbox = {
    document, location, URL, URLSearchParams,
    history: { replaceState: (state: unknown, title: string, url?: string) => { events.push("replaceState"); history.push([state, title, url]); } },
    fetch: async (url: string) => {
      events.push("fetch");
      fetched.push(url);
      if (options.fetchFails === true) throw new Error("offline");
      const status = options.cellStatus ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => (options.cell === undefined ? { cellUrl: CELL } : options.cell) };
    },
  };
  vm.runInNewContext(script, sandbox);
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  return { replaced, history, fetched, message: document.getElementById("message")?.textContent ?? "", events };
}

describe("web/rovara-dev-join/index.html", () => {
  const document = parseHtml(html);
  it("loads no script other than join.js, and nothing from another origin", () => {
    expect(document.querySelectorAll("script").map((element) => [element.getAttribute("src"), element.textContent])).toEqual([["join.js", ""]]);
    expect(html).not.toMatch(/(?:src|href|action)\s*=\s*"(?:https?:)?\/\//i);
    expect(document.querySelectorAll("link, iframe, img, form, style")).toEqual([]);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
  it("sends no referrer and sets the content security policy", () => {
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toBe("default-src 'self'; script-src 'self'; connect-src 'self'");
  });
  it("tells a browser without JavaScript what to run", () => {
    expect(document.querySelector("noscript")?.textContent.trim()).toBe("Turn on JavaScript to open this invite, or run: agentx login --invite <link>");
  });
});

describe("web/rovara-dev-join/cell.json", () => {
  const cell = JSON.parse(readFileSync(join(DIR, "cell.json"), "utf8")) as { cellUrl: string };
  it("names an https cell with no query or hash", () => {
    const url = new URL(cell.cellUrl);
    expect(url.protocol).toBe("https:");
    expect(url.search + url.hash).toBe("");
    expect(Object.keys(cell)).toEqual(["cellUrl"]);
  });
});

describe("web/rovara-dev-join/join.js", () => {
  it("sends the browser to exactly the cell's join URL for an invite in the fragment, and clears the address first", async () => {
    const result = await run({ hash: `#invite=${TOKEN}` });
    expect(result.replaced).toEqual([`${CELL}/v1/auth/join?invite=${TOKEN}`]);
    expect(result.fetched).toEqual(["./cell.json"]);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]?.[2]).toBe("/join/");
    expect(result.history[0]?.[2]).not.toContain(TOKEN);
    expect(result.events).toEqual(["replaceState", "fetch", "replace"]);
  });

  it("accepts the older ?invite= links", async () => {
    const result = await run({ search: `?invite=${TOKEN}` });
    expect(result.replaced).toEqual([`${CELL}/v1/auth/join?invite=${TOKEN}`]);
    expect(result.events[0]).toBe("replaceState");
    expect(result.history[0]?.[2]).toBe("/join/");
  });

  it("reads only the invite from the fragment", async () => {
    const result = await run({ hash: `#utm=1&invite=${TOKEN}&redirect=https://evil.example` });
    expect(result.replaced).toEqual([`${CELL}/v1/auth/join?invite=${TOKEN}`]);
  });

  it.each([["a short one", "#invite=short"], ["an empty one", "#invite="], ["none", ""], ["a long one", `#invite=${TOKEN}A`], ["one with a slash", `#invite=${TOKEN.slice(0, 42)}/`], ["one with markup", `#invite=${TOKEN.slice(0, 40)}<b>`]])("does not fetch or redirect for %s", async (_name, hash) => {
    const result = await run({ hash });
    expect(result.fetched).toEqual([]);
    expect(result.replaced).toEqual([]);
    expect(result.message).toBe("This invite link isn't valid");
    expect(result.events[0]).toBe("replaceState");
  });

  it("clears a bad fragment too", async () => {
    expect((await run({ hash: "#invite=short" })).history).toHaveLength(1);
  });

  it.each([
    ["http", "http://evil"], ["http with a real-looking host", "http://abc.execute-api.us-west-2.amazonaws.com"], ["a query", "https://x/?a=1"], ["an empty query", "https://x/?"],
    ["a hash", "https://x/#a"], ["an empty hash", "https://x/#"], ["a password", "https://user:pw@x"], ["not a URL", "not a url"], ["a javascript URL", "javascript:alert(1)"], ["a number", 7], ["nothing", undefined], ["a relative path", "/v1/auth"],
  ])("does not redirect for a cellUrl with %s", async (_name, cellUrl) => {
    const result = await run({ hash: `#invite=${TOKEN}`, cell: { cellUrl } });
    expect(result.replaced).toEqual([]);
    expect(result.message).toBe("Rovara is not reachable from this link right now. Try again later.");
  });

  it.each([["a body that is not an object", null], ["a list", []], ["a string", "https://x"]])("does not redirect for %s", async (_name, cell) => {
    const result = await run({ hash: `#invite=${TOKEN}`, cell });
    expect(result.replaced).toEqual([]);
    expect(result.message).toBe("Rovara is not reachable from this link right now. Try again later.");
  });

  it("says Rovara is not reachable when cell.json cannot be read", async () => {
    for (const options of [{ cellStatus: 404 }, { fetchFails: true }]) {
      const result = await run({ hash: `#invite=${TOKEN}`, ...options });
      expect(result.replaced).toEqual([]);
      expect(result.message).toBe("Rovara is not reachable from this link right now. Try again later.");
    }
  });

  it("keeps a path on the cell's base (a stage) and drops a trailing slash", async () => {
    const result = await run({ hash: `#invite=${TOKEN}`, cell: { cellUrl: `${CELL}/prod/` } });
    expect(result.replaced).toEqual([`${CELL}/prod/v1/auth/join?invite=${TOKEN}`]);
  });

  it("never writes markup: it sets text only", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|document\.cookie/);
  });
});

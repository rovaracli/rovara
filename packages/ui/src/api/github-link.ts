// "Your GitHub account" (L4-GH): the GitHub account a person links to themselves, so Rovara can tell which pull requests and commits are theirs. Read and changed through Cloud's
// `/v1/app/me/github` routes (Cloud passes them to Rovara Code as the person; Code answers 501 here until it serves them, and the page says "not connected yet").
//   GET    /v1/app/me/github        -> { linked: false } | { linked: true, login, linkedAt? }
//   POST   /v1/app/me/github/link   -> { authorizeUrl } (GitHub's page); GitHub then sends the person back to the profile with `?github_link=<word>`
//   DELETE /v1/app/me/github        -> { unlinked: boolean }
// Every reader is total over untrusted data. Words shown come from this file, never from the server or GitHub.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const MY_GITHUB_PATH = "/v1/app/me/github";
export const MY_GITHUB_LINK_PATH = MY_GITHUB_PATH + "/link";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
export type MyGithub = { linked: false } | { linked: true; login: string; linkedAt?: string };
export function readMyGithub(body: unknown): MyGithub {
 if (isRecord(body) && body["linked"] === false) return { linked: false };
 if (isRecord(body) && body["linked"] === true && typeof body["login"] === "string" && LOGIN.test(body["login"])) {
  const at = body["linkedAt"];
  return { linked: true, login: body["login"], ...(typeof at === "string" && Number.isFinite(Date.parse(at)) ? { linkedAt: at } : {}) };
 }
 throw new Error("not a GitHub link");
}

/** GitHub's login page Cloud answered for a link: https, github.com's own authorize path, or nothing. */
export function readGithubLinkStart(body: unknown): { authorizeUrl: string } {
 const value = isRecord(body) ? body["authorizeUrl"] : undefined;
 try {
  const url = new URL(typeof value === "string" ? value : "");
  if (url.protocol === "https:" && url.hostname === "github.com" && url.pathname === "/login/oauth/authorize" && url.username === "" && url.password === "" && url.port === "" && url.hash === "") return { authorizeUrl: url.toString() };
 } catch { /* falls through */ }
 throw new Error("not GitHub's address");
}

/** What the landing address says (`?github_link=<word>`), as one fixed sentence; anything else is nothing. */
export function githubLinkNotice(word: string | null): { tone: "ok" | "bad"; text: string } | undefined {
 switch (word) {
  case "linked": return { tone: "ok", text: "Your GitHub account is connected. Rovara can now tell which commits and pull requests are yours." };
  case "cancelled": return { tone: "bad", text: "Connecting GitHub was cancelled. Nothing changed." };
  case "taken": return { tone: "bad", text: "That GitHub account is already connected to another member of your company." };
  case "exists": return { tone: "bad", text: "You already have a GitHub account connected. Disconnect it first." };
  case "not_available": return { tone: "bad", text: "Connecting your GitHub account isn't available yet." };
  case "start_again": return { tone: "bad", text: "That didn't work. Start again from here." };
  case "unavailable": return { tone: "bad", text: "Your GitHub account couldn't be connected just now. Try again." };
  default: return undefined;
 }
}

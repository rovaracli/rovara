// Plan 2, Task 6: `agentx login --invite <link>`. An invite link comes in these shapes (UX1 adds a cell's own <origin>/join#invite=<token>): the rovara.dev link a cloud install hands out
// (https://rovara.dev/join#invite=<token>), the link of a cell's own join page (<cell>/v1/auth/join?invite=<token>) and the bare
// token. This file reads them, finds the cell, and asks that cell, before any browser opens, what the invite is for (ruling R19).
import { INVITE_WRONG_EMAIL_MESSAGE, agentXError } from "@rovara-code/contracts";
import { createInterface } from "node:readline";
import { z } from "zod";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

/** The one host whose /join page the CLI trusts to name a cell: the rovara.dev forwarder (web/rovara-dev-join). */
export const ROVARA_DIRECTORY_ORIGIN = "https://rovara.dev";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NOT_AN_INVITE = "that is not a Rovara invite link";
const CELL_JOIN_SUFFIX = "/v1/auth/join";
export const INVITE_NO_LONGER_USABLE = "That invite can no longer be used; ask for a new one.";

export interface ParsedInviteLink { token: string; cellUrl?: string; directoryOrigin?: string }

/** The invite and, when the link says so, the cell it is for or the directory that knows the cell. */
/**
 * `knownCells` (UX1 review I1): the cells this computer already signs in to (its saved logins) and any URL the person gave. A cloud cell serves its own
 * invite page at <origin>/join, and such a link is read as that cell only when its origin is one of these; any other host's /join is refused as before.
 */
export function parseInviteLink(link: string, knownCells: readonly string[] = []): ParsedInviteLink {
  const text = link.trim();
  if (TOKEN_PATTERN.test(text)) return { token: text };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw agentXError("CONFIG_INVALID", NOT_AN_INVITE);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw agentXError("CONFIG_INVALID", NOT_AN_INVITE);
  const path = url.pathname.replace(/\/+$/, "");
  let where: Pick<ParsedInviteLink, "cellUrl" | "directoryOrigin">;
  if (path.endsWith(CELL_JOIN_SUFFIX)) where = { cellUrl: `${url.origin}${path.slice(0, -CELL_JOIN_SUFFIX.length)}` };
  else if (path === "/join" && url.origin === ROVARA_DIRECTORY_ORIGIN) where = { directoryOrigin: url.origin };
  // UX1: a cloud cell serves its own invite page at <app origin>/join; the CLI follows it only to a cell it already knows. Only rovara.dev is the directory.
  else if (path === "/join" && knownOrigins(knownCells).has(url.origin)) where = { cellUrl: url.origin };
  else throw agentXError("CONFIG_INVALID", NOT_AN_INVITE);
  const token = new URLSearchParams(url.hash.replace(/^#/, "")).get("invite") ?? url.searchParams.get("invite");
  if (token === null || token === "") throw agentXError("CONFIG_INVALID", "that invite link has no invite in it");
  if (!TOKEN_PATTERN.test(token)) throw agentXError("CONFIG_INVALID", NOT_AN_INVITE);
  return { token, ...where };
}

/** The https origins of the known cells; anything unparsable or not https is left out. */
function knownOrigins(cells: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const cell of cells) {
    try {
      const url = new URL(cell);
      if (url.protocol === "https:" && url.username === "" && url.password === "") origins.add(url.origin);
    } catch {
      // Not a URL: not a known cell.
    }
  }
  return origins;
}

/** An https URL with no query, hash or password, as the cell's base: the same rule web/rovara-dev-join/join.js applies. */
function httpsCellBase(value: unknown): string | undefined {
  if (typeof value !== "string" || /[?#]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The cell's base URL for a parsed link: named by the link, or read from the directory's cell.json. */
export async function resolveInviteCell(parsed: ParsedInviteLink, fetchImplementation: typeof fetch): Promise<string> {
  if (parsed.cellUrl !== undefined) {
    const base = httpsCellBase(parsed.cellUrl);
    if (base === undefined) throw agentXError("CONFIG_INVALID", NOT_AN_INVITE);
    return base;
  }
  if (parsed.directoryOrigin === undefined) {
    throw agentXError("CONFIG_INVALID", "that invite is only a code, so it does not say where to sign in; add your Rovara address: agentx login <url> --invite <code>");
  }
  const unreachable = agentXError("RUNTIME_UNAVAILABLE", "Rovara is not reachable from this invite link right now; try again later");
  let body: unknown;
  try {
    const response = await fetchImplementation(`${parsed.directoryOrigin}/join/cell.json`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw unreachable;
    body = await response.json();
  } catch {
    throw unreachable;
  }
  const base = httpsCellBase(typeof body === "object" && body !== null ? (body as { cellUrl?: unknown }).cellUrl : undefined);
  if (base === undefined) throw unreachable;
  return base;
}

const InviteSummarySchema = z.object({ orgName: z.string(), role: z.enum(["admin", "member"]), state: z.literal("open"), /** A link no address is written for, on an install where only an invite lets a new person sign up: a new person opens it in a browser. */ inBrowserOnly: z.literal(true).optional() });
const InviteStateSchema = z.object({ state: z.enum(["expired", "used", "unknown"]) });
export type InviteSummary = z.infer<typeof InviteSummarySchema>;

/** What the cell's public join page says about an invite, as JSON: the organization and role for an open one, otherwise why not. */
export async function fetchInviteSummary(cellUrl: string, token: string, fetchImplementation: typeof fetch): Promise<InviteSummary> {
  let response: Response;
  try {
    response = await fetchImplementation(`${cellUrl}${CELL_JOIN_SUFFIX}?invite=${encodeURIComponent(token)}`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach Rovara at ${new URL(cellUrl).host} to check the invite; check your connection and try again`);
  }
  const body: unknown = await response.json().catch(() => undefined);
  const open = InviteSummarySchema.safeParse(body);
  if (response.ok && open.success) return open.data;
  const closed = InviteStateSchema.safeParse(body);
  if (closed.success) {
    throw agentXError("INVITE_INVALID", closed.data.state === "unknown"
      ? "that invite link isn't valid; check that you copied the whole link, or ask for a new invite"
      : INVITE_NO_LONGER_USABLE);
  }
  throw agentXError("RUNTIME_UNAVAILABLE", `${new URL(cellUrl).host} did not answer as a Rovara sign-in server; check the link or try again`);
}

/** The line shown before the browser opens (ruling R19): who the invite is for, in what role, and which server will sign you in. */
export const inviteConfirmationLine = (summary: InviteSummary, cellUrl: string): string =>
  `This invite is for ${sanitizeServerText(summary.orgName)} (as ${summary.role}) on ${new URL(cellUrl).host}.`;
/** Said after the confirmation line when the invite is a link no address is written for (`inBrowserOnly`): such a person's first sign-in needs the browser page, which asks for their email address. */
export const INVITE_BROWSER_NOTE = "This invite is a link, not sent to an email address. If you are new to Rovara, open the link in a browser instead: its page asks for your email address and sends you a sign-in code. If you already have a Rovara account, continue here.";
export const INVITE_QUESTION = "Open the browser to join? (Y/n)";
/** With --no-browser nothing opens, so the question does not say it will. */
export const INVITE_QUESTION_NO_BROWSER = "Continue to join? (Y/n)";

/** How a sign-in with an invite ended when the invite was not used (the sign-in itself still succeeded). */
export const InviteOutcomeSchema = z.enum(["ALREADY_IN_ORG", "INVITE_INVALID", "INVITE_WRONG_EMAIL"]);
export type InviteOutcome = z.infer<typeof InviteOutcomeSchema>;

/** What to tell the person once the browser step is over: the joined line, or the exact words for why the invite was not used. `org` is the organization they are in now. */
export function inviteOutcomeText(outcome: "joined" | InviteOutcome, org?: { name: string; role: string }): string {
  switch (outcome) {
    case "joined":
      return org === undefined ? "You joined the organization." : `You joined ${sanitizeServerText(org.name)} as ${sanitizeServerText(org.role)}.`;
    case "ALREADY_IN_ORG": {
      if (org === undefined) return "You're already in another Rovara organization. For now, a person can belong to one Rovara organization: sign in with a different email address, or ask an owner of that organization to remove you. If it is a team you made by mistake and no one else is in it, run agentx org leave and try the invite again.";
      const name = sanitizeServerText(org.name);
      return `You're already in ${name}. For now, a person can belong to one Rovara organization: sign in with a different email address, or ask an owner of ${name} to remove you. If ${name} is a team you made by mistake and no one else is in it, run agentx org leave and try the invite again.`;
    }
    case "INVITE_WRONG_EMAIL":
      return INVITE_WRONG_EMAIL_MESSAGE;
    case "INVITE_INVALID":
      return INVITE_NO_LONGER_USABLE;
  }
}

const CurrentOrgSchema = z.object({ org: z.object({ name: z.string() }), role: z.string() });

/** The organization the person is in now and their role there (GET /v1/dev/org), for the line after an invite sign-in; undefined when it cannot be read. */
export async function fetchCurrentOrg(deps: DeveloperSessionDeps, env: string): Promise<{ name: string; role: string } | undefined> {
  try {
    const { body } = await developerRequest(deps, env, "/v1/dev/org", CurrentOrgSchema);
    return { name: body.org.name, role: body.role };
  } catch {
    return undefined;
  }
}

/**
 * Asks "<question> " and reads one line: an empty line, y or yes is a yes (the question reads (Y/n)); n or no is a no. Ctrl-C or the end of
 * input is never a yes; it declines.
 */
export function askYesByDefault(question: string, streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; signals?: NodeJS.EventEmitter }): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: streams.input, output: streams.output, terminal: (streams.input as { isTTY?: boolean }).isTTY === true });
    let settled = false;
    const finish = (answer: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      streams.signals?.off("SIGINT", interrupt);
      rl.close();
      if (answer === undefined) reject(agentXError("CONFIRMATION_DECLINED", "the prompt ended without a yes, so nothing changed; run the command again to join"));
      else resolve(answer);
    };
    function interrupt(): void { finish(undefined); }
    rl.on("SIGINT", interrupt);
    rl.on("close", interrupt);
    streams.signals?.once("SIGINT", interrupt);
    const ask = (): void => {
      rl.question(`${question} `, (line) => {
        const answer = line.trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") finish(true);
        else if (answer === "n" || answer === "no") finish(false);
        else {
          streams.output.write("  answer y or n\n");
          ask();
        }
      });
    };
    ask();
  });
}

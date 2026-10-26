// Rovara Code (Plan 6 Task 10): what a drafted dev setup is allowed to say. The draft is MODEL OUTPUT read from files an outsider may have written (a README, a Makefile, a CI
// file), so it is a proposal and nothing more: this module turns whatever the model answered into a `SetupDraft` that is bounded, redacted, one line per command and
// honest about what it would run. The worker runs it on the model's answer and the broker runs it again on whatever the worker reported (the broker never trusts the
// worker's copy), so both sides read a draft the same way.
//
// What it guarantees about the draft it returns:
//   - every text is redacted (`redactText`) and cut to its limit, and a command with a control or format character (a newline, an escape, a bidirectional override, a
//     zero-width character) is left out and counted in the notes, because a person could not see what it would run;
//   - a command that can run is written as the executor will run it (`formatCommandLine` of `parseCommandLine`): same program, same arguments, one line. One that can't be
//     read as a single program (`curl x | sh`) is kept as written, so the person sees what the repository asks for;
//   - a command that fetches code from the internet and runs it is in `flaggedCommands`, whatever the model said (`remoteCodeReason` decides, not the model);
//   - a secret is a NAME (letters, digits, `_`, `.`, `-`); a value that came with it is cut off;
//   - a domain is one the project settings accept, a devcontainer is a path inside one of the project's repositories, and the revision is the caller's, never the model's.
import {
  SETUP_DRAFT_SECRETS_MAX, SetupDraftSchema, type SetupDraft,
} from "./rovara-code.js";
import { ALLOWED_DOMAIN_MESSAGE, isAllowedDomain } from "./app-projects.js";
import { formatCommandLine, parseCommandLine, SETUP_TIMEOUT } from "./project-commands.js";
import { redactText } from "./redaction.js";

/** What a person is told about a command that fetches code and runs it (the plan's exact words). */
export const REMOTE_CODE_REASON = "Runs a script downloaded from the internet.";

/** The project settings take at most this many commands of each kind, each at most this long (`ProjectSettingsBodySchema`). */
export const SETUP_DRAFT_COMMANDS_MAX = 16;
export const SETUP_DRAFT_COMMAND_MAX_CHARS = 500;
export const SETUP_DRAFT_DOMAINS_MAX = 50;
/** A proposed devcontainer file is sent to a pull request intent (8 KiB of text with its instructions), so it is cut well below that. */
export const SETUP_DRAFT_DEVCONTAINER_MAX_BYTES = 6_000;
/** The raw answer a draft is read from is never larger than this. */
export const SETUP_DRAFT_ANSWER_MAX_BYTES = 262_144;

/** The only places a dev container's configuration lives. */
const DEVCONTAINER_PATH = /^(?:\.devcontainer\/(?:[A-Za-z0-9_.-]{1,64}\/)?devcontainer\.json|\.devcontainer\.json)$/u;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/u;
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

// ---- commands that fetch code and run it

const FETCH_TOOL = String.raw`(?:curl|wget|fetch|aria2c|iwr|irm|invoke-webrequest|invoke-restmethod)`;
const INTERPRETER = String.raw`(?:sudo\s+(?:-\S+\s+)*|env\s+(?:\S+=\S+\s+)*|xargs\s+(?:-\S+\s+)*|exec\s+)*(?:ba|z|da|k|c|fi)?sh|python[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|pwsh|powershell|iex|invoke-expression|source|eval`;
const REMOTE_CODE_PATTERNS: readonly RegExp[] = [
  // curl ... | sh, wget -qO- ... | sudo bash, iwr ... | iex
  new RegExp(String.raw`(?<![\w-])${FETCH_TOOL}(?![\w-])[^\n]*\|\s*(?:${INTERPRETER})(?![\w-])`, "iu"),
  // bash <(curl ...), source <(wget ...), . <(curl ...)
  new RegExp(String.raw`<\(\s*${FETCH_TOOL}(?![\w-])`, "iu"),
  // sh -c "$(curl ...)", eval "$(wget ...)", bash `curl ...`
  new RegExp(String.raw`(?:\$\(|\x60)\s*${FETCH_TOOL}(?![\w-])`, "iu"),
  // curl ... -o file && sh file, curl ... ; bash ./file
  new RegExp(String.raw`(?<![\w-])${FETCH_TOOL}(?![\w-])[^\n]*(?:&&|;)\s*(?:(?:${INTERPRETER})\s|chmod\s+\+x\b|\.\/)`, "iu"),
  // sh -c "curl ... | ..." is covered above; a shell given a URL to run
  new RegExp(String.raw`(?<![\w-])(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*https?:\/\/`, "iu"),
];

/** `REMOTE_CODE_REASON` when the command fetches code from the internet and runs it, else undefined. A text with a hidden character is not read at all (it is left out earlier). */
export function remoteCodeReason(command: string): string | undefined {
  return REMOTE_CODE_PATTERNS.some((pattern) => pattern.test(command)) ? REMOTE_CODE_REASON : undefined;
}

// ---- helpers

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
/** Redacted, on one line (every run of whitespace, control and format characters is one space), and cut to `max` characters. */
export function oneLineText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...redactText(value).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, max).join("").trimEnd();
}
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/** What a command is, as it is shown, and whether it was left out (and why). */
type CommandReading = { kind: "kept"; text: string } | { kind: "left_out"; reason: "hidden" | "too_long" | "empty" };

function readCommand(raw: string): CommandReading {
  if (HIDDEN.test(raw)) return { kind: "left_out", reason: "hidden" };
  const redacted = redactText(raw).trim();
  if (redacted === "") return { kind: "left_out", reason: "empty" };
  if ([...redacted].length > SETUP_DRAFT_COMMAND_MAX_CHARS) return { kind: "left_out", reason: "too_long" };
  try {
    // As the executor will run it: the same program and arguments, quoted once.
    const text = formatCommandLine(parseCommandLine(redacted, ".", SETUP_TIMEOUT));
    return [...text].length > SETUP_DRAFT_COMMAND_MAX_CHARS ? { kind: "left_out", reason: "too_long" } : { kind: "kept", text };
  } catch {
    // Not one program (a pipe, `&&`, an unclosed quote): shown as written, with whitespace made single so a person reads one line.
    return { kind: "kept", text: redacted.replace(/\s+/gu, " ") };
  }
}

interface CommandResult { commands: string[]; leftOut: { hidden: number; tooLong: number; extra: number } }

function readCommands(value: unknown): CommandResult {
  const commands: string[] = [];
  const leftOut = { hidden: 0, tooLong: 0, extra: 0 };
  for (const raw of strings(value)) {
    const reading = readCommand(raw);
    if (reading.kind === "left_out") {
      if (reading.reason === "hidden") leftOut.hidden += 1;
      else if (reading.reason === "too_long") leftOut.tooLong += 1;
      continue;
    }
    if (commands.includes(reading.text)) continue;
    if (commands.length >= SETUP_DRAFT_COMMANDS_MAX) { leftOut.extra += 1; continue; }
    commands.push(reading.text);
  }
  return { commands, leftOut };
}

/** A secret's name from what the model wrote: the part before any `=` (a value that came with it is dropped), if that is a name. */
function secretNameOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.split("=", 1)[0]!.trim();
  return SECRET_NAME.test(name) ? name : undefined;
}

export interface SetupDraftContext {
  /** The project revision the draft was made for: the caller's, never the model's. */
  basedOnRevision: number;
  /** The names of the project's repositories, for the devcontainer's. */
  repositories: readonly string[];
}

export type SetupDraftReading = { ok: true; draft: SetupDraft } | { ok: false; errors: string[] };

/**
 * Reads a model's answer (already parsed from JSON) as a draft. Lenient about what the model adds, strict about what it keeps; `ok: false` only when the answer is not an
 * object, or has nothing a person could use (no commands, no devcontainer, no domains and no secrets).
 */
export function sanitizeSetupDraft(raw: unknown, context: SetupDraftContext): SetupDraftReading {
  if (!isObject(raw)) return { ok: false, errors: ["the answer is not a JSON object"] };
  const notes: string[] = [];
  const setup = readCommands(raw["setupCommands"]);
  const test = readCommands(raw["testCommands"]);
  const hidden = setup.leftOut.hidden + test.leftOut.hidden;
  const tooLong = setup.leftOut.tooLong + test.leftOut.tooLong;
  const extra = setup.leftOut.extra + test.leftOut.extra;
  if (hidden > 0) notes.push(`${String(hidden)} command${hidden === 1 ? " was" : "s were"} left out because ${hidden === 1 ? "it has" : "they have"} hidden or control characters.`);
  if (tooLong > 0) notes.push(`${String(tooLong)} command${tooLong === 1 ? " was" : "s were"} left out because ${tooLong === 1 ? "it is" : "they are"} longer than ${String(SETUP_DRAFT_COMMAND_MAX_CHARS)} characters.`);
  if (extra > 0) notes.push(`${String(extra)} more command${extra === 1 ? " was" : "s were"} left out: a project keeps at most ${String(SETUP_DRAFT_COMMANDS_MAX)} of each kind.`);

  // Flags: every listed command the detector reads as "fetches and runs code", and any other the model flagged that is in a list (it may only add caution).
  const listed = new Set([...setup.commands, ...test.commands]);
  const flagged = new Map<string, string>();
  for (const command of listed) {
    const reason = remoteCodeReason(command);
    if (reason !== undefined) flagged.set(command, reason);
  }
  const modelFlags = Array.isArray(raw["flaggedCommands"]) ? raw["flaggedCommands"] : [];
  for (const entry of modelFlags) {
    const command = isObject(entry) ? readCommand(typeof entry["command"] === "string" ? entry["command"] : "") : { kind: "left_out" as const, reason: "empty" as const };
    if (command.kind !== "kept" || !listed.has(command.text) || flagged.has(command.text)) continue;
    const reason = oneLineText(isObject(entry) ? entry["reason"] : undefined, 300);
    flagged.set(command.text, reason === "" ? "Rovara flagged this command." : reason);
  }

  const secrets: SetupDraft["secretsNeeded"] = [];
  const seen = new Set<string>();
  const rawSecrets = Array.isArray(raw["secretsNeeded"]) ? raw["secretsNeeded"] : [];
  for (const entry of rawSecrets) {
    const source = typeof entry === "string" ? { name: entry } : isObject(entry) ? entry : undefined;
    const name = source === undefined ? undefined : secretNameOf(source["name"]);
    if (name === undefined || seen.has(name)) continue;
    if (secrets.length >= SETUP_DRAFT_SECRETS_MAX) { notes.push(`Only the first ${String(SETUP_DRAFT_SECRETS_MAX)} secret names are listed.`); break; }
    seen.add(name);
    secrets.push({ name, why: oneLineText(source?.["why"], 300), foundIn: oneLineText(source?.["foundIn"], 500) });
  }

  const domains: string[] = [];
  for (const domain of strings(raw["allowedDomains"])) {
    const lower = domain.trim().toLowerCase();
    if (!isAllowedDomain(lower)) { notes.push(`A domain was left out: it ${ALLOWED_DOMAIN_MESSAGE}.`); continue; }
    if (!domains.includes(lower) && domains.length < SETUP_DRAFT_DOMAINS_MAX) domains.push(lower);
  }

  let devcontainer: SetupDraft["devcontainer"];
  if (isObject(raw["devcontainer"])) {
    const source = raw["devcontainer"];
    const repository = typeof source["repository"] === "string" ? source["repository"] : "";
    const configPath = typeof source["configPath"] === "string" ? source["configPath"] : "";
    if (!context.repositories.includes(repository) || !DEVCONTAINER_PATH.test(configPath)) {
      notes.push("A dev container was left out: it has to be a devcontainer.json inside one of the project's repositories.");
    } else {
      const exists = source["exists"] === true;
      const proposed = typeof source["proposedContent"] === "string" ? redactText(source["proposedContent"]).replace(/\r\n?/gu, "\n") : undefined;
      const usable = !exists && proposed !== undefined && proposed.trim() !== "" && utf8Bytes(proposed) <= SETUP_DRAFT_DEVCONTAINER_MAX_BYTES && !/[\p{Cc}\p{Cf}]/u.test(proposed.replace(/[\n\t]/gu, ""));
      if (!exists && proposed !== undefined && !usable) notes.push("A proposed dev container file was left out: it is empty, too long or has control characters.");
      devcontainer = { repository, configPath, exists, ...(usable ? { proposedContent: proposed } : {}) };
    }
  }

  const noteText = typeof raw["notes"] === "string" ? redactText(raw["notes"]).replace(/\r\n?/gu, "\n").replace(/(?!\n)\p{Cc}|\p{Cf}/gu, " ").replace(/[^\S\n]+/gu, " ").trim() : "";
  const allNotes = [...(noteText === "" ? [] : [noteText]), ...notes].join("\n");
  const draft: SetupDraft = {
    basedOnRevision: context.basedOnRevision,
    setupCommands: setup.commands,
    testCommands: test.commands,
    ...(devcontainer === undefined ? {} : { devcontainer }),
    allowedDomains: domains,
    secretsNeeded: secrets,
    flaggedCommands: [...flagged].map(([command, reason]) => ({ command, reason })),
    notes: [...allNotes].slice(0, 2000).join(""),
  };
  const empty = draft.setupCommands.length === 0 && draft.testCommands.length === 0 && draft.devcontainer === undefined && draft.allowedDomains.length === 0 && draft.secretsNeeded.length === 0;
  if (empty) return { ok: false, errors: ["the answer has no commands, dev container, domains or secrets in it"] };
  const checked = SetupDraftSchema.safeParse(draft);
  return checked.success ? { ok: true, draft: checked.data } : { ok: false, errors: [`the draft is not valid: ${checked.error.issues[0]?.path.join(".") ?? "draft"}`] };
}

/** The label a worker puts on the fenced block that carries its answer. */
export const SETUP_DRAFT_INFO_STRING = "agentx-setup-draft";

/**
 * The JSON in the LAST block fenced with the setup-draft label of a model's final message, parsed; undefined when there is none or it is not JSON or is too large.
 * Anything outside the block is ignored: it is chat, not the draft.
 */
export function setupDraftAnswerOf(text: string): unknown {
  const pattern = new RegExp(String.raw`(?:^|\n)\x60\x60\x60${SETUP_DRAFT_INFO_STRING}[ \t]*\n([\s\S]*?)\n\x60\x60\x60(?=\n|$)`, "gu");
  let last: string | undefined;
  for (const match of text.matchAll(pattern)) last = match[1];
  if (last === undefined || utf8Bytes(last) > SETUP_DRAFT_ANSWER_MAX_BYTES) return undefined;
  try { return JSON.parse(last) as unknown; } catch { return undefined; }
}

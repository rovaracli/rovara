// Meta repo lane B (K1, task B3): the broker re-reads every place a setup proposal says a value came from. The worker's copy of a proposal is never trusted, and neither is the
// model behind it: a model can write a quote that is not in the file, or a file that does not exist. For each file citation (`file`, `ci`, `readme`, `manifest`) the broker reads
// `repo@commit:path` from GitHub and checks that the file is there and, when the citation names a quote, that the quote is in the file within a few lines of the cited line.
//
// An item is
//   `verified`    every file citation it has was read and holds, and it has at least one;
//   `unverified`  a citation was read and does NOT hold (the file is missing, or the quote is not near that line);
//   `unchecked`   nothing could be read: the item cites no file (an inferred one), GitHub could not be asked, or the budget for reads ran out.
// Only a verified, safe item is pre-ticked on the page. An unverified or unchecked item is still shown, so a person can decide, but never ticked for them.
//
// Bounded and fail closed: at most `READS_MAX` distinct files per proposal, a few at a time, within one deadline; whatever is left is `unchecked`. A file is read only up to the
// cited line (plus a margin), so a huge file costs little. Nothing here ever writes, and no text of a file is kept or returned: only the verdict.
import { FILE_PROVENANCE_KINDS, setupItemsOf, type Provenance, type SetupProposal, type SetupVerification } from "@agentx/contracts";

/** Reads a file at a commit in one of the project's repositories: undefined when the file is not there; throws when GitHub cannot answer. */
export type CitationFileReader = (repository: string, path: string, commit: string, options: { untilLine?: number; timeoutMs: number }) => Promise<string | undefined>;

export const VERIFY_READS_MAX = 40;
export const VERIFY_CONCURRENCY = 4;
export const VERIFY_DEADLINE_MS = 20_000;
export const VERIFY_READ_TIMEOUT_MS = 8_000;
/** How many lines either side of the cited line the quote may be on. Models are off by a line or two; a wider window would let a quote match anywhere. */
export const VERIFY_LINE_SLACK = 3;

type Verdict = "holds" | "fails" | "unread";

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

/** Whether a file's text supports a citation: the line exists, and the quote (whitespace collapsed) is within `VERIFY_LINE_SLACK` lines of it, or anywhere when no line is named. */
export function citationHolds(text: string, citation: Pick<Provenance, "line" | "quote">): boolean {
  const lines = text.split(/\r\n|\r|\n/u);
  if (citation.line !== undefined && citation.line > lines.length) return false;
  if (citation.quote === undefined) return true;
  const wanted = collapse(citation.quote);
  if (wanted === "") return true;
  if (citation.line === undefined) return collapse(text).includes(wanted);
  const from = Math.max(0, citation.line - 1 - VERIFY_LINE_SLACK);
  const window = lines.slice(from, citation.line + VERIFY_LINE_SLACK).join("\n");
  return collapse(window).includes(wanted);
}

/** The verdict for every item of a proposal. Never throws: a failed read leaves the items that needed it `unchecked`. */
export async function verifyProposal(
  read: CitationFileReader | undefined,
  proposal: SetupProposal,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<Record<string, SetupVerification>> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? VERIFY_DEADLINE_MS);
  const items = setupItemsOf(proposal);

  // One read per (repository, commit, path), as far as the deepest line any citation needs.
  const needs = new Map<string, { repository: string; path: string; commit: string; untilLine: number | undefined; whole: boolean }>();
  const keyOf = (citation: Provenance) => `${citation.repo!}\0${citation.commit!}\0${citation.path!}`;
  for (const item of items) {
    for (const citation of item.proposed.from) {
      if (!FILE_PROVENANCE_KINDS.includes(citation.kind)) continue;
      const key = keyOf(citation);
      const entry = needs.get(key) ?? { repository: citation.repo!, path: citation.path!, commit: citation.commit!, untilLine: 0, whole: false };
      // A quote with no line, or no line at all, needs the whole file; a line needs the text through it and the margin after.
      if (citation.line === undefined) entry.whole = true;
      else entry.untilLine = Math.max(entry.untilLine ?? 0, citation.line + VERIFY_LINE_SLACK + 1);
      needs.set(key, entry);
    }
  }

  const texts = new Map<string, { kind: "text"; text: string } | { kind: "missing" } | { kind: "unread" }>();
  const queue = [...needs.entries()].slice(0, VERIFY_READS_MAX);
  if (read !== undefined) {
    let next = 0;
    const worker = async () => {
      for (;;) {
        const index = next;
        next += 1;
        const entry = queue[index];
        if (entry === undefined) return;
        const remaining = deadline - now();
        if (remaining <= 0) { texts.set(entry[0], { kind: "unread" }); continue; }
        const [key, need] = entry;
        try {
          const text = await read(need.repository, need.path, need.commit, {
            ...(need.whole ? {} : { untilLine: need.untilLine! }), timeoutMs: Math.max(1, Math.min(VERIFY_READ_TIMEOUT_MS, remaining)),
          });
          texts.set(key, text === undefined ? { kind: "missing" } : { kind: "text", text });
        } catch {
          texts.set(key, { kind: "unread" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, worker));
  }

  const verdictOf = (citation: Provenance): Verdict => {
    const found = texts.get(keyOf(citation));
    if (found === undefined || found.kind === "unread") return "unread";
    if (found.kind === "missing") return "fails";
    return citationHolds(found.text, citation) ? "holds" : "fails";
  };

  const result: Record<string, SetupVerification> = {};
  for (const item of items) {
    const fileCitations = item.proposed.from.filter((citation) => FILE_PROVENANCE_KINDS.includes(citation.kind));
    if (fileCitations.length === 0) { result[item.id] = "unchecked"; continue; }
    const verdicts = fileCitations.map(verdictOf);
    result[item.id] = verdicts.includes("fails") ? "unverified" : verdicts.every((verdict) => verdict === "holds") ? "verified" : "unchecked";
  }
  return result;
}

/** Whether every verdict is final (nothing was left unread by an error or the budget), so it can be kept; an `unchecked` item with no file to read is final. */
export function verificationIsFinal(proposal: SetupProposal, verdicts: Record<string, SetupVerification>): boolean {
  return setupItemsOf(proposal).every((item) => verdicts[item.id] !== "unchecked" || !item.proposed.from.some((citation) => FILE_PROVENANCE_KINDS.includes(citation.kind)));
}

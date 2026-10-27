// Playbook P1: the Proof section when its inputs cannot be read in time. The description rewrite after a pushed PR-feedback fix runs under a short deadline (5 seconds), and the Proof section's reads (the
// approved plan, the test proof, the browser/API rows) must not be what abandons it. They are given a short time of their own; if they do not answer, the Proof section the description already has is kept
// exactly as it is (it may describe the code before the fix, which the next full rewrite corrects) and the rest of the block is brought up to date.
import { ROVARA_STATUS_END, ROVARA_STATUS_START } from "../developer/pull-request-feedback-section.js";

/** The longest the Proof section's reads may take inside the description rewrite, whatever the rewrite's own limit is. */
export const PROOF_READ_MAX_MS = 1_500;
const KEPT_LINES_MAX = 400;
const KEPT_BYTES_MAX = 16_000;

/** The Proof section's share of the rewrite's time limit: a third of it, at most `PROOF_READ_MAX_MS`. */
export function proofReadLimitMs(updateMaxMs: number): number {
  return Math.max(1, Math.min(PROOF_READ_MAX_MS, Math.floor(updateMaxMs / 3)));
}

/** `read`'s value if it answers within `ms`; `{ done: false }` when it is slower or fails (it is then left to finish or fail on its own, and its outcome is ignored). Never rejects. */
export async function withinTime<T>(ms: number, read: () => Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read().then((value) => ({ done: true as const, value }), () => ({ done: false as const })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The lines of the Proof section in `body`'s marked block (from its "### Proof" heading up to the next "## " heading), or undefined when there is none, the block is not exactly one pair of markers in order,
 * or the section is larger than a section Rovara writes. These are lines Rovara wrote into the block earlier; they go back into the same block.
 */
export function keptProofLines(body: string): string[] | undefined {
  const start = body.indexOf(ROVARA_STATUS_START);
  const end = body.indexOf(ROVARA_STATUS_END);
  if (start === -1 || end === -1 || end < start || body.indexOf(ROVARA_STATUS_START, start + 1) !== -1 || body.indexOf(ROVARA_STATUS_END, end + 1) !== -1) return undefined;
  const lines = body.slice(start + ROVARA_STATUS_START.length, end).split(/\r?\n/u);
  const from = lines.indexOf("### Proof");
  if (from === -1) return undefined;
  let to = lines.findIndex((line, index) => index > from && line.startsWith("## "));
  if (to === -1) to = lines.length;
  const kept = lines.slice(from, to);
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept.length > KEPT_LINES_MAX || Buffer.byteLength(kept.join("\n"), "utf8") > KEPT_BYTES_MAX ? undefined : kept;
}

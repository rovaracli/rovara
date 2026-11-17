// What a page read becomes on screen: numbered sources (one number per distinct file and lines, in the order the page first uses them), the markers each paragraph
// carries, and the thin note a paragraph gets when a claim it rests on changed, was not found or was marked wrong. Nothing here trusts the text; it only counts and groups.
import type { WikiBlock, WikiPageResponse, WikiShownClaim, WikiSourceState } from "../../../api/wiki.js";
import { safeExternalUrl } from "../../../text/links.js";

export interface Cite { n: number; repo: string; path: string; commit: string; line: number; lineEnd?: number; source: WikiSourceState; claims: string[] }
export interface BlockState { stale: { file: string } | undefined; notFound: boolean; flagged: boolean }
export interface PageModel { cites: Cite[]; markers(block: WikiBlock): Cite[]; state(block: WikiBlock): BlockState; outline: Array<{ blockId: string; text: string }> }

const rank: Record<WikiSourceState, number> = { found: 0, changed: 1, not_found: 2 };
const keyOf = (c: { repo: string; path: string; commit: string; line: number; lineEnd?: number | undefined }) => [c.repo, c.path, c.commit, c.line, c.lineEnd ?? ""].join("\u0000");

export function modelOf(res: WikiPageResponse): PageModel {
  const claims = new Map<string, WikiShownClaim>(res.page.claims.map((claim) => [claim.claimId, claim]));
  const cites = new Map<string, Cite>(), order: Cite[] = [];
  const claimIdsOf = (block: WikiBlock): string[] => (block.kind === "heading" ? [] : block.claimIds);
  const markersOf = (block: WikiBlock): Cite[] => {
    const seen = new Set<number>(), out: Cite[] = [];
    for (const id of claimIdsOf(block)) {
      for (const citation of claims.get(id)?.citations ?? []) {
        const cite = cites.get(keyOf(citation));
        if (cite !== undefined && !seen.has(cite.n)) { seen.add(cite.n); out.push(cite); }
      }
    }
    return out;
  };
  // Numbers are given in reading order, so the first paragraph's markers are 1, 2, 3.
  for (const block of res.page.blocks) {
    for (const id of claimIdsOf(block)) {
      const claim = claims.get(id);
      if (claim === undefined) continue;
      for (const citation of claim.citations) {
        const key = keyOf(citation), known = cites.get(key);
        if (known === undefined) {
          const cite: Cite = { n: order.length + 1, repo: citation.repo, path: citation.path, commit: citation.commit, line: citation.line, ...(citation.lineEnd === undefined ? {} : { lineEnd: citation.lineEnd }), source: claim.source, claims: [claim.text] };
          cites.set(key, cite);
          order.push(cite);
        } else {
          if (rank[claim.source] > rank[known.source]) known.source = claim.source;
          if (!known.claims.includes(claim.text) && known.claims.length < 3) known.claims.push(claim.text);
        }
      }
    }
  }
  return {
    cites: order,
    markers: markersOf,
    state: (block) => {
      const own = claimIdsOf(block).flatMap((id) => { const claim = claims.get(id); return claim === undefined ? [] : [claim]; });
      const changed = own.find((claim) => claim.source === "changed");
      return { stale: changed === undefined ? undefined : { file: changed.citations[0]?.path ?? "" }, notFound: own.some((claim) => claim.source === "not_found"), flagged: own.some((claim) => claim.flagged) };
    },
    outline: res.page.blocks.flatMap((block) => (block.kind === "heading" && block.level === 2 ? [{ blockId: block.blockId, text: block.text }] : [])),
  };
}

/** The file and lines on GitHub, built from the project's own repository (never from wiki text): a repository the project does not list gets no link. */
export function hostLink(repositories: ReadonlyArray<{ name?: string | undefined; fullName: string }>, cite: Pick<Cite, "repo" | "path" | "commit" | "line" | "lineEnd">): string | undefined {
  const repository = repositories.find((one) => one.name === cite.repo);
  if (repository === undefined || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(repository.fullName)) return undefined;
  const path = cite.path.split("/").map(encodeURIComponent).join("/");
  const anchor = cite.lineEnd === undefined || cite.lineEnd === cite.line ? `#L${String(cite.line)}` : `#L${String(cite.line)}-L${String(cite.lineEnd)}`;
  return safeExternalUrl(`https://github.com/${repository.fullName}/blob/${cite.commit}/${path}${anchor}`);
}

// Design review, DR13 (design-review-stage.md 3.12 item 9): the fakes the poisoning suite plants its hostile text with. The payload catalog itself is tests/web/support/design-review-payloads.ts (shared with the Design tab tests).
import { frameResult } from "../../packages/broker/src/context-sources/present.js";
import type { PacketReaders } from "../../packages/broker/src/design-review/packet.js";

export * from "../web/support/design-review-payloads.js";

/** The sites 3.12 item 9 names: a repository file, a steering file in the meta repository, an MCP item, the design itself (and the requirements it is reviewed against). */
export const PLANT_SITES = ["repo_file", "meta_repo_file", "mcp_item", "design", "requirements"] as const;
export type PlantSite = (typeof PLANT_SITES)[number];

export const COMMIT = "a".repeat(40);
export const PACKET_REQUIREMENTS = "# Requirements\n\nR1: A payment that times out is retried once.\nR2: A payment is never charged twice.\n";
export const PACKET_DESIGN = "# Design\n\n## 1. Problem and goal\nR1 and R2.\n\n## 3. Proposed design\n### 3.1 Retry\nR1: retry once. R2: use the payment id as the idempotency key.\n";
export const PACKET_SOURCES = [
  { kind: "repo_file", repo: "api", path: "src/pay.ts" },
  { kind: "meta_repo_file", path: "steering/rules.md" },
  { kind: "mcp_item", sourceId: "tracker", itemRef: "ABC-7" },
] as const;

/** The readers of a packet, serving the benign text of each source unless a payload is planted in it. The MCP item is framed by the context-tools route's own `frameResult`, as in production. */
export function fakeReaders(planted: Partial<Record<"repo_file" | "meta_repo_file" | "mcp_item", string>> = {}): PacketReaders {
  return {
    readRepoFile: async () => `export const retry = 1;\n${planted.repo_file ?? ""}\n`,
    readMetaFile: async () => `# Steering\nPrefer small changes.\n${planted.meta_repo_file ?? ""}\n`,
    fetchMcpItem: async () => ({
      ok: true,
      text: frameResult({ source: { label: "Tracker" } as never, itemRef: "ABC-7", fetchedAt: "2026-11-03T10:00:00.000Z", text: `Ticket ABC-7: retries.\n${planted.mcp_item ?? ""}`, maxBytes: 16_384, standing: "outsider" }).text,
      fetchedAt: "2026-11-03T10:00:00.000Z",
    }),
  };
}

/** The tag sequence of a rendered user message, case- and spacing-insensitive, so a forged tag in any spelling shows up. */
export function frameTagNames(rendered: string): string[] {
  return [...rendered.matchAll(/<\s*(\/?)\s*(source-file|source-result|request-information)\b[^>]*>/giu)].map((match) => `${match[1]}${match[2]!.toLowerCase()}`);
}

/** The frame tags the packet's own documents have, derived from the document kinds and nothing else. An MCP item is framed twice: the packet's `source-file` around the route's `source-result`. */
export function expectedFrameTags(kinds: readonly string[], request: boolean): string[] {
  return [
    ...(request ? ["request-information", "/request-information"] : []),
    ...kinds.flatMap((kind) => (kind === "mcp_item" ? ["source-file", "source-result", "/source-result", "/source-file"] : ["source-file", "/source-file"])),
  ];
}

export function countOf(haystack: string, needle: string): number {
  return needle === "" ? 0 : haystack.split(needle).length - 1;
}

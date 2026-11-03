// Design review stage, DR4 (designs-2026-10-30/design-review-stage.md 3.4 "Fresh context, and how Rovara proves it", step 1): the BROKER builds each reviewer's packet.
//
// A packet is the role prompt (id, version, digest), the design (artifact digest), the approved requirements (digest) and the design's section 8 sources, read by the broker:
// repository files at the pinned base commit, meta repository files at `knowledgeCommit`, and MCP items fetched again through the context-tools route under the PLAN_CRITIQUE
// stage permission. Every item is recorded with its kind, ref, commit or fetch time, digest and bytes, and the packet digest covers that record (canonical JSON, then SHA-256).
//
// What is NOT in a packet, by construction: the planner's transcript, the Slack thread, people's messages. The builder takes a strict, closed set of fields, so a caller that passes one
// of those is refused (`forbidden_input`), never silently trimmed. The request text goes in for the comprehension reviewer only, labelled as information.
//
// Nothing here reads anything itself: the three readers are injected (`PacketReaders`), so the existing code-host and context-tools readers are reused by the wiring (see `mcpItemReaderOf`).
// Everything is bounded: at most DESIGN_REVIEW_PACKET_ITEMS_MAX items and PACKET_BYTES_MAX bytes. A source that does not fit or cannot be read is left out and listed in `omitted`, with a
// fixed reason; the design and the requirements are never left out (the build is refused instead).
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DESIGN_REVIEW_PACKET_ITEMS_MAX, PACKET_DIGEST_VERSION, ReviewerPacketItemSchema, ReviewerRoleSchema, itemOf, packetDigestOf, renderPacketDocument, renderPacketRequest, reviewerMessagesOf,
  type ContextToolCallResponse, type PacketDelivery, type PacketDocument, type PacketItemKind, type ReviewerPacketItem,
} from "@agentx/contracts";

/** The most bytes of text one packet carries (role prompt, documents and request together). About 100k tokens. [I: tune after the first staging runs.] */
export const PACKET_BYTES_MAX = 400_000;
/** The most of the request text the comprehension reviewer is given. */
export const REQUEST_TEXT_MAX_BYTES = 16_000;
/** Section 8 can name any number of sources; the build looks at this many and no more. */
export const PACKET_SOURCES_LOOKED_AT_MAX = 200;
/** [I] Roughly four bytes to a token for prose, a little fewer for code. Calibrate against the proxy's first-call counts before relying on the 10% check. */
export const BYTES_PER_TOKEN = 4;
/** [I] Tokens a first call carries that the packet does not: the four read-only tool definitions and the wrapper words. Calibrate on the first staging runs. */
export const FIRST_CALL_OVERHEAD_TOKENS = 1_500;

export const PACKET_OMITTED_REASONS = ["invalid_ref", "unpinned_repo", "no_knowledge_commit", "not_found", "unavailable", "not_text", "duplicate", "item_cap", "byte_cap"] as const;
export type PacketOmittedReason = (typeof PACKET_OMITTED_REASONS)[number];

export const PACKET_BUILD_FAILURES = ["forbidden_input", "invalid_input", "design_digest_mismatch", "requirements_digest_mismatch", "packet_too_large"] as const;
export type PacketBuildFailure = (typeof PACKET_BUILD_FAILURES)[number];
const BUILD_MESSAGES: Record<PacketBuildFailure, string> = {
  forbidden_input: "A reviewer packet takes only the role, the design, the requirements, the request and the section 8 sources.",
  invalid_input: "The reviewer packet input is not valid.",
  design_digest_mismatch: "The design is not the one that was approved for review.",
  requirements_digest_mismatch: "The requirements are not the ones that were approved.",
  packet_too_large: "The role prompt, the design and the requirements are too large for one reviewer packet.",
};
/** A packet that cannot be built. The message is fixed text; nothing from the input is echoed. */
export class PacketBuildError extends Error {
  constructor(readonly code: PacketBuildFailure) { super(BUILD_MESSAGES[code]); this.name = "PacketBuildError"; }
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/** A ref is shown inside an attribute of the data frame, so it is plain text with none of the characters that could close the frame. */
const PlainRef = z.string().min(1).max(500).refine((value) => !/[\p{Cc}\p{Cf}"<>\\]/u.test(value), "must be a plain reference");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const Artifact = z.object({
  ref: PlainRef.refine((value) => value.length <= 200),
  /** The artifact's version label (its round, or a short digest); recorded where an item has no commit. */
  revision: z.string().min(1).max(64).refine((value) => !/[\p{Cc}\p{Cf}"<>\\]/u.test(value)),
  text: z.string().min(1),
  /** The digest the broker recorded when the artifact was stored; when given, the text must hash to it. */
  expectedDigest: Digest.optional(),
}).strict();

const SourceRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo_file"), repo: z.string().min(1).max(200), path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("meta_repo_file"), path: z.string().min(1).max(512) }).strict(),
  z.object({
    kind: z.literal("mcp_item"), sourceId: z.string().min(1).max(64), itemRef: z.string().min(1).max(200),
    /** The presented tool name and arguments that fetch the item (the call a stage recorded for its citation). */
    tool: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()),
  }).strict(),
]);
export type DesignSourceRef = z.infer<typeof SourceRef>;

/** The only things a packet is built from. `.strict()`: a transcript, a thread or messages passed along are refused. */
export const PacketBuildInputSchema = z.object({
  role: ReviewerRoleSchema,
  rolePrompt: z.object({ id: z.string().min(1).max(100), version: z.number().int().min(1), text: z.string().min(1).max(64_000) }).strict(),
  design: Artifact,
  requirements: Artifact,
  /** The task's request, as the person wrote it. Used for the comprehension reviewer only; ignored for every other role. */
  requestText: z.string().max(200_000).optional(),
  /** The pinned base commit of each repository the design may read, by the name section 8 uses. A repository with no pin is not read. */
  baseCommits: z.record(z.string().min(1).max(200), Sha1),
  knowledgeCommit: Sha1.optional(),
  sources: z.array(SourceRef).max(PACKET_SOURCES_LOOKED_AT_MAX),
}).strict();
export type PacketBuildInput = z.input<typeof PacketBuildInputSchema>;

/** What the broker reads for a packet. Each is an existing reader behind a small port (the wiring is listed in report.md). A throw or an `undefined` leaves the source out. */
export interface PacketReaders {
  /** A repository file at the pinned commit (`getFileAtCommit` of the code host); `undefined` when the file is not there. */
  readRepoFile(input: { repo: string; path: string; commit: string; maxBytes: number }): Promise<string | undefined>;
  /** A meta repository file at `knowledgeCommit` (the same reader, pointed at the project's meta repository). */
  readMetaFile(input: { path: string; commit: string; maxBytes: number }): Promise<string | undefined>;
  /** An MCP item fetched again through the context-tools route under the PLAN_CRITIQUE stage permission (see `mcpItemReaderOf`). */
  fetchMcpItem(input: { sourceId: string; tool: string; arguments: Record<string, unknown> }): Promise<{ ok: true; text: string; fetchedAt: string } | { ok: false }>;
}

export interface BuiltPacket extends PacketDelivery {
  rolePrompt: { id: string; version: number; digest: string; text: string };
  packetDigest: string;
  /** What `ReviewerRun.packet` records: one entry per document, in the same order. */
  items: ReviewerPacketItem[];
  /** Sources section 8 named that are not in the packet, each with a fixed reason. The card says so. */
  omitted: Array<{ kind: PacketItemKind; ref: string; reason: PacketOmittedReason }>;
  /** Bytes of everything the first request carries. */
  totalBytes: number;
  /** What the broker expects the first model call to read; the proxy's count is held to this within 10% (verify.ts). */
  estimatedInputTokens: number;
}

// The words the reviewer is given, and the packet digest, live in contracts/src/design-review-packet.ts: the worker renders and digests the same bytes with the same functions (DR5).
export { PACKET_DIGEST_VERSION, itemOf, packetDigestOf, renderPacketDocument, renderPacketRequest, reviewerMessagesOf };
export type { PacketDelivery, PacketDocument, PacketItemKind, ReviewerPacketItem };

/** What the broker expects the first call to cost in input tokens: the bytes of the first request, divided by BYTES_PER_TOKEN, plus the fixed overhead. */
export function estimateInputTokens(totalBytes: number, options: { bytesPerToken?: number; overheadTokens?: number } = {}): number {
  return Math.ceil(totalBytes / (options.bytesPerToken ?? BYTES_PER_TOKEN)) + (options.overheadTokens ?? FIRST_CALL_OVERHEAD_TOKENS);
}

function cutToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "")}\n[cut]`;
}

/** The path rules of the code host's reader (`getFileAtCommit`): relative, no empty, dot or dot-dot segment, no backslash. */
function plainPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\\") || /[\p{Cc}\p{Cf}"<>]/u.test(path)) return false;
  return !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

export interface BuildPacketOptions {
  bytesPerToken?: number;
  overheadTokens?: number;
}

/**
 * Builds one reviewer's packet. Refuses (PacketBuildError) when the input has a field outside the closed set, when the design or the requirements do not hash to the recorded digest,
 * or when the role prompt, design and requirements alone do not fit. Sources are looked at in the order section 8 gives them; one that cannot be used is listed in `omitted`.
 */
export async function buildReviewerPacket(rawInput: unknown, readers: PacketReaders, options: BuildPacketOptions = {}): Promise<BuiltPacket> {
  const parsed = PacketBuildInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PacketBuildError(parsed.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "forbidden_input" : "invalid_input");
  }
  const input = parsed.data;
  if (input.design.expectedDigest !== undefined && sha256(input.design.text) !== input.design.expectedDigest) throw new PacketBuildError("design_digest_mismatch");
  if (input.requirements.expectedDigest !== undefined && sha256(input.requirements.text) !== input.requirements.expectedDigest) throw new PacketBuildError("requirements_digest_mismatch");

  const documents: PacketDocument[] = [
    { kind: "design", ref: input.design.ref, commitOrFetchedAt: input.design.revision, text: input.design.text },
    { kind: "requirements", ref: input.requirements.ref, commitOrFetchedAt: input.requirements.revision, text: input.requirements.text },
  ];
  const request = input.role === "comprehension" && input.requestText !== undefined && input.requestText.trim() !== "" ? cutToBytes(input.requestText, REQUEST_TEXT_MAX_BYTES) : undefined;
  const fixedBytes = byteLength(input.rolePrompt.text) + (request === undefined ? 0 : byteLength(renderPacketRequest(request))) + documents.reduce((sum, document) => sum + byteLength(renderPacketDocument(document)), 0);
  if (fixedBytes > PACKET_BYTES_MAX) throw new PacketBuildError("packet_too_large");

  let totalBytes = fixedBytes;
  const omitted: BuiltPacket["omitted"] = [];
  const seen = new Set<string>();
  const leave = (kind: PacketItemKind, ref: string, reason: PacketOmittedReason): void => { omitted.push({ kind, ref: ref.replace(/[\p{Cc}\p{Cf}"<>\\]/gu, "?").slice(0, 500), reason }); };

  for (const source of input.sources) {
    const ref = source.kind === "repo_file" ? `${source.repo}:${source.path}` : source.kind === "meta_repo_file" ? `meta:${source.path}` : `${source.sourceId}:${source.itemRef}`;
    if (!PlainRef.safeParse(ref).success || (source.kind !== "mcp_item" && !plainPath(source.path))) { leave(source.kind, ref, "invalid_ref"); continue; }
    if (seen.has(`${source.kind}\u0000${ref}`)) { leave(source.kind, ref, "duplicate"); continue; }
    seen.add(`${source.kind}\u0000${ref}`);
    if (documents.length >= DESIGN_REVIEW_PACKET_ITEMS_MAX) { leave(source.kind, ref, "item_cap"); continue; }
    const room = PACKET_BYTES_MAX - totalBytes;
    if (room <= 0) { leave(source.kind, ref, "byte_cap"); continue; }

    let document: PacketDocument | undefined;
    try {
      if (source.kind === "repo_file") {
        const commit = input.baseCommits[source.repo];
        if (commit === undefined) { leave(source.kind, ref, "unpinned_repo"); continue; }
        const text = await readers.readRepoFile({ repo: source.repo, path: source.path, commit, maxBytes: room });
        if (text === undefined) { leave(source.kind, ref, "not_found"); continue; }
        document = { kind: "repo_file", ref, commitOrFetchedAt: commit, text };
      } else if (source.kind === "meta_repo_file") {
        if (input.knowledgeCommit === undefined) { leave(source.kind, ref, "no_knowledge_commit"); continue; }
        const text = await readers.readMetaFile({ path: source.path, commit: input.knowledgeCommit, maxBytes: room });
        if (text === undefined) { leave(source.kind, ref, "not_found"); continue; }
        document = { kind: "meta_repo_file", ref, commitOrFetchedAt: input.knowledgeCommit, text };
      } else {
        const answer = await readers.fetchMcpItem({ sourceId: source.sourceId, tool: source.tool, arguments: source.arguments });
        if (!answer.ok || answer.text.trim() === "" || answer.fetchedAt.length === 0 || answer.fetchedAt.length > 64) { leave(source.kind, ref, "unavailable"); continue; }
        document = { kind: "mcp_item", ref, commitOrFetchedAt: answer.fetchedAt, text: answer.text };
      }
    } catch {
      // The reason is fixed. What the reader threw is not kept: it can hold a path, a host or a token.
      leave(source.kind, ref, "unavailable");
      continue;
    }
    if (document.text.includes("\u0000")) { leave(source.kind, ref, "not_text"); continue; }
    const bytes = byteLength(renderPacketDocument(document));
    if (bytes > room || itemOf(document).bytes > 5_000_000) { leave(source.kind, ref, "byte_cap"); continue; }
    documents.push(document);
    totalBytes += bytes;
  }

  const delivery: PacketDelivery = { role: input.role, rolePrompt: { id: input.rolePrompt.id, version: input.rolePrompt.version, text: input.rolePrompt.text }, documents, request };
  const items = documents.map((document) => ReviewerPacketItemSchema.parse(itemOf(document)));
  return {
    role: input.role,
    rolePrompt: { id: input.rolePrompt.id, version: input.rolePrompt.version, digest: sha256(input.rolePrompt.text), text: input.rolePrompt.text },
    documents,
    ...(request === undefined ? {} : { request }),
    packetDigest: packetDigestOf(delivery),
    items,
    omitted,
    totalBytes,
    estimatedInputTokens: estimateInputTokens(totalBytes, options),
  };
}

/**
 * The MCP reader over the existing context-tools route: `call` is `callContextTool(deps, run, request)` with `run.operation.workflowMode` set to "PLAN_CRITIQUE", so every
 * check the route makes (stage permission, the tool still being the ticked read-only tool, argument rules, the stage's allowance) applies unchanged. The answer is already framed as untrusted data.
 */
export function mcpItemReaderOf(call: (request: { requestId: string; tool: string; arguments: Record<string, unknown> }) => Promise<ContextToolCallResponse>, options: { now: () => number; newRequestId: () => string }): PacketReaders["fetchMcpItem"] {
  return async (input) => {
    const answer = await call({ requestId: options.newRequestId(), tool: input.tool, arguments: input.arguments });
    if (answer.status !== "OK") return { ok: false };
    return { ok: true, text: answer.text, fetchedAt: answer.citations?.[0]?.fetchedAt ?? new Date(options.now()).toISOString() };
  };
}

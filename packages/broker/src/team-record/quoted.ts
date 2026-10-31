// Quoted and forwarded text (design control C3): a member who pastes or forwards an outside person's words does not make them the member's own. A row whose text
// holds a quoted or forwarded piece, or a Slack attachment, is only as trusted as its least trusted piece; when the tap does not say who wrote the pieces they count
// as an outsider's. This is the record-side check for a tap that did not do it; the distiller has its own, finer one.
const QUOTED_LINE = /^[ \t]*(?:>|&gt;)/m;
const FORWARD_MARKERS: readonly RegExp[] = [
  /^[ \t]*-{2,}[ \t]*(?:forwarded|original)[ \t]+message/im,
  /\bbegin forwarded message\b/i,
  /^[ \t]*(?:fwd?|fw)[ \t]*:/im,
  /^[ \t]*on .{3,200} wrote:[ \t]*$/im,
  /^[ \t]*from:[ \t]*.+\n[ \t]*(?:sent|date):/im,
  /\bforwarded from\b/i,
];

export function hasQuotedOrForwarded(text: string | undefined): boolean {
  if (text === undefined) return false;
  return QUOTED_LINE.test(text) || FORWARD_MARKERS.some((pattern) => pattern.test(text));
}

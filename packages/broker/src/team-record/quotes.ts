// R8: quote detection (design control C3). A member's message can quote, forward or attach somebody else's words. Those words keep their
// own author's trust; when the author is unknown the trust is `outsider`. So an outsider cannot launder text by having a member forward it
// (poisoning case P3).
import type { TrustClass } from "./shared-types.js";
import { minTrust } from "./taint.js";

export interface TextSpan {
  id: string;
  text: string;
  trust: TrustClass;
  /** True when the span is somebody else's words inside this message. */
  quoted: boolean;
}

export interface MessageAttachment {
  text: string;
  /** Known only when the ingest could map the quoted author to a person. Unknown is outsider. */
  authorTrust?: TrustClass;
}

export interface MessageInput {
  /** The message text as the source sent it (Slack escapes > as &gt;). */
  text: string;
  /** Trust of the message's own author. */
  trust: TrustClass;
  /** Slack `attachments` and shared messages, forwarded email parts, and similar. */
  attachments?: readonly MessageAttachment[];
}

const QUOTE_LINE = /^\s{0,3}(?:>|&gt;)/;
const MULTI_LINE_QUOTE_START = /^\s{0,3}(?:>>>|&gt;&gt;&gt;)/;
const FORWARD_MARKER = /^\s*(?:-{3,}\s*)?(?:forwarded message|begin forwarded message|original message|forwarded from)\b/i;
const FWD_SUBJECT = /^\s*(?:fwd?|fw):/i;

/**
 * Splits a message into spans. Own lines keep the author's trust. Block-quote lines (`>`), everything after `>>>`, everything after a
 * forward marker, and every attachment become quoted spans: `authorTrust` when known, otherwise `outsider`, and never above the
 * message author's own trust. Span ids are s1, s2, ... in order.
 */
export function splitQuotedSpans(message: MessageInput, idPrefix = "s"): TextSpan[] {
  const spans: TextSpan[] = [];
  let counter = 0;
  const add = (text: string, trust: TrustClass, quoted: boolean): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    counter += 1;
    spans.push({ id: `${idPrefix}${counter}`, text: trimmed, trust, quoted });
  };
  const quotedTrust = (known?: TrustClass): TrustClass => minTrust([message.trust, known ?? "outsider"]);

  let own: string[] = [];
  let quote: string[] = [];
  const flushOwn = (): void => {
    add(own.join("\n"), message.trust, false);
    own = [];
  };
  const flushQuote = (): void => {
    add(quote.join("\n"), quotedTrust(), true);
    quote = [];
  };

  let rest = false; // inside `>>>` or after a forward marker: everything to the end is quoted
  const lines = message.text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (rest) {
      quote.push(line);
      return;
    }
    if (MULTI_LINE_QUOTE_START.test(line) || FORWARD_MARKER.test(line) || (index === 0 && FWD_SUBJECT.test(line))) {
      flushOwn();
      rest = true;
      quote.push(line);
      return;
    }
    if (QUOTE_LINE.test(line)) {
      flushOwn();
      quote.push(line);
      return;
    }
    if (quote.length > 0) flushQuote();
    own.push(line);
  });
  flushOwn();
  flushQuote();

  for (const attachment of message.attachments ?? []) add(attachment.text, quotedTrust(attachment.authorTrust), true);
  return spans;
}

import type { SessionEventReaderSchema, SessionMessageReaderSchema } from "@agentx/contracts/web";
import { RelativeTime } from "../../design/RelativeTime.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { VisibleText } from "../../design/VisibleText.js";

type ReadEvent = ReturnType<typeof SessionEventReaderSchema.parse>;
type ReadMessage = ReturnType<typeof SessionMessageReaderSchema.parse>;

function provenance(source: ReadEvent["source"]): string {
 if (source === "slack") return "from Slack";
 if (source === "app" || source === "page") return "from the web";
 return "Source unavailable";
}

/** The human comment attribution row in Talk, using the event's served source without guessing a channel. */
export function TalkCommentProvenanceView({ event, message }: { event: ReadEvent; message?: ReadMessage | undefined }) {
 const page = useTaskPagePolicy() !== undefined;
 if (event.type !== "comment" || (message !== undefined && (message.kind !== "comment" || event.messageId !== message.messageId))) return null;
 const author = message?.author.name ?? (event.actor?.kind === "member" ? event.actor.name : undefined);
 if (author === undefined) return null;
 return <div className="rv-message-meta" data-testid="talk-comment-provenance" data-message-id={message?.messageId ?? event.messageId}>
  <strong><VisibleText text={author} /></strong>
  <span><RelativeTime at={message?.createdAt ?? event.at} /> · {provenance(event.source)}</span>
  {!page && <span>Comment</span>}
 </div>;
}

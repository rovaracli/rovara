import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SessionMessageReaderSchema } from "@agentx/contracts/web";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import "../../packages/ui/src/design/design.css";
import "../../packages/ui/src/screens/session/session.css";
import { TalkCommentEditRecoveryView } from "../../packages/ui/src/screens/session/TalkCommentEditRecoveryView.js";
import { messageFixture } from "../web/support/session-fixture.js";

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "conflict";
const theme = params.get("theme") ?? "light";
document.documentElement.dataset.theme = theme;
document.documentElement.dataset.look = "v2";
const style = document.createElement("style");
style.textContent = tokensCss() + lookV2Css() + "body{padding:24px}.rv-early-signal{max-width:720px;margin:24px auto}@media(max-width:639px){body{padding:12px}}";
document.head.append(style);
const parsedMessage = SessionMessageReaderSchema.parse(messageFixture({ text: "My unsent explanation for the review" }));
const root = document.getElementById("root");
if (!root) throw new Error("capture root is missing");
createRoot(root).render(createElement(TalkCommentEditRecoveryView, {
  state: state as "conflict" | "missing" | "reload-failed",
  messageId: parsedMessage.messageId,
  draft: parsedMessage.text,
  onReload: () => undefined,
  onCopyDraft: () => undefined,
}));
requestAnimationFrame(() => { document.body.dataset.captureReady = "true"; });

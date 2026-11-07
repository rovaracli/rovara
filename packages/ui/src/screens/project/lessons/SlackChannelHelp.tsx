import { useState } from "react";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { useAppHost } from "../../../host.js";
import { isSlackLinkUrl } from "../../../text/links.js";
import { T } from "./lessons-text.js";

const Reader = { parse: (value: unknown) => { const url = (value as { authorizeUrl?: unknown } | null)?.authorizeUrl;if (typeof url !== "string") throw new Error("unreadable");return { authorizeUrl: url }; } };

/** UX-4b: link the person's Slack account from where it is needed (the same start as the account menu's, finished in this browser), so a private channel can be checked and listed. */
export function LinkSlackButton() {
 const host = useAppHost(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function start() {
  setBusy(true);setError(undefined);
  try {
   const result = await createApiClient(host).send("POST", "/v1/app/me/identities/slack", undefined, Reader, { retry: "never" });
   if (result.kind !== "done" || !isSlackLinkUrl(result.value.authorizeUrl, host.origin)) throw new ApiError(502, "INVALID_RESPONSE", "Couldn't start linking. Try again.");
   host.navigate(result.value.authorizeUrl);
  } catch { setError(T.SRC_LINK_FAILED);setBusy(false); }
 }
 return <div className="rv-lessons-actions"><Button variant="secondary" busy={busy} onClick={() => { void start(); }}>{T.SRC_LINK_SLACK}</Button>{error !== undefined && <p role="alert">{error}</p>}</div>;
}

/**
 * UX-4b: how to make a private channel usable, in place: add Rovara to the channel, then read the list again; or use the Slack-side shortcut, which asks in the channel itself. Shown where a private
 * channel is missing from the list and after "Rovara can't use that channel".
 */
export function AddRovaraSteps({ onRefresh }: { onRefresh?: () => void }) {
 return <div className="rv-lessons-help">
  <p>{T.SRC_STEPS_TITLE}</p>
  <ol><li>{T.SRC_STEP_JOIN}</li><li>{T.SRC_STEP_INVITE}</li><li>{T.SRC_STEP_REFRESH}</li></ol>
  <p className="rv-muted">{T.SRC_SHORTCUT}</p>
  {onRefresh !== undefined && <div className="rv-lessons-actions"><Button variant="secondary" onClick={onRefresh}>{T.SRC_REFRESH_LIST}</Button></div>}
 </div>;
}

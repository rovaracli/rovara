import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { Button } from "../design/Button.js";
import { isSlackLinkUrl } from "../text/links.js";
import { VisibleText } from "../design/VisibleText.js";
/** What the sign-in server says about a Slack link that came back to the app (`/app?slack_link=<outcome>`), in the person's words. */
export const SLACK_LINK_MESSAGES: Readonly<Record<string, string>> = {
 linked: "Your Slack account is linked. Mention Rovara in Slack to start work.",
 cancelled: "Linking was cancelled. Nothing changed.",
 wrong_browser: "That link has to be finished in the browser where you started it. Start again from here.",
 wrong_team: "That Slack account is in a different workspace than the one connected to your company. Sign in to Slack with your company's workspace, then try again. Nothing changed.",
 no_workspace: "Your company hasn't connected a Slack workspace to Rovara yet, so there's nothing to link to. Ask a company owner to contact Rovara support to connect it, then link your account here.",
 taken: "That Slack account already belongs to another Rovara account, so it can't be linked here. Nothing changed.",
 has_one: "A Slack account is already linked to your account. Remove it first to link another.",
 reauth: "For safety, sign in again, then link your Slack account.",
 refused: "Slack didn't accept that sign-in. Try again.",
 error: "Couldn't link your Slack account. Try again in a moment.",
};
/** The outcome code the sign-in server left in the address when it sent the person back, if it is one we know. */
export function slackLinkOutcome(path: string): string | undefined {
 const value = new URLSearchParams(path.split("?", 2)[1] ?? "").get("slack_link");
 return value !== null && Object.hasOwn(SLACK_LINK_MESSAGES, value) ? value : undefined;
}
const Reader = { parse: (value: unknown) => { const url = (value as { authorizeUrl?: unknown } | null)?.authorizeUrl;if (typeof url !== "string") throw new Error("unreadable");return { authorizeUrl: url }; } };
const Removed = { parse: (value: unknown) => value };
/** Account menu: link the signed-in person's Slack account (Sign in with Slack, finished in this browser), or remove the link. */
export function SlackLink({ outcome }: { outcome?: string | undefined }) {
 const host = useAppHost(), query = useQueryClient();
 const me = useQuery({ queryKey: ["me"], queryFn: () => createApiClient(host).get("/v1/app/me", AppMeResponseReaderSchema), refetchOnMount: "always" });
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [notice, setNotice] = useState(outcome === undefined ? undefined : SLACK_LINK_MESSAGES[outcome]);
 const linked = me.data?.identities.some(identity => identity.provider === "slack") === true;
 // UX1: where Slack sign-in is off here there is nothing to link (an existing link can still be removed).
 if (me.data?.linkable?.slack === false && !linked) return null;
 async function start() {
  setBusy(true);setError(undefined);setNotice(undefined);
  try {
   const result = await createApiClient(host).send("POST", "/v1/app/me/identities/slack", undefined, Reader, { retry: "never" });
   if (result.kind !== "done" || !isSlackLinkUrl(result.value.authorizeUrl, host.origin)) throw new ApiError(502, "INVALID_RESPONSE", "Couldn't start linking. Try again.");
   host.navigate(result.value.authorizeUrl);
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't start linking. Try again.");setBusy(false); }
 }
 async function remove() {
  setBusy(true);setError(undefined);setNotice(undefined);
  try { await createApiClient(host).send("DELETE", "/v1/app/me/identities/slack", undefined, Removed, { retry: "never" });await query.invalidateQueries({ queryKey: ["me"] });setNotice("Your Slack account is unlinked."); }
  catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't unlink your Slack account. Try again."); } finally { setBusy(false); }
 }
 return <div className="rv-slack-link"><p className="rv-muted">{linked ? "Your Slack account is linked, so Rovara knows you in Slack." : "Link your Slack account so Rovara knows you when you mention it in Slack."}</p>{me.isSuccess && (linked ? <Button onClick={() => { void remove(); }} busy={busy}>Unlink your Slack account</Button> : <Button onClick={() => { void start(); }} busy={busy}>Link your Slack account</Button>)}{notice && <p role="status"><VisibleText text={notice} /></p>}{error && <p role="alert"><VisibleText text={error} /></p>}</div>;
}

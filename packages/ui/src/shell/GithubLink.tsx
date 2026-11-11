// UX1: link the signed-in person's GitHub account from the web app, whatever they signed in with (email code, Google, Slack). GitHub proves the account; the
// sign-in server links it to THIS account only (never a second company or trial) and refuses a GitHub account that already belongs to someone else.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "../api/client.js";
import { ApiError } from "../api/errors.js";
import { Button } from "../design/Button.js";
import { isGithubLinkUrl } from "../text/links.js";
import { VisibleText } from "../design/VisibleText.js";
/** What the sign-in server says about a GitHub link that came back to the app (`?github_link=<outcome>`), in the person's words. */
export const GITHUB_LINK_MESSAGES: Readonly<Record<string, string>> = {
 linked: "Your GitHub account is linked.",
 cancelled: "Linking was cancelled. Nothing changed.",
 wrong_browser: "That link has to be finished in the browser where you started it. Start again from here.",
 taken: "That GitHub account already belongs to another Rovara account, so it can't be linked here. Sign in to GitHub with a different account, then try again. Nothing changed.",
 has_one: "A GitHub account is already linked to your account.",
 reauth: "For safety, sign in again, then link your GitHub account.",
 refused: "GitHub didn't accept that sign-in. Try again.",
 error: "Couldn't link your GitHub account. Try again in a moment.",
};
export function githubLinkOutcome(path: string): string | undefined {
 const value = new URLSearchParams(path.split("?", 2)[1] ?? "").get("github_link");
 return value !== null && Object.hasOwn(GITHUB_LINK_MESSAGES, value) ? value : undefined;
}
const Reader = { parse: (value: unknown) => { const url = (value as { authorizeUrl?: unknown } | null)?.authorizeUrl;if (typeof url !== "string") throw new Error("unreadable");return { authorizeUrl: url }; } };
export function GithubLink({ outcome, returnTo = "/app", primary = false }: { outcome?: string | undefined; returnTo?: "/app" | "/app/onboard" | "/app/admin/connections"; primary?: boolean }) {
 const host = useAppHost();
 const me = useQuery({ queryKey: ["me"], queryFn: () => createApiClient(host).get("/v1/app/me", AppMeResponseReaderSchema), refetchOnMount: "always" });
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [reauth, setReauth] = useState(outcome === "reauth"), [notice] = useState(outcome === undefined ? undefined : GITHUB_LINK_MESSAGES[outcome]);
 const linked = me.data?.identities.find(identity => identity.provider === "github");
 if (me.data?.linkable?.github === false && linked === undefined) return null;
 async function start() {
  setBusy(true);setError(undefined);setReauth(false);
  try {
   const result = await createApiClient(host).send("POST", "/v1/app/me/identities/github", { returnTo }, Reader, { retry: "never" });
   if (result.kind !== "done" || !isGithubLinkUrl(result.value.authorizeUrl, host.origin)) throw new ApiError(502, "INVALID_RESPONSE", "Couldn't start linking. Try again.");
   host.navigate(result.value.authorizeUrl);
  } catch (failure) { if (failure instanceof ApiError && failure.code === "REAUTH_REQUIRED") setReauth(true);else setError(failure instanceof ApiError ? failure.message : "Couldn't start linking. Try again.");setBusy(false); }
 }
 return <div className="rv-github-link">{linked !== undefined ? <p className="rv-muted">GitHub{linked.login === undefined ? "" : <> account <VisibleText text={linked.login} /></>} is linked to your account.</p> : <><p className="rv-muted">Link your GitHub account so Rovara can connect your repositories and know you on GitHub. You stay in the same company.</p>{me.isSuccess && <Button variant={primary ? "primary" : "secondary"} onClick={() => { void start(); }} busy={busy}>Link your GitHub account</Button>}</>}
  {notice && <p role="status"><VisibleText text={notice} /></p>}{error && <p role="alert"><VisibleText text={error} /></p>}
  {reauth && <><p role="alert">For safety, linking needs a sign-in from the last few minutes.</p><Button onClick={() => host.signIn(returnTo)}>Sign in again</Button></>}</div>;
}

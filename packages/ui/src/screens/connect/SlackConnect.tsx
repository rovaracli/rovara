// Guided onboarding PR 11 (design 3b): "Add to Slack" (optional, "Set up later") and what Slack's return came back with. The landing address carries one fixed
// word (`slack=`); the outcome itself (the workspace's name, the "signed in from A but added to B" question) is kept by Cloud's server for this sign-in.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntegrationsApi } from "../../api/integrations.js";
import { needsStepUp } from "../../api/admin-company.js";
import { useAppHost } from "../../host.js";
import { isSlackAuthorizeUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { FreshSignIn } from "../admin/parts.js";
import "./connect.css";

/** Cloud's fixed sentence for each landing word (slack-connect.ts SLACK_OUTCOMES). */
export const SLACK_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
 cancelled: "Rovara wasn't added to Slack. You can add it any time.",
 start_again: "Start again from Rovara.",
 taken: "This Slack workspace is already connected to a different Rovara company.",
 other_workspace: "This company is already connected to a different Slack workspace. A company owner can disconnect it first.",
 enterprise: "Rovara can be added to one Slack workspace, not to a whole Enterprise Grid organization. Add it to a single workspace.",
 unavailable: "Slack could not be connected just now. Start again from Rovara.",
 not_set_up: "Adding Rovara to Slack isn't set up on this Rovara yet. Ask the Rovara team.",
 not_available: "Adding Rovara to Slack isn't available yet.",
});
/** Slack's docs don't say what an approval-pending install returns, so the step says what happens instead (PR 4 Questions). */
export const SLACK_APPROVAL_NOTE = "If your Slack workspace needs admin approval, Slack asks your admin; once approved, press Add to Slack again.";
const workspaceWords = (name: string | undefined) => name === undefined ? "your Slack workspace" : name;

/** Starts Add to Slack: Cloud's server asks Code for a state, binds it to this browser, and answers Slack's page to open. */
export function useSlackInstall() {
 const api = useIntegrationsApi(), host = useAppHost(), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
 async function start() {
  setBusy(true);setError(undefined);
  try { const { authorizeUrl } = await api.slackInstall();if (!isSlackAuthorizeUrl(authorizeUrl, host.origin)) throw new Error("Rovara returned an invalid Slack link.");host.navigate(authorizeUrl); }
  catch (e) { setError(e instanceof Error ? e.message : "Couldn't add Rovara to Slack.");setBusy(false); }
 }
 return { busy, error, start };
}

export function useSlackWorkspace(enabled = true) {
 const api = useIntegrationsApi();
 return useQuery({ queryKey: ["slack", "workspace"], queryFn: api.slackStatus, enabled, retry: false });
}

function AddButton({ label = "Add to Slack" }: { label?: string }) {
 const install = useSlackInstall();
 return <><Button variant="primary" busy={install.busy} data-testid="slack-add" onClick={() => { void install.start(); }}>{label}</Button>{install.error !== undefined && <p role="alert" data-testid="slack-add-error"><VisibleText text={install.error} /></p>}</>;
}

/**
 * The company step "Add Rovara to Slack" (optional). Its state is read from the company's workspace (Code's read), never a saved position. "Set up later" is the
 * caller's: the guided setup (PR 9) records it; it never blocks.
 */
export function AddToSlackStep({ skipped = false, onSkip, onUndoSkip }: { skipped?: boolean; onSkip?: () => void; onUndoSkip?: () => void }) {
 const workspace = useSlackWorkspace(), ws = workspace.data?.workspace;
 if (workspace.isPending) return <section className="rv-connect-step" aria-label="Add Rovara to Slack" data-testid="slack-step"><h2>Add Rovara to Slack</h2><p>Checking Slack…</p></section>;
 if (ws !== undefined && ws !== null && ws.state === "connected") return <section className="rv-connect-step" aria-label="Add Rovara to Slack" data-testid="slack-step" data-state="done"><h2>Add Rovara to Slack</h2><p role="status" data-testid="slack-connected-line">Rovara is in <strong><VisibleText text={workspaceWords(ws.teamName)} /></strong>.</p></section>;
 if (skipped) return <section className="rv-connect-step" aria-label="Add Rovara to Slack" data-testid="slack-step" data-state="skipped"><h2>Add Rovara to Slack <span className="rv-connect-optional">Optional</span></h2><p data-testid="slack-skipped">Skipped (optional). You can add Rovara to Slack later in Company settings, Connections.</p>{onUndoSkip !== undefined && <Button onClick={onUndoSkip}>Add it now</Button>}</section>;
 return <section className="rv-connect-step" aria-label="Add Rovara to Slack" data-testid="slack-step" data-state="open">
  <h2>Add Rovara to Slack <span className="rv-connect-optional">Optional</span></h2>
  <p>Rovara answers in Slack threads and posts updates to your project's channel. Slack asks which workspace to add it to.</p>
  {workspace.isError && <p role="alert">Couldn't check Slack just now.</p>}
  {ws !== undefined && ws !== null && ws.state === "disconnected" && <p role="status">Rovara was removed from <VisibleText text={workspaceWords(ws.teamName)} />. Add it again to reconnect.</p>}
  <div className="rv-connect-actions"><AddButton label={ws !== undefined && ws !== null ? "Reconnect Slack" : "Add to Slack"} />{onSkip !== undefined && <Button variant="secondary" data-testid="slack-skip" onClick={onSkip}>Set up later</Button>}</div>
  <p className="rv-connect-note">{SLACK_APPROVAL_NOTE}</p>
 </section>;
}

/** What Slack's return came back with (`slack=<word>` on the landing address). Refusals are fixed sentences with "Try again". */
export function SlackConnectResult({ outcome }: { outcome: string }) {
 const api = useIntegrationsApi(), query = useQueryClient();
 const [kept, setKept] = useState(false), [disconnect, setDisconnect] = useState<{ busy: boolean; done?: string; error?: string; stepUp?: boolean }>({ busy: false });
 // Own words only: a crafted `?…=toString` must not find Object.prototype's members.
 const refusal = Object.hasOwn(SLACK_REFUSALS, outcome) ? SLACK_REFUSALS[outcome] : undefined;
 const result = useQuery({ queryKey: ["slack", "connect-result"], enabled: outcome === "result", queryFn: async () => { const value = await api.slackResult();if (value.status === "connected") void query.invalidateQueries({ queryKey: ["slack", "workspace"] });return value; }, retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false });
 async function doDisconnect() {
  setDisconnect({ busy: true });
  try { const value = await api.slackDisconnect();setDisconnect({ busy: false, done: `Rovara was removed from ${workspaceWords(value.workspaceName)}.` });void query.invalidateQueries({ queryKey: ["slack"] , predicate: item => item.queryKey[1] !== "connect-result" }); }
  catch (e) { setDisconnect(needsStepUp(e) ? { busy: false, stepUp: true } : { busy: false, error: e instanceof Error ? e.message : SLACK_REFUSALS.unavailable! }); }
 }
 if (refusal !== undefined) return <section className="rv-connect-result" aria-label="Slack connection" data-testid="slack-refused"><p role={outcome === "cancelled" ? "status" : "alert"} data-testid="slack-refused-message"><VisibleText text={refusal} /></p>{outcome !== "not_set_up" && outcome !== "not_available" && <AddButton label="Try again" />}</section>;
 if (outcome !== "result" || result.isPending || result.isError || result.data.status === "none") return null;
 const value = result.data;
 if (value.mismatch !== undefined && !kept) {
  if (disconnect.done !== undefined) return <section className="rv-connect-result" aria-label="Slack connection"><p role="status" data-testid="slack-disconnected"><VisibleText text={disconnect.done} /></p><AddButton /></section>;
  return <section className="rv-connect-result" aria-label="Slack connection" data-testid="slack-mismatch">
   <p>You signed in from <strong><VisibleText text={workspaceWords(value.mismatch.signedInName)} /></strong> but added Rovara to <strong><VisibleText text={workspaceWords(value.workspaceName)} /></strong>. Keep it?</p>
   <div className="rv-connect-actions"><Button variant="primary" data-testid="slack-keep" onClick={() => setKept(true)}>Keep</Button><Button busy={disconnect.busy} data-testid="slack-mismatch-disconnect" onClick={() => { void doDisconnect(); }}>Disconnect</Button></div>
   {disconnect.stepUp === true && <FreshSignIn action="disconnect Slack" refused />}
   {disconnect.error !== undefined && <p role="alert" data-testid="slack-disconnect-error"><VisibleText text={disconnect.error} /></p>}
  </section>;
 }
 return <section className="rv-connect-result" aria-label="Slack connection"><p role="status" data-testid="slack-connected">Rovara is in <strong><VisibleText text={workspaceWords(value.workspaceName)} /></strong>.</p></section>;
}

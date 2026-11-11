import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { useAgentApi, type ReadAgent, type ReadAgentProfile } from "../../api/agents.js";
import type { SendResult } from "../../api/client.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { paths } from "../../paths.js";
import { agentAllows } from "./agent-access.js";
import { failureText } from "./agent-context.js";
import { DesktopBuilderNote } from "./agent-phone.js";
export function UpdateAvailableBanner({ agent }: { agent: ReadAgent }) {
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState<{ result: Exclude<SendResult<unknown>, { kind: "done" }>; version?: number }>(), sending = useRef(false), api = useAgentApi(), host = useAppHost(), query = useQueryClient();
 const adopt = agent.builtin && agentAllows(agent, "manage") && agent.pinnedVersion !== undefined && agent.latestVersion > agent.pinnedVersion;
 if (pending === undefined && !adopt && (agent.updateAvailable === undefined || !agentAllows(agent, "edit") || agent.builtin)) return null;
 async function update() {
  if (sending.current || pending !== undefined) return;sending.current = true;setBusy(true);setError(undefined);
  try { if (adopt) { const result = await api.adopt(agent.agentId, agent.latestVersion);if (result.kind !== "done") { setPending({ result, version: agent.latestVersion });return; }await query.invalidateQueries({ queryKey: ["agent", agent.agentId], exact: true });await query.invalidateQueries({ queryKey: ["agents"] }); }
   else { const draft = await api.draft(agent.agentId), result = await api.updateBase(agent.agentId, draft.draft.revision);if (result.kind !== "done") { setPending({ result });return; }await query.invalidateQueries({ queryKey: ["agent", agent.agentId] });host.navigate(paths.agentEdit(agent.agentId) + "?review=base"); }
  } catch (failure) { setError(failureText(failure, "Couldn't review the update. Try again.")); } finally { sending.current = false;setBusy(false); }
 }
 return <section className="rv-agent-section" aria-label="Workflow update"><p>{adopt || pending?.version !== undefined ? "A newer built-in version is available." : "A newer version of the method this workflow builds on is available."}</p><Button busy={busy} disabled={pending !== undefined} onClick={() => { void update(); }}>{adopt || pending?.version !== undefined ? "Adopt v" + (pending?.version ?? agent.latestVersion) : "Review update"}</Button>{!adopt && pending?.version === undefined && <DesktopBuilderNote text="Reviewing an update opens the builder, which works best on a larger screen." />}{error && <p role="alert"><VisibleText text={error} /></p>}{pending && <>{pending.result.kind === "needs_confirmation" && <ul>{pending.result.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}<ConfirmInBrowser<ReadAgentProfile> result={pending.result} subjectKey={["agent", agent.agentId]} isApplied={view => pending.version !== undefined && view.agent.pinnedVersion !== undefined && view.agent.pinnedVersion >= pending.version} onApplied={() => setPending(undefined)} /></>}</section>;
}

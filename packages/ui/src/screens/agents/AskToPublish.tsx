import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadAgentProfile } from "../../api/agents.js";
import { MAX_NOTE_CHARACTERS, MY_AGENTS_KEY, PUBLISH_KEY, publicationOf, useAgentPublishApi, type PublishAnswer, type PublishTarget } from "../../api/agent-publish.js";
import { useNav } from "../../api/nav.js";
import { useAppHost } from "../../host.js";
import { isConfirmUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { agentAllows } from "./agent-access.js";
import { failureText } from "./agent-context.js";
import { PublishSummary, summaryFromProfile } from "./PublishSummary.js";
import { askEffect, knownTarget, parseTargetKey, targetKey, targetName, waitingLine } from "./publish-words.js";
import "./publish.css";

/** Whether this person can ask to publish this agent at all: an active custom agent they manage, with a published version (the server asks for one). */
export function canAskToPublish(profile: ReadAgentProfile): boolean {
 const agent = profile.agent;
 return !agent.builtin && agent.status === "active" && agent.disabled !== true && agentAllows(agent, "manage") && (agent.currentVersion ?? profile.current?.version) !== undefined;
}

/**
 * Ask to publish an agent to a project you are on, or to the whole company. The server decides who may approve, and says so in its own words when it refuses; this dialog says plainly, before asking, what approving does
 * (owner decision 91: a project request MOVES the agent to the project and a maintainer there becomes accountable). A maintainer of the project, or an admin, gets the answer "published" at once, and it is shown as done.
 */
export default function AskToPublish({ profile, initialOpen = false, initialTarget, trigger }: { profile: ReadAgentProfile; initialOpen?: boolean; initialTarget?: string | undefined; trigger?: string }) {
 const agent = profile.agent, host = useAppHost(), api = useAgentPublishApi(), query = useQueryClient(), nav = useNav();
 const [open, setOpen] = useState(initialOpen), [choice, setChoice] = useState(() => initialTarget !== undefined && parseTargetKey(initialTarget) !== undefined ? initialTarget : ""), [note, setNote] = useState("");
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [answer, setAnswer] = useState<PublishAnswer>(), [sentTo, setSentTo] = useState<PublishTarget>();
 const sending = useRef(false), intent = useRef<{ signature: string; id: string } | undefined>(undefined);
 const publication = publicationOf(agent), version = agent.currentVersion ?? profile.current?.version;
 const options = useMemo(() => {
  const taken = new Set(publication?.projects ?? []), projects = (nav.isError ? [] : nav.data?.projects ?? []).filter(project => !taken.has(project.name)).map(project => ({ value: "project:" + project.name, label: "The " + project.name + " project" }));
  return publication?.level === "company" ? projects : [...projects, { value: "company", label: "The whole company" }];
 }, [nav.isError, nav.data, publication?.level, publication?.projects]);
 if (!canAskToPublish(profile) || version === undefined) return null;
 const target = parseTargetKey(choice), preview = summaryFromProfile(profile), tooLong = [...note].length > MAX_NOTE_CHARACTERS;
 async function send() {
  if (sending.current || target === undefined || version === undefined || tooLong) return;
  sending.current = true;setBusy(true);setError(undefined);
  // The same ask sent again (a retry after an error) keeps its request id, so the server answers the one it already has; a changed target or note is a new ask.
  const trimmed = note.trim(), signature = JSON.stringify([targetKey(target), version, trimmed]);
  if (intent.current?.signature !== signature) intent.current = { signature, id: crypto.randomUUID() };
  try {
   const result = await api.ask(agent.agentId, { requestId: intent.current.id, target, version, ...(trimmed === "" ? {} : { note: trimmed }) });
   setAnswer(result);setSentTo(target);
   await Promise.all([[PUBLISH_KEY], ["agent", agent.agentId], ["agents"], [MY_AGENTS_KEY]].map(queryKey => query.invalidateQueries({ queryKey })));
  } catch (failure) { setError(failureText(failure, "Couldn't send this request. Try again.")); } finally { sending.current = false;setBusy(false); }
 }
 function reset(next: boolean) { if (busy) return;if (next && answer !== undefined) { setAnswer(undefined);setSentTo(undefined);setNote("");setChoice("");setError(undefined);intent.current = undefined; }setOpen(next); }
 const request = answer?.status === "NEEDS_CONFIRMATION" ? answer.request : undefined;
 const confirmUrl = request?.approval.canDecide === true && knownTarget(request.target)?.kind === "company" ? [request.approval.confirmUrl, answer?.status === "NEEDS_CONFIRMATION" ? answer.confirmUrl : undefined].find((url): url is string => typeof url === "string" && isConfirmUrl(url, host.origin)) : undefined;
 return <Dialog title={"Ask to publish " + agent.name} className="rv-agent-dialog rv-pub-dialog" open={open} onOpenChange={reset} trigger={<Button {...(trigger === "primary" ? { variant: "primary" as const } : {})}>Ask to publish</Button>}>
  {answer === undefined ? <>
   <p>Share this agent beyond yourself. Version {version} is what gets published.</p>
   <Select label="Publish to" value={choice} onValueChange={setChoice} disabled={busy || nav.isPending} placeholder={nav.isPending ? "Loading" : "Choose where"} options={options} />
   {nav.isError && <p role="alert">Couldn't load your projects. Close this and try again.</p>}
   {options.length === 0 && !nav.isPending && !nav.isError && <p>This agent is already published everywhere you can ask for.</p>}
   {target !== undefined && <p className="rv-pub-effect" role="status"><VisibleText text={askEffect(agent.name, target)} /></p>}
   {preview !== undefined && <><h3>What you are asking to publish</h3><PublishSummary summary={preview} /></>}
   <TextArea label="A note for the approver (optional)" hint={"Why it should be shared. Up to " + String(MAX_NOTE_CHARACTERS) + " characters."} value={note} onChange={event => setNote(event.target.value)} rows={3} {...(tooLong ? { error: "That note is too long." } : {})} />
   <div className="rv-actions"><Button variant="primary" busy={busy} disabled={target === undefined || tooLong} onClick={() => { void send(); }}>Send request</Button></div>
   {error && <p role="alert"><VisibleText text={error} /></p>}
  </> : answer.status === "published" && sentTo !== undefined ? <>
   <p role="status"><strong>Done.</strong> <VisibleText text={agent.name} /> is now published to <VisibleText text={targetName(sentTo)} />.</p>
   {sentTo.kind === "project" && <p>It belongs to the <VisibleText text={sentTo.project} /> project now. You can still edit it.</p>}
   <div className="rv-actions"><Button variant="primary" onClick={() => reset(false)}>Close</Button></div>
  </> : request !== undefined ? <>
   <p role="status"><strong>Request sent.</strong> {waitingLine(request.target)}.</p>
   <p><VisibleText text={request.effect} /></p>
   {request.note !== null && request.note !== "" && <p className="rv-pub-note">Your note: <VisibleText text={request.note} /></p>}
   <h3>What the approver sees</h3><PublishSummary summary={request.summary} label="What the approver sees" />
   {confirmUrl !== undefined && <p>You can approve this yourself. <Button variant="primary" onClick={() => { host.openExternal(confirmUrl); }}>Confirm on the next page</Button></p>}
   <div className="rv-actions"><Button onClick={() => reset(false)}>Close</Button></div>
  </> : <p role="alert">This request is still pending. Reload to check its status.</p>}
 </Dialog>;
}

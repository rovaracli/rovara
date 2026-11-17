// Guided onboarding PR 11 (design 3c, DEC 254k): a project's Slack channel. One component for the project checklist (optional row with "Set up later"; PR 9
// places it) and for Project settings (add, change, remove). Everything shown is read from Code's answers through Cloud: the channel link, the company's workspace.
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntegrationsApi } from "../../api/integrations.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { useSlackInstall } from "./SlackConnect.js";
import "./connect.css";

type Mode = "checklist" | "settings";
interface Props { project: string; mode: Mode; canEdit: boolean; skipped?: boolean; onSkip?: () => void; onUndoSkip?: () => void }

/** The state a checklist shows for this row: done (linked), optional (not linked), skipped (the caller's "Set up later"). */
export type SlackRowState = "done" | "optional" | "skipped";

function ChannelPicker({ project, current, onDone, onCancel }: { project: string; current?: string; onDone: () => void; onCancel?: () => void }) {
 const api = useIntegrationsApi(), query = useQueryClient();
 const [cursor, setCursor] = useState<string>(), [chosen, setChosen] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [invite, setInvite] = useState<{ id: string; message: string }>();
 const page = useQuery({ queryKey: ["slack", "channels", project, cursor ?? ""], queryFn: () => api.slackChannels(project, cursor), retry: false });
 async function link(channelId: string, check: boolean) {
  setBusy(true);setError(undefined);
  try {
   const answer = await api.linkChannel(project, channelId, check);
   if (answer.status === "invite_needed") { setInvite({ id: channelId, message: answer.message });return; }
   setInvite(undefined);void query.invalidateQueries({ queryKey: ["slack", "project-channel", project] });void query.invalidateQueries({ queryKey: ["slack", "channels", project] });onDone();
  } catch (e) { setError(e instanceof Error ? e.message : "Slack could not be checked just now; try again."); }
  finally { setBusy(false); }
 }
 if (page.isPending) return <p>Loading channels…</p>;
 if (page.isError) return <><p role="alert" data-testid="slack-channels-error"><VisibleText text={page.error instanceof Error ? page.error.message : "Couldn't load channels."} /></p><Button onClick={() => { void page.refetch(); }}>Try again</Button></>;
 const options = page.data.channels.map(channel => ({ value: channel.id, label: `${channel.isPrivate ? "" : "#"}${channel.name}${channel.isPrivate ? " (private)" : ""}${channel.linked === true && channel.linkedProject !== project ? ` (linked to ${channel.linkedProject ?? "another project"})` : ""}`, disabled: channel.linked === true && channel.linkedProject !== project }));
 return <div className="rv-connect-picker" data-testid="slack-channel-picker">
  <Select label="Slack channel" value={chosen ?? current ?? ""} onValueChange={value => { setChosen(value);setInvite(undefined); }} options={options} placeholder="Pick a channel" />
  {page.data.nextCursor !== undefined && <Button data-testid="slack-channels-more" onClick={() => setCursor(page.data.nextCursor)}>More channels</Button>}
  <div className="rv-connect-actions">
   <Button variant="primary" busy={busy} disabled={chosen === undefined || chosen === current} data-testid="slack-channel-link" onClick={() => { if (chosen !== undefined) void link(chosen, false); }}>Link channel</Button>
   {onCancel !== undefined && <Button onClick={onCancel}>Cancel</Button>}
  </div>
  <p className="rv-connect-note">Or type <code>/rovara link {project}</code> in the channel.</p>
  {invite !== undefined && <div role="status" data-testid="slack-invite-needed"><p><VisibleText text={invite.message} /></p><Button variant="primary" busy={busy} data-testid="slack-channel-check" onClick={() => { void link(invite.id, true); }}>Check</Button></div>}
  {error !== undefined && <p role="alert" data-testid="slack-channel-error"><VisibleText text={error} /></p>}
 </div>;
}

export function SlackChannelRow({ project, mode, canEdit, skipped = false, onSkip, onUndoSkip }: Props) {
 const api = useIntegrationsApi(), query = useQueryClient(), install = useSlackInstall();
 const linked = useQuery({ queryKey: ["slack", "project-channel", project], queryFn: () => api.projectChannel(project), retry: false });
 const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [note, setNote] = useState<string>();
 const channelId = linked.data?.channels[0]?.id;
 // The channel's name, from the picker's first page (Code's link read carries ids only).
 const names = useQuery({ queryKey: ["slack", "channels", project, ""], queryFn: () => api.slackChannels(project), enabled: channelId !== undefined && canEdit, retry: false });
 const name = names.data?.channels.find(channel => channel.id === channelId)?.name;
 async function unlink() {
  setBusy(true);setError(undefined);
  try { await api.unlinkChannel(project);setNote("Channel removed. Threads already started keep working.");void query.invalidateQueries({ queryKey: ["slack"] }); }
  catch (e) { setError(e instanceof Error ? e.message : "Slack could not be checked just now; try again."); }
  finally { setBusy(false); }
 }
 const state: SlackRowState = channelId !== undefined ? "done" : skipped ? "skipped" : "optional";
 const heading = <h3>Slack channel {mode === "checklist" && <span className="rv-connect-optional">{state === "done" ? "Done" : state === "skipped" ? "Skipped (optional)" : "Optional"}</span>}</h3>;
 const wrap = (children: ReactNode) => <section className="rv-connect-row" aria-label="Slack channel" data-testid="slack-channel-row" data-state={state}>{heading}{children}</section>;
 if (linked.isPending) return wrap(<p>Checking Slack…</p>);
 if (linked.isError) return wrap(<><p role="alert"><VisibleText text={linked.error instanceof Error ? linked.error.message : "Couldn't read the Slack channel."} /></p><Button onClick={() => { void linked.refetch(); }}>Try again</Button></>);
 if (mode === "checklist" && skipped && channelId === undefined) return wrap(<><p data-testid="slack-channel-skipped">Skipped. You can link a channel later in Project settings.</p>{onUndoSkip !== undefined && <Button onClick={onUndoSkip}>Link a channel now</Button>}</>);
 if (!linked.data.connected) return wrap(<>
  <p data-testid="slack-channel-not-connected">Add Rovara to Slack first, then pick this project's channel.</p>
  {canEdit && <div className="rv-connect-actions"><Button variant="primary" busy={install.busy} data-testid="slack-row-add" onClick={() => { void install.start(); }}>Add to Slack</Button>{mode === "checklist" && onSkip !== undefined && <Button data-testid="slack-channel-skip" onClick={onSkip}>Set up later</Button>}</div>}
  {install.error !== undefined && <p role="alert"><VisibleText text={install.error} /></p>}
 </>);
 if (channelId !== undefined && !editing) return wrap(<>
  <p role="status" data-testid="slack-channel-linked">Linked to <strong>{name === undefined ? <>a Slack channel (<code>{channelId}</code>)</> : <VisibleText text={`#${name}`} />}</strong>.</p>
  {canEdit && <div className="rv-connect-actions"><Button data-testid="slack-channel-change" onClick={() => { setEditing(true);setNote(undefined); }}>Change</Button><Button busy={busy} data-testid="slack-channel-remove" onClick={() => { void unlink(); }}>Remove</Button></div>}
  {error !== undefined && <p role="alert" data-testid="slack-channel-error"><VisibleText text={error} /></p>}
 </>);
 if (!canEdit) return wrap(<p>No channel linked yet. A company owner or admin, or this project's admin, can link one.</p>);
 return wrap(<>
  {note !== undefined && <p role="status" data-testid="slack-channel-note"><VisibleText text={note} /></p>}
  <p>Pick the channel where this project's work is discussed. Public channels are joined for you; for a private channel, invite Rovara first.</p>
  <ChannelPicker project={project} {...(channelId === undefined ? {} : { current: channelId })} onDone={() => { setEditing(false);setNote(undefined); }} {...(editing ? { onCancel: () => setEditing(false) } : {})} />
  {mode === "checklist" && onSkip !== undefined && channelId === undefined && <Button data-testid="slack-channel-skip" onClick={onSkip}>Set up later</Button>}
 </>);
}

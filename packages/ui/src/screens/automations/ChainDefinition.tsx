// exp/automations: a chain's design. Everyone who can see the chain reads the design that runs. People who may change it get a plain text draft (the design as JSON: no visual builder),
// the problems the server finds in it, and Publish. A publish the server holds for a person answers 202: the page then says "Waiting for an admin to confirm" with the link.
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chainKey, useAutomationsApi, type ChainRead } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextArea } from "../../design/TextArea.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Dialog } from "../../design/Dialog.js";
import { ActionNote, noteOf, problemNote, type Note } from "./ActionNote.js";
import { useReturnFocus } from "./useReturnFocus.js";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

type DraftRead = Awaited<ReturnType<ReturnType<typeof useAutomationsApi>["draft"]>>;
/** Reads the draft, then hands it to the form, which starts from it and keeps the person's own text until they ask for the latest (a new `epoch` starts the form again). */
function DraftEditor({ chain, canPublish, onChanged }: { chain: ChainRead; canPublish: boolean; onChanged: () => void }) {
  const api = useAutomationsApi(), read = useQuery({ queryKey: chainKey(chain.chainId, "draft"), queryFn: () => api.draft(chain.chainId), retry: false, refetchOnWindowFocus: false }), [epoch, setEpoch] = useState(0);
  if (read.isPending) return <Skeleton label="Loading the draft" />;
  if (read.isError) return <ActionNote note={problemNote(read.error, true)} />;
  return <DraftForm key={epoch} focusEditor={epoch > 0} chain={chain} canPublish={canPublish} data={read.data} refresh={async () => (await read.refetch()).data} restart={() => { setEpoch(value => value + 1); }} onChanged={onChanged} />;
}

function DraftForm({ focusEditor, chain, canPublish, data, refresh, restart, onChanged }: { focusEditor: boolean; chain: ChainRead; canPublish: boolean; data: DraftRead; refresh: () => Promise<DraftRead | undefined>; restart: () => void; onChanged: () => void }) {
  const api = useAutomationsApi(), query = useQueryClient(), back = useReturnFocus(), [replacing, setReplacing] = useState(false);
  const [text, setText] = useState(() => pretty(data.draft.definition)), [saved, setSaved] = useState(text), [revision, setRevision] = useState(data.draft.revision), [note, setNote] = useState<Note>(), [busy, setBusy] = useState<string>(), [message, setMessage] = useState(""), sending = useRef(false);
  // After "Reload the latest draft" the form starts again and the button that asked is gone, so focus goes to the text.
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusEditor) editor.current?.focus(); }, [focusEditor]);
  const dirty = text !== saved;
  let parsed: { ok: true; value: unknown } | { ok: false };
  try { parsed = { ok: true, value: JSON.parse(text) }; } catch { parsed = { ok: false }; }
  async function run(label: string, work: () => Promise<Note>) {
    if (sending.current) return;
    sending.current = true;setBusy(label);setNote(undefined);
    try { setNote(await work()); } catch (error) { setNote(problemNote(error)); }
    finally { sending.current = false;setBusy(undefined); }
  }
  const save = () => run("save", async () => {
    if (!parsed.ok) return { kind: "problem", problem: { message: "The design isn't valid JSON yet.", forbidden: false, reauth: false } };
    const result = await api.saveDraft(chain.chainId, revision, parsed.value);
    if (result.kind === "done") { setRevision(result.value.draft.revision);setSaved(text);await refresh(); }
    return noteOf(result, "The draft is saved. Nothing runs from it until it is published.");
  });
  const publish = () => run("publish", async () => {
    const result = await api.publish(chain.chainId, revision, message);
    if (result.kind === "done") { await query.invalidateQueries({ queryKey: ["automations"] });onChanged(); }
    // A draft that is what already runs publishes nothing: the server answers with the version that runs.
    const unchanged = result.kind === "done" && result.value.version.version === chain.currentVersion;
    return noteOf(result, result.kind !== "done" ? "" : unchanged ? `No change; version ${String(result.value.version.version)} keeps running.` : `Published as version ${String(result.value.version.version)}. New runs use it.`, result.kind === "done" ? result.value.disabledTriggers.map(item => `A trigger was turned off: ${item.problems[0]?.message ?? "it no longer qualifies"}`) : undefined);
  });
  const reload = async () => { setReplacing(false);await refresh();restart(); };
  return <div className="rv-auto-form">
    <TextArea ref={editor} label="Draft design (JSON)" hint="This is what a publish will use. Saving does not change what runs." value={text} spellCheck={false} rows={14} className="rv-auto-code" onChange={event => { setText(event.target.value); }} {...(parsed.ok ? {} : { error: "This isn't valid JSON yet." })} />
    {data.problems.length > 0 && <div role="status" className="rv-auto-note"><p><strong>The server found problems to fix before publishing</strong></p><ul>{data.problems.map((problem, index) => <li key={index}><VisibleText text={problem.path === "" ? problem.message : `${problem.path}: ${problem.message}`} /></li>)}</ul></div>}
    <TextField label="Note for this version" hint="Optional." maxLength={200} value={message} onChange={event => { setMessage(event.target.value); }} autoComplete="off" />
    <div className="rv-actions"><Button busy={busy === "save"} disabled={!dirty || !parsed.ok} onClick={() => { void save(); }}>Save draft</Button>{canPublish && <Button variant="primary" busy={busy === "publish"} disabled={dirty || chain.status === "archived"} onClick={() => { void publish(); }}>Publish</Button>}<Button variant="quiet" onClick={event => { if (dirty) { back.remember(event);setReplacing(true); } else void reload(); }}>Reload the latest draft</Button></div>
    {!canPublish && <p className="rv-muted" role="note">This chain has triggers turned on, so only people who manage it can publish or roll back.</p>}
    {canPublish && dirty && <p className="rv-muted">Save the draft before publishing it.</p>}
    {chain.status === "archived" && <p className="rv-muted">This chain is archived. Unarchive it to publish.</p>}
    <ActionNote note={note} />
    <Dialog title="Reload the latest draft?" description="This replaces your unsaved text." onCloseAutoFocus={event => { back.onCloseAutoFocus(event); }} open={replacing} onOpenChange={setReplacing}>
      <div className="rv-actions"><Button variant="danger" onClick={() => { void reload(); }}>Replace my text</Button><Button onClick={() => { setReplacing(false); }}>Keep editing</Button></div>
    </Dialog>
  </div>;
}

export function ChainDefinition({ chain, current, canEdit, canPublish, onChanged }: { chain: ChainRead; current: { version: number; definition: unknown } | undefined; canEdit: boolean; /** May publish (edit access, and manage access while the chain has triggers on). */ canPublish: boolean; onChanged: () => void }) {
  return <section className="rv-project-section rv-auto" aria-labelledby="chain-design"><h2 id="chain-design">Design</h2>
    {current === undefined ? <p className="rv-muted">Nothing is published yet, so this chain can't run.</p> : <details><summary>The design that runs now (version {current.version})</summary><pre className="rv-auto-code" tabIndex={0} aria-label={`Design of version ${String(current.version)}`}><VisibleText text={pretty(current.definition)} /></pre></details>}
    {canEdit ? <DraftEditor chain={chain} canPublish={canPublish} onChanged={onChanged} /> : <p className="rv-muted" role="note">You can read the design. Only people who can edit this chain can change it.</p>}
  </section>;
}

// exp/automations: a chain's published versions, newest first, and rolling back to an earlier one (for people who may edit it). A rollback that makes anything less safe waits for a person: the answer shows the link.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chainKey, useAutomationsApi, type ChainVersionRow } from "../../api/automations.js";
import { Button } from "../../design/Button.js";
import { Chip } from "../../design/Chip.js";
import { Dialog } from "../../design/Dialog.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ActionNote, noteOf, problemNote, type Note } from "./ActionNote.js";

export function ChainVersions({ chainId, canEdit, onChanged }: { chainId: string; canEdit: boolean; onChanged: () => void }) {
  const api = useAutomationsApi(), query = useQueryClient(), read = useQuery({ queryKey: chainKey(chainId, "versions"), queryFn: () => api.versions(chainId), retry: false });
  const [target, setTarget] = useState<ChainVersionRow>(), [note, setNote] = useState<Note>(), [busy, setBusy] = useState(false), sending = useRef(false);
  async function rollback() {
    if (sending.current || target === undefined) return;
    sending.current = true;setBusy(true);setNote(undefined);
    try {
      const result = await api.rollback(chainId, target.version);
      setNote(noteOf(result, `Version ${String(target.version)} is the one that runs now.`, result.kind === "done" ? result.value.disabledTriggers.map(item => `A trigger was turned off: ${item.problems[0]?.message ?? "it no longer qualifies"}`) : undefined));
      setTarget(undefined);await query.invalidateQueries({ queryKey: ["automations"] });onChanged();
    } catch (error) { setNote(problemNote(error)); } finally { sending.current = false;setBusy(false); }
  }
  return <section className="rv-project-section rv-auto" aria-labelledby="chain-versions"><h2 id="chain-versions">Versions</h2>
    {read.isPending ? <Skeleton label="Loading versions" /> : read.isError ? <ActionNote note={problemNote(read.error)} /> : read.data.versions.length === 0 ? <p className="rv-muted">No versions yet.</p> : <ul className="rv-auto-list">{[...read.data.versions].sort((a, b) => b.version - a.version).map(version => <li key={version.version} className="rv-auto-row">
      <div className="rv-auto-row-head"><div><strong>Version {version.version}</strong>{version.current && <> <Chip>Running now</Chip></>}</div>{canEdit && !version.current && <Button onClick={() => { setNote(undefined);setTarget(version); }}>Roll back to this</Button>}</div>
      <p className="rv-muted">Published <RelativeTime at={version.publishedAt} />{version.note !== undefined && <> · <VisibleText text={version.note} /></>}</p>
    </li>)}</ul>}
    {target === undefined && <ActionNote note={note} />}
    <Dialog title={`Run version ${String(target?.version ?? "")} again?`} description="New runs use that version. Runs that have started keep theirs." open={target !== undefined} onOpenChange={open => { if (!open) { setTarget(undefined);setNote(undefined); } }}>
      <ActionNote note={note} />
      <div className="rv-actions"><Button variant="primary" busy={busy} onClick={() => { void rollback(); }}>Roll back</Button><Button onClick={() => { setTarget(undefined);setNote(undefined); }}>Cancel</Button></div>
    </Dialog>
  </section>;
}

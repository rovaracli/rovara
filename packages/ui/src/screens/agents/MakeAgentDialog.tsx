import { useTaskAction } from "../../api/task-action.js";
import { TaskActionNotice } from "../session/TaskActionNotice.js";
import { useMemo, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router";
import { AGENT_NAME_MAX, AgentIdSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionApi } from "../../api/sessions.js";
import type { SendResult } from "../../api/client.js";
import { Dialog } from "../../design/Dialog.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { paths } from "../../paths.js";
import { failureText } from "./agent-context.js";
export function MakeAgentDialog({ id, open, onOpenChange, trigger, onCloseAutoFocus }: { id: string; open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactElement; onCloseAutoFocus: (event: Event) => void }) {
 const [name, setName] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [created, setCreated] = useState<{ id: string; copied: boolean }>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), sending = useRef(false), intent = useRef<{ name: string; requestId: string } | undefined>(undefined);
 const host = useAppHost(), api = useMemo(() => createSessionApi(host), [host]);
 const action = useTaskAction(host, "make-agent:" + id, open);
 async function make() {
  if (action.locked || sending.current || created !== undefined || pending !== undefined || name.length > AGENT_NAME_MAX) return;sending.current = true;setBusy(true);setError(undefined);
  const trimmed = name.trim();if (intent.current?.name !== trimmed) intent.current = { name: trimmed, requestId: crypto.randomUUID() };
  try { const result = await action.run("make-agent", { requestId: intent.current.requestId, ...(trimmed ? { name: trimmed } : {}) }, body => api.makeAgent(id, body as { requestId: string; name?: string }));if (result.kind !== "done") { setPending(result);return; }const next = AgentIdSchema.parse(result.value.agent.agentId);setCreated({ id: next, copied: result.value.copied });if (result.value.copied) host.navigate(paths.agentEdit(next)); }
  catch (failure) { setError(failureText(failure, "Couldn't create the draft. Try again.")); }
  finally { sending.current = false;setBusy(false); }
 }
 return <Dialog className="rv-action-dialog" title="Make this an agent" description="Create a draft method from this task. Inspect its instructions, steps, tools and limits before testing or publishing." open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }} onCloseAutoFocus={onCloseAutoFocus} trigger={trigger}><form onSubmit={event => { event.preventDefault();void make(); }}><TextField label="Workflow name (optional)" value={name} maxLength={AGENT_NAME_MAX} onChange={event => setName(event.target.value)} disabled={action.locked || busy || created !== undefined || pending !== undefined} /><p className="rv-muted">Leave blank to use the task's name. Creating the draft doesn't share or publish it.</p><Button type="submit" variant="primary" busy={busy} disabled={action.locked || created !== undefined || pending !== undefined || name.length > AGENT_NAME_MAX}>Create draft</Button><TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={"/app/sessions/" + encodeURIComponent(id)} check={() => api.read(id)} />{error && <p role="alert"><VisibleText text={error} /></p>}{created && <p role="status">{created.copied ? "Your draft is ready." : "The source workflow couldn't be copied. Your new draft starts from scratch."} <Link to={paths.agentEdit(created.id)}>Inspect draft</Link></p>}{pending && <ConfirmInBrowser result={pending} subjectKey={["session", id]} isApplied={() => false} />}</form></Dialog>;
}

import { useEffect, useRef, useState } from "react";
import { AgentIdSchema, ROVARA_CODE_AGENT_ID, type ProjectOverviewReaderSchema } from "@agentx/contracts/web";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { VisibleText } from "../../design/VisibleText.js";
import { StartSessionDialog } from "./StartSessionDialog.js";
type Agent = ReturnType<typeof ProjectOverviewReaderSchema.parse>["agents"][number];
export function NewSessionMenu({ project, agents }: { project: string; agents: readonly Agent[] }) {
 const [open, setOpen] = useState(false), [selected, setSelected] = useState<Agent>(), [busy, setBusy] = useState(false);
 const choices = useRef(new Map<string, HTMLButtonElement>()), previous = useRef<string | undefined>(undefined);
 useEffect(() => { if (open && selected === undefined && previous.current !== undefined) choices.current.get(previous.current)?.focus(); }, [open, selected]);
 // Rovara Code is the first choice: it runs the project's own process. The agents below it follow as before.
 const code = agents.find(agent => agent.agentId === ROVARA_CODE_AGENT_ID), others = agents.filter(agent => agent.agentId !== ROVARA_CODE_AGENT_ID && AgentIdSchema.safeParse(agent.agentId).success);
 const first: Agent = { agentId: ROVARA_CODE_AGENT_ID, name: "Rovara Code", description: code?.description ?? "Describe the work and this project's process runs it.", running: code?.running ?? 0 };
 const available: Array<{ agent: Agent; label: string }> = [{ agent: first, label: "Describe the work (Rovara Code)" }, ...others.map(agent => ({ agent, label: agent.name }))];
 return <Dialog title={selected === undefined ? "New session" : "New session with " + selected.name} open={open} onOpenChange={value => { if (busy) return;setOpen(value);if (!value) setSelected(undefined); }} trigger={<Button variant="primary">New session</Button>}>{selected === undefined ? <><p>Choose the agent whose workflow fits the work.</p><ul className="rv-project-choices">{available.map(({ agent, label }) => <li key={agent.agentId}><Button ref={node => { if (node === null) choices.current.delete(agent.agentId);else choices.current.set(agent.agentId, node); }} onClick={() => { previous.current = agent.agentId;setSelected(agent); }}><VisibleText text={label} /></Button><p className="rv-muted"><VisibleText text={agent.description} /></p></li>)}</ul></> : <StartSessionDialog key={selected.agentId} project={project} agent={selected} onBusyChange={setBusy} onBack={() => setSelected(undefined)} />}</Dialog>;
}

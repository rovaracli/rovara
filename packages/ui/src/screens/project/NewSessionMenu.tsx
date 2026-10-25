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
 // PLAN6: keep the excluded code-start flow out of the generic agent choice and API.
 const available = agents.filter(agent => agent.agentId !== ROVARA_CODE_AGENT_ID && AgentIdSchema.safeParse(agent.agentId).success);
 return <Dialog title={selected === undefined ? "New session" : "New session with " + selected.name} open={open} onOpenChange={value => { if (busy) return;setOpen(value);if (!value) setSelected(undefined); }} trigger={<Button variant="primary">New session</Button>}>{selected === undefined ? <><p>Choose the agent whose workflow fits the work.</p><ul className="rv-project-choices">{available.map(agent => <li key={agent.agentId}><Button ref={node => { if (node === null) choices.current.delete(agent.agentId);else choices.current.set(agent.agentId, node); }} onClick={() => { previous.current = agent.agentId;setSelected(agent); }}><VisibleText text={agent.name} /></Button><p className="rv-muted"><VisibleText text={agent.description} /></p></li>)}</ul>{available.length === 0 && <p>No agents are available for a new session here.</p>}</> : <StartSessionDialog key={selected.agentId} project={project} agent={selected} onBusyChange={setBusy} onBack={() => setSelected(undefined)} />}</Dialog>;
}

import { useQuery } from "@tanstack/react-query";
import { useAgentApi } from "../../api/agents.js";
import { useState } from "react";
import { ProjectRoleSchema, projectAllows } from "@agentx/cloud-contracts/web";
import type { ReadAgent } from "../../api/agents.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Select } from "../../design/Select.js";
import { useAgentProjects } from "./agent-context.js";
import { StartSessionDialog } from "../project/StartSessionDialog.js";
export function AgentStartDialog({ agent }: { agent: ReadAgent }) {
 const [open, setOpen] = useState(false), [project, setProject] = useState(""), [chosen, setChosen] = useState<string>(), [busy, setBusy] = useState(false), projects = useAgentProjects(open);
 const api = useAgentApi(), roster = useQuery({ queryKey: ["agents", "all", project], enabled: open && project !== "", queryFn: () => api.list("all", project) });
 const canStart = !roster.isError && roster.data?.agents.some(item => item.agentId === agent.agentId && item.status === "active" && !item.disabled) === true;
 const available = projects.isError ? [] : projects.data?.projects.filter(item => { const role = ProjectRoleSchema.safeParse(item.myRole);return item.status === "active" && role.success && projectAllows(role.data, "start_tasks"); }) ?? [];
 return <Dialog title={"New session with " + agent.name} className="rv-agent-dialog" open={open} onOpenChange={value => { if (busy) return;setOpen(value);if (!value) { setChosen(undefined);setProject(""); } }} trigger={<Button variant="primary">Start session</Button>}>
 {chosen === undefined ? <><p>Choose where this method should work. That project's access and spending limits apply.</p><Select label="Project" value={project} onValueChange={setProject} disabled={projects.isPending || projects.isError} options={available.map(item => ({ value: item.name, label: item.name }))} />{projects.isError && <p role="alert">Couldn't load your projects. Close and reopen to try again.</p>}{!projects.isPending && !projects.isError && available.length === 0 && <p>No projects where you can start work are available.</p>}{project && roster.isPending && <p role="status">Checking workflow availability</p>}{project && roster.isError && <p role="alert">Couldn't check this project. Choose another project or reopen this dialog.</p>}{project && !roster.isPending && !roster.isError && !canStart && <p>This workflow isn't available on that project. Choose another project.</p>}<Button variant="primary" disabled={!canStart || !available.some(item => item.name === project)} onClick={() => setChosen(project)}>Continue</Button></> : <StartSessionDialog key={chosen} project={chosen} agent={agent} onBusyChange={setBusy} backLabel="Choose another project" onBack={() => setChosen(undefined)} />}
 </Dialog>;
}

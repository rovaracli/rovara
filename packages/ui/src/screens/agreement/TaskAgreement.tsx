import { Suspense, lazy, useState } from "react";
import { Skeleton } from "../../design/Skeleton.js";
import "./agreement.css";
import { T } from "./agreement-text.js";
import type { TaskFacts } from "./agreement-rows.js";
// The panel is its own chunk, and on the task page it reads nothing until this closed section is opened.
const WorkingAgreementPanel = lazy(async () => ({ default: (await import("./WorkingAgreementPanel.js")).WorkingAgreementPanel }));
/** The compact Working agreement on the task page (one closed section on the Pipeline tab, shown only while the switch is on; the page loads this file only then). */
export default function TaskAgreement({ project, task }: { project: string; task: TaskFacts }) {
 const [open, setOpen] = useState(false);
 return <details className="rv-agree-task rv-loaded-knowledge" onToggle={event => { setOpen(event.currentTarget.open); }}><summary>{T.TASK_TITLE}</summary>{open && <Suspense fallback={<Skeleton label={T.LOADING} />}><WorkingAgreementPanel project={project} variant="task" task={task} /></Suspense>}</details>;
}

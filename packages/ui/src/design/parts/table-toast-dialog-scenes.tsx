import { useState } from "react";
import { DataTable, type Column } from "../DataTable.js";
import { Toast } from "../Toast.js";
import { Announcer } from "../Announcer.js";
import { ConfirmationDialog } from "../ConfirmationDialog.js";
import { Button } from "../Button.js";
import { StatusChip } from "../StatusChip.js";

const exampleTasks = [
 { id: "refunds", title: "Add refunds endpoint", status: "running", owner: "A", updated: "20 s" },
 { id: "webhook", title: "Fix webhook retry backoff", status: "could_not_run", owner: "S", updated: "4 min" },
] as const;
const exampleColumns: readonly Column<(typeof exampleTasks)[number]>[] = [
 { key: "task", title: "Task", render: row => <><strong>{row.title}</strong><span className="rv-p3-phone-detail">{row.owner === "A" ? "Ana" : "Sam"} · {row.updated}</span></> },
 { key: "status", title: "Status", render: row => <StatusChip state={row.status} /> },
 { key: "owner", title: "Owner", render: row => <span className="rv-p3-example-owner" aria-label={row.owner === "A" ? "Ana" : "Sam"}>{row.owner}</span> },
 { key: "updated", title: "Updated", render: row => row.updated },
];
function TableScene() {
 const [selectedKey, setSelectedKey] = useState("webhook"), [opened, setOpened] = useState<string>();
 return <div className="rv-p3-table-scene"><DataTable caption="Example tasks" columns={exampleColumns} rows={exampleTasks} rowKey={row => row.id} selection={{ selectedKey, onSelect: setSelectedKey, onOpen: key => setOpened(exampleTasks.find(row => row.id === key)?.title) }} />
  <p className="rv-p3-note">One line, 48 high. Selected row sits on sunken with a marker bar and opens the side peek. Enter opens the full task; J and K move.</p>
  {opened && <p>Opened example task: {opened}</p>}
 </div>;
}
function ToastScene() {
 const [receipt, setReceipt] = useState<string>();
 return <Announcer><div className="rv-p3-toast-scene">{receipt ? <p>{receipt}</p> : <Toast message="Stopped following this task." onUndo={() => setReceipt("Following this example task again.")} onDismiss={() => setReceipt(current => current ?? "Example notification dismissed.")} />}</div>
  <p className="rv-p3-note">Only for a finished, reversible action, and always with Undo. Anything that started work or merged code gets a receipt on the page, never a toast.</p>
 </Announcer>;
}
function ConfirmationScene() {
 const [open, setOpen] = useState(false), [receipt, setReceipt] = useState<string>();
 function finish(message: string) { setReceipt(message); setOpen(false); }
 return <div><Button onClick={() => setOpen(true)}>Preview Close confirmation</Button>
  <p className="rv-p3-note">Static example: 3 unpublished files, with a 30-day retention supplied by the fixture. Live callers must supply the actual served retention.</p>
  <ConfirmationDialog kind="close" open={open} onOpenChange={setOpen} title={'Close "Add refunds endpoint"?'} consequence="Rovara checked this example task: 3 changed files are not in a pull request yet. Closing keeps them for 30 days unless you discard them." confirm={{ label: "Keep changes and close", onConfirm: () => finish("Example closed with changes kept.") }} discard={{ label: "Discard changes and close", consequence: "Deletes the 3 unpublished files. This can't be undone.", onDiscard: () => finish("Example closed with unpublished changes discarded.") }} />
  {receipt && <p>{receipt}</p>}
 </div>;
}
/** P5 mounts render as a React component. Every interaction is local fixture state. */
export const tableToastDialogGalleryScenes = [
 { id: "table", title: "Table row", render: TableScene },
 { id: "toast", title: "Toast", render: ToastScene },
 { id: "confirmation", title: "Confirmation dialog", render: ConfirmationScene },
] as const;

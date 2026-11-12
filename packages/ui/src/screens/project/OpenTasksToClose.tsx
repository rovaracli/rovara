import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/cloud-contracts/web";
import { mergeLiveTiles, useLive } from "../../api/live.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { CloseTaskDialog } from "../session/CloseTaskDialog.js";
/** One of the person's open tasks, as a link to its page and a Close button. */
function OpenTask({ id, title, project, onClosed }: { id: string; title: string; project: string | undefined; onClosed: () => Promise<unknown> }) {
 const [open, setOpen] = useState(false);
 return <li><Link to={"/app/sessions/" + id}><VisibleText text={title} /></Link>{project !== undefined && <span className="rv-muted"> on <VisibleText text={project} /></span>} <CloseTaskDialog id={id} open={open} onOpenChange={setOpen} onClosed={onClosed} trigger={<Button>Close</Button>} /></li>;
}
/**
 * Shown when a start was refused because the person has too many open tasks: the tasks they can close, each a link and a Close button, read from the Live wall (`close` is in a tile's actions only for a
 * task the person owns). Closing one refreshes the list and tells the start box, which clears its refusal so the work can be started again.
 */
export function OpenTasksToClose({ onClosed }: { onClosed: () => void }) {
 const live = useLive("mine"), query = useQueryClient();
 const tiles = live.data === undefined ? [] : mergeLiveTiles(live.data.pages).filter(tile => tile.actions.includes("close"));
 const closed = async () => { await query.invalidateQueries({ queryKey: ["live"] });onClosed(); };
 if (live.isPending) return <Skeleton label="Loading your open tasks" />;
 if (live.isError) return <p role="alert">Couldn't load your open tasks. Open Work to close one.</p>;
 if (tiles.length === 0) return <p className="rv-muted">No task of yours can be closed from here. Ask an admin to free a place.</p>;
 return <ul aria-label="Your open tasks">{tiles.map(tile => <OpenTask key={tile.sessionId} id={SessionIdSchema.parse(tile.sessionId)} title={tile.title} project={tile.project} onClosed={closed} />)}</ul>;
}

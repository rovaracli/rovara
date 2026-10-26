import { useEffect } from "react";
import { useAnnounce } from "./Announcer.js";
import { IconButton } from "./IconButton.js";
export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) { const announce = useAnnounce();useEffect(() => { announce(message); }, [announce, message]);return <aside className="rv-toast" aria-label="Notification"><span>{message}</span><IconButton label="Dismiss notification" variant="quiet" onClick={onDismiss}>×</IconButton></aside>; }

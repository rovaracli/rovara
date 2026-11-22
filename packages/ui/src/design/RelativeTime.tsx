import { useEffect, useState } from "react";
import { useTaskPagePolicy } from "../screens/session/task-page-policy.js";
export function RelativeTime({ at }: { at: string }) {
 const taskPage = useTaskPagePolicy() !== undefined, [now, setNow] = useState(() => Date.now());useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000);return () => clearInterval(timer); }, []);
 const time = Date.parse(at);if (!Number.isFinite(time)) return <span>Time unavailable</span>;
 // On the task page a time is the viewer's own clock (HH:MM; the day too when it is not today), as the boards draw it, never an age.
 if (taskPage) { const when = new Date(time), today = new Date(now), clock = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });return <time dateTime={at} title={when.toLocaleString()}>{when.toDateString() === today.toDateString() ? clock : when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + clock}</time>; }
 const delta = Math.max(0, Math.floor((now - time) / 60000));const words = delta === 0 ? "Just now" : delta < 60 ? `${String(delta)}m ago` : delta < 1440 ? `${String(Math.floor(delta / 60))}h ago` : `${String(Math.floor(delta / 1440))}d ago`;
 return <time dateTime={at} title={new Date(time).toLocaleString()}>{words}</time>;
}

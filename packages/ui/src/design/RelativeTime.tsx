import { useEffect, useState } from "react";
export function RelativeTime({ at }: { at: string }) {
 const [now, setNow] = useState(() => Date.now());useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000);return () => clearInterval(timer); }, []);
 const time = Date.parse(at);if (!Number.isFinite(time)) return <span>Time unavailable</span>;
 const delta = Math.max(0, Math.floor((now - time) / 60000));const words = delta === 0 ? "Just now" : delta < 60 ? `${String(delta)}m ago` : delta < 1440 ? `${String(Math.floor(delta / 60))}h ago` : `${String(Math.floor(delta / 1440))}d ago`;
 return <time dateTime={at} title={new Date(time).toLocaleString()}>{words}</time>;
}

// Small pieces of the Browser testing page (the approved mock's: chips, banners, sections, the key/value summary). They draw only what they are given; none asks Code anything.
import type { ReactNode } from "react";
import { VisibleText } from "../../../design/VisibleText.js";
import type { Chip } from "./model.js";

const ICONS = {
  check: <path d="M3 8.5l3.2 3.2L13 4.8" />, alert: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.8V8.6M8 11v.01" /></>, info: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.4V11M8 5v.01" /></>,
  spin: <path d="M8 2a6 6 0 106 6" />, lock: <><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>, pause: <path d="M6 3.5v9M10 3.5v9" />, copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1.5 1.5 0 00-1.5-1.5H4.5A1.5 1.5 0 003 3.5V9a1.5 1.5 0 001.5 1.5h1" /></>,
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name }: { name: IconName }) {
  return <svg className={name === "spin" ? "bt-spin" : undefined} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ICONS[name]}</svg>;
}

export function ChipView({ chip, icon, testId }: { chip: Chip; icon?: IconName; testId?: string }) {
  return <span className={`bt-chip bt-chip-${chip.kind}`} data-testid={testId}>{icon !== undefined && <Icon name={icon} />}<VisibleText text={chip.label} /></span>;
}
export const plain = (label: string): Chip => ({ label, kind: "plain" });

/** A quiet line that says the read is being asked again. */
export function Live({ children }: { children: ReactNode }) {
  return <div className="bt-live" role="status"><Icon name="spin" /><span>{children}</span></div>;
}

export function Notice({ kind, icon, title, children, actions, role, testId }: { kind: "ok" | "attn" | "bad" | "plain"; icon: IconName; title: string; children?: ReactNode; actions?: ReactNode; role?: "alert" | "status"; testId?: string }) {
  return <div className={`bt-banner bt-banner-${kind}`} role={role ?? (kind === "bad" ? "alert" : "status")} data-testid={testId}>
    <Icon name={icon} /><div><b><VisibleText text={title} /></b>{children !== undefined && <p>{children}</p>}{actions !== undefined && <div className="bt-acts">{actions}</div>}</div>
  </div>;
}

/** A card of the page. `num`: its number, "done" (ticked) or "none" (no mark). */
export function Section({ id, num, title, right, children, muted = false }: { id: string; num: number | "done" | "none"; title: string; right?: ReactNode; children: ReactNode; /** Not counted yet: the number is drawn quiet. */ muted?: boolean }) {
  return <section className={`bt-sub ${num === "none" ? "bt-nonum" : ""}`} aria-labelledby={`${id}-h`} data-testid={id}>
    <div className="bt-sh">{num === "done" ? <span className="bt-num bt-num-done" aria-hidden="true"><Icon name="check" /></span> : num !== "none" && <span className={`bt-num ${muted ? "bt-num-off" : ""}`} aria-hidden="true">{num}</span>}<h2 className="bt-st" id={`${id}-h`}><VisibleText text={title} /></h2>{right !== undefined && <span className="bt-sd">{right}</span>}</div>
    <div className="bt-sb">{children}</div>
  </section>;
}

export function Item({ name, text, extra, right, dim, testId }: { name: ReactNode; text?: ReactNode; extra?: ReactNode; right?: ReactNode; dim?: boolean; testId?: string }) {
  return <div className={`bt-item ${dim === true ? "bt-dim" : ""}`} data-testid={testId}><div className="bt-grow"><div className="bt-n">{name}</div>{text !== undefined && <div className="bt-s">{text}</div>}{extra}</div>{right}</div>;
}

export function Mono({ text }: { text: string }) { return <span className="bt-mono"><VisibleText text={text} /></span>; }

export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="bt-kvs">{rows.map(([key, value]) => <div key={key} className="bt-kv"><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

/** Under the controls of a card while the read is not fresh: they are off, and why. */
export function WhyOff({ show, children }: { show: boolean; children: ReactNode }) {
  return show ? <div className="bt-why" role="status" data-testid="bt-why-off"><Icon name="lock" /><span>{children}</span></div> : null;
}

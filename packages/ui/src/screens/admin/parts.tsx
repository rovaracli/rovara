// Small parts the Hybrid 1 admin pages share (DEC 223): "not connected yet", the fresh sign-in step, a stat, a meter and a section card.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useAppHost, type AppHost } from "../../host.js";
import { Button } from "../../design/Button.js";

/** What a page says for a route Cloud or Code does not serve yet. Never a spinner, never an empty table that looks like "nothing there". */
export function NotConnected({ what, children }: { what: string; children?: ReactNode }) {
 return <div className="rv-not-connected" data-testid="not-connected" role="status"><b>Not connected yet</b><p>{what} isn't connected to Rovara Code yet. {children ?? "Nothing is lost; this page fills in when it is."}</p></div>;
}

// The fresh sign-in step's "you confirmed" state. The browser cannot know whether Code accepted a step-up, and the server checks it on every sensitive route anyway,
// so this only decides whether the page shows the step or the action. It is not a URL flag anyone can type: the button stores a one-time nonce in the
// host's storage and puts it in the return address; coming back with the same nonce (and within 10 minutes) starts a confirmation that lasts the step-up window.
// The address is cleaned afterwards, so a reload, a bookmark or a shared link never says "confirmed". If the server later says the step-up is too old, the page
// goes back to the step (`refused`).
const NONCE_KEY = "rovara.stepup.nonce", CONFIRMED_KEY = "rovara.stepup.confirmedAt", NONCE_MAX_MS = 10 * 60_000, WINDOW_MS = 10 * 60_000;
type Storage = AppHost["storage"];
function readNumber(storage: Storage, key: string): number | undefined { const raw = storage.get(key); const value = raw === undefined || raw === "" ? Number.NaN : Number(raw); return Number.isFinite(value) ? value : undefined; }
export function startStepUpNonce(storage: Storage): string {
 const nonce = crypto.randomUUID();
 try { storage.set(NONCE_KEY, JSON.stringify({ nonce, at: Date.now() })); } catch { /* Blocked storage: the person still goes through the step, and the page shows it again on return. */ }
 return nonce;
}
function nonceMatches(storage: Storage, value: string | null): boolean {
 if (value === null) return false;
 try { const stored = JSON.parse(storage.get(NONCE_KEY) ?? "null") as { nonce?: unknown; at?: unknown } | null; return stored !== null && stored.nonce === value && typeof stored.at === "number" && Date.now() - stored.at <= NONCE_MAX_MS; } catch { return false; }
}
/** The address a person returns to after the fresh sign-in: this page again, carrying the nonce, so it can say "you confirmed". */
export function confirmedReturn(path: string, nonce: string): string {
 const [base, query = ""] = path.split("?", 2), params = new URLSearchParams(query);
 params.set("confirmed", nonce);
 return base + "?" + params.toString();
}
/** The server said the step-up is too old (or not there): forget the local confirmation, so a reload or another person's row asks again. */
export function forgetConfirmed(storage: Storage, who: string): void { try { storage.set(`${CONFIRMED_KEY}.${who}`, ""); } catch { /* ignored */ } }
/**
 * True while the person's confirmation is live: they just came back with the nonce this tab stored, or did so less than the step-up window ago. It is worked out when the
 * page opens (a sign-in round trip is a full page load); if the server later finds the step-up too old, the page shows the step again.
 */
export function useJustConfirmed(who: string | undefined): boolean {
 const host = useAppHost(), [params, setParams] = useSearchParams(), flag = params.get("confirmed"), key = who === undefined ? undefined : `${CONFIRMED_KEY}.${who}`;
 const [confirmed] = useState(() => {
  const at = key === undefined ? undefined : readNumber(host.storage, key), now = Date.now();
  return (key !== undefined && nonceMatches(host.storage, flag)) || (at !== undefined && now - at <= WINDOW_MS && now >= at);
 });
 useEffect(() => {
  if (flag === null) return;
  if (key !== undefined && nonceMatches(host.storage, flag)) { try { host.storage.set(key, String(Date.now())); host.storage.set(NONCE_KEY, ""); } catch { /* A blocked store only means the next page asks again. */ } }
  const next = new URLSearchParams(params); next.delete("confirmed"); setParams(next, { replace: true });
 }, [flag]); // eslint-disable-line react-hooks/exhaustive-deps
 return confirmed;
}

/**
 * The fresh sign-in step (Code's step-up page). A sensitive change does not act on its own: it asks the person to confirm it is them again (a passkey, or a code emailed
 * to the confirmation address), and Code checks that on its own route. A Slack, Google or GitHub round trip never counts.
 */
export function FreshSignIn({ action, done = false, refused = false }: { action: string; done?: boolean; refused?: boolean }) {
 const host = useAppHost();
 return <div className="rv-fresh" data-testid="fresh-sign-in" data-state={done ? "done" : refused ? "needed" : "ask"}>
  <div><b>{done ? "You confirmed it's you" : "Confirm it's you first"}</b>
   <p>{done ? `Now ${action}. This stays open for a few minutes.` : refused ? `Your last confirmation is too old to ${action}. Confirm it's you again, then come back to this step.` : `To ${action}, confirm it's you again with a passkey or a code sent to your confirmation email. Signing in again with Slack, Google or GitHub is not enough.`}</p></div>
  {!done && <Button variant="primary" data-testid="fresh-sign-in-start" onClick={() => { host.signIn(confirmedReturn(host.currentPath(), startStepUpNonce(host.storage)), { stepUp: true }); }}>Confirm it's you</Button>}
 </div>;
}

export function Stat({ label, children, note, tone }: { label: string; children: ReactNode; note?: ReactNode; tone?: "bad" | "warn" | "ok" }) {
 return <div className="rv-stat" {...(tone === undefined ? {} : { "data-tone": tone })}><span className="rv-stat-label">{label}</span><b className="rv-stat-value">{children}</b>{note !== undefined && <span className="rv-stat-note">{note}</span>}</div>;
}

/** A meter with a held part: the spent part is solid, the held part is lighter. Words go beside it; the bar alone says nothing to a screen reader. */
export function SpendMeter({ used, held = 0, bad = false, label, caption = false }: { used: number; held?: number; bad?: boolean; label: string; caption?: boolean }) {
 const pct = (n: number) => `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
 return <><div className="rv-meter rv-spend-meter" role="img" aria-label={label}><i className={bad ? "bad" : ""} style={{ width: pct(used) }} />{held > 0 && <u style={{ width: pct(Math.min(held, 1 - Math.min(1, used))) }} />}</div>{caption && <p className="rv-meter-caption" aria-hidden="true">{label}</p>}</>;
}

export function AdminSection({ id, title, note, children, actions }: { id?: string; title: string; note?: ReactNode; children: ReactNode; actions?: ReactNode }) {
 return <section className="rv-admin-card" {...(id === undefined ? {} : { id })} aria-label={title}><div className="rv-section-head"><h2>{title}</h2>{actions ?? (note !== undefined && <span>{note}</span>)}</div>{children}</section>;
}

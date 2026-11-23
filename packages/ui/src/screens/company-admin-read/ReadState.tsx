import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "../../design/Button.js";
import { ApiError } from "../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../api/served-read.js";
import { ErrorBlock, Loading, Notice, readClock } from "./parts.js";

/**
 * The shared read policy (DEC 254zzz324), the same one the company money and AI pages use; this file adds no rule of its own.
 * A failed re-read keeps the last confirmed facts with one "Updated HH:MM · Reconnecting" line, and every action stays disabled while they are stale.
 * Only the access signals (401 / 403 / 404 and the shared access codes) clear the facts. A re-read that is still fetching keeps the last confirmed facts on screen (the controller's ruling: no blank while fetching, like G2 / G3).
 * Keeping facts for display grants no authority: the actions re-check the fresh read at send time (CompanySettingsReadScreen).
 */
export interface Shown<T> { data: T | undefined; /** The time of the kept successful read, set only while a transient failure or a paused read is being shown. */ staleSince: number | undefined }
export function shownFacts<T>(read: UseQueryResult<T, Error>): Shown<T> {
 // The mount fence stays: facts that came from an earlier visit are not drawn until this mount's read has answered. A refetch AFTER that keeps the facts.
 if (!read.isFetchedAfterMount || read.isPending) return { data: undefined, staleSince: undefined };
 const served = servedReadState(read);
 if (served.data === undefined) return served;
 // A paused (offline) read cannot confirm anything: the same transient case as a failed one.
 return { data: served.data, staleSince: served.staleSince ?? (read.isPaused ? read.dataUpdatedAt : undefined) };
}
/** True while the page shows facts that the latest read did not confirm. Pages use it to disable every action. */
export function readIsStale(read: UseQueryResult<unknown, Error>): boolean { return shownFacts(read).staleSince !== undefined; }

function Reconnecting({ since }: { since: number }) {
 return <p className="rv-car-reconnecting" role="status">Updated {readClock(since) ?? "earlier"} · Reconnecting</p>;
}

/**
 * `header` always renders (the title is known from the entry); it receives the page's facts while the read is confirmed or stale-by-network.
 * `afterWrite`: a change was SAVED and the read that follows it has not answered: the facts on hand predate that change, so none are drawn, and the page
 * never says "Nothing was changed".
 */
export function ReadState<T>({ read, label, code, wide = false, afterWrite = false, changeSaid = "Your change was saved.", header, before, after, children }: { read: UseQueryResult<T, Error>; label: string; code: string; wide?: boolean; afterWrite?: boolean; /** What the page says about that change; a change sent for approval is not "saved". */ changeSaid?: string; header: (data: T | undefined, readAt: string | undefined) => ReactNode; /** Always drawn under the header (an action's answer survives the re-read it causes). */ before?: ReactNode; /** Always drawn after the read (sections with their own reads, and links). */ after?: ReactNode; children: (data: T, stale: boolean) => ReactNode }) {
 const shown = shownFacts(read), data = afterWrite ? undefined : shown.data;
 // Cloud's fixed 501 NOT_ON_CODE_YET: this install does not serve the read at all. A calm status, not an error block.
 const notHere = read.isError && read.error instanceof ApiError && read.error.status === 501 && read.error.code === "NOT_ON_CODE_YET";
 const ended = read.isError && isAccessEnded(read.error);
 const again = <div className="rv-car-refresh"><Button variant="quiet" disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Read {label.toLowerCase()} again</Button></div>;
 const retry = () => { void read.refetch(); };
 return <div className={wide ? "rv-car-state rv-car-wide" : "rv-car-state"}>
  {header(data, data === undefined ? undefined : readClock(read.dataUpdatedAt))}
  {before}
  {data !== undefined ? <>
   {shown.staleSince !== undefined && <Reconnecting since={shown.staleSince} />}
   {children(data, shown.staleSince !== undefined)}
  </>
   : notHere ? <div className="rv-car-notice" role="status" data-testid="not-connected"><b>Not connected yet</b><p>{label} isn&apos;t connected to Rovara Code yet. Nothing is lost; this page fills in when it is.</p></div>
   : read.isError && ended ? <ErrorBlock code={code.replace(/-READ-FAILED$/, "-ACCESS-LOST")} happened="This read is no longer available to you. Earlier details are hidden." next="If you should still have access, ask a company owner or admin." {...(afterWrite ? { safe: "Your change went through." } : {})} busy={read.isFetching} onRetry={retry} />
   : read.isError && afterWrite ? <><Notice role="status">Couldn&apos;t refresh this page; reconnecting. {changeSaid}</Notice>{again}</>
   : read.isError ? <ErrorBlock code={code} happened="Rovara can't tell yet. The latest read failed; earlier details are hidden." busy={read.isFetching} onRetry={retry} />
   : read.isPaused ? <Notice role="status">Rovara can&apos;t tell yet. The read is paused; earlier details are hidden.</Notice>
   : read.isPending || read.isFetching ? <Loading>{read.data === undefined ? `Loading ${label.toLowerCase()}` : "Checking current details; earlier details are hidden."}</Loading>
   : <Notice role="status">Rovara can&apos;t tell yet.</Notice>}
  {after}
  {data !== undefined && again}
 </div>;
}

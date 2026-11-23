import { Fragment, type ReactNode } from "react";
import { ApiError } from "../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../api/served-read.js";
import { Button } from "../../design/Button.js";
import { ErrorBlock } from "./parts.js";
import { StaleMark } from "./stale.js";
type Read<T> = { data: T | undefined; dataUpdatedAt: number; isPending: boolean; isFetching: boolean; isError: boolean; failureCount: number; error: unknown; failureReason?: unknown; refetch(): unknown };
/** Shared display policy: transient failures retain facts; access loss removes them. */
export function ReadState<T>({ read, children, refName = "READ", scope = "section", safe }: { read: Read<T>; children: (data: T) => ReactNode; refName?: string; scope?: "page" | "section"; safe?: string | undefined }) {
 const shown = servedReadState(read);
 if (shown.data !== undefined && shown.staleSince !== undefined) {
  // Stale: the last data stays; the page draws one quiet line (StaleSlot). Nothing says "error" and nothing is hidden.
  // Both branches wrap the children in the same keyed Fragment, so going fresh -> stale never remounts them (a write in flight keeps its lock and outcome).
  return <><StaleMark key="stale" at={shown.staleSince} /><Fragment key="read">{children(shown.data)}</Fragment></>;
 }
 if (read.isError || read.failureCount > 0) {
  const denied = isAccessEnded(read.error) || isAccessEnded(read.failureReason);
  const unavailable = !denied && read.error instanceof ApiError && read.error.status === 501;
  // Without retained facts, access loss gets the shared 4e access block; only 501 means unsupported.
  if (unavailable) return <div className="g4-error" data-kind="unknown"><p role="alert">We can&#8217;t tell yet. This read isn&#8217;t available on this install.</p><Button onClick={() => { void read.refetch(); }}>Load again</Button></div>;
  return <ErrorBlock kind={denied ? "denied" : "failed"} scope={scope} refName={refName} retry={() => { void read.refetch(); }} {...(safe === undefined ? {} : { safe })} />;
 }
 // Kept facts stay on screen during a re-read: unmounting them would drop an in-flight write's outcome and its single-flight lock.
 if (read.data === undefined) return <div className="g4-loading"><p className="g4-state" role="status">Reading this section…</p><div className="g4-skeleton-rows" aria-hidden="true"><span className="rv-skeleton" /><span className="rv-skeleton" /><span className="rv-skeleton" /></div></div>;
 return <><Fragment key="read">{children(read.data)}</Fragment></>;
}

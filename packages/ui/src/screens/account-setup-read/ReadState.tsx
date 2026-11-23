import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "../../design/Button.js";
import { isAccessEnded } from "../../api/served-read.js";
import { ErrorBlock, Loading, SectionUnknown } from "./parts.js";
import { servedFacts, useWroteSafe } from "./read-model.js";
import { useReconnectingLine } from "./reconnecting.js";

export interface ReadStateProps<T> {
 query: UseQueryResult<T, Error>; label: string; children: (data: T, updatedAt: number) => ReactNode; refresh?: boolean; variant?: "page" | "section"; code?: string;
 /** Wraps the loading and unknown outcomes (for reads that sit beside other content). */
 shell?: (node: ReactNode) => ReactNode;
 /** The whole outcome sits in ONE list row with this name, so the row is the same element while it loads, fails or shows. */
 rowLabel?: string;
}
/**
 * One place for every read outcome, on the SHARED policy (servedReadState + isAccessEnded, DEC 254zzz324; no local rule here).
 * Facts (the last good read) show whenever the shared policy keeps them, including while the read is fetched again; a failed re-read that is not
 * an access signal adds one "Updated HH:MM · Reconnecting" line. 401, 403, 404 and the shared access codes clear them behind the access-ended block.
 * `page` reads own the whole page body and show the 4e error block; `section` reads stay inside their section.
 */
function Outcome<T>({ query, label, children, refresh = false, variant = "section", code = "READ-FAILED", shell }: ReadStateProps<T>) {
 const wrap = (node: ReactNode) => shell === undefined ? node : shell(node);
 const { data, staleSince } = servedFacts(query);
 const line = useReconnectingLine(staleSince), wroteSafe = useWroteSafe();
 const retry = () => { void query.refetch(); };
 if (data !== undefined) return <>{line !== null && wrap(line)}{children(data, query.dataUpdatedAt)}{refresh && staleSince === undefined && <div className="g5-refresh"><Button variant="quiet" data-read-retry onClick={retry}>Check again</Button></div>}</>;
 if (query.isError || query.failureCount > 0) {
  const denied = isAccessEnded(query.error) || isAccessEnded(query.failureReason);
  const sentence = `Can't tell yet: ${denied ? "access to this information could not be confirmed." : `${label} couldn't be read.`}`;
  return variant === "page" ? <ErrorBlock code={code} happened={sentence} busy={query.isFetching} onRetry={retry} {...(wroteSafe === undefined ? {} : { safe: wroteSafe })} /> : wrap(<SectionUnknown busy={query.isFetching} onRetry={retry}>{sentence}</SectionUnknown>);
 }
 return wrap(<Loading>{`Checking ${label}… Can't tell yet.`}</Loading>);
}
export function ReadState<T>(props: ReadStateProps<T>) {
 return props.rowLabel === undefined ? <Outcome {...props} /> : <li className="g5-row" aria-label={props.rowLabel}><Outcome {...props} /></li>;
}

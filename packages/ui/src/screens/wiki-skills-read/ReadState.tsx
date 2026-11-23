import { createContext, useContext, type ReactNode } from "react";
import { ApiError } from "../../api/errors.js";
import { isAccessEnded, isLocalMissing, servedReadState } from "../../api/served-read.js";
import { useHolding } from "./hold.js";
import { AccessEnded, ErrorBlock, HeldLine, Loading, Notice, StaleLine, readClock } from "./parts.js";

type Back = { label: string; href: string };
/** One timestamp for the current composed surface; kept facts grant no write authority. */
export const ReadSurfaceContext = createContext<{ staleSince: number | undefined } | undefined>(undefined);
export function ReadState({ read, label = "this page", code = "WIKI-READ-FAILED", back, quiet = false, staleLine = true, notFound, header, children }: { read: { isPending: boolean; isFetching: boolean; isError: boolean; failureCount: number; error: unknown; data: unknown; dataUpdatedAt: number; failureReason?: unknown; refetch: () => unknown }; label?: string; code?: string; back?: Back; quiet?: boolean; staleLine?: boolean; /** The sentence for a read about ONE page or skill that is no longer there (its read is marked local); the rest of the scope stays usable. */ notFound?: string; header?: (confirmed: boolean, readAt: string | undefined) => ReactNode; children: ReactNode }) {
 const shown = servedReadState(read), surface = useContext(ReadSurfaceContext), holding = useHolding();
 const failed = (read.isError || read.failureCount > 0) && shown.data === undefined;
 const gone = isLocalMissing(read.error) || isLocalMissing(read.failureReason);
 const denied = !gone && (isAccessEnded(read.error) || isAccessEnded(read.failureReason));
 const unavailable = read.error instanceof ApiError && read.error.status === 501;
 const staleSince = surface === undefined ? shown.staleSince : surface.staleSince;
 const confirmed = shown.data !== undefined && !read.isPending && (!read.isFetching || shown.staleSince !== undefined || holding);
 const top = header?.(confirmed, confirmed && staleSince === undefined ? readClock(read.dataUpdatedAt) : undefined);
 const heading = <>{top}{confirmed && staleSince !== undefined && !quiet && staleLine && top != null && <StaleLine at={readClock(staleSince)} />}</>;
 const retry = () => { void read.refetch(); };
 if (failed && gone && !quiet && notFound !== undefined) return <>{heading}<HeldLine {...(back === undefined ? {} : { back })}>{notFound}</HeldLine></>;
 if (failed && denied) return quiet ? <AccessEnded bare busy={read.isFetching} onRetry={retry} /> : <AccessEnded busy={read.isFetching} onRetry={retry} />;
 if (failed && quiet) return <>{heading}{unavailable ? <Notice>Can&apos;t tell yet.</Notice> : <Notice role="alert">Couldn&apos;t read {label} just now. Earlier information is hidden.</Notice>}</>;
 if (failed) return <>{heading}{unavailable ? <HeldLine {...(back === undefined ? {} : { back })}>Can&apos;t tell yet. This read isn&apos;t available here yet.</HeldLine> : <ErrorBlock code={code} happened={`Rovara did not return ${label}. Earlier information is hidden.`} busy={read.isFetching} onRetry={retry} />}</>;
 // Pending refreshes never expose a cached private read as current authority.
 if (read.isPending || (read.isFetching && shown.staleSince === undefined && !holding)) return <>{heading}{quiet ? <Notice role="status">Loading the latest read…</Notice> : <Loading>Loading the latest read…</Loading>}</>;
 if (shown.data === undefined) return <>{heading}{quiet ? <Notice>Can&apos;t tell yet.</Notice> : <HeldLine {...(back === undefined ? {} : { back })}>Can&apos;t tell yet.</HeldLine>}</>;
 return <>{heading}{children}</>;
}

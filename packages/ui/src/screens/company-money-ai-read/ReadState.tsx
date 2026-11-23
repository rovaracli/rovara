import { createContext, useContext, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { isAccessEnded, servedReadState } from '../../api/served-read.js';
import { ApiError } from '../../api/errors.js';
import { OutcomeNotConfirmed } from '../../design/OutcomeNotConfirmed.js';
import { freshFacts } from './read-model.js';
import { HeldLine, Unknown } from './Parts.js';
// A composed surface owns one status line. Retained display facts never grant write authority.
const StaleParent = createContext(false);
function Reconnecting({ since }: { since: number }) {
 return <p className="g2-reconnecting" role="status">Updated {new Date(since).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })} · Reconnecting</p>;
}
/** Internal composition boundary for sibling reads on one G2 page. */
export function ReadSurface({ reads, children }: { reads: readonly UseQueryResult<unknown>[]; children: ReactNode }) {
 const parent = useContext(StaleParent);
 const since = reads.map(read => servedReadState(read).staleSince).find(time => time !== undefined);
 return <StaleParent.Provider value={parent || since !== undefined}>
  {!parent && since !== undefined && <Reconnecting since={since} />}{children}
 </StaleParent.Provider>;
}
/** First-read errors use 4e; a failed refresh follows the shared access-only eviction policy. */
export function ReadState<T>({ read, label, scope = 'page', children }: { read: UseQueryResult<T>; label: string; scope?: 'page' | 'section'; children: (data: T) => ReactNode }) {
 const parent = useContext(StaleParent), shown = servedReadState(read), data = freshFacts(read);
 if (data !== undefined) return <StaleParent.Provider value={parent || shown.staleSince !== undefined}>
  {!parent && shown.staleSince !== undefined && <Reconnecting since={shown.staleSince} />}{children(data)}
 </StaleParent.Provider>;
 const error = read.error, denied = read.isError && isAccessEnded(error);
 const notHere = error instanceof ApiError && error.status === 501 && error.code === 'NOT_ON_CODE_YET';
 if (notHere) return <div className="g2-read-state g2-held-row"><Unknown /><HeldLine role="status">Rovara can&apos;t read this here yet.</HeldLine></div>;
 if (!read.isError) return <div className="g2-read-state" aria-busy={read.isFetching}><HeldLine role="status">{`Reading ${label.toLowerCase()}…`}</HeldLine></div>;
 const ref = label.toUpperCase().replace(/[^A-Z0-9]+/gu, '-');
 return <div className="g2-read-state g2-read-error" role="alert" aria-busy={read.isFetching}>
  <OutcomeNotConfirmed
   title={denied ? `Rovara can't show this ${scope} to you` : `Rovara couldn't read this ${scope}`}
   happened={denied ? 'You no longer have access to this page. Previous information is hidden.' : 'The last read did not answer. Previous information is hidden.'}
   safe="Loading again only reads; it does not repeat a change."
   next={denied ? 'Ask a company owner or admin if you should have access, then load the page again.' : 'Load the page again. If it still cannot be read, ask a company owner or admin.'}
   check={{ label: 'Load again', onCheck: () => { void read.refetch(); } }} busy={read.isFetching} refCode={`${ref}-${denied ? 'ACCESS-LOST' : 'FAILED'}`} />
 </div>;
}

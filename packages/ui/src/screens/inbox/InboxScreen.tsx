import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { INBOX_KIND_WORDS, INBOX_NOT_AVAILABLE_TEXT, INBOX_POLL_MS, INBOX_READ_IDS_MAX, PROJECT_NOTICE_KIND_WORDS } from "@agentx/contracts/web";
import { createInboxApi, inboxNotAvailable } from "../../api/inbox.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { EmptyState } from "../../design/EmptyState.js";
import { PageHeader } from "../../design/PageHeader.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VisuallyHidden } from "../../design/VisuallyHidden.js";
import { InboxAttention } from "./InboxAttention.js";
import "./inbox.css";

type InboxPage = Awaited<ReturnType<ReturnType<typeof createInboxApi>["page"]>>;
/** A kind a newer Code added reads as plain "Update". */
const kindWords = (kind: string) => (Object.hasOwn(INBOX_KIND_WORDS, kind) ? INBOX_KIND_WORDS[kind as keyof typeof INBOX_KIND_WORDS] : "Update");

/**
 * What waits for the person, and what happened, newest first (web task channel K5). Each row opens the task (its session, or the task by its id) and marks
 * itself read. The page reads again every 30 seconds (live updates come later). Rovara Code decides which rows the person may see; this page only draws them.
 */
export function InboxScreen() {
 const host = useAppHost(), api = useMemo(() => createInboxApi(host), [host]), query = useQueryClient();
 const [marking, setMarking] = useState(false), [failure, setFailure] = useState<string>();
 const inbox = useInfiniteQuery({
  queryKey: ["inbox", "list"], retry: false, initialPageParam: undefined as string | undefined, getNextPageParam: (page: InboxPage) => page.nextCursor,
  queryFn: ({ pageParam }): Promise<InboxPage> => api.page(pageParam === undefined ? {} : { cursor: pageParam }),
  refetchInterval: current => (current.state.error !== null && inboxNotAvailable(current.state.error) ? false : INBOX_POLL_MS),
 });
 // L4-U5b: project notices are independent of task updates. A failed latest read hides cached notices and explains the incomplete read. Unsupported Code answers empty, so this is never an all-clear.
 const notices = useQuery({ queryKey: ["inbox", "project-notices"], retry: false, queryFn: () => api.projectNotices(), refetchInterval: INBOX_POLL_MS });
 const noticeItems = notices.isSuccess && notices.failureCount === 0 ? notices.data.items : [];
 const fresh = inbox.isSuccess && inbox.failureCount === 0;
 const items: InboxPage["items"] = fresh ? inbox.data.pages.flatMap(page => page.items) : [];
 const unreadIds = items.filter(item => !item.read).map(item => item.id);
 const unread = inbox.data?.pages[0]?.unread ?? unreadIds.length;
 const refresh = () => Promise.all([query.invalidateQueries({ queryKey: ["inbox", "list"] }), query.invalidateQueries({ queryKey: ["inbox", "badge"] })]);
 // Opening a row marks it read, once and without holding the page: a failed mark leaves the row unread and costs nothing else.
 const markOne = (id: string) => { void api.markRead({ requestId: crypto.randomUUID(), ids: [id] }).then(() => refresh(), () => undefined); };
 async function markAll() {
  if (marking || unreadIds.length === 0) return;
  setMarking(true);setFailure(undefined);
  try {
   // At most 50 ids go in one request.
   for (let start = 0; start < unreadIds.length; start += INBOX_READ_IDS_MAX) await api.markRead({ requestId: crypto.randomUUID(), ids: unreadIds.slice(start, start + INBOX_READ_IDS_MAX) });
  } catch (error) { setFailure(error instanceof ApiError ? error.message : "Couldn't mark these as read. Try again."); }
  finally { setMarking(false);await refresh(); }
 }
 const notAvailable = inbox.isError && inboxNotAvailable(inbox.error);
 return <section className="rv-notices" data-testid="inbox"><PageHeader title="Inbox" {...(fresh && unread > 0 ? { description: `${String(unread)} unread` } : {})}
  actions={!notAvailable && unreadIds.length > 0 ? <Button disabled={marking} onClick={() => { void markAll(); }}>Mark all as read</Button> : undefined} />
  <InboxAttention />
  <h2 className="rv-notice-section">Updates</h2>
  {notices.isError && <p role="status" data-testid="project-notices-error">Project notices could not be loaded. The inbox may be incomplete. <Button onClick={() => { void notices.refetch(); }}>Reload project notices</Button></p>}
  {noticeItems.length > 0 && <section aria-labelledby="rv-project-notices-title" data-testid="project-notices"><h2 id="rv-project-notices-title" className="rv-notice-section">Projects that need an admin</h2>
   <ol className="rv-notice-list" aria-label="Projects that need an admin">{noticeItems.map(item => <li key={item.id} className="rv-notice-row" data-read="false" data-testid="project-notice-row" data-kind={item.kind}>
    <Link to={"/projects/" + encodeURIComponent(item.project)} className="rv-notice-link">
     <span className="rv-notice-dot" aria-hidden="true" />
     <span className="rv-notice-main"><b><VisibleText text={item.project} /></b><small>{Object.hasOwn(PROJECT_NOTICE_KIND_WORDS, item.kind) ? PROJECT_NOTICE_KIND_WORDS[item.kind as keyof typeof PROJECT_NOTICE_KIND_WORDS] : "Update"} · <VisibleText text={item.status} /></small></span>
     <span className="rv-notice-meta"><RelativeTime at={item.at} /></span>
    </Link>
   </li>)}</ol></section>}
  {inbox.isPending && <Skeleton label="Loading your inbox" />}
  {notAvailable && <p role="status" data-testid="inbox-unavailable">{INBOX_NOT_AVAILABLE_TEXT}</p>}
  {inbox.isError && !notAvailable && <div role="alert" data-testid="load-error"><p><VisibleText text={inbox.error instanceof ApiError ? inbox.error.message : "Couldn't load your inbox. Try again."} /></p><Button onClick={() => { void inbox.refetch(); }}>Try again</Button></div>}
  {failure !== undefined && <p role="alert"><VisibleText text={failure} /></p>}
  {inbox.data !== undefined && !inbox.isError && items.length === 0 && <EmptyState testId="inbox-empty" title="No updates shown" description="No updates were returned. Rovara can't tell yet whether anything else needs you." />}
  {inbox.data !== undefined && !inbox.isError && items.length > 0 && <ol className="rv-notice-list" aria-label="Inbox">{items.map(item => <li key={item.id} className="rv-notice-row" data-read={item.read ? "true" : "false"} data-testid="inbox-row">
   <Link to={item.open} className="rv-notice-link" onClick={() => { if (!item.read) markOne(item.id); }}>
    <span className="rv-notice-dot" aria-hidden="true" />
    <span className="rv-notice-main"><b><VisibleText text={item.title} /></b><small>{kindWords(item.kind)} · <VisibleText text={item.status} /></small></span>
    <span className="rv-notice-meta">{!item.read && <VisuallyHidden>Unread. </VisuallyHidden>}<RelativeTime at={item.at} /></span>
   </Link>
  </li>)}</ol>}
  {fresh && inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => { void inbox.fetchNextPage(); }}>Show more</Button>}
 </section>;
}

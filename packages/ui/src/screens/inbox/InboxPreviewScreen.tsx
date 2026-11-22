import { useInboxReadActions } from "./useInboxReadActions.js";
import { QueueActions } from "../work/QueueActions.js";
import { useMemo } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { INBOX_KIND_WORDS, INBOX_NOT_AVAILABLE_TEXT, INBOX_POLL_MS, PROJECT_NOTICE_KIND_WORDS } from "@agentx/contracts/web";
import { createInboxReadApi, inboxNotAvailable } from "../../api/inbox-read.js";
import { accessEndedCode, servedReadState } from "../../api/served-read.js";
import { StaleReads } from "../work/StaleReads.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { HeldState } from "../../design/HeldState.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { VisuallyHidden } from "../../design/VisuallyHidden.js";
import { ErrorBlock, QuietNote, readFailureTodo, readFailureWords, shortAge, updatedWords } from "../work/queue-preview.js";
import { InboxAttentionSection, InboxPeek, useInboxAttention } from "./InboxAttention.js";
import "./inbox-preview.css";
import "../work/work-preview.css";

type InboxPage = Awaited<ReturnType<ReturnType<typeof createInboxReadApi>["page"]>>;
/** A kind a newer Code added reads as plain "Update". */
const kindWords = (kind: string) => (Object.hasOwn(INBOX_KIND_WORDS, kind) ? INBOX_KIND_WORDS[kind as keyof typeof INBOX_KIND_WORDS] : "Update");

/**
 * What waits for the person, and what happened, newest first (web task channel K5). Each row opens the task (its session, or the task by its id) and opens
 * using the shared live mark-read handler. The page reads again every 30 seconds (live updates come later). Rovara Code decides which rows the person may see; this page only draws them.
 * Boards 2a (list and short peek), 2b (first day, caught up, partly loaded), 2d (phone), 2e (phone, a row opens full width) and 10b (320 px).
 */
export function InboxPreviewScreen() { return <QueueActions><InboxPreviewContent /></QueueActions>; }
function InboxPreviewContent() {
 const host = useAppHost(), api = useMemo(() => createInboxReadApi(host), [host]);
 const inbox = useInfiniteQuery({
  queryKey: ["inbox", "list"], retry: false, initialPageParam: undefined as string | undefined, getNextPageParam: (page: InboxPage) => page.nextCursor,
  queryFn: ({ pageParam }): Promise<InboxPage> => api.page(pageParam === undefined ? {} : { cursor: pageParam }),
  refetchInterval: current => (current.state.error !== null && inboxNotAvailable(current.state.error) ? false : INBOX_POLL_MS),
 });
 // L4-U5b: project notices are independent of task updates. A failed latest read hides cached notices and explains the incomplete read. Unsupported Code answers empty, so this is never an all-clear.
 const notices = useQuery({ queryKey: ["inbox", "project-notices"], retry: false, queryFn: () => api.projectNotices(), refetchInterval: INBOX_POLL_MS });
 const keptInbox = servedReadState(inbox), keptNotices = servedReadState(notices);
 const state = useInboxAttention(notices.isError);
 const noticeItems = keptNotices.data?.items ?? [];
 const fresh = inbox.isSuccess && inbox.failureCount === 0;
 const items: InboxPage["items"] = keptInbox.data?.pages.flatMap(page => page.items) ?? [];
 const { marking, failure, markAll, markOne } = useInboxReadActions(items.filter(item => !item.read).map(item => item.id), fresh);
 const unread = inbox.data?.pages[0]?.unread ?? items.filter(item => !item.read).length;
 const notAvailable = inbox.isError && accessEndedCode(inbox.error) === undefined && inboxNotAvailable(inbox.error);
 const noticesFailed = notices.isError;
 const { needsCount, tasks, now, selected, attention } = state;
 const updated = tasks.isSuccess && tasks.failureCount === 0 && tasks.dataUpdatedAt > 0 ? updatedWords(new Date(tasks.dataUpdatedAt).toISOString(), now) : "";
 const summary = [needsCount !== undefined ? `${String(needsCount)} ${needsCount === 1 ? "item" : "items"} shown that ${needsCount === 1 ? "needs" : "need"} you` : "", noticesFailed ? "" : updated, fresh && unread > 0 ? `${String(unread)} unread` : ""].filter(part => part !== "").join(" · ");
 return <section className="rv-qp rv-inbox-preview" data-testid="inbox" data-peek={selected !== undefined} data-detail-open={selected !== undefined}>
  <div className="rv-qp-main">
   <PageHeader title="Inbox" actions={fresh && items.some(item => !item.read) ? <Button disabled={marking} onClick={() => { void markAll(); }}>Mark all as read</Button> : undefined} {...(summary !== "" ? { description: summary + "." } : {})} />
   {attention.length > 0 && !tasks.isError && !state.decisions.isError && <p className="rv-qp-scope"><HeldState /> <span>Rovara can't tell yet whether this is everything that needs you.</span></p>}
   <StaleReads reads={[...state.retainedReads, keptInbox, keptNotices]} />
   <InboxAttentionSection state={state} noticesFailed={noticesFailed} retryNotices={() => { void notices.refetch(); }} />
   {noticesFailed && attention.length > 0 && <ErrorBlock title="Rovara couldn't load project notices." retryLabel="Check project notices again" onRetry={() => { void notices.refetch(); }} refCode="INBOX-NOTICES-UNREAD" todo={readFailureTodo(notices.error)} testId="project-notices-error">Project notices could not be loaded. The inbox may be incomplete. {readFailureWords(notices.error, "")}</ErrorBlock>}
   {noticesFailed && attention.length === 0 && (state.tab !== "needs" || state.tasks.isError || state.decisions.isError) && <ErrorBlock title="Rovara couldn't load project notices." retryLabel="Check project notices again" onRetry={() => { void notices.refetch(); }} refCode="INBOX-NOTICES-UNREAD" todo={readFailureTodo(notices.error)} testId="project-notices-error">Project notices could not be loaded. The inbox may be incomplete. {readFailureWords(notices.error, "")}</ErrorBlock>}
   {noticeItems.length > 0 && <section aria-labelledby="rv-project-notices-title" data-testid="project-notices" className="rv-qp-updates"><h2 id="rv-project-notices-title">Projects that need an admin</h2>
    <ol className="rv-qp-update-list" aria-label="Projects that need an admin">{noticeItems.map(item => <li key={item.id} className="rv-qp-update" data-read="false" data-testid="project-notice-row" data-kind={item.kind}>
     <Link to={"/projects/" + encodeURIComponent(item.project)}>
      <span className="rv-qp-update-dot" aria-hidden="true" />
      <span className="rv-qp-update-main"><b><VisibleText text={item.project} /></b><small>{Object.hasOwn(PROJECT_NOTICE_KIND_WORDS, item.kind) ? PROJECT_NOTICE_KIND_WORDS[item.kind as keyof typeof PROJECT_NOTICE_KIND_WORDS] : "Update"} · <VisibleText text={item.status} /></small></span>
      <time dateTime={item.at}>{shortAge(item.at, now)}</time>
     </Link>
    </li>)}</ol></section>}
   {failure !== undefined && <p role="alert" className="rv-qp-failure"><VisibleText text={failure} /></p>}
   {inbox.isPending && <Skeleton label="Loading your inbox" />}
   {notAvailable && <QuietNote testId="inbox-unavailable">{INBOX_NOT_AVAILABLE_TEXT}</QuietNote>}
   {inbox.isError && !notAvailable && <ErrorBlock live="alert" testId="load-error" title="Rovara couldn't load your updates." onRetry={() => { void inbox.refetch(); }} refCode="INBOX-UPDATES-UNREAD" todo={readFailureTodo(inbox.error)}><VisibleText text={readFailureWords(inbox.error, "Couldn't load your inbox. Try again.")} /></ErrorBlock>}
   {keptInbox.data !== undefined && items.length > 0 && <section className="rv-qp-updates"><h2>Updates</h2><ol className="rv-qp-update-list" aria-label="Inbox">{items.map(item => <li key={item.id} className="rv-qp-update" data-read={item.read ? "true" : "false"} data-testid="inbox-row">
    <Link to={item.open} onClick={() => { if (!item.read) markOne(item.id); }}>
     <span className="rv-qp-update-dot" aria-hidden="true" />
     <span className="rv-qp-update-main"><b><VisibleText text={item.title} /></b><small>{kindWords(item.kind)} · <VisibleText text={item.status} /></small></span>
     <time dateTime={item.at}>{!item.read && <VisuallyHidden>Unread. </VisuallyHidden>}{shortAge(item.at, now)}</time>
    </Link>
   </li>)}</ol></section>}
   {fresh && inbox.hasNextPage && <Button disabled={inbox.isFetchingNextPage} onClick={() => { void inbox.fetchNextPage(); }}>Show more</Button>}
  </div>
  <InboxPeek state={state} />
 </section>;
}

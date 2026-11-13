// Convergence S0 WIRING: the `realtime` point on Cloud's cloud events service (lane A8's AppSyncEventsPublisher), with Cloud's pages' vocabulary.
//
// The core tells an open page that something it shows changed with notices of its own (`attention.changed`, vendor core/notify/attention.ts). Cloud's pages hear
// exactly four notices (`RealtimeNoticeSchema`, cloud-contracts/src/realtime.ts): session.updated, session.event, home.changed, device.command. A page that gets
// anything else drops it, and a mapped copy cannot be made honestly: `home.changed` carries the summary revision and the page keeps the highest one it saw per key
// (ui/src/realtime/client.ts), so a made-up revision would hide Cloud's real ones.
//
// What Cloud already does for a core task: its notice sink over the stream of the table (realtime/sink.ts) tells pages `session.updated` and `home.changed` from the
// session summaries (the core keeps them under the same keys, D14). So the root's publisher passes the notices the pages know, and does not send the core's own
// `attention.changed` to the events API: it is the core's hint for pages Code serves itself, and the same change reaches Cloud's pages through the sink.
// A dropped entry counts as sent (nothing was refused, there was nobody to tell), never as failed.
import type { RealtimeBatch, RealtimePublishResult, RealtimePublisher } from "@rovara-code/contracts";

/** The notices Cloud's pages understand. */
export const PAGE_NOTICE_TYPES: ReadonlySet<string> = new Set(["session.updated", "session.event", "home.changed", "device.command"]);

export function cloudPageNotices(inner: RealtimePublisher): RealtimePublisher {
  return {
    capabilities: inner.capabilities,
    async publish(batch: RealtimeBatch): Promise<RealtimePublishResult> {
      const known = batch.entries.filter((entry) => PAGE_NOTICE_TYPES.has(entry.notice.type));
      const dropped = batch.entries.length - known.length;
      if (known.length === 0) return { sent: dropped, failed: 0 };
      const result = await inner.publish({ ...batch, entries: known });
      return { sent: result.sent + dropped, failed: result.failed };
    },
    ...(inner.close === undefined ? {} : { close: () => inner.close?.() }),
  };
}

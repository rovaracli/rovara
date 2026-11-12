// The time limits of a person's attention direct message (a `NOTIFY_DM` row), shared by the notifier that posts it and the broker's sweep that re-queues it. No imports: the notifier Lambda bundles this file.
import { SHARE_DELIVERY_WINDOW_MS } from "@rovara-code/contracts";

/**
 * A row still PENDING this long after it was written (or last re-queued) was given up on by the notifier, whose own retries end at `SHARE_DELIVERY_WINDOW_MS`; the sweep puts it in front of the notifier again.
 * Ten minutes past the window, so a notice still on its last retry is never doubled (the row's claim would stop a double post anyway).
 */
export const ATTENTION_DM_REQUEUE_AFTER_MS = SHARE_DELIVERY_WINDOW_MS + 10 * 60_000;
/** A direct message older than this is not sent, by the sweep or the notifier: a burst of stale messages after an outage helps nobody. Home's "Needs you" still lists what is open. */
export const ATTENTION_DM_MAX_AGE_MS = 24 * 3_600_000;
/** A row the sweep marked MISSED, or one whose delivery failed, is kept this long (seconds) after that, so Health can count it. */
export const ATTENTION_DM_FAILURE_KEEP_SECONDS = 2 * 86_400;

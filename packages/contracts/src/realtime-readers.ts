import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { CodeSettingsChangedNoticeSchema, RealtimeNoticeSchema, RealtimeTokenResponseSchema, SessionSharedNoticeSchema } from "./realtime.js";

export const RealtimeNoticeReaderSchema = forwardReader(RealtimeNoticeSchema);
export const RealtimeTokenResponseReaderSchema = forwardReader(RealtimeTokenResponseSchema);
const FeedNoticeSchema = z.discriminatedUnion("type", [...RealtimeNoticeSchema.options, SessionSharedNoticeSchema, CodeSettingsChangedNoticeSchema]);
export const ChangesFeedEntryReaderSchema = z.intersection(forwardReader(FeedNoticeSchema), z.looseObject({ at: z.string().datetime(), sk: z.string().min(1) }));
export const ChangesFeedPageReaderSchema = z.looseObject({ notices: z.array(ChangesFeedEntryReaderSchema), next: z.string(), reset: z.literal(true).optional() });
export type ReadRealtimeNotice = z.output<typeof RealtimeNoticeReaderSchema>;
export type ReadFeedNotice = z.output<typeof ChangesFeedEntryReaderSchema>;

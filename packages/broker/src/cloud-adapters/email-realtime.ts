// Lane A8: the email port on SES, and the realtime port on the cloud events service (AppSync Events). Hosted-only (owner decisions 72 O2 and 101), so they live here and not in public Code. Registered by the composition root
// when the switch lanes land; nothing calls them yet. Typed on a mirror of Code's K1 ports (`k1-ports/`) until the vendor pin carries them. Conformance: pending the pin (tests/conformance/pending-lanes.ts).
export { SES_CAPABILITIES, SES_COOL_DOWN_MS, SES_SEND_TIMEOUT_MS, SesEmailSender, isSesSender, type SesEmailSenderOptions, type SesSendLimits, type SesSender } from "./email-ses/email-sender.js";
export { APPSYNC_CAPABILITIES, AppSyncEventsPublisher, regionOfEndpoint, type AppSyncEventsPublisherOptions } from "./realtime-appsync/publisher.js";
export { DEFAULT_NAMESPACE, channelOf, isChannelNamespace, parseChannel } from "./realtime-appsync/channels.js";
export { signedHeaders, type AwsCredentials } from "./realtime-appsync/sigv4.js";

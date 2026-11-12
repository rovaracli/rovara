// Runtime per-company UI flags (lane U5): the names the flag store reads. The shapes and the names are the server's contract (`packages/cloud-contracts/src/ui-flags.ts`); they are re-exported here so the
// flag store and the tests keep one import path. Decision 125 removed the Settings page that changed them (the eight finished screens are no flags any more); the broker's admin routes stay for the screens
// still being finished, and a future page reads them with `UiFlagsAdminAnswerReaderSchema`.
export { UI_FLAG_NAMES } from "@agentx/cloud-contracts/web";
export type { UiFlagName, UiFlagState } from "@agentx/cloud-contracts/web";

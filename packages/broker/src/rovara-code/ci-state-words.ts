// TE-B2 (honest CI states): the two CI states a person is told in words, never silently counted as a pass. Broker-side only (Rovara Code's contracts carry the same words under the same name; a Cloud export under
// that name would be a second owner, see tests/contract/cloud-contracts-no-duplicate-names.test.ts). The web app and the CLI keep their own copies of the two sentences; a contract test holds all of them equal.
export const CI_STATE_WORDS = {
  none: "No CI on this repository",
  unreadable: "CI not readable: grant checks read, or set this project to 'do not read CI'",
} as const;

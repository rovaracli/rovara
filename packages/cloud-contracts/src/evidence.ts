// Proof and evidence (design proof-test-env, section 3.2): the EvidencePack a task's checks, tests, coverage, API samples and browser runs add up to, and the
// view of it the task page reads. Browser-safe: nothing here imports a Node module. The worker writes the raw parts; the BROKER builds the pack, re-redacts every
// text and checks every count against the files, so a worker's own summary is never taken as truth. Every list and string is bounded, every text is one plain line
// (no control or format characters) that readers escape for their own markup, and a pack for any other candidate digest is ignored by the broker.
import { type EvidenceDependencyLabel } from "@rovara-code/contracts";
/** The fixed words of each label. `company_approved` is completed with the service by `evidenceDependencyLabelWords`; a fake that made up answers adds "(+N made-up answers)" there too. */
export const EVIDENCE_DEPENDENCY_LABEL_WORDS: Record<EvidenceDependencyLabel, string> = {
  real: "real", real_project_image: "real (company-approved image)", company_approved: "company-approved image", rovara_local_aws: "Rovara local AWS", test_account: "test account",
  recorded_fake: "recorded fake", hand_written_fake: "hand-written fake", faked_by_tests: "faked by your tests", not_available: "not available",
};
/**
 * TE-H4a (O20, O49): days the stored evidence pack (the small JSON record) is kept: one year. It is the expiry of the `ExpireEvidenceRecord` lifecycle rule (infra/lib/control-plane.ts), which no company setting
 * can move (`evidenceRetentionDays` has no `evidence-record` entry). Videos and traces keep 14 days and screenshots, API samples and output tails 30 (EVIDENCE_RETENTION_DAYS in the Code contracts).
 * It lives here for now; moving it into Code's `EVIDENCE_RETENTION_DAYS` is a deferred row.
 */
export const EVIDENCE_RECORD_RETENTION_DAYS = 365;
const FAKE_LABELS: readonly EvidenceDependencyLabel[] = ["recorded_fake", "hand_written_fake"];

/** The words of a label: "company-approved <service> image" names its service (owner Q9), and a fake that made up answers says how many. */
export function evidenceDependencyLabelWords(label: EvidenceDependencyLabel, service: string, madeUpAnswers = 0): string {
  if (label === "company_approved") return `company-approved ${service} image`;
  const words = EVIDENCE_DEPENDENCY_LABEL_WORDS[label];
  return madeUpAnswers > 0 && FAKE_LABELS.includes(label) ? `${words} (+${madeUpAnswers} made-up answers)` : words;
}

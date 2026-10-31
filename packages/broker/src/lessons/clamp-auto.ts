// Learning v2 wiring (review item 6): while automatic go-live is not enabled, a tier-0 "auto" must never be honoured, whatever wrote it (an old row, a hand edit, a bug). This wraps
// the settings reader the learning lane resolves its policy from, so the clamp holds at read time and at settle time alike (both resolve through the reader). The flag is asked at
// every read: switching it off takes effect at once, and a failing reader is left to fail closed in `resolveLearning`.
import type { LearningSettings, LearningSettingsReader } from "./policy.js";

const clampLevel = <T extends string | undefined>(level: T): T | "one" => (level === "auto" ? "one" : level);

export function clampedSettings(reader: LearningSettingsReader, autoApplyEnabled: () => boolean): LearningSettingsReader {
  return {
    async read(workspaceId, project) {
      const settings: LearningSettings = (await reader.read(workspaceId, project)) ?? {};
      if (autoApplyEnabled()) return settings;
      return {
        ...settings,
        ...(settings.tier0Approval === undefined ? {} : { tier0Approval: clampLevel(settings.tier0Approval) }),
        ...(settings.approval === undefined ? {} : { approval: { ...settings.approval, ...(settings.approval.tier0 === undefined ? {} : { tier0: clampLevel(settings.approval.tier0) }) } }),
        ...(settings.companyApproval === undefined ? {} : { companyApproval: { ...settings.companyApproval, ...(settings.companyApproval.tier0 === undefined ? {} : { tier0: clampLevel(settings.companyApproval.tier0) }) } }),
      };
    },
  };
}

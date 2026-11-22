import { ArtifactLinkSchema } from "@agentx/contracts/web";
import type { TaskCaptureViewItem } from "../../../packages/ui/src/screens/session/TaskCaptureViewer.js";

const SHA = "a".repeat(64);

function link(captureKey: string, available = true) {
 return ArtifactLinkSchema.parse({
  kind: "jpeg", sha256: SHA, bytes: 512, retentionClass: "evidence-std",
  state: available ? "available" : "withheld",
  ...(available ? { href: `/v1/app/task-capture-fixture/${captureKey}` } : {}),
 });
}

function item(captureId: string, side: "before" | "after", pageLabel: string, viewportLabel: string, captureKey: string, available = true): TaskCaptureViewItem {
 const artifact = link(captureKey, available);
 return {
  captureId, side, pageLabel, viewportLabel, ...(artifact.href === undefined ? {} : { href: artifact.href }),
  alt: `${pageLabel} ${side} capture at ${viewportLabel}`,
 };
}

const page = "Refund reconciliation";
const desktop = "Desktop, 1440 by 1000";
const phone = "Phone, 390 by 844";

export const TASK_CAPTURE_VIEWER_CASES = {
 pair: {
  board: "TaskEvidence + TaskShots + ShotViewer: selected before/after pair and viewport labels",
  captures: [
   item("before-desktop", "before", page, desktop, "pair-before-desktop"),
   item("after-desktop", "after", page, desktop, "pair-after-desktop"),
   item("before-phone", "before", page, phone, "pair-before-phone"),
   item("after-phone", "after", page, phone, "pair-after-phone"),
  ],
  selectedCaptureId: "after-desktop",
 },
 long: {
  board: "TaskShots + ShotViewer: long page and viewport labels wrap without horizontal overflow",
  captures: [item("after-long", "after", "Refund reconciliation · " + "quarterly-settlement-".repeat(4), "Phone, 390 by 844 · full page, 12,480 px", "long-after")],
  selectedCaptureId: "after-long",
 },
 missing: {
  board: "States: unavailable evidence is advisory and does not imply a page failure",
  captures: [item("after-missing", "after", page, phone, "missing-after", false)],
  selectedCaptureId: "after-missing",
 },
 composed: {
  board: "TaskEvidence + ShotViewer: Back returns to the task with the exact selected capture retained",
  captures: [
   item("before-phone", "before", page, phone, "composed-before-phone"),
   item("after-phone", "after", page, phone, "composed-after-phone"),
  ],
  selectedCaptureId: "before-phone",
 },
} satisfies Record<string, { board: string; captures: TaskCaptureViewItem[]; selectedCaptureId: string }>;

export const TASK_CAPTURE_ARTIFACT_LINKS = Object.values(TASK_CAPTURE_VIEWER_CASES).flatMap(scene => scene.captures.map(capture => ({
 captureId: capture.captureId,
 link: link(capture.href?.split("/").at(-1) ?? capture.captureId, capture.href !== undefined),
})));

import { expect, it } from "vitest";
import { ArtifactLinkSchema } from "@agentx/contracts/web";
import { TASK_CAPTURE_ARTIFACT_LINKS, TASK_CAPTURE_VIEWER_CASES } from "./support/task-capture-viewer-cases.js";

it("parses every capture fixture link with the production artifact-link reader", () => {
 expect(Object.keys(TASK_CAPTURE_VIEWER_CASES)).toEqual(["pair", "long", "missing", "composed"]);
 for (const [sceneName, scene] of Object.entries(TASK_CAPTURE_VIEWER_CASES)) {
  expect(scene.captures.some(capture => capture.captureId === scene.selectedCaptureId), sceneName).toBe(true);
 }
 expect(TASK_CAPTURE_ARTIFACT_LINKS).toHaveLength(8);
 for (const { captureId, link } of TASK_CAPTURE_ARTIFACT_LINKS) {
  expect(ArtifactLinkSchema.parse(link), captureId).toEqual(link);
 }
 expect(TASK_CAPTURE_ARTIFACT_LINKS.filter(entry => entry.link.state === "available")).toHaveLength(7);
 expect(TASK_CAPTURE_ARTIFACT_LINKS.filter(entry => entry.link.state === "withheld")).toHaveLength(1);
 expect(ArtifactLinkSchema.safeParse({
  kind: "jpeg", sha256: "a".repeat(64), bytes: 512, retentionClass: "evidence-std", state: "available", href: "https://example.com/private.jpg",
 }).success).toBe(false);
});

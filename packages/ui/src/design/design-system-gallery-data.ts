import type { ReactNode } from "react";
/** Foundation scenes from sheet 4e; R3 adds the component vocabulary here. */
export const foundationScenes = [
 { id: "colours", title: "Colour roles" },
 { id: "type", title: "Type: five sizes, two weights" },
 { id: "space", title: "Space: 4px base" },
 { id: "focus", title: "Focus and selection" },
] as const;
export const colourRoles = [
 ["bg", "bg"], ["surface", "bgRaised"], ["sunken", "bgSunken"],
 ["border", "border"], ["border-strong", "borderStrong"], ["text", "text"],
 ["text-muted", "textMuted"], ["accent", "accent"],
] as const;
export const statusRoles = [
 ["attention", "statusNeedsYou", "statusNeedsYouBg"],
 ["running", "statusRunning", "statusRunningBg"],
 ["ok", "statusDone", "statusDoneBg"],
 ["bad", "statusFailed", "statusFailedBg"],
 ["idle", "statusStopped", "statusStoppedBg"],
] as const;
export const spaceExamples = [
 [4, "icon to label inside a chip"], [8, "between controls in a group"],
 [12, "row content gap"], [16, "row padding, phone gutter"],
 [24, "inside a decision card"], [32, "between sections"],
 [48, "page top, between page regions"],
] as const;

/** Scene exports are local examples, never API fixtures or real task actions. */
export type GalleryScene = { id: string; title: string; render: () => ReactNode };
export const galleryScenes = [
 ...foundationScenes.slice(0, 3),
 { id: "statuses", title: "Status chips: the only vocabulary" },
 { id: "buttons", title: "Buttons" }, { id: "decisions", title: "Decision card" },
 { id: "timeline", title: "Timeline row" }, { id: "table", title: "Table row" },
 { id: "toast", title: "Toast" }, { id: "confirmation", title: "Confirmation dialog" },
 { id: "outcome", title: "Error: outcome not confirmed" },
 { id: "focus", title: "New in v2: selection, focus and outlines" },
 { id: "shell-running", title: "Running task shell" }, { id: "shell-plan", title: "Plan decision shell" }, { id: "shell-gaps", title: "Merge with gaps shell" },
 { id: "delivery", title: "New in v2: delivery states for a message" }, { id: "held", title: "New in v2: fewer competing labels" },
 { id: "states-loading", title: "Loading" }, { id: "states-empty", title: "Empty" }, { id: "states-slow", title: "Slow" },
 { id: "states-error", title: "Error" }, { id: "states-stale", title: "Stale" }, { id: "states-phone", title: "Phone" },
 { id: "states-first-load-failed", title: "First load failed" }, { id: "states-stale-or-heartbeat", title: "Stale list, or lost heartbeat" }, { id: "states-write-unconfirmed", title: "Write not confirmed" },
] as const;
/** Fail visibly on malformed/duplicate registrations instead of capturing the wrong part. */
export function collectPartScenes(modules: Record<string, unknown>): GalleryScene[] {
 const scenes: GalleryScene[] = [];
 for (const value of Object.values(modules)) {
  if (!value || typeof value !== "object") continue;
  for (const [name, entries] of Object.entries(value)) {
   if (!name.endsWith("GalleryScenes")) continue;
   if (!Array.isArray(entries)) throw new Error(`Invalid gallery export: ${name}`);
   for (const entry of entries as unknown[]) {
    if (!entry || typeof entry !== "object" || !("id" in entry) || !("title" in entry) || !("render" in entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.render !== "function" || !galleryScenes.some(scene => scene.id === entry.id) || scenes.some(scene => scene.id === entry.id)) throw new Error(`Invalid or duplicate gallery scene in ${name}`);
    scenes.push(entry as GalleryScene);
   }
  }
 }
 return scenes;
}

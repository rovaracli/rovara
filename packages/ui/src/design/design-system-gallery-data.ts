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

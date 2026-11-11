import type { ColorTokens } from "./tokens.js";
/**
 * The "v2" look (design pass 2026-11-11, owner choices of the same day): light "A" is the default theme, dark "B" is the dark mode, both on the SAME token names.
 * It is a second VALUE set for the existing `--rv-*` names plus a few new `--rv-*` names; it is never a second system. The whole sheet is scoped to
 * `:root[data-look="v2"]`, so while that attribute is absent every screen resolves exactly the values in tokens.ts. Density (Comfortable or Compact) is its own
 * attribute, `data-density`, independent of the theme, and only means something under v2.
 */
export interface LookColorTokens extends ColorTokens {
  bgSidebar: string; bgPopover: string;
  textSubtle: string;
  borderMedium: string;
  accentHover: string; accentSoft: string;
  statusRunningBg: string; statusRunningBorder: string;
  statusNeedsYouBg: string; statusNeedsYouBorder: string;
  statusFailedBg: string; statusFailedBorder: string;
  statusDoneBg: string; statusDoneBorder: string;
  statusStoppedBg: string; statusStoppedBorder: string;
  statusInfo: string; statusInfoBg: string; statusInfoBorder: string;
}
/** Text on its own tint, and on the surfaces text sits on. Every pair must reach 4.5:1. */
export const LOOK_TEXT_PAIRS: readonly (readonly [keyof LookColorTokens, keyof LookColorTokens])[] = [
  ...(["text", "textMuted", "textSubtle", "accentText"] as const).flatMap(color => (["bg", "bgRaised", "bgSunken", "bgSidebar", "bgPopover"] as const).map(background => [color, background] as const)),
  ["accentText", "accentSoft"], ["text", "accentSoft"],
  ["onAccent", "accent"], ["onAccent", "accentHover"], ["onDanger", "danger"],
  ...(["statusRunning", "statusNeedsYou", "statusFailed", "statusDone", "statusStopped", "statusInfo"] as const).flatMap(color => [[color, `${color}Bg` as const] as const, [color, "bgRaised"] as const, [color, "bg"] as const]),
];
/** Interface parts (control edges, focus ring, status dots) must reach 3:1 on the surfaces they sit on. */
export const LOOK_UI_PAIRS: readonly (readonly [keyof LookColorTokens, keyof LookColorTokens])[] = [
  ...(["borderStrong", "focus", "accent", "statusRunning", "statusNeedsYou", "statusFailed", "statusDone", "statusStopped", "statusPaused", "statusInfo"] as const).flatMap(color => (["bg", "bgRaised"] as const).map(background => [color, background] as const)),
  ["focus", "bgPopover"], ["borderStrong", "bgPopover"], ["borderStrong", "bgSunken"],
];
export const LOOK_COLORS = {
  light: {
    bg: "#f9fafb", bgRaised: "#ffffff", bgSunken: "#f2f4f7", bgSidebar: "#f2f4f7", bgPopover: "#ffffff",
    text: "#161d2b", textMuted: "#556073", textSubtle: "#626b7d",
    border: "#e1e5ec", borderMedium: "#c7cedb", borderStrong: "#808a9c",
    accent: "#3157d5", accentHover: "#2546b8", accentSoft: "#eef2ff", accentText: "#2a4cc4", onAccent: "#ffffff", focus: "#3157d5",
    danger: "#b42323", onDanger: "#ffffff",
    statusRunning: "#6340a8", statusRunningBg: "#f3effb", statusRunningBorder: "#d8cbf1",
    statusNeedsYou: "#8a5300", statusNeedsYouBg: "#fff4e0", statusNeedsYouBorder: "#f3d29c",
    statusFailed: "#b42323", statusFailedBg: "#fdeeee", statusFailedBorder: "#f4c2c2",
    statusDone: "#1c6b4f", statusDoneBg: "#ecf7f1", statusDoneBorder: "#b9e2cd",
    statusStopped: "#556073", statusStoppedBg: "#f2f4f7", statusStoppedBorder: "#e1e5ec",
    statusPaused: "#556073",
    statusInfo: "#1f5fa8", statusInfoBg: "#eaf3fd", statusInfoBorder: "#bcd6f4",
  },
  dark: {
    bg: "#0e1116", bgRaised: "#151a21", bgSunken: "#11151b", bgSidebar: "#0b0e12", bgPopover: "#1b212a",
    text: "#e8ecf2", textMuted: "#a3adbd", textSubtle: "#8792a3",
    border: "#262e3a", borderMedium: "#364152", borderStrong: "#657289",
    // One accent hue in both themes: A's cobalt (hue ~227), lightened for the dark surfaces. Not the design pass's periwinkle.
    accent: "#6f8ff6", accentHover: "#8aa4f8", accentSoft: "#1c2440", accentText: "#9ab3fa", onAccent: "#0b1020", focus: "#9ab3fa",
    danger: "#ff9a9a", onDanger: "#45151d",
    statusRunning: "#c4adff", statusRunningBg: "#1f1834", statusRunningBorder: "#3a2e5e",
    statusNeedsYou: "#f0c06b", statusNeedsYouBg: "#2a2110", statusNeedsYouBorder: "#4a3a17",
    statusFailed: "#ff9a9a", statusFailedBg: "#2c1515", statusFailedBorder: "#522424",
    statusDone: "#6fd3a2", statusDoneBg: "#12261d", statusDoneBorder: "#1f4434",
    statusStopped: "#a3adbd", statusStoppedBg: "#1b212a", statusStoppedBorder: "#2a3340",
    statusPaused: "#a3adbd",
    statusInfo: "#7cc0ff", statusInfoBg: "#102236", statusInfoBorder: "#1f3d5c",
  },
} as const satisfies { light: LookColorTokens; dark: LookColorTokens };
/** Theme-dependent non-colour values: elevation and the focus halo. */
export const LOOK_EFFECTS = {
  light: { shadow1: "0 1px 2px rgb(16 24 40 / .05)", shadow2: "0 1px 3px rgb(16 24 40 / .06), 0 4px 12px rgb(16 24 40 / .05)", shadow3: "0 12px 40px rgb(16 24 40 / .12)", focusHalo: "0 0 0 4px rgb(49 87 213 / .18)" },
  dark: { shadow1: "0 0 0 1px rgb(255 255 255 / .02)", shadow2: "0 1px 0 rgb(255 255 255 / .03) inset, 0 6px 18px rgb(0 0 0 / .35)", shadow3: "0 16px 48px rgb(0 0 0 / .55)", focusHalo: "0 0 0 4px rgb(154 179 250 / .25)" },
} as const;
/** Density is chosen on its own, never by theme. Comfortable is A's roomy values; Compact is the design pass's B values (README: "carry B's density tokens ... as a compact option"). */
export const LOOK_DENSITY = {
  comfortable: { rowY: 14, card: 20, gap: 24, controlH: 40, font: { lg: 16, xl: 18, xxl: 30 } },
  compact: { rowY: 10, card: 16, gap: 20, controlH: 36, font: { lg: 15, xl: 17, xxl: 26 } },
} as const;
export type Density = keyof typeof LOOK_DENSITY;
export const LOOK_SHAPE = { radius: { sm: 6, md: 10, lg: 14 }, fontSm: 12, fontMd: 14, motionFastMs: 150, touchMinPx: 44 } as const;
const kebab = (key: string): string => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
function colors(theme: "light" | "dark"): string {
 const effects = LOOK_EFFECTS[theme];
 return Object.entries(LOOK_COLORS[theme]).map(([key, value]) => `--rv-${kebab(key)}:${value};`).join("") + `--rv-shadow-1:${effects.shadow1};--rv-shadow-2:${effects.shadow2};--rv-shadow-3:${effects.shadow3};--rv-focus-halo:${effects.focusHalo};color-scheme:${theme};`;
}
function density(name: Density): string {
 const d = LOOK_DENSITY[name];
 return `--rv-density-row-y:${String(d.rowY)}px;--rv-density-card:${String(d.card)}px;--rv-density-gap:${String(d.gap)}px;--rv-control-h:${String(d.controlH)}px;--rv-font-lg:${String(d.font.lg)}px;--rv-font-xl:${String(d.font.xl)}px;--rv-font-xxl:${String(d.font.xxl)}px;`;
}
const ROOT = ':root[data-look="v2"]';
/** The v2 sheet. Append it AFTER tokensCss(); it changes nothing until `data-look="v2"` is on the root. */
export function lookV2Css(): string {
 const shape = `--rv-radius-sm:${String(LOOK_SHAPE.radius.sm)}px;--rv-radius-md:${String(LOOK_SHAPE.radius.md)}px;--rv-radius-lg:${String(LOOK_SHAPE.radius.lg)}px;--rv-radius-card:var(--rv-radius-md);--rv-motion-fast:${String(LOOK_SHAPE.motionFastMs)}ms;--rv-touch-min:0px;--rv-control-size:max(var(--rv-control-h),var(--rv-touch-min));--rv-focus-offset:2px;`;
 return `${ROOT}{${colors("light")}${shape}${density("comfortable")}}`
  + `@media (prefers-color-scheme: dark){${ROOT}:not([data-theme="light"]){${colors("dark")}}}`
  + `${ROOT}[data-theme="dark"]{${colors("dark")}}`
  + `${ROOT}[data-density="compact"]{${density("compact")}}`
  // Phone and touch screens: every control is at least 44px, whatever the density.
  + `@media (max-width: 767px), (pointer: coarse){${ROOT}{--rv-touch-min:${String(LOOK_SHAPE.touchMinPx)}px}}`
  + `${ROOT} :focus-visible{box-shadow:var(--rv-focus-halo)}`;
}

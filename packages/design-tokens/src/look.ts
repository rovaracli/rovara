import type { ColorTokens } from "./tokens.js";
/**
 * The 4e design-system sheet (2026-11-21): light and dark share the same role names.
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
  ["text", "bgSunken"], ["focus", "bgSunken"], ["focus", "bgPopover"], ["borderStrong", "bgPopover"], ["borderStrong", "bgSunken"],
];
export const LOOK_COLORS = {
  light: {
    bg: "#f5f6f7",
    bgRaised: "#ffffff",
    bgSunken: "#eceef1",
    border: "#dde1e6",
    borderStrong: "#7c8594",
    text: "#15181d",
    textMuted: "#59616e",
    accent: "#15181d",
    statusNeedsYou: "#8a5300",
    statusNeedsYouBg: "#fff1cc",
    statusRunning: "#1b4fd1",
    statusRunningBg: "#e6edfe",
    statusDone: "#14663a",
    statusDoneBg: "#dff3e6",
    statusFailed: "#b0261d",
    statusFailedBg: "#fce6e3",
    statusStopped: "#4a5260",
    statusStoppedBg: "#e9ecef",
    bgSidebar: "#f5f6f7",
    bgPopover: "#ffffff",
    textSubtle: "#59616e",
    borderMedium: "#7c8594",
    accentHover: "#15181d",
    accentSoft: "#eceef1",
    accentText: "#15181d",
    onAccent: "#ffffff",
    focus: "#1b4fd1",
    danger: "#b0261d",
    onDanger: "#ffffff",
    statusPaused: "#4a5260",
    statusInfo: "#1b4fd1",
    statusInfoBg: "#e6edfe",
    statusRunningBorder: "#7c8594",
    statusNeedsYouBorder: "#7c8594",
    statusFailedBorder: "#7c8594",
    statusDoneBorder: "#7c8594",
    statusStoppedBorder: "#7c8594",
    statusInfoBorder: "#7c8594",
  },
  dark: {
    bg: "#0e1013",
    bgRaised: "#16191e",
    bgSunken: "#0a0c0e",
    border: "#2a3038",
    borderStrong: "#6b7380",
    text: "#eceef1",
    textMuted: "#9ba4b1",
    accent: "#eceef1",
    statusNeedsYou: "#f3c458",
    statusNeedsYouBg: "#382b0b",
    statusRunning: "#93b4ff",
    statusRunningBg: "#17264b",
    statusDone: "#7ed69c",
    statusDoneBg: "#11301d",
    statusFailed: "#ff9d94",
    statusFailedBg: "#3e1917",
    statusStopped: "#b4bbc6",
    statusStoppedBg: "#23282f",
    bgSidebar: "#0e1013",
    bgPopover: "#16191e",
    textSubtle: "#9ba4b1",
    borderMedium: "#6b7380",
    accentHover: "#eceef1",
    accentSoft: "#0a0c0e",
    accentText: "#eceef1",
    onAccent: "#16191e",
    focus: "#93b4ff",
    danger: "#ff9d94",
    onDanger: "#16191e",
    statusPaused: "#b4bbc6",
    statusInfo: "#93b4ff",
    statusInfoBg: "#17264b",
    statusRunningBorder: "#6b7380",
    statusNeedsYouBorder: "#6b7380",
    statusFailedBorder: "#6b7380",
    statusDoneBorder: "#6b7380",
    statusStoppedBorder: "#6b7380",
    statusInfoBorder: "#6b7380",
  },
} as const satisfies { light: LookColorTokens; dark: LookColorTokens };
/** Theme-dependent non-colour values: elevation and the focus halo. */
export const LOOK_EFFECTS = {
  light: { shadow1: "0 1px 2px rgb(16 24 40 / .05)", shadow2: "0 1px 3px rgb(16 24 40 / .06), 0 4px 12px rgb(16 24 40 / .05)", shadow3: "0 12px 40px rgb(16 24 40 / .12)", focusHalo: "0 0 0 4px rgb(27 79 209 / .18)" },
  dark: { shadow1: "0 0 0 1px rgb(255 255 255 / .02)", shadow2: "0 1px 0 rgb(255 255 255 / .03) inset, 0 6px 18px rgb(0 0 0 / .35)", shadow3: "0 16px 48px rgb(0 0 0 / .55)", focusHalo: "0 0 0 4px rgb(147 180 255 / .25)" },
} as const;
/** Density remains independent of theme; 4e fixes type and control sizes in both densities. */
export const LOOK_DENSITY = {
  comfortable: { rowY: 14, rowYDense: 9, card: 20, gap: 24, controlH: 36, font: { lg: 16, xl: 20, xxl: 28, title: 20 } },
  compact: { rowY: 10, rowYDense: 5, card: 16, gap: 20, controlH: 36, font: { lg: 16, xl: 20, xxl: 28, title: 20 } },
} as const;
export type Density = keyof typeof LOOK_DENSITY;
export const LOOK_SHAPE = { radius: { sm: 6, md: 10, lg: 14 }, fontXs: 12, fontSm: 12, fontMd: 14, fontTitle: 'Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', motionFastMs: 150, touchMinPx: 48 } as const;
const kebab = (key: string): string => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
function colors(theme: "light" | "dark"): string {
 const effects = LOOK_EFFECTS[theme];
 return Object.entries(LOOK_COLORS[theme]).map(([key, value]) => `--rv-${kebab(key)}:${value};`).join("") + `--rv-shadow-1:${effects.shadow1};--rv-shadow-2:${effects.shadow2};--rv-shadow-3:${effects.shadow3};--rv-focus-halo:${effects.focusHalo};color-scheme:${theme};`;
}
function density(name: Density): string {
 const d = LOOK_DENSITY[name];
 return `--rv-density-row-y:${String(d.rowY)}px;--rv-density-card:${String(d.card)}px;--rv-density-gap:${String(d.gap)}px;--rv-control-h:${String(d.controlH)}px;--rv-font-lg:${String(d.font.lg)}px;--rv-font-xl:${String(d.font.xl)}px;--rv-font-xxl:${String(d.font.xxl)}px;--rv-font-title-size:${String(d.font.title)}px;--rv-density-row-y-dense:${String(d.rowYDense)}px;`;
}
const ROOT = ':root[data-look="v2"]';
/** The v2 sheet. Append it AFTER tokensCss(); it changes nothing until `data-look="v2"` is on the root. */
export function lookV2Css(): string {
 const shape = `--rv-radius-sm:${String(LOOK_SHAPE.radius.sm)}px;--rv-radius-md:${String(LOOK_SHAPE.radius.md)}px;--rv-radius-lg:${String(LOOK_SHAPE.radius.lg)}px;--rv-radius-card:var(--rv-radius-md);--rv-motion-fast:${String(LOOK_SHAPE.motionFastMs)}ms;--rv-font-xs:${String(LOOK_SHAPE.fontXs)}px;--rv-font-title:${LOOK_SHAPE.fontTitle};--rv-font-ui:${LOOK_SHAPE.fontTitle};--rv-font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace;--rv-font-sm:12px;--rv-font-md:14px;--rv-reading-width:760px;--rv-table-width:1200px;--rv-table-row-h:48px;${[4, 8, 12, 16, 24, 32, 48].map((value, index) => `--rv-space-${String(index + 1)}:${String(value)}px;`).join("")}--rv-touch-min:0px;--rv-control-size:max(var(--rv-control-h),var(--rv-touch-min));--rv-focus-offset:2px;`;
 return `${ROOT}{${colors("light")}${shape}${density("comfortable")}}`
  + `@media (prefers-color-scheme: dark){${ROOT}:not([data-theme="light"]){${colors("dark")}}}`
  + `${ROOT}[data-theme="dark"]{${colors("dark")}}`
  + `${ROOT}[data-density="compact"]{${density("compact")}}`
  // Phone only: 48px targets; tablet and desktop retain 36px in either density.
  + `@media (max-width: 639px){${ROOT}{--rv-touch-min:${String(LOOK_SHAPE.touchMinPx)}px}}`;
}

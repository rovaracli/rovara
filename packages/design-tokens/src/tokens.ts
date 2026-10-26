export interface ColorTokens {
  bg: string;
  bgRaised: string;
  bgSunken: string;
  text: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentText: string;
  onAccent: string;
  focus: string;
  danger: string;
  onDanger: string;
  statusRunning: string;
  statusNeedsYou: string;
  statusFailed: string;
  statusDone: string;
  statusStopped: string;
  statusPaused: string;
}
export const TOKENS = {
light: {"bg": "#f6f7f9", "bgRaised": "#ffffff", "bgSunken": "#edf0f4", "text": "#192434", "textMuted": "#4d5c70", "border": "#d8dee7", "borderStrong": "#7a8798", "accent": "#244fc2", "accentText": "#244fc2", "onAccent": "#ffffff", "focus": "#244fc2", "danger": "#b42332", "onDanger": "#ffffff", "statusRunning": "#2458b8", "statusNeedsYou": "#865600", "statusFailed": "#b42332", "statusDone": "#217047", "statusStopped": "#586678", "statusPaused": "#7753a0"},
dark: {"bg": "#141920", "bgRaised": "#1d2530", "bgSunken": "#10151c", "text": "#eef2f8", "textMuted": "#b4c0d0", "border": "#384658", "borderStrong": "#8191a7", "accent": "#9bb9ff", "accentText": "#aac3ff", "onAccent": "#142542", "focus": "#a7c4ff", "danger": "#ffb1b7", "onDanger": "#45151d", "statusRunning": "#9bb9ff", "statusNeedsYou": "#edc47f", "statusFailed": "#ffb1b7", "statusDone": "#83d3a8", "statusStopped": "#b4c0d0", "statusPaused": "#d0aff4"},
space: [0, 4, 8, 12, 16, 24, 32, 48], radius: { sm: 4, md: 8, lg: 12 },
font: { ui: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", mono: "ui-monospace, SFMono-Regular, Consolas, monospace", sizes: { sm: 12, md: 14, lg: 16, xl: 20, xxl: 28 } }, motionMs: { fast: 120, normal: 200 }
} as const satisfies { light: ColorTokens; dark: ColorTokens; space: readonly number[]; radius: Record<string, number>; font: { ui: string; mono: string; sizes: Record<string, number> }; motionMs: Record<string, number> };

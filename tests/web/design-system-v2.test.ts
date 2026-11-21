// @vitest-environment jsdom
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LOOK_COLORS, contrastRatio, lookV2Css } from "../../packages/design-tokens/src/index.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
afterEach(cleanup);
const read = (path: string) => readFileSync(resolve(path), "utf8");
it("emits the literal 4e roles and their legacy aliases in both themes", () => {
 const expected = {
  light: ["#f5f6f7", "#ffffff", "#eceef1", "#dde1e6", "#7c8594", "#15181d", "#59616e", "#15181d", "#8a5300", "#fff1cc", "#1b4fd1", "#e6edfe", "#14663a", "#dff3e6", "#b0261d", "#fce6e3", "#4a5260", "#e9ecef"],
  dark: ["#0e1013", "#16191e", "#0a0c0e", "#2a3038", "#6b7380", "#eceef1", "#9ba4b1", "#eceef1", "#f3c458", "#382b0b", "#93b4ff", "#17264b", "#7ed69c", "#11301d", "#ff9d94", "#3e1917", "#b4bbc6", "#23282f"],
 };
 const keys = ["bg", "bgRaised", "bgSunken", "border", "borderStrong", "text", "textMuted", "accent", "statusNeedsYou", "statusNeedsYouBg", "statusRunning", "statusRunningBg", "statusDone", "statusDoneBg", "statusFailed", "statusFailedBg", "statusStopped", "statusStoppedBg"] as const;
 for (const theme of ["light", "dark"] as const) {
  const c = LOOK_COLORS[theme];
  expect(keys.map(key => c[key])).toEqual(expected[theme]);
  for (const [alias, role] of [["accentText", "accent"], ["onAccent", "bgRaised"], ["focus", "statusRunning"], ["danger", "statusFailed"], ["statusPaused", "statusStopped"], ["textSubtle", "textMuted"], ["bgSidebar", "bg"], ["bgPopover", "bgRaised"], ["borderMedium", "borderStrong"], ["accentSoft", "bgSunken"], ["statusInfo", "statusRunning"]] as const) expect(c[alias]).toBe(c[role]);
  expect(contrastRatio(c.text, c.bgSunken)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(c.text, c.bgSunken)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(c.focus, c.bgRaised)).toBeGreaterThanOrEqual(3);
 }
});
it("emits fixed type, space, widths and phone targets regardless of density", () => {
 const css = lookV2Css();
 for (const declaration of ["--rv-font-xxl:28px", "--rv-font-xl:20px", "--rv-font-lg:16px", "--rv-font-md:14px", "--rv-font-sm:12px", "--rv-font-xs:12px", "--rv-reading-width:760px", "--rv-table-width:1200px", "--rv-table-row-h:48px", "--rv-control-h:36px", "--rv-focus-offset:2px"]) expect(css).toContain(declaration);
 [4, 8, 12, 16, 24, 32, 48].forEach((space, index) => expect(css).toContain(`--rv-space-${String(index + 1)}:${String(space)}px`));
 expect(css).toContain('@media (max-width: 639px){:root[data-look="v2"]{--rv-touch-min:48px}}');
 expect(css).not.toContain("pointer: coarse");
});
it("copies each bundled font with its OFL licence next to it", () => {
 const scratch = mkdtempSync(join(tmpdir(), "design-system-r1-assets-"));
 try {
 mkdirSync(join(scratch, "scripts"));
 cpSync("scripts/ui-copy-assets.mjs", join(scratch, "scripts/ui-copy-assets.mjs"));
 cpSync("packages/ui/src", join(scratch, "packages/ui/src"), { recursive: true });
 execFileSync(process.execPath, [join(scratch, "scripts/ui-copy-assets.mjs")]);
 for (const [font, licence] of [["inter-latin-400.woff2", "Inter-OFL.txt"], ["inter-latin-600.woff2", "Inter-OFL.txt"], ["jetbrains-mono-latin-400.woff2", "JetBrainsMono-OFL.txt"]] as const) {
  const root = "packages/ui/";
  expect(readFileSync(join(scratch, `${root}dist/design/fonts/${font}`))).toEqual(readFileSync(`${root}src/design/fonts/${font}`));
  expect(read(join(scratch, `${root}dist/design/fonts/${licence}`))).toContain("SIL OPEN FONT LICENSE");
 }
 const css = read(join(scratch, "packages/ui/dist/design/design.css"));
 expect(css.match(/@font-face/g)).toHaveLength(3);
 expect(css).not.toMatch(/https?:|@import/);
 expect(css).not.toMatch(/font-weight:\s*(?:500|550|650|700)|font:(?:500|550|650|700)/);
 } finally { rmSync(scratch, { recursive: true, force: true }); }
});
it("gives keyboard focus a two-pixel offset and selection a separate text-coloured bar", () => {
 const css = read("packages/ui/src/design/design.css"), shell = read("packages/ui/src/shell/shell.css");
 expect(css).toContain("text-overflow:ellipsis;min-height:var(--rv-control-size,36px)");
 expect(css).toContain(":focus-visible,input:focus,textarea:focus,.rv-ds-gallery .is-focus-demo{outline:2px solid var(--rv-focus);outline-offset:2px}");
 expect(css).toContain('.rv-selected{background:var(--rv-bg-sunken);color:var(--rv-text);font-weight:600;');
 expect(css).toContain("border-inline-start:3px solid var(--rv-text)");
 expect(shell).toContain("border-inline-start:3px solid var(--rv-text)");
 expect(shell).toContain("@media(max-width:1023px)");
 expect(shell).toContain("@media(min-width:1024px)");
 expect(shell).toContain("@media(max-width:639px)");
});
for (const theme of ["light", "dark"] as const) it(`${theme}: gallery demonstrates semantic type and selection with keyboard focus`, async () => {
 const { DesignSystemGallery } = await import("../../packages/ui/src/design/DesignSystemGallery.js");
 renderUi(h(DesignSystemGallery), { theme });
 expect(screen.getByRole("heading", { level: 1, name: "A calm control room" })).toBeTruthy();
 expect(screen.getByText("a3f9c1e · poetry install --no-interaction").tagName).toBe("CODE");
 expect(screen.getByRole("button", { name: "Inbox, 3 waiting", pressed: true }).className).toContain("rv-selected");
 const next = screen.getByRole("button", { name: "Work", pressed: false });
 await userEvent.click(next);
 expect(next.getAttribute("aria-pressed")).toBe("true");
 expect(screen.getByRole("button", { name: "Inbox, 3 waiting" }).getAttribute("aria-pressed")).toBe("false");
 const composer = screen.getByRole("textbox", { name: "Composer with focus" });composer.focus();
 expect(document.activeElement).toBe(composer);
 expect(composer.tagName).toBe("INPUT");
 expect(composer.classList.contains("is-focus-demo")).toBe(true);
 const focus = screen.getByRole("region", { name: "Focus and selection" });
 for (const name of ["Request changes", "Review evidence", "Rotate webhook signing secrets"]) expect(within(focus).getByRole("button", { name }).classList.contains("is-focus-demo")).toBe(true);
 expect(within(focus).getByText("Add refunds endpoint").classList.contains("rv-selected")).toBe(true);
 expect(within(focus).getByText("keyboard focus")).toBeTruthy();
 const inbox = within(focus).getByRole("button", { name: "Inbox, 3 waiting" });
 expect(inbox.querySelector("svg[aria-hidden=true]")).toBeTruthy();
 expect(within(inbox).getByText("3")).toBeTruthy();
 expect(within(focus).getByText("Selected: bar, weight and text colour")).toBeTruthy();
 expect(within(focus).getByText("Focus ring: 2 px, running blue, 2 px offset")).toBeTruthy();
 await expectNoAxeViolations(document.body);
});

it("statically exports the mounted gallery from the design barrel", async () => {
 const { DesignSystemGallery } = await import("../../packages/ui/src/design/index.js");
 renderUi(h(DesignSystemGallery));
 expect(screen.getByRole("heading", { name: "A calm control room", level: 1 })).toBeTruthy();
});
it("keeps control notes and reversed accent text in both role panels", async () => {
 const { DesignSystemGallery } = await import("../../packages/ui/src/design/DesignSystemGallery.js");
 renderUi(h(DesignSystemGallery));
 for (const label of screen.getAllByText("border-strong")) expect(label.parentElement?.textContent).toContain("· controls");
 for (const label of screen.getAllByText("accent")) {
  expect(label.parentElement?.textContent).toContain("· actions only");
  expect(label.parentElement?.querySelector(".rv-ds-swatch")?.textContent).toBe("Aa");
 }
 expect(screen.queryByText("Reading column · 760px")).toBeNull();
 expect(screen.queryByText("Tables · 1200px · rows 48px")).toBeNull();
 expect(screen.getByText(/Reading column 760, tables 1,200/)).toBeTruthy();
});
it("preserves desktop sample space and readable phone role names", () => {
 const css = read("packages/ui/src/design/design.css");
 expect(css).toContain(".rv-ds-gallery{max-width:1344px;");
 expect(css).toContain("grid-template-columns:140px minmax(0,1fr)");
 expect(css).toContain(".rv-ds-swatches dt{white-space:nowrap;");
 expect(css).toContain("@media(max-width:359px){.rv-ds-swatches{grid-template-columns:minmax(0,1fr)}}");
 expect(css).toContain(".rv-ds-space-list dt{width:24px;font:400 var(--rv-font-md)/1.55 var(--rv-font-ui)");
 expect(css).toContain(".rv-ds-space-list>div{display:flex;align-items:baseline;");
 expect(css).toContain(".rv-ds-composer{height:max(44px,var(--rv-control-size));border-radius:8px}");
});

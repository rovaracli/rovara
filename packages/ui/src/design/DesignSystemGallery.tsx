import { useState, type CSSProperties } from "react";
import { LOOK_COLORS } from "@agentx/design-tokens";
import { colourRoles, galleryScenes, collectPartScenes, spaceExamples, statusRoles } from "./design-system-gallery-data.js";
import { StatusChip } from "./StatusChip.js";
import { useInRouterContext, useLocation } from "react-router";
import { shellGalleryScenes } from "./parts/shell-gallery-scenes.js";
import "./parts/shell-gallery.css";
import { chipsButtonsGalleryScenes } from "./parts/chips-buttons-scenes.js";
import { decisionTimelineGalleryScenes } from "./parts/decision-timeline-scenes.js";
import { tableToastDialogGalleryScenes } from "./parts/table-toast-dialog-scenes.js";
import { outcomeDeliveryHeldGalleryScenes } from "./parts/outcome-delivery-held-scenes.js";
const partScenes = collectPartScenes({
 chips: { chipsButtonsGalleryScenes }, decisions: { decisionTimelineGalleryScenes },
 table: { tableToastDialogGalleryScenes }, outcomes: { outcomeDeliveryHeldGalleryScenes },
 shell: { shellGalleryScenes },
});
function themeStyle(theme: "light" | "dark"): CSSProperties {
 return { ...Object.fromEntries(Object.entries(LOOK_COLORS[theme]).map(([key, value]) => [`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value])), colorScheme: theme };
}
/** Mounted local demonstrations. This page never reads or writes company data. */
export function DesignSystemGallery() {
 return useInRouterContext() ? <RoutedGallery /> : <Gallery search="" />;
}
function RoutedGallery() { return <Gallery search={useLocation().search} />; }
function Gallery({ search }: { search: string }) {
 const sceneId = new URLSearchParams(search).get("scene");
 const shellScene = sceneId !== null && ["shell-running", "shell-plan", "shell-gaps"].includes(sceneId);
 const wideFoundation = sceneId === "colours" || sceneId === "focus";
 const known = !sceneId || galleryScenes.some(scene => scene.id === sceneId);
 return <div className={`rv-ds-gallery${sceneId ? " rv-ds-isolated" : ""}${shellScene ? " rv-ds-shell-gallery" : ""}${wideFoundation ? " rv-ds-wide-foundation" : ""}`}>
  <header><p className="rv-ds-meta">ROVARA DESIGN SYSTEM · SHEET V2</p><h1 tabIndex={-1}>A calm control room</h1><p className="rv-ds-lead">Quiet, dense, exact. Colour only means status, and always comes with an icon and a word. The interface speaks like a good colleague&apos;s hand-over note.</p></header>
  <nav aria-label="Gallery scenes">{galleryScenes.map(scene => <a key={scene.id} href={`?scene=${scene.id}`} aria-current={sceneId === scene.id ? "page" : undefined}>{scene.title}</a>)}</nav>
  {!known && <h2>Scene not found</h2>}
  {galleryScenes.filter(scene => !sceneId || scene.id === sceneId).map(scene => {
   const part = partScenes.find(entry => entry.id === scene.id);
   if (["colours", "type", "space", "focus"].includes(scene.id)) return <Foundation key={scene.id} sceneId={scene.id} />;
   if (!part) throw new Error(`Missing gallery scene: ${scene.id}`);
   const Part = part.render, ownsHeading = ["statuses", "buttons"].includes(scene.id);
   return <section key={scene.id} id={scene.id} data-gallery-scene={scene.id} aria-label={ownsHeading ? scene.title : undefined} aria-labelledby={ownsHeading ? undefined : `ds-${scene.id}`}>{!ownsHeading && <h2 id={`ds-${scene.id}`} className={scene.id.startsWith("shell-") ? "rv-visually-hidden" : undefined}>{scene.title}</h2>}<Part /></section>;
  })}
 </div>;
}
function Foundation({ sceneId }: { sceneId: string }) {
 return <div className="rv-ds-foundation-scene" data-gallery-scene={sceneId}>
  {sceneId === "colours" && <section id="colours" aria-labelledby="ds-colours"><h2 id="ds-colours">Colour roles</h2><div className="rv-ds-themes">{(["light", "dark"] as const).map(theme => {
   const colors = LOOK_COLORS[theme];
   const style = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value])) as CSSProperties;
   return <div key={theme} className="rv-ds-panel" style={{ ...style, colorScheme: theme }}><h3 className="rv-ds-meta">{theme === "light" ? "LIGHT" : "DARK · SAME ROLE NAMES"}</h3><dl className="rv-ds-swatches">{colourRoles.map(([label, key]) => <div key={label}><span className="rv-ds-swatch" style={{ background: colors[key], color: colors.onAccent }} aria-hidden="true">{key === "accent" ? "Aa" : null}</span><dt>{label}</dt><dd><code>{colors[key].toUpperCase()}{key === "borderStrong" ? " · controls" : key === "accent" ? " · actions only" : ""}</code></dd></div>)}</dl><dl className="rv-ds-swatches rv-ds-status-colours">{statusRoles.map(([label, fg, bg]) => <div key={label}><span className="rv-ds-swatch" style={{ background: colors[bg], color: colors[fg] }} aria-hidden="true">Aa</span><dt>{label}</dt><dd><code>{colors[fg].toUpperCase()} / {colors[bg].toUpperCase()}</code></dd></div>)}</dl></div>;
  })}</div></section>}
  {(sceneId === "type" || sceneId === "space") && <div className="rv-ds-foundations">
   {sceneId === "type" && <section id="type" className="rv-ds-panel" aria-labelledby="ds-type"><h2 id="ds-type">Type: five sizes, two weights</h2><div className="rv-ds-type-list">
    <div><span>28 page</span><h3 className="rv-ds-page-type">Add refunds endpoint</h3></div>
    <div><span>20 section</span><h3 className="rv-ds-section-type">Checks and reviews</h3></div>
    <div><span>16 lead</span><p className="rv-ds-lead">Building. Nothing needed from you.</p></div>
    <div><span>14 body</span><p>Next: checks, then review. <strong>Semibold</strong> marks the one thing to read first.</p></div>
    <div><span>12 meta</span><p className="rv-ds-meta">Updated 20 s ago · acme/payments · Ana</p></div>
    <div><span>12 mono</span><code>a3f9c1e · poetry install --no-interaction</code></div>
   </div><p className="rv-ds-meta">Inter 400 and 600. JetBrains Mono for shas, commands and logs.</p></section>}
   {sceneId === "space" && <section id="space" className="rv-ds-panel" aria-labelledby="ds-space"><h2 id="ds-space">Space: 4px base</h2><dl className="rv-ds-space-list">{spaceExamples.map(([size, use]) => <div key={size}><dt>{size}</dt><dd><i style={{ width: `var(--rv-space-${String(spaceExamples.findIndex(entry => entry[0] === size) + 1)})` }} aria-hidden="true" />{use}</dd></div>)}</dl><p className="rv-ds-meta">Three breakpoints: phone under 640, tablet, desktop from 1024. Reading column 760, tables 1,200. Controls 36 high on desktop, 48 on phone.</p></section>}
  </div>}
  {sceneId === "focus" && <section id="focus" aria-labelledby="ds-focus"><h2 id="ds-focus">New in v2: selection, focus and outlines</h2><p className="rv-ds-focus-intro">Where an outline or a fill is the only way to tell a control or a state, it now reaches 3:1. Quiet borders remain, for separators only.</p><div className="rv-ds-themes">{(["light", "dark"] as const).map(theme => <FocusPanel key={theme} theme={theme} />)}</div></section>}
 </div>;
}
function FocusPanel({ theme }: { theme: "light" | "dark" }) {
 const [selected, setSelected] = useState("Inbox"), suffix = theme === "dark" ? " · dark" : "";
 return <section className="rv-ds-panel" data-focus-theme={theme} style={themeStyle(theme)} aria-label={theme === "light" ? "Focus and selection" : "Dark focus and selection"}>
  <h3 className="rv-ds-meta">{theme.toUpperCase()}</h3>
  <div className="rv-ds-focus-examples">
   <div><div className="rv-ds-selection" role="group" aria-label={`Selection example${suffix}`}>{["Inbox", "Work"].map(label => <button key={label} type="button" className={selected === label ? "rv-selected" : ""} aria-label={`${label === "Inbox" ? "Inbox, 3 waiting" : label}${suffix}`} aria-pressed={selected === label} onClick={() => setSelected(label)}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{label === "Inbox" ? <path d="M4 5h16l2 13H2L4 5Zm-1 8h6l1 3h4l1-3h6" /> : <path d="M4 6h16M4 12h16M4 18h16" />}</svg>{label}{label === "Inbox" ? <span className="rv-ds-nav-count" aria-hidden="true">3</span> : null}</button>)}</div><p className="rv-ds-meta">Selected: bar, weight and text colour</p></div>
   <div className="rv-ds-focus-rows"><div className="rv-selected">Add refunds endpoint<StatusChip state="needs_you" /></div><button type="button" className="is-focus-demo" aria-label={`Rotate webhook signing secrets${suffix}`} aria-describedby={`ds-keyboard-focus-${theme}`}>Rotate webhook signing secrets<span id={`ds-keyboard-focus-${theme}`} className="rv-ds-meta">keyboard focus</span></button></div>
  </div>
  <div className="rv-actions rv-ds-ring-buttons"><button type="button" className="rv-button is-focus-demo" aria-label={`Request changes${suffix}`}>Request changes</button><button type="button" className="rv-button rv-button-primary is-focus-demo" aria-label={`Review evidence${suffix}`}>Review evidence</button><span className="rv-ds-not-started"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="8" cy="8" r="5" /></svg>Not started</span></div>
  <p className="rv-ds-meta rv-ds-focus-caption">Focus ring: 2 px, running blue, 2 px offset</p>
  <label className="rv-field rv-ds-composer-field"><span className="rv-ds-meta">Composer with focus{suffix}</span><input type="text" className="rv-input rv-ds-composer is-focus-demo" defaultValue="Add a test for a repeated refund request." /></label>
 </section>;
}

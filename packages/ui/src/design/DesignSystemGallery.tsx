import { useState, type CSSProperties } from "react";
import { LOOK_COLORS } from "@agentx/design-tokens";
import { colourRoles, foundationScenes, spaceExamples, statusRoles } from "./design-system-gallery-data.js";
/** Mounted, static foundation reference. No company data or write actions. */
export function DesignSystemGallery() {
 const [selected, setSelected] = useState("Inbox");
 return <div className="rv-ds-gallery">
  <header><p className="rv-ds-meta">ROVARA DESIGN SYSTEM · SHEET V2</p><h1 tabIndex={-1}>A calm control room</h1><p className="rv-ds-lead">Quiet, dense, exact. Colour only means status, and always comes with an icon and a word. The interface speaks like a good colleague&apos;s hand-over note.</p></header>
  <nav aria-label="Foundation scenes">{foundationScenes.map(scene => <a key={scene.id} href={`#${scene.id}`}>{scene.title}</a>)}</nav>
  <section id="colours" aria-labelledby="ds-colours"><h2 id="ds-colours">Colour roles</h2><div className="rv-ds-themes">{(["light", "dark"] as const).map(theme => {
   const colors = LOOK_COLORS[theme];
   const style = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--rv-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value])) as CSSProperties;
   return <div key={theme} className="rv-ds-panel" style={{ ...style, colorScheme: theme }}><h3 className="rv-ds-meta">{theme === "light" ? "LIGHT" : "DARK · SAME ROLE NAMES"}</h3><dl className="rv-ds-swatches">{colourRoles.map(([label, key]) => <div key={label}><span className="rv-ds-swatch" style={{ background: colors[key] }} aria-hidden="true" /><dt>{label}</dt><dd><code>{colors[key].toUpperCase()}</code></dd></div>)}</dl><dl className="rv-ds-swatches rv-ds-status-colours">{statusRoles.map(([label, fg, bg]) => <div key={label}><span className="rv-ds-swatch" style={{ background: colors[bg], color: colors[fg] }} aria-hidden="true">Aa</span><dt>{label}</dt><dd><code>{colors[fg].toUpperCase()} / {colors[bg].toUpperCase()}</code></dd></div>)}</dl></div>;
  })}</div></section>
  <div className="rv-ds-foundations">
   <section id="type" className="rv-ds-panel" aria-labelledby="ds-type"><h2 id="ds-type">Type: five sizes, two weights</h2><div className="rv-ds-type-list">
    <div><span>28 page</span><h3 className="rv-ds-page-type">Add refunds endpoint</h3></div>
    <div><span>20 section</span><h3 className="rv-ds-section-type">Checks and reviews</h3></div>
    <div><span>16 lead</span><p className="rv-ds-lead">Building. Nothing needed from you.</p></div>
    <div><span>14 body</span><p>Next: checks, then review. <strong>Semibold</strong> marks the one thing to read first.</p></div>
    <div><span>12 meta</span><p className="rv-ds-meta">Updated 20 s ago · acme/payments · Ana</p></div>
    <div><span>12 mono</span><code>a3f9c1e · poetry install --no-interaction</code></div>
   </div><p className="rv-ds-meta">Inter 400 and 600. JetBrains Mono for shas, commands and logs.</p></section>
   <section id="space" className="rv-ds-panel" aria-labelledby="ds-space"><h2 id="ds-space">Space: 4px base</h2><dl className="rv-ds-space-list">{spaceExamples.map(([size, use]) => <div key={size}><dt>{size}</dt><dd><i style={{ width: size }} aria-hidden="true" />{use}</dd></div>)}</dl><p className="rv-ds-meta">Three breakpoints: phone under 640, tablet, desktop from 1024. Controls 36 high on desktop, 48 on phone.</p><div className="rv-ds-reading-guide">Reading column · 760px</div><div className="rv-ds-table-guide">Tables · 1200px · rows 48px</div></section>
  </div>
  <section id="focus" className="rv-ds-panel" aria-labelledby="ds-focus"><h2 id="ds-focus">Focus and selection</h2><p className="rv-ds-meta">Selected: bar, weight and text colour on sunken. Focus ring: 2px, running blue, 2px offset.</p><div className="rv-ds-selection" role="group" aria-label="Selection example">{["Inbox", "Work"].map(label => <button key={label} type="button" className={selected === label ? "rv-selected" : ""} aria-pressed={selected === label} onClick={() => setSelected(label)}>{label}</button>)}</div><div className="rv-actions"><button type="button" className="rv-button">Request changes</button><button type="button" className="rv-button rv-button-primary">Review evidence</button></div><label className="rv-field">Composer with focus<textarea className="rv-input" defaultValue="Add a test for a repeated refund request." /></label></section>
 </div>;
}

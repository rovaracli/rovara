// OWNER DECISION 18: the documents the task page's plan panel opens (`?doc=`), and the feedback view (`?view=feedback`). Small and eager: the panel itself is a lazy chunk.
/** The documents the panel opens: a fixed list, in reading order. */
export const PANEL_DOCUMENTS = ["requirements", "design", "plan"] as const;
export type PanelDocument = (typeof PANEL_DOCUMENTS)[number];
export const isPanelDocument = (value: string | null | undefined): value is PanelDocument => (PANEL_DOCUMENTS as readonly string[]).includes(value ?? "");
export const PANEL_DOCUMENT_WORDS: Record<PanelDocument, { name: string; read: string }> = {
 requirements: { name: "Requirements", read: "Read the full requirements" }, design: { name: "Design", read: "Read the full design" }, plan: { name: "Coding plan", read: "Read the full plan" },
};
/** The document a decision card decides, by its kind (a card with tabs decides the tab shown). */
export const panelDocumentOfCard = (kind: string, tab?: string): PanelDocument | undefined =>
 kind === "approve_plan" ? "plan" : kind === "approve_design" ? "design" : kind === "approve_requirements" ? (tab === "design" ? "design" : "requirements") : undefined;

/** The search parameter that opens the feedback view, and its one value. */
export const FEEDBACK_VIEW = { param: "view", value: "feedback" } as const;

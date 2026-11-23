/** The DOM id prefix of a stage's card or row: Suggested rules scroll to and focus `<id>-title` when a rule must be removed by hand. */
export const stageDomId = (id: string) => "hww-stage-" + id.replace(/[^A-Za-z0-9_-]/g, "_");

/** The query key of a project's setup run journal (its commands and the addresses the run asked for). */
export const journalKey = (project: string) => ["onboard", "setup-journal", project] as const;

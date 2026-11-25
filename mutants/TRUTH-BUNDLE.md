# Mutant evidence: TRUTH-BUNDLE (pr/truth-bundle-20261125)

Each mutant was applied singly, in place, to one product line, then `tests/web/truth-bundle.test.ts`, `tests/web/saved-env-panel.test.ts` and `tests/web/project-page.test.ts` were run (vitest, `--maxWorkers=1`), and the line was restored with `git checkout`.

| # | Mutant | Result | Killed by |
|---|--------|---|---|
| M1 | Copy writes the company id plus an extra character (host copy) | KILLED | "Company ID is the row label, and Copy uses the host's own copy" |
| M1b | same, browser clipboard path | KILLED | "the company settings page shows the company id from /me with a Copy button" |
| M2 | no "Copied." line after a copy | KILLED | company id Copy test |
| M3 | no failure sentence after a failed copy | KILLED | "a failed copy says so in one sentence" |
| M4 | row label "Company ID" renamed | KILLED | "Company ID is the row label ..." |
| M5 | host's own copy ignored (always the browser clipboard) | KILLED | "Company ID is the row label ..." |
| M6 | heading back to "Running now" | KILLED | project-page test (no visibility claim, "Your running tasks") |
| M7 | visibility sentence put back | KILLED | project-page test |
| M8 | non-editor header shows the raw channel id | first batch run SURVIVED (not explained; the replacement did apply), rerun alone KILLED | "a person who cannot edit sees that a channel is linked, never its raw id" |
| M9 | channel drawn although the workspace is not connected | KILLED | "no channel is drawn when none is linked, the workspace is not connected, or the read is refused" |
| M10 | saved-environment panel put back on the Overview tab | KILLED | saved-env-panel page test (Setup tab only) |
| M11 | Reset button drawn when `canReset` is true | KILLED | saved-env-panel "shows health ..." and "draws no Reset ..." tests |
| M12 | Automation keys link renamed away from the nav | KILLED | "the Admin nav links Automation keys ..." |

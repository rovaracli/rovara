// UX-4b: a failed setup check, read for a person. The server sends one line (`failedStepOf`: "setup: npm ci - <reason>", "test: npm test - <reason>", or "setup: <reason>" for a clone or a dev
// container); this splits it into the step that failed, its cause, and a fix in fixed words chosen from what the cause says. The cause is the server's redacted text, shown as text.

export interface SetupFailure {
 /** "Setup command", "Test command" or "Preparing the machine". */
 step: string;
 command?: string;
 cause: string;
 fix: string;
}

const FIXES: ReadonlyArray<{ test: RegExp; fix: string }> = [
 { test: /did not finish within 50 minutes/u, fix: "The check stopped answering. Run it again; if it stops again, make the slowest command shorter or let Rovara run the setup." },
 { test: /command not found|not found: |: not found|No such file or directory|ENOENT/iu, fix: "A command or file it needs isn't on the machine. Install the tool in an earlier setup command, or fix the path." },
 { test: /ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|network|ECONNREFUSED|ETIMEDOUT|timed out|403 Forbidden|blocked/iu, fix: "It couldn't reach a website. Add the website it needs under Allowed websites on the project page, then check again." },
 { test: /permission denied|EACCES|EPERM/iu, fix: "It wasn't allowed to write somewhere. Write inside the repository or a temporary folder instead." },
 { test: /lockfile|package-lock|frozen|ERESOLVE|peer dep/iu, fix: "The dependencies don't install as locked. Update the lockfile in the repository, or use the install command the repository documents." },
 { test: /out of memory|ENOMEM|Killed|heap/iu, fix: "It ran out of memory. Run fewer jobs at once in that command." },
 { test: /exit(ed)? (code|status) [1-9]|failed|error/iu, fix: "The command reported an error. Run it on your own machine to see the full output, fix it in the repository, then check again." },
];

/** The step, cause and fix of a failed check's one line; undefined for an empty line. */
export function setupFailureOf(line: string | undefined): SetupFailure | undefined {
 if (line === undefined || line.trim() === "") return undefined;
 const match = /^(setup|test):\s?(.*)$/u.exec(line);
 const stage = match?.[1] ?? "setup", rest = match?.[2] ?? line;
 const dash = rest.indexOf(" - ");
 // "setup: <reason>" (no command) is a step that ran before any command: the clone, the dev container.
 const named = dash >= 0;
 const command = named ? rest.slice(0, dash).trim() : undefined;
 const cause = (named ? rest.slice(dash + 3) : rest).trim() || "No reason was recorded.";
 const fix = FIXES.find(entry => entry.test.test(cause))?.fix ?? "Check the command on your own machine, fix it in the repository or in the commands above, then check again.";
 return { step: !named ? "Preparing the machine" : stage === "test" ? "Test command" : "Setup command", ...(command === undefined || command === "" ? {} : { command }), cause, fix };
}

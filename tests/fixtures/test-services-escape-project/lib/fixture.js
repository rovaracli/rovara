"use strict";
// The ESCAPE_* overrides exist so the repository's own tests (tests/contract/test-services-escape-project.test.ts) can aim a test at something that IS reachable and check that the test then FAILS. In a real round they must
// do nothing: a target, a resolver or an age limit that a variable could change would let a round be told to look elsewhere. So an override is honoured only when ESCAPE_FIXTURE_TEST=1, which only the fixture tests set.
const fixtureMode = () => process.env.ESCAPE_FIXTURE_TEST === "1";
/** The value of the override `name`, or undefined (always undefined outside the fixture tests). */
const setting = (name) => (fixtureMode() ? process.env[name] : undefined);

module.exports = { fixtureMode, setting };

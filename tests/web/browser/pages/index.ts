// Everything the browser specs know about the screens. A redesign changes the files in this folder, not the specs.
export { AskBox, setAnswers } from "./answers.js";
export { AccountPage, AdminPage, AiSpendPage, ProjectLifecyclePage } from "./admin.js";
export { BROWSER_TESTING_ROUTE, BrowserTestingPage, browserTestingWrites, setBrowserTesting } from "./browser-testing.js";
export { HomePage } from "./home.js";
export { FAKE_CODE_URL, LessonsPage, setLessons } from "./lessons.js";
export { ConnectPage, FAKE_LINEAR_CODES, FAKE_SLACK_CODES } from "./connect.js";
export { CompanyOnboardingPage, FAKE_GITHUB_CODES, FAKE_INVITE_CODE, GithubConnectPage, setFakePerson, setNoCompany } from "./onboarding.js";
export { InboxPage, seedInbox } from "./inbox.js";
export { ProjectPage } from "./project.js";
export { RepoPickerPage, resetCreatedProjects } from "./repo-picker.js";
export { PERSON, PROJECT, ROUTES, UNSERVED_SCREENS } from "./routes.js";
export { PeoplePanel, SessionPage } from "./session.js";
export { SetupApprovalPage, SetupChecklistPage, SetupTabPage, setEvalCard, setSetupApply, setSetupRun, setSetupScenario } from "./setup.js";
export { ShellPage, UnavailablePage } from "./shell.js";
export { SignedOutPage } from "./sign-in.js";
export { WorkPage } from "./work.js";
export { WikiPage, WikiSetupPanel, setWiki, setWikiSetup } from "./wiki.js";

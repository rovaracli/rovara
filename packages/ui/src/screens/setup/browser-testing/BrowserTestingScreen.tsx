// The Browser testing page on its own route: /app/projects/{name}/browser-testing (a project's setup, reachable from the setup checklist's row and from the project's Settings).
import { useParams } from "react-router";
import { BrowserTestingPage } from "./BrowserTestingPage.js";
import { NotFound } from "../../../shell/NotFound.js";

export function BrowserTestingScreen() {
  const { name } = useParams();
  return name === undefined ? <NotFound /> : <BrowserTestingPage key={name} project={name} />;
}

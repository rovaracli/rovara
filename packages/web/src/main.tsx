import { createRoot } from "react-dom/client";
import { Probe } from "@agentx/ui";
import { configureZodForCsp } from "@agentx/contracts/web";
configureZodForCsp();
const root = document.getElementById("root");
if (!root) throw new Error("App root missing");
createRoot(root).render(<Probe />);

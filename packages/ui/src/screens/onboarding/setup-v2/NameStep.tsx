import { Button } from "../../../design/Button.js";
import { TextArea } from "../../../design/TextArea.js";
import { TextField } from "../../../design/TextField.js";
import { nameProblem } from "./repo-plan.js";

/** Step 1: name the project and say in a line what it is for. Held by the page until the repositories are chosen: nothing is created yet. */
export function NameStep({ name, description, onName, onDescription, onNext }: { name: string; description: string; onName: (value: string) => void; onDescription: (value: string) => void; onNext: () => void }) {
 const problem = nameProblem(name);
 return <>
  <h2>Name the project</h2>
  <p>A project is one product or system your team works on, with its repositories, people and agents.</p>
  <form onSubmit={event => { event.preventDefault();if (problem === undefined) onNext(); }}>
   <TextField label="Project name" value={name} hint="Lowercase letters, numbers and hyphens. Leave blank to use the repository name." maxLength={63} {...(problem === undefined ? {} : { error: problem })} onChange={event => onName(event.target.value)} />
   <TextArea label="What is this project for?" value={description} maxLength={280} onChange={event => onDescription(event.target.value)} />
   <Button type="submit" variant="primary" disabled={problem !== undefined}>Choose repositories</Button>
  </form>
 </>;
}

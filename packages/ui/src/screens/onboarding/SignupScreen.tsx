import { SignInChoices } from "../signed-out/SignInChoices.js";
import { PageHeader } from "../../design/PageHeader.js";
import "./onboarding.css";
export function SignupScreen(){return <main className="rv-entry rv-onboarding-entry"><p className="rv-eyebrow">Rovara</p><PageHeader title="Start with Rovara" description="Turn a useful way of working into something your team can use together." focusOnMount /><SignInChoices returnPath="/app/welcome" label="Sign up or sign in" /><p>A free trial starts when you connect GitHub.</p><p className="rv-muted">Have an invite? Open the link you were sent.</p></main>;}

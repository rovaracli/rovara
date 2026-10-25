import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { PageHeader } from "../../design/PageHeader.js";
import "./onboarding.css";
export function SignupScreen(){const host=useAppHost();return <main className="rv-entry rv-onboarding-entry"><p className="rv-eyebrow">Rovara</p><PageHeader title="Start with Rovara" description="Turn a useful way of working into something your team can use together." focusOnMount /><Button variant="primary" onClick={()=>host.signIn("/app/welcome")}>Sign up or sign in</Button><p>A free trial starts when you connect GitHub.</p><p className="rv-muted">Have an invite? Open the link you were sent.</p></main>;}

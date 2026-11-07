import { Link } from "react-router";
import { paths } from "../paths.js";
// Chains and triggers are hidden (owner decision 2026-11-07). Their data and code stay; an old link lands here instead of on an error.
export function Unavailable() { return <section><h1 tabIndex={-1}>This isn't available</h1><p>This part of Rovara isn't available right now.</p><Link to={paths.home}>Go to Home</Link></section>; }

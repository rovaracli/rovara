import { Link } from "react-router";
import { paths } from "../paths.js";
export function NotFound() { return <section><h1 tabIndex={-1}>Not found</h1><p>We couldn't find that. It may not exist, or it hasn't been shared with you.</p><Link to={paths.home}>Go to Home</Link></section>; }

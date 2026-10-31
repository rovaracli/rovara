import { useEffect, useRef } from "react";
import { NavigationType, useNavigationType, useSearchParams } from "react-router";

export const SUGGESTED_RULES_ID = "suggested-rules";
/** The Home card's "Review" link opens the project page on How we work (a new entry or a first load); choosing the tab on the page replaces the address instead. On the first render with the suggestions read, the person is taken to their heading, one time; if there were none then, a later read never moves them. */
export function useSuggestedRulesLink(settled: boolean, hasOpen: boolean): void {
 const [params] = useSearchParams(), type = useNavigationType(), arrived = useRef(params.get("tab") === "how-we-work" && type !== NavigationType.Replace), done = useRef(false);
 useEffect(() => {
  if (!arrived.current || done.current || !settled) return;
  done.current = true;
  if (!hasOpen) return;
  const heading = document.getElementById(SUGGESTED_RULES_ID);
  heading?.scrollIntoView?.({ block: "start" });heading?.focus();
 }, [settled, hasOpen]);
}

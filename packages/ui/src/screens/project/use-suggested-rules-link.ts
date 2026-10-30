import { useEffect, useRef } from "react";
import { NavigationType, useNavigationType, useSearchParams } from "react-router";

export const SUGGESTED_RULES_ID = "suggested-rules";
/** The Home card's "Review" link opens the project page on How we work (a new entry or a first load); choosing the tab on the page replaces the address instead. Once there are open suggestions, the person is taken to their heading, one time. */
export function useSuggestedRulesLink(hasOpen: boolean): void {
 const [params] = useSearchParams(), type = useNavigationType(), arrived = useRef(params.get("tab") === "how-we-work" && type !== NavigationType.Replace), done = useRef(false);
 useEffect(() => {
  if (!arrived.current || done.current || !hasOpen) return;
  const heading = document.getElementById(SUGGESTED_RULES_ID);
  if (heading === null) return;
  done.current = true;heading.scrollIntoView?.({ block: "start" });heading.focus();
 }, [hasOpen]);
}

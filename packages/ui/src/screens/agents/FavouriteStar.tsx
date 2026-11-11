import { useFavourites } from "./use-favourites.js";
import { VisibleText } from "../../design/VisibleText.js";
import "./publish.css";

/** The star on a card and on the profile: a toggle that says what it does in words for a screen reader ("Favourite Payments Expert", pressed or not). Hidden when the favourites cannot be read at all. */
export default function FavouriteStar({ agentId, name }: { agentId: string; name: string }) {
 const favourites = useFavourites();
 if (!favourites.ready && !favourites.pending) return null;
 const on = favourites.ids.includes(agentId), mine = favourites.error?.agentId === agentId ? favourites.error.message : undefined;
 return <span className="rv-pub-fav">
  <button type="button" className="rv-pub-star" aria-pressed={on} aria-label={"Favourite " + name} aria-busy={favourites.busyId === agentId || undefined} disabled={!favourites.ready || favourites.busyId !== undefined} onClick={() => { void favourites.toggle(agentId, name); }}>
   <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8L3.5 9.7l5.9-.9z" /></svg>
  </button>
  {mine !== undefined && <span role="alert" className="rv-pub-fav-error"><VisibleText text={mine} /></span>}
 </span>;
}

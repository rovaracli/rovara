import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { nextNeedsYou, type WorkRow } from "../../api/work-read.js";
import { useAnnounce } from "../../design/Announcer.js";
/** The live Work post-decision handler: advance using the latest rows after refresh. */
export function useWorkAdvance(rows: readonly WorkRow[], select: (id: string) => void) {
 const rowsRef = useRef(rows), query = useQueryClient(), announce = useAnnounce();
 useEffect(() => { rowsRef.current = rows; }, [rows]);
 return (taskId: string) => {
  const next = nextNeedsYou(rowsRef.current, taskId), row = rowsRef.current.find(entry => entry.id === next);
  void query.invalidateQueries({ queryKey: ["work"] });
  if (next !== undefined && row !== undefined) { select(next);announce("Moved to " + row.title); }
 };
}

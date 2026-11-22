import { createContext, createElement, useContext, type ReactNode } from "react";

// The approved task-page composition has a fixed action disposition. This is
// route scope, never an install setting or a feature switch. Legacy standalone
// views keep their own callers; the real task page always supplies this scope.
const TaskPage = createContext<"task-page" | undefined>(undefined);
export function TaskPageBoundary({ children }: { children: ReactNode }) {
 return createElement(TaskPage.Provider, { value: "task-page" }, children);
}
export const useTaskPagePolicy = () => useContext(TaskPage);

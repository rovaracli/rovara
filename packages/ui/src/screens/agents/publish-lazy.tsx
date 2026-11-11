import { lazy } from "react";
/**
 * Every part of agent publishing a screen shows loads from here, after the first paint and only where the switch (`rovara.publish`) is on: a person with it off downloads none of it.
 * The screens that use these were already lazy routes; the Home row is inside the new Home's own lazy chunk.
 */
export const ProfilePublishing = lazy(() => import("./ProfilePublishing.js"));
export const FavouriteStar = lazy(() => import("./FavouriteStar.js"));
export const PublishDirectoryExtras = lazy(() => import("./PublishDirectoryExtras.js"));
export const PublishRequestsLink = lazy(async () => ({ default: (await import("./PublishDirectoryExtras.js")).PublishRequestsLink }));
export const AskToPublish = lazy(() => import("./AskToPublish.js"));

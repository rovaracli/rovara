// The project page's Sources tab reads `/v1/app/projects/{p}/record/sources`, a route neither Cloud nor Rovara Code serves yet (Cloud answers 501 NOT_ON_CODE_YET). Until it does the tab is not
// offered and `?tab=sources` opens the Overview. Turn this on in the same change that adds the route. The tab's code (SourcesTab, api/record-sources.ts) is kept; `ProjectScreen` takes
// `sourcesTabOffered` so a test can open the tab.
export const SOURCES_TAB_OFFERED = false;

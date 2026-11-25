import { useQuery } from "@tanstack/react-query";
import { useIntegrationsApi } from "../../api/integrations.js";
import { VisibleText } from "../../design/VisibleText.js";

/**
 * The project's linked Slack channel(s) in the header facts, read from the route the Slack settings already use (`GET /v1/app/projects/{p}/slack/channel`, which serves ids only). A person who may edit the project also
 * reads the channel names (the picker's first page, as the Slack settings row does); anyone else sees "A linked Slack channel", never a bare id. Nothing is drawn while the read is pending, fails, is refused (Code serves that route to admins only) or says no channel is linked: a header never claims a channel it could not read (DEC 540).
 */
export function ProjectChannels({ project, canEdit }: { project: string; canEdit: boolean }) {
 const api = useIntegrationsApi();
 const linked = useQuery({ queryKey: ["slack", "project-channel", project], queryFn: () => api.projectChannel(project), retry: false });
 const ids = linked.data?.connected === true ? linked.data.channels.map(channel => channel.id) : [];
 const names = useQuery({ queryKey: ["slack", "channels", project, ""], queryFn: () => api.slackChannels(project), enabled: ids.length > 0 && canEdit, retry: false });
 if (ids.length === 0) return null;
 return <>{ids.map(id => {
  const name = names.data?.channels.find(channel => channel.id === id)?.name;
  return <span key={id} data-testid="project-slack-channel">{name === undefined ? "A linked Slack channel" : <>Slack <VisibleText text={`#${name}`} /></>}</span>;
 })}</>;
}

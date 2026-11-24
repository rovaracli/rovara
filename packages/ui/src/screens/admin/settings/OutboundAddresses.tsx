// L4-EGR: "Rovara's outbound addresses", one read-only line in Company settings (owners and admins; the page decides who sees it, Code and Cloud decide again). The company can allow these
// addresses in its own firewall. They belong to this Rovara, so every company on it has the same ones, and the line says so. Nothing here changes anything.
// It draws nothing while loading, when there are no addresses yet (an older Rovara), or when they can't be read: no error is shown for a line that is only information.
import { EGRESS_ADDRESSES_PATH, EGRESS_NOTICE_DAYS, readEgressAddresses } from "../../../api/egress-addresses.js";
import { AdminSection } from "../parts.js";
import { useAdminRead } from "../models/read.js";

const reader = { parse: readEgressAddresses };

export function OutboundAddresses() {
 const read = useAdminRead("egress-addresses", EGRESS_ADDRESSES_PATH, reader, { stable: true });
 const addresses = read.data;
 if (addresses === undefined || addresses.length === 0) return null;
 const many = addresses.length > 1;
 return <AdminSection title="Rovara's outbound addresses" note="Read only">
  <p data-testid="outbound-addresses">Rovara's outbound {many ? "addresses" : "address"}: {addresses.map((address, index) => <span key={address}>{index > 0 && ", "}<code>{address}</code></span>)}. {many ? "They're" : "It's"} shared by all companies on this Rovara, and we give {EGRESS_NOTICE_DAYS} days' notice before {many ? "they change" : "it changes"}.</p>
  <p className="rv-muted" data-testid="outbound-addresses-scope">These are the addresses the machines that run tasks connect from. A few calls, such as connector and sign-in checks, don't use them yet. Also add your server's address to the project's allowed addresses.</p>
 </AdminSection>;
}

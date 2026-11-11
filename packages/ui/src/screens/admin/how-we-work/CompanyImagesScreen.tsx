import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createCompanyTestImagesApi, type CompanyTestImage } from "../../../api/company-test-images.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import "./how-we-work.css";

// The fixed words of the approved-images screen. Nothing here comes from the server.
export const IMAGES_TEXT = {
 TITLE: "Approved test images",
 NOTE: "Rovara runs its own list of service images for tests (databases, caches and queues). If a project needs another image, an admin approves it here once. Each approval is pinned to one exact image, so an image that changes later needs a new approval.",
 NOT_ADMIN: "Only a company owner or admin can see or change approved test images.",
 NOT_ON: "Approved test images are not turned on for this company.",
 LOAD_FAILED: "Couldn't load the approved test images.",
 FAILED: "That did not work. Try again.",
 STALE: "That image changed. The list was refreshed: check it and try again.",
 SIGN_IN_AGAIN: "Sign in again",
 BACK: "Back to How we work",
 ADD_HEADING: "Add an image",
 ADD_HINT: "Name a version tag from a public registry, for example postgres:18. Rovara looks up the exact image and shows it here for approval. Nothing runs until you approve it.",
 ADD_BUTTON: "Look up this image",
 WAITING: "Waiting for approval",
 NONE_WAITING: "Nothing is waiting for approval.",
 APPROVED: "Approved",
 NONE_APPROVED: "No extra image is approved. Only Rovara's own image list is used.",
 APPROVE: "Approve this image",
 APPROVE_HELP: "You approve exactly the image shown here, by its digest. It runs with the same limits as Rovara's own images of that kind. You need to have signed in within the last 10 minutes.",
 DISMISS: "Dismiss",
 REVOKE: "Revoke",
 REVOKE_HELP: "Revoking stops the next run from using this image. A run that has already started finishes with it.",
 NOT_OFFICIAL: "This is not an official image. Whoever publishes it decides what is inside, and it will run in your tests. Check that you trust the publisher before you approve it.",
 FROM_SETUP: "Asked for by the setup of the project ",
 FROM_ADMIN: "Added by ",
 KINDS: "Rovara can run these kinds of service: ",
} as const;

const problem = (error: unknown): { message: string; reauth: boolean; stale: boolean } => error instanceof ApiError
 ? { message: error.message, reauth: error.code === "REAUTH_REQUIRED", stale: error.code === "CHANGE_STALE" } : { message: IMAGES_TEXT.FAILED, reauth: false, stale: false };

/** The read the screen and the How we work card share (a refusal as "not found" means the switches are off). */
export function useCompanyImages(enabled = true) {
 const host = useAppHost(), api = useMemo(() => createCompanyTestImagesApi(host), [host]);
 return { api, read: useQuery({ queryKey: ["admin", "company-test-images"], queryFn: () => api.list(), enabled, refetchOnWindowFocus: false, retry: false }) };
}

export function CompanyImagesScreen() {
 const { role } = useAdminContext();
 if (role !== "owner" && role !== "admin") return <section><PageHeader focusOnMount title={IMAGES_TEXT.TITLE} /><p role="alert">{IMAGES_TEXT.NOT_ADMIN}</p></section>;
 return <Images />;
}

function Card({ image, children }: { image: CompanyTestImage; children: React.ReactNode }) {
 return <section aria-label={image.image} className="rv-hww-company-card">
  <h2><VisibleText text={image.image} /></h2>
  <p className="rv-muted">From <VisibleText text={image.registry === "docker.io" ? "Docker Hub" : image.registry} />. Kind of service: <VisibleText text={image.family} />. {image.origin === "setup" && image.project !== undefined ? <>{IMAGES_TEXT.FROM_SETUP}<VisibleText text={image.project} />.</> : <>{IMAGES_TEXT.FROM_ADMIN}<VisibleText text={image.proposedBy} />.</>}</p>
  {!image.official && <p role="note"><strong>{IMAGES_TEXT.NOT_OFFICIAL}</strong></p>}
  <p>Digest it is pinned to: <code><VisibleText text={"sha256:" + image.digest} /></code></p>
  {children}
 </section>;
}

function Images() {
 const { api, read } = useCompanyImages(), host = useAppHost(), query = useQueryClient(), sending = useRef(false);
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<ReturnType<typeof problem>>(), [note, setNote] = useState<string>(), [name, setName] = useState("");
 useEffect(() => () => { void query.cancelQueries({ queryKey: ["admin", "company-test-images"] }); }, [query]);
 async function run(label: string, work: () => Promise<void>, done?: string): Promise<boolean> {
  if (sending.current) return false;
  sending.current = true;setBusy(label);setError(undefined);setNote(undefined);
  try { await work();if (done !== undefined) setNote(done);await read.refetch();return true; }
  catch (caught) { const seen = problem(caught);setError(seen.stale ? { ...seen, message: IMAGES_TEXT.STALE } : seen);if (seen.stale) await read.refetch();return false; }
  finally { sending.current = false;setBusy(undefined); }
 }
 const notOn = read.error instanceof ApiError && read.error.status === 404;
 const state = read.data, waiting = state?.images.filter(image => image.status === "proposed") ?? [], approved = state?.images.filter(image => image.status === "approved") ?? [];
 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title={IMAGES_TEXT.TITLE} description={IMAGES_TEXT.NOTE} />
  <p><Link to="/app/admin/how-we-work">{IMAGES_TEXT.BACK}</Link></p>
  {error !== undefined && <p role="alert"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{IMAGES_TEXT.SIGN_IN_AGAIN}</Button></>}</p>}
  <p role="status">{note ?? ""}</p>
  {read.isPending ? <Skeleton label="Loading approved test images" /> : notOn ? <p role="status">{IMAGES_TEXT.NOT_ON}</p> : state === undefined ? <div><p role="alert">{IMAGES_TEXT.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   <form aria-label={IMAGES_TEXT.ADD_HEADING} className="rv-hww-company-card" onSubmit={event => { event.preventDefault();if (name.trim() !== "") void run("add", () => api.add(name.trim()), "Looked up. Check the image below and approve it if it is right.").then(added => { if (added) setName(""); }); }}>
    <h2>{IMAGES_TEXT.ADD_HEADING}</h2>
    <TextField label="Image" hint={IMAGES_TEXT.ADD_HINT} value={name} onChange={event => { setName(event.target.value); }} autoComplete="off" maxLength={300} />
    {state.kinds.length > 0 && <p className="rv-muted">{IMAGES_TEXT.KINDS}<VisibleText text={state.kinds.join(", ")} />.</p>}
    <div className="rv-hww-company-actions"><Button type="submit" variant="primary" busy={busy === "add"} disabled={busy !== undefined || name.trim() === ""}>{IMAGES_TEXT.ADD_BUTTON}</Button></div>
   </form>
   <h2>{IMAGES_TEXT.WAITING}</h2>
   {waiting.length === 0 ? <p className="rv-muted">{IMAGES_TEXT.NONE_WAITING}</p> : <div className="rv-hww-company-cards">
    {waiting.map(image => <Card key={image.imageId} image={image}>
     <p className="rv-muted">{IMAGES_TEXT.APPROVE_HELP}</p>
     <div className="rv-hww-company-actions"><Button variant="primary" busy={busy === "approve:" + image.imageId} disabled={busy !== undefined} onClick={() => { void run("approve:" + image.imageId, () => api.approve(image), "Approved.") }}>{IMAGES_TEXT.APPROVE}</Button><Button disabled={busy !== undefined} onClick={() => { void run("revoke:" + image.imageId, () => api.revoke(image), "Dismissed.") }}>{IMAGES_TEXT.DISMISS}</Button></div>
    </Card>)}
   </div>}
   <h2>{IMAGES_TEXT.APPROVED}</h2>
   {approved.length === 0 ? <p className="rv-muted">{IMAGES_TEXT.NONE_APPROVED}</p> : <div className="rv-hww-company-cards">
    {approved.map(image => <Card key={image.imageId} image={image}>
     <p className="rv-muted">{IMAGES_TEXT.REVOKE_HELP}</p>
     <div className="rv-hww-company-actions"><Button variant="danger" busy={busy === "revoke:" + image.imageId} disabled={busy !== undefined} onClick={() => { void run("revoke:" + image.imageId, () => api.revoke(image), "Revoked.") }}>{IMAGES_TEXT.REVOKE}</Button></div>
    </Card>)}
   </div>}
  </>}
 </section>;
}

/** On the company How we work page: a link to the approved images, shown only when the server has them on (and for an admin). A refusal or a failed read shows nothing. Its own chunk. */
export default function CompanyImagesRow() {
 const { role } = useAdminContext(), { read } = useCompanyImages(role === "owner" || role === "admin");
 if (read.data === undefined) return null;
 const waiting = read.data.images.filter(image => image.status === "proposed").length;
 return <section aria-label={IMAGES_TEXT.TITLE} className="rv-hww-company-card rv-hww-suggestions"><h2>{IMAGES_TEXT.TITLE}</h2>
  <p className="rv-muted">Approve a service image that is not in Rovara's own list, for test runs.</p>
  {waiting > 0 && <p role="status">{waiting === 1 ? "1 image is waiting for approval." : String(waiting) + " images are waiting for approval."}</p>}
  <p><Link to="/app/admin/how-we-work/images">Open approved test images</Link></p>
 </section>;
}

// Invoices, newest first, ten at a time. "Show more" asks for the next page with the server's cursor. The PDF and online links are the provider's, https only.
import type { Invoice } from "../../api/trial-billing.js";
import { useInvoices } from "../../api/trial-billing.js";
import { ApiError } from "../../api/errors.js";
import { safeExternalUrl } from "../../text/links.js";
import { Button } from "../../design/Button.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { dayText, MinorMoney } from "./format.js";
import { invoiceStatusWords } from "./trial-logic.js";

export const INVOICE_WORDS = { HEADING: "Invoices", NONE: "No invoices yet.", MORE: "Show more invoices", FAILED: "Couldn't load invoices. Try again.", RETRY: "Try again" } as const;

function Links({ invoice }: { invoice: Invoice }) {
 const pdf = invoice.pdfUrl === null ? undefined : safeExternalUrl(invoice.pdfUrl), online = invoice.hostedUrl === null ? undefined : safeExternalUrl(invoice.hostedUrl);
 if (pdf === undefined && online === undefined) return <span className="rv-muted">None</span>;
 return <span className="rv-tb-links">{pdf !== undefined && <a href={pdf} target="_blank" rel="noopener noreferrer" aria-label={`PDF of invoice ${invoice.number}`}>PDF</a>}{online !== undefined && <a href={online} target="_blank" rel="noopener noreferrer" aria-label={`View invoice ${invoice.number} online`}>View online</a>}</span>;
}
const COLUMNS: readonly Column<Invoice>[] = [
 { key: "date", title: "Date", render: row => dayText(row.issuedAt) },
 { key: "number", title: "Invoice", render: row => <VisibleText text={row.number} /> },
 { key: "amount", title: "Amount", render: row => <MinorMoney minor={row.totalMinor} currency={row.currency} /> },
 { key: "status", title: "Status", render: row => invoiceStatusWords(row.status) },
 { key: "links", title: "Links", render: row => <Links invoice={row} /> },
];

export function InvoicesSection({ enabled }: { enabled: boolean }) {
 const read = useInvoices(enabled), rows = read.data?.pages.flatMap(page => page.invoices) ?? [];
 return <section className="rv-tb-card" aria-labelledby="tb-invoices"><h2 id="tb-invoices">{INVOICE_WORDS.HEADING}</h2>
  {read.isPending && read.fetchStatus !== "idle" ? <Skeleton label="Loading invoices" /> : read.isError && rows.length === 0 ? <><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : INVOICE_WORDS.FAILED} /></p><div><Button onClick={() => { void read.refetch(); }}>{INVOICE_WORDS.RETRY}</Button></div></>
   : rows.length === 0 ? <p>{INVOICE_WORDS.NONE}</p>
   : <DataTable caption="Invoices" columns={COLUMNS} rows={rows} rowKey={row => row.invoiceId} />}
  {read.isError && rows.length > 0 && <p role="alert">{INVOICE_WORDS.FAILED}</p>}
  {read.hasNextPage && <div><Button busy={read.isFetchingNextPage} onClick={() => { void read.fetchNextPage(); }}>{INVOICE_WORDS.MORE}</Button></div>}
 </section>;
}

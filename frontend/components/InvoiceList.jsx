import { currency, statusClass } from "@/lib/format";

function InvoiceRow({ invoice, includeInvoiceNumber = true }) {
  return (
    <article className="invoice-item">
      <div>
        <div className="invoice-row">
          <span className="invoice-name">{invoice.customer_name}</span>
          <span className="invoice-amount">{currency(invoice.amount)}</span>
        </div>
        <p className="invoice-meta">
          {includeInvoiceNumber ? `${invoice.invoice_number} · ` : ""}Date {invoice.issued_on}
          {Number(invoice.outstanding || 0) > 0 ? ` · Outstanding ${currency(invoice.outstanding)}` : ""}
        </p>
      </div>
      <span className={`status-badge ${statusClass(invoice.status)}`}>{invoice.status}</span>
    </article>
  );
}

export default function InvoiceList({ invoices = [], includeInvoiceNumber = true, showPaymentButton = false, openModal, emptyText }) {
  if (!invoices.length) {
    return <div className="clean-empty">{emptyText || "No invoices yet. Create your first invoice to replace the preview state with live billing data."}</div>;
  }

  if (showPaymentButton) {
    return (
      <div className="all-invoice-list">
        {invoices.map((invoice) => (
          <div className="all-invoice-item" key={invoice.id}>
            <InvoiceRow invoice={invoice} includeInvoiceNumber={includeInvoiceNumber} />
            {Number(invoice.outstanding || 0) > 0 ? (
              <button className="button button-secondary" type="button" onClick={() => openModal?.("payment", { invoiceId: invoice.id })}>
                Record Payment
              </button>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="invoice-list">
      {invoices.map((invoice) => (
        <InvoiceRow key={invoice.id} invoice={invoice} includeInvoiceNumber={includeInvoiceNumber} />
      ))}
    </div>
  );
}

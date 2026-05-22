import { currency } from "@/lib/format";

const cardMeta = [
  {
    key: "monthly_revenue",
    label: "Monthly Revenue",
    note: "Payments collected this month.",
    icon: "M5 17h14M7 14l3-3 3 2 4-6M8 19V9M13 19v-5M18 19V7"
  },
  {
    key: "outstanding_payments",
    label: "Outstanding Payments",
    note: "Open balance across invoices.",
    icon: "M6 5h12v14H6zM9 9h6M9 12h4M9 15h3"
  },
  {
    key: "invoice_count",
    label: "Invoices",
    note: "Overall invoice count currently tracked in billing.",
    icon: "M7 4h10v16l-2-1-2 1-2-1-2 1-2-1zM9 8h6M9 12h6M9 16h3"
  }
];

function SummaryIcon({ path }) {
  return (
    <span className="summary-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={path}></path>
      </svg>
    </span>
  );
}

export default function SummaryCards({ summary }) {
  const data = summary || {};
  const balanceDirection = data.net_balance_direction === "negative" ? "negative" : "positive";

  return (
    <section id="summaryGrid" className="summary-grid" aria-label="Billing summary">
      {cardMeta.map((card) => {
        const value = card.key === "invoice_count" ? Number(data[card.key] || 0) : currency(data[card.key]);
        return (
          <article key={card.key} className="summary-card">
            <div className="summary-top">
              <span className="summary-label">{card.label}</span>
              <SummaryIcon path={card.icon} />
            </div>
            <strong className="summary-value">{value}</strong>
            <p className="summary-note">{card.note}</p>
          </article>
        );
      })}

      <article className={`summary-card balance-${balanceDirection}`}>
        <div className="summary-top">
          <span className="summary-label">Net Balance</span>
          <span className="summary-tooltip" data-tooltip="Monthly revenue minus outstanding payments.">?</span>
        </div>
        <strong className="summary-value">{currency(data.net_balance)}</strong>
        <p className="summary-note">Revenue less pending collections.</p>
        <span className={`balance-helper ${balanceDirection === "negative" ? "negative" : ""}`}>
          {balanceDirection === "negative" ? "Negative cash position" : "Positive cash position"}
        </span>
      </article>
    </section>
  );
}

export default function CustomerModule({ customers = [], openModal }) {
  return (
    <section id="customerInfoView" className="app-view active" data-title="Customer Info">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Customer Info</h2>
            <div className="panel-subtitle">Customer contact records for billing and follow-up.</div>
          </div>
          <button className="button button-primary" type="button" onClick={() => openModal("customer")}>
            Add Customer
          </button>
        </div>
        <div className="customer-list">
          {customers.length ? (
            customers.map((customer) => (
              <article key={customer.id} className="customer-item">
                <h3>{customer.name}</h3>
                <p className="customer-meta">
                  <span>{customer.email || "No email"}</span>
                  <span>{customer.phone || "No phone"}</span>
                </p>
              </article>
            ))
          ) : (
            <div className="module-empty">No customer records yet.</div>
          )}
        </div>
      </section>
    </section>
  );
}

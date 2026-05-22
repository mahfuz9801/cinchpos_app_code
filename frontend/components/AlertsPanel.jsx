export default function AlertsPanel({ alerts = [] }) {
  return (
    <aside className="alerts-panel" id="alerts-panel">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>Alerts & Notifications</h3>
            <div className="panel-subtitle">Overdue balances and due-today reminders.</div>
          </div>
        </div>
        <div className="alert-list">
          {alerts.length ? (
            alerts.map((alert, index) => (
              <article key={`${alert.title}-${index}`} className="alert-card">
                <h4>{alert.title}</h4>
                <p className="alert-copy">{alert.detail}</p>
              </article>
            ))
          ) : (
            <div className="clean-empty">No overdue balances or due-today reminders.</div>
          )}
        </div>
      </section>
    </aside>
  );
}

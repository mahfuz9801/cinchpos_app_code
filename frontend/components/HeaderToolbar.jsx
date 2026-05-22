export default function HeaderToolbar({ title, businessName, ownerName, openModal }) {
  return (
    <header id="dashboard" className="app-toolbar">
      <div className="window-title">
        <div className="platform-controls" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div>
          <div className="eyebrow">{ownerName}</div>
          <h1>
            <span>{businessName}</span> <span id="workspaceTitle">{title}</span>
          </h1>
        </div>
      </div>
      <div className="toolbar-actions">
        <button className="button button-primary pos-launch" type="button" onClick={() => openModal("pos")}>
          CinchPOS
        </button>
        <button className="button button-secondary" type="button" onClick={() => openModal("customer")}>
          Add Customer
        </button>
        <button className="button button-secondary" type="button" onClick={() => openModal("payment")}>
          Record Payment
        </button>
        <button className="button button-secondary" type="button" onClick={() => openModal("invoice")}>
          Create Invoice
        </button>
        <button className="button button-secondary" type="button" onClick={() => openModal("settings")}>
          Settings
        </button>
      </div>
    </header>
  );
}

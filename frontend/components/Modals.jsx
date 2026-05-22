"use client";

import { useEffect, useMemo, useState } from "react";
import { createCustomer, createInvoice, recordPayment } from "@/lib/api";
import { currency, todayISO } from "@/lib/format";
import InvoiceList from "./InvoiceList";
import POSModule from "./POSModule";

function ModalShell({ open, title, subtitle, large = false, children, onClose }) {
  return (
    <div className={`modal ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className={`modal-card ${large ? "large" : ""}`}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${title}`}>
            &times;
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CustomerModal({ open, onClose, onRefresh, showMessage }) {
  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await createCustomer(payload);
      form.reset();
      await onRefresh();
      onClose();
      showMessage("Customer saved.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  return (
    <ModalShell
      open={open}
      title="Add Customer"
      subtitle="Create a customer record for invoices and future payment activity."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <label>
          Customer Name
          <input name="name" type="text" placeholder="Northwind Labs" required />
        </label>
        <div className="form-grid">
          <label>
            Email
            <input name="email" type="email" placeholder="Optional" />
          </label>
          <label>
            Phone
            <input name="phone" type="text" placeholder="Optional" />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Save Customer
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function InvoiceModal({ open, customers, onClose, onRefresh, showMessage }) {
  const [issuedOn, setIssuedOn] = useState(todayISO());
  const [dueOn, setDueOn] = useState(todayISO());

  useEffect(() => {
    if (open) {
      const today = todayISO();
      setIssuedOn(today);
      setDueOn(today);
    }
  }, [open]);

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await createInvoice(payload);
      form.reset();
      setIssuedOn(todayISO());
      setDueOn(todayISO());
      await onRefresh();
      onClose();
      showMessage("Invoice created.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  return (
    <ModalShell
      open={open}
      title="Create Invoice"
      subtitle="Capture a customer, amount, and dates with a minimal billing form."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <label>
          Customer
          <select name="customer_id" required disabled={!customers.length}>
            {customers.length ? (
              customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))
            ) : (
              <option value="">Add a customer first</option>
            )}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Amount
            <input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required />
          </label>
          <label>
            Invoice Number
            <input name="invoice_number" type="text" placeholder="Auto generated if blank" />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Issued On
            <input name="issued_on" type="date" required value={issuedOn} onChange={(event) => setIssuedOn(event.target.value)} />
          </label>
          <label>
            Due On
            <input name="due_on" type="date" required value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
          </label>
        </div>
        <label>
          Notes
          <textarea name="notes" placeholder="Optional note for the invoice"></textarea>
        </label>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!customers.length}>
            Create Invoice
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function PaymentModal({ open, invoices, selectedInvoiceId, onClose, onRefresh, showMessage }) {
  const outstandingInvoices = useMemo(
    () => invoices.filter((invoice) => Number(invoice.outstanding || 0) > 0),
    [invoices]
  );
  const selected = outstandingInvoices.find((invoice) => String(invoice.id) === String(selectedInvoiceId));
  const [paidOn, setPaidOn] = useState(todayISO());
  const [invoiceId, setInvoiceId] = useState("");

  useEffect(() => {
    if (open) {
      setPaidOn(todayISO());
      setInvoiceId(selected?.id || outstandingInvoices[0]?.id || "");
    }
  }, [open, selected?.id, outstandingInvoices]);

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());

    try {
      await recordPayment(payload);
      form.reset();
      setPaidOn(todayISO());
      await onRefresh();
      onClose();
      showMessage("Payment recorded.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  return (
    <ModalShell
      open={open}
      title="Record Payment"
      subtitle="Apply a payment to an outstanding invoice and update totals immediately."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <label>
          Invoice
          <select name="invoice_id" required disabled={!outstandingInvoices.length} value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
            {outstandingInvoices.length ? (
              outstandingInvoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.invoice_number} · {invoice.customer_name} · {currency(invoice.outstanding)}
                </option>
              ))
            ) : (
              <option value="">Create an invoice before recording a payment</option>
            )}
          </select>
        </label>
        <div className="form-grid">
          <label>
            Payment Amount
            <input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required />
          </label>
          <label>
            Paid On
            <input name="paid_on" type="date" required value={paidOn} onChange={(event) => setPaidOn(event.target.value)} />
          </label>
        </div>
        <div className="form-grid">
          <label>
            Method
            <select name="method">
              <option>Bank Transfer</option>
              <option>UPI</option>
              <option>Card</option>
              <option>Cash</option>
            </select>
          </label>
          <label>
            Notes
            <input name="notes" type="text" placeholder="Optional" />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!outstandingInvoices.length}>
            Record Payment
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function AllInvoicesModal({ open, invoices, openModal, onClose }) {
  return (
    <ModalShell
      open={open}
      large
      title="All Invoices"
      subtitle="Compact invoice rows that keep the list readable without turning into a heavy table."
      onClose={onClose}
    >
      <InvoiceList invoices={invoices} showPaymentButton openModal={openModal} emptyText="No invoice history available yet." />
    </ModalShell>
  );
}

function SettingsModal({ open, settings, onSettingsChange, onClose, showMessage }) {
  const [localSettings, setLocalSettings] = useState(settings);

  useEffect(() => {
    if (open) {
      setLocalSettings(settings);
    }
  }, [open, settings]);

  function handleSubmit(event) {
    event.preventDefault();
    onSettingsChange(localSettings);
    onClose();
    showMessage("Settings saved.");
  }

  return (
    <ModalShell
      open={open}
      large
      title="Settings"
      subtitle="Change appearance and personalize this billing workspace."
      onClose={onClose}
    >
      <form onSubmit={handleSubmit}>
        <section className="settings-section">
          <h4>Appearance</h4>
          <p className="settings-help">Choose how the app should look in daily use. System Default follows your device setting.</p>
          <div className="theme-options" role="radiogroup" aria-label="Appearance mode">
            {[
              ["system", "System Default", "Follow device", "theme-system"],
              ["light", "Light Mode", "Bright counter view", "theme-light"],
              ["dark", "Dark Mode", "Low-light workspace", "theme-dark"]
            ].map(([value, title, copy, className]) => (
              <label key={value} className={`theme-option ${localSettings.appearance === value ? "active" : ""}`}>
                <input
                  type="radio"
                  name="appearance"
                  value={value}
                  checked={localSettings.appearance === value}
                  onChange={() => setLocalSettings((current) => ({ ...current, appearance: value }))}
                />
                <span className={`theme-swatch ${className}`}></span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </label>
            ))}
          </div>
          <label>
            Layout Density
            <select value={localSettings.density} onChange={(event) => setLocalSettings((current) => ({ ...current, density: event.target.value }))}>
              <option value="comfortable">Comfortable</option>
              <option value="compact">Compact</option>
            </select>
          </label>
          <label>
            POS Device Type
            <select value={localSettings.deviceType} onChange={(event) => setLocalSettings((current) => ({ ...current, deviceType: event.target.value }))}>
              <option value="desktop">Desktop POS</option>
              <option value="touch">Touch POS</option>
            </select>
          </label>
        </section>
        <section className="settings-section">
          <h4>Personalize</h4>
          <div className="form-grid">
            <label>
              Business Name
              <input value={localSettings.businessName} onChange={(event) => setLocalSettings((current) => ({ ...current, businessName: event.target.value }))} />
            </label>
            <label>
              Workspace Label
              <input value={localSettings.ownerName} onChange={(event) => setLocalSettings((current) => ({ ...current, ownerName: event.target.value }))} />
            </label>
          </div>
        </section>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Save Settings
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

export default function Modals({ activeModal, customers, invoices, settings, onSettingsChange, openModal, closeModal, onRefresh, showMessage }) {
  const name = activeModal?.name;

  return (
    <>
      <CustomerModal open={name === "customer"} onClose={closeModal} onRefresh={onRefresh} showMessage={showMessage} />
      <InvoiceModal open={name === "invoice"} customers={customers} onClose={closeModal} onRefresh={onRefresh} showMessage={showMessage} />
      <PaymentModal
        open={name === "payment"}
        invoices={invoices}
        selectedInvoiceId={activeModal?.props?.invoiceId}
        onClose={closeModal}
        onRefresh={onRefresh}
        showMessage={showMessage}
      />
      <AllInvoicesModal open={name === "allInvoices"} invoices={invoices} openModal={openModal} onClose={closeModal} />
      <SettingsModal open={name === "settings"} settings={settings} onSettingsChange={onSettingsChange} onClose={closeModal} showMessage={showMessage} />
      <ModalShell open={name === "pos"} large title="CinchPOS" onClose={closeModal}>
        {name === "pos" ? (
          <POSModule customers={customers} invoices={invoices} onRefresh={onRefresh} showMessage={showMessage} onClose={closeModal} embedded />
        ) : null}
      </ModalShell>
    </>
  );
}

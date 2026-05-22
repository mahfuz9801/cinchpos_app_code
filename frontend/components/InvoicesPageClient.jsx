"use client";

import { useCallback, useEffect, useState } from "react";
import { getCustomers, getInvoices } from "@/lib/api";
import DashboardLayout from "./DashboardLayout";
import InvoiceList from "./InvoiceList";

export default function InvoicesPageClient() {
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);

  const refreshAll = useCallback(async () => {
    const [invoiceRows, customerRows] = await Promise.all([getInvoices(), getCustomers()]);
    setInvoices(invoiceRows || []);
    setCustomers(customerRows || []);
  }, []);

  useEffect(() => {
    refreshAll().catch(() => {});
  }, [refreshAll]);

  return (
    <DashboardLayout title="Invoices" customers={customers} invoices={invoices} onRefresh={refreshAll}>
      {({ openModal }) => (
        <section id="invoicesView" className="app-view active" data-title="Invoices">
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2>Invoices</h2>
                <div className="panel-subtitle">Full invoice list with status and payment health.</div>
              </div>
              <button className="button button-primary" type="button" onClick={() => openModal("invoice")}>
                Create Invoice
              </button>
            </div>
            <InvoiceList invoices={invoices} showPaymentButton openModal={openModal} emptyText="No invoice history available yet." />
          </section>
        </section>
      )}
    </DashboardLayout>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { getCustomers, getDashboard, getInvoices, getTrend } from "@/lib/api";
import { todayISO } from "@/lib/format";
import AlertsPanel from "./AlertsPanel";
import DashboardLayout from "./DashboardLayout";
import InvoiceList from "./InvoiceList";
import SalesTrendChart from "./SalesTrendChart";
import SummaryCards from "./SummaryCards";

export default function DashboardPageClient() {
  const [summary, setSummary] = useState(null);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [trend, setTrend] = useState(null);
  const [trendView, setTrendView] = useState("weekly");
  const [customRange, setCustomRange] = useState({ startDate: todayISO(), endDate: todayISO() });

  const loadLists = useCallback(async () => {
    const [dashboard, invoiceRows, customerRows] = await Promise.all([
      getDashboard(),
      getInvoices(),
      getCustomers()
    ]);
    setSummary(dashboard.summary);
    setRecentInvoices(dashboard.recent_invoices || []);
    setAlerts(dashboard.alerts || []);
    setInvoices(invoiceRows || []);
    setCustomers(customerRows || []);
  }, []);

  const loadTrend = useCallback(async (view = trendView, range = customRange) => {
    const trendRows = await getTrend({
      view,
      startDate: view === "custom" ? range.startDate : undefined,
      endDate: view === "custom" ? range.endDate : undefined
    });
    setTrend(trendRows);
  }, [customRange, trendView]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadLists(), loadTrend(trendView, customRange)]);
  }, [customRange, loadLists, loadTrend, trendView]);

  useEffect(() => {
    refreshAll().catch(() => {});
  }, []);

  async function handleTrendViewChange(nextView) {
    setTrendView(nextView);
    if (nextView !== "custom") {
      await loadTrend(nextView, customRange);
    }
  }

  async function handleApplyRange() {
    await loadTrend("custom", customRange);
  }

  return (
    <DashboardLayout title="Dashboard" customers={customers} invoices={invoices} onRefresh={refreshAll}>
      {({ openModal, showMessage }) => (
        <section id="dashboardView" className="app-view active" data-title="Dashboard">
          <section className="quick-strip" aria-label="Quick Actions">
            <div>
              <p className="action-label">Quick Actions</p>
              <h2>Counter-ready billing tools</h2>
            </div>
            <div className="action-group">
              <button className="button button-primary pos-launch" type="button" onClick={() => openModal("pos")}>
                CinchPOS
              </button>
              <button className="button button-secondary" type="button" onClick={() => openModal("invoice")}>
                Create Invoice
              </button>
              <button className="button button-secondary" type="button" onClick={() => openModal("payment")}>
                Record Payment
              </button>
              <button className="button button-secondary" type="button" onClick={() => openModal("customer")}>
                Add Customer
              </button>
            </div>
          </section>

          <SummaryCards summary={summary} />

          <section id="reports" className="dashboard-grid">
            <div>
              <SalesTrendChart
                trend={trend}
                view={trendView}
                customRange={customRange}
                onViewChange={(view) => handleTrendViewChange(view).catch((error) => showMessage(error.message))}
                onRangeChange={setCustomRange}
                onApplyRange={() => handleApplyRange().catch((error) => showMessage(error.message))}
              />

              <section className="panel" id="invoice-list-panel">
                <div className="panel-header">
                  <div>
                    <h2>Recent Invoices</h2>
                    <div className="panel-subtitle">Latest invoice health with payment status.</div>
                  </div>
                  <button className="button button-secondary" type="button" onClick={() => openModal("allInvoices")}>
                    View All
                  </button>
                </div>
                <InvoiceList invoices={recentInvoices.slice(0, 6)} />
              </section>
            </div>

            <AlertsPanel alerts={alerts} />
          </section>
        </section>
      )}
    </DashboardLayout>
  );
}

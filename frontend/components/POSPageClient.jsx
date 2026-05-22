"use client";

import { useCallback, useEffect, useState } from "react";
import { getCustomers, getInvoices } from "@/lib/api";
import DashboardLayout from "./DashboardLayout";
import POSModule from "./POSModule";

export default function POSPageClient() {
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);

  const refreshAll = useCallback(async () => {
    const [customerRows, invoiceRows] = await Promise.all([getCustomers(), getInvoices()]);
    setCustomers(customerRows || []);
    setInvoices(invoiceRows || []);
  }, []);

  useEffect(() => {
    refreshAll().catch(() => {});
  }, [refreshAll]);

  return (
    <DashboardLayout title="CinchPOS" customers={customers} invoices={invoices} onRefresh={refreshAll}>
      {({ showMessage }) => <POSModule customers={customers} invoices={invoices} onRefresh={refreshAll} showMessage={showMessage} />}
    </DashboardLayout>
  );
}

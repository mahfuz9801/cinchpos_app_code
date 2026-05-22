"use client";

import { useCallback, useEffect, useState } from "react";
import { getCustomers, getInvoices } from "@/lib/api";
import DashboardLayout from "./DashboardLayout";
import InventoryModule from "./InventoryModule";

export default function InventoryPageClient() {
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
    <DashboardLayout title="Inventory" customers={customers} invoices={invoices} onRefresh={refreshAll}>
      {({ showMessage }) => <InventoryModule showMessage={showMessage} />}
    </DashboardLayout>
  );
}

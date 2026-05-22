"use client";

import { useCallback, useEffect, useState } from "react";
import { getCustomers, getInvoices } from "@/lib/api";
import CustomerModule from "./CustomerModule";
import DashboardLayout from "./DashboardLayout";

export default function CustomersPageClient() {
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
    <DashboardLayout title="Customer Info" customers={customers} invoices={invoices} onRefresh={refreshAll}>
      {({ openModal }) => <CustomerModule customers={customers} openModal={openModal} />}
    </DashboardLayout>
  );
}

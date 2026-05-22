"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  createCustomer,
  createInvoice,
  getCustomers,
  getDashboard,
  getInvoices,
  getTrend,
  recordPayment,
  updateCustomer
} from "@/lib/api";
import {
  calculateDiscountPercent,
  getInventoryBarcodeLabel,
  getInventoryGSTBreakup,
  getInventoryItemKey,
  getInventoryItemBarcodes,
  getInventoryItemName,
  normalizeInventoryBarcodes
} from "@/lib/inventory";
import {
  cleanText,
  currency,
  escapeHTML,
  formatDate,
  formatIndianPhone,
  invoiceOutstandingAmount,
  invoicePaidAmount,
  maskAccountNumber,
  normalizeKey,
  normalizePhone,
  phonesMatch,
  statusClass,
  todayISO
} from "@/lib/format";
import { flushStoredWrites, readStoredJSON, readStoredValue, writeStoredJSON, writeStoredValue } from "@/lib/storage";
import {
  APP_COMPANY,
  APP_NAME,
  appViews,
  dataTransferConfigs,
  defaultAccount,
  defaultPOSCustomer,
  defaultSettings,
  makeTransferDraftState,
  routeViewMap,
  storageKeys
} from "@/lib/cinchpos/constants";
import {
  addInventoryItemToPOSInstance,
  buildPOSSearchPatch,
  createNextPOSBillInstance,
  deletePOSBillFromInstance,
  findInventoryItemForPOS,
  findInventoryItemsByBarcode,
  findInventoryItemsByBarcodeCandidate,
  findInventoryMatches,
  getPOSBillSummary,
  makeBill,
  makeInitialPOSState,
  makePOSInstance,
  removePOSLineItem,
  updatePOSLineItemsPrice,
  updatePOSLineItemsQuantity
} from "@/lib/cinchpos/pos";
import {
  collectDetectedColumns,
  formatTransferFieldLabel,
  getTransferGuideSteps,
  getTransferSmartNotes,
  getTransferSourceProfile,
  normalizeCustomerImport,
  normalizeExpenseImport,
  normalizeInventoryImport,
  normalizeInvoiceImport,
  normalizePurchaseImport,
  packageRows,
  parseTransferRows,
  readFileAsDataURL,
  readFileAsText,
  summarizeInventoryImport,
  transferSourceProfiles,
} from "@/lib/cinchpos/transfer";
import {
  AppLogo,
  Empty,
  FileAction,
  HeaderSupportMenu,
  HeaderTitle,
  IconSprite,
  InvoiceRow,
  Modal,
  StoreLogo,
  SummaryIcon,
  TrendChart
} from "@/components/cinchpos/SharedUI";

export default function CinchPOSApp({ initialView = "dashboard" }) {
  const resolvedInitialView = routeViewMap[initialView] || initialView || "dashboardView";
  const [activeView, setActiveView] = useState(resolvedInitialView);
  const [renderedViews, setRenderedViews] = useState(() => ({ [resolvedInitialView]: true }));
  const [activeModal, setActiveModal] = useState("");
  const [prefillInvoiceId, setPrefillInvoiceId] = useState("");
  const [message, setMessage] = useState("");
  const [summary, setSummary] = useState(null);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [allInvoices, setAllInvoices] = useState([]);
  const [realInvoices, setRealInvoices] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [trend, setTrend] = useState([]);
  const [trendView, setTrendView] = useState("weekly");
  const [trendStartDate, setTrendStartDate] = useState("");
  const [trendEndDate, setTrendEndDate] = useState("");
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventoryItems, setInventoryItems] = useState([]);
  const [inventoryVisibleCount, setInventoryVisibleCount] = useState(120);
  const [settingsDraft, setSettingsDraft] = useState(defaultSettings);
  const [settingsPanelSection, setSettingsPanelSection] = useState("account");
  const [bankAccount, setBankAccount] = useState(null);
  const [purchaseRecords, setPurchaseRecords] = useState([]);
  const [expenseRecords, setExpenseRecords] = useState([]);
  const [purchaseBills, setPurchaseBills] = useState([]);
  const [storeDocuments, setStoreDocuments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [account, setAccount] = useState(defaultAccount);
  const [posState, setPosState] = useState(makeInitialPOSState);
  const [posNavigationOpen, setPosNavigationOpen] = useState(false);
  const [dataTransferResult, setDataTransferResult] = useState(null);
  const [transferDrafts, setTransferDrafts] = useState(makeTransferDraftState);
  const [transferBusy, setTransferBusy] = useState(() => dataTransferConfigs.reduce((flags, config) => {
    flags[config.type] = false;
    return flags;
  }, {}));
  const [activeTransferGuide, setActiveTransferGuide] = useState("customers");
  const messageTimer = useRef(null);
  const appWorkspaceRef = useRef(null);
  const posModuleContextRef = useRef(null);
  const transferFileRefs = useRef({});
  const transferFiles = useRef({});
  const dashboardRetryTimer = useRef(null);
  const settingsRestoreInputRef = useRef(null);
  const startupViewApplied = useRef(false);

  const showMessage = useCallback((text) => {
    setMessage(text);
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    messageTimer.current = window.setTimeout(() => setMessage(""), 3200);
  }, []);

  useEffect(() => () => {
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    if (dashboardRetryTimer.current) {
      window.clearTimeout(dashboardRetryTimer.current);
    }
  }, []);

  const businessName = settings.businessName || defaultSettings.businessName;
  const ownerName = settings.ownerName || defaultSettings.ownerName;
  const fallbackInitials = businessName.split(/\s+/).map((word) => word.charAt(0)).join("").slice(0, 2).toUpperCase() || "CP";
  const currentTitle = appViews.find((view) => view.id === activeView)?.title || "Dashboard";
  const storeLogoSource = settings.storeLogo || settings.storeLogoUrl || "";
  const currentSummary = summary || {
    monthly_revenue: 0,
    outstanding_payments: 0,
    expenses_total: 0,
    invoice_count: 0,
    net_balance: 0,
    net_balance_direction: "positive"
  };
  const isWorkspaceEmpty = !customers.length && !allInvoices.length && Number(currentSummary.invoice_count || 0) === 0;
  const outstandingInvoices = realInvoices.filter((invoice) => Number(invoice.outstanding || 0) > 0);
  const trendPeak = Math.max(...(trend.length ? trend : [{ value: 0 }]).map((point) => Number(point.value || 0)), 0);
  const trendCaption = {
    daily: "Collections in the last 7 days",
    weekly: "Collections by week over the last 8 weeks",
    monthly: "Collections in the last 6 months",
    custom: trendStartDate && trendEndDate ? `Collections from ${trendStartDate} to ${trendEndDate}` : "Collections in the selected custom range"
  }[trendView] || "Collections by week over the last 8 weeks";
  const navigationViews = appViews.filter((view) => !view.settingsOnly);
  const defaultDueDaysNumber = Math.max(0, Number(settings.defaultDueDays || defaultSettings.defaultDueDays || 0) || 0);
  const defaultDueDate = useMemo(() => {
    const [year, month, day] = todayISO().split("-").map(Number);
    const dueDate = new Date(year, month - 1, day + defaultDueDaysNumber);
    return `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}-${String(dueDate.getDate()).padStart(2, "0")}`;
  }, [defaultDueDaysNumber]);
  const deferredInventorySearch = useDeferredValue(inventorySearch);
  const workspaceStats = useMemo(() => ({
    customers: customers.length,
    invoices: allInvoices.length,
    outstandingInvoices: outstandingInvoices.length,
    inventory: inventoryItems.length,
    lowStock: inventoryItems.filter((item) => Number(item.stock || 0) <= 5).length,
    purchases: purchaseRecords.length,
    purchaseBills: purchaseBills.length,
    expenses: expenseRecords.length,
    employees: employees.length,
    documents: storeDocuments.length
  }), [
    allInvoices.length,
    customers.length,
    employees.length,
    expenseRecords.length,
    inventoryItems,
    outstandingInvoices.length,
    purchaseBills.length,
    purchaseRecords.length,
    storeDocuments.length
  ]);
  const appPlatform = useMemo(() => {
    if (typeof navigator === "undefined") {
      return "Unknown platform";
    }
    return navigator.userAgentData?.platform || navigator.platform || "Unknown platform";
  }, []);
  const isPOSView = activeView === "cinchPOSView";

  function buildClientInvoiceNumber(issuedOn = todayISO()) {
    const prefix = cleanText(settings.invoicePrefix, defaultSettings.invoicePrefix).toUpperCase();
    const datePart = cleanText(issuedOn, todayISO()).replace(/[^0-9]/g, "") || todayISO().replace(/-/g, "");
    const usedNumbers = new Set((allInvoices || []).map((invoice) => normalizeKey(invoice.invoice_number)));
    let suffix = 1;
    let candidate = `${prefix}-${datePart}-${String(suffix).padStart(3, "0")}`;
    while (usedNumbers.has(normalizeKey(candidate))) {
      suffix += 1;
      candidate = `${prefix}-${datePart}-${String(suffix).padStart(3, "0")}`;
    }
    return candidate;
  }

  function findCustomerForInvoice(invoice) {
    const invoiceCustomerId = cleanText(invoice?.customer_id || invoice?.customerId);
    const invoiceCustomerName = cleanText(invoice?.customer_name || invoice?.customerName).toLowerCase();
    return customers.find((customer) => (
      (invoiceCustomerId && String(customer.id) === invoiceCustomerId)
      || (invoiceCustomerName && cleanText(customer.name).toLowerCase() === invoiceCustomerName)
    ));
  }

  function getInvoicePhone(invoice) {
    return cleanText(invoice?.customer_phone || invoice?.customerPhone || findCustomerForInvoice(invoice)?.phone, "Not added");
  }

  function getCustomerInvoiceStats(customer) {
    const customerName = cleanText(customer?.name).toLowerCase();
    const customerInvoices = allInvoices.filter((invoice) => (
      String(invoice.customer_id || invoice.customerId || "") === String(customer.id || "")
      || (customerName && cleanText(invoice.customer_name || invoice.customerName).toLowerCase() === customerName)
    ));
    return {
      count: customerInvoices.length,
      outstanding: customerInvoices.reduce((total, invoice) => total + invoiceOutstandingAmount(invoice), 0)
    };
  }

  useEffect(() => {
    setRenderedViews((current) => (current[activeView] ? current : { ...current, [activeView]: true }));
  }, [activeView]);

  useEffect(() => {
    const storedSettings = { ...defaultSettings, ...readStoredJSON(storageKeys.settings, defaultSettings) };
    if (cleanText(storedSettings.businessName) === APP_NAME) {
      storedSettings.businessName = defaultSettings.businessName;
    }
    setSettings(storedSettings);
    setAccount({ ...defaultAccount, ...readStoredJSON(storageKeys.account, defaultAccount) });
    setInventoryItems(readStoredJSON(storageKeys.inventory, []));
    setBankAccount(readStoredJSON(storageKeys.bank, null));
    setPurchaseRecords(readStoredJSON(storageKeys.purchases, []));
    setExpenseRecords(readStoredJSON(storageKeys.expenses, []));
    setPurchaseBills(readStoredJSON(storageKeys.purchaseBills, []));
    setStoreDocuments(readStoredJSON(storageKeys.documents, []));
    setEmployees(readStoredJSON(storageKeys.employees, []));
    setPosState(readStoredJSON(storageKeys.pos, makeInitialPOSState()));
    setTrendView(readStoredValue(storageKeys.trendView, "weekly"));
    setTrendStartDate(readStoredValue(storageKeys.trendStart, ""));
    setTrendEndDate(readStoredValue(storageKeys.trendEnd, ""));
    setWorkspaceLoaded(true);
  }, []);

  useEffect(() => {
    const flush = () => flushStoredWrites();
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.settings, settings);
    const resolvedAppearance = settings.appearance === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : settings.appearance;
    document.body.dataset.appearance = resolvedAppearance;
    document.body.dataset.appearancePreference = settings.appearance || "system";
    document.body.dataset.deviceType = settings.deviceType || "desktop";
    document.body.dataset.previewWatermark = settings.showPreviewWatermark === false ? "off" : "on";
    document.body.classList.toggle("density-compact", settings.density === "compact");
  }, [settings, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.account, account);
  }, [account, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.inventory, inventoryItems);
  }, [inventoryItems, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.bank, bankAccount);
  }, [bankAccount, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.purchases, purchaseRecords);
  }, [purchaseRecords, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.expenses, expenseRecords);
  }, [expenseRecords, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.purchaseBills, purchaseBills);
  }, [purchaseBills, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.documents, storeDocuments);
  }, [storeDocuments, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.employees, employees);
  }, [employees, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.pos, posState);
  }, [posState, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredValue(storageKeys.trendView, trendView);
    writeStoredValue(storageKeys.trendStart, trendStartDate);
    writeStoredValue(storageKeys.trendEnd, trendEndDate);
  }, [trendEndDate, trendStartDate, trendView, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || startupViewApplied.current) {
      return;
    }
    startupViewApplied.current = true;
    const initialViewKey = routeViewMap[initialView] || initialView || "dashboardView";
    const routeOverridesStartup = initialViewKey !== "dashboardView";
    const preferredView = settings.startupView || defaultSettings.startupView;
    if (!routeOverridesStartup && preferredView && preferredView !== activeView) {
      setActiveView(preferredView);
      setRenderedViews((current) => (current[preferredView] ? current : { ...current, [preferredView]: true }));
    }
  }, [activeView, initialView, settings.startupView, workspaceLoaded]);

  useEffect(() => {
    if (activeModal !== "settings") {
      setSettingsDraft(settings);
    }
  }, [activeModal, settings]);

  const loadDashboard = useCallback(async () => {
    const [dashboard, invoices, customerRows, trendRows] = await Promise.all([
      getDashboard(),
      getInvoices(),
      getCustomers(),
      getTrend({
        view: trendView === "custom" && trendStartDate && trendEndDate ? "custom" : (trendView === "custom" ? "weekly" : trendView),
        startDate: trendView === "custom" ? trendStartDate : undefined,
        endDate: trendView === "custom" ? trendEndDate : undefined
      })
    ]);
    setSummary(dashboard.summary);
    setRecentInvoices(dashboard.recent_invoices || []);
    setAllInvoices(invoices || []);
    setAlerts(dashboard.alerts || []);
    setTrend(trendRows.points || []);
    setRealInvoices(invoices || []);
    setCustomers(customerRows || []);
  }, [trendEndDate, trendStartDate, trendView]);

  useEffect(() => {
    let cancelled = false;

    const attemptLoad = async (attempt = 1) => {
      try {
        await loadDashboard();
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (attempt < 6) {
          const retryDelay = Math.min(3200, 450 + attempt * 450);
          dashboardRetryTimer.current = window.setTimeout(() => {
            dashboardRetryTimer.current = null;
            attemptLoad(attempt + 1);
          }, retryDelay);
          return;
        }
        showMessage(error.message);
      }
    };

    if (dashboardRetryTimer.current) {
      window.clearTimeout(dashboardRetryTimer.current);
      dashboardRetryTimer.current = null;
    }

    attemptLoad();

    return () => {
      cancelled = true;
      if (dashboardRetryTimer.current) {
        window.clearTimeout(dashboardRetryTimer.current);
        dashboardRetryTimer.current = null;
      }
    };
  }, [loadDashboard, showMessage]);

  function switchView(viewId) {
    setActiveView(viewId);
    setPosNavigationOpen(false);
    appWorkspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openModal(name, invoiceId = "") {
    setPrefillInvoiceId(invoiceId || "");
    if (name === "settings") {
      setSettingsDraft(settings);
      setSettingsPanelSection("account");
    }
    setActiveModal(name);
  }

  function closeModal() {
    setActiveModal("");
    setPrefillInvoiceId("");
  }

  async function refreshTrend(nextView = trendView) {
    if (nextView === "custom" && (!trendStartDate || !trendEndDate)) {
      showMessage("Choose a start and end date for the custom range.");
      return;
    }
    const trendRows = await getTrend({
      view: nextView,
      startDate: nextView === "custom" ? trendStartDate : undefined,
      endDate: nextView === "custom" ? trendEndDate : undefined
    });
    setTrend(trendRows.points || []);
  }

  function findCustomerByPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return null;
    }
    return customers.find((customer) => phonesMatch(customer.phone, normalizedPhone)) || null;
  }

  function getPOSInstance(formId) {
    return posState[formId] || makePOSInstance(formId);
  }

  function getActiveBill(formId) {
    const instance = getPOSInstance(formId);
    return instance.bills.find((bill) => bill.id === instance.activeBillId) || instance.bills[0] || makeBill(formId, 1);
  }

  function updatePOSInstance(formId, updater) {
    setPosState((current) => {
      const instance = current[formId] || makePOSInstance(formId);
      return { ...current, [formId]: updater(instance) };
    });
  }

  function updateActiveBill(formId, updater) {
    updatePOSInstance(formId, (instance) => ({
      ...instance,
      bills: instance.bills.map((bill) => (
        bill.id === instance.activeBillId ? updater(bill) : bill
      ))
    }));
  }

  function updatePOSCustomer(formId, patch) {
    updateActiveBill(formId, (bill) => ({
      ...bill,
      customer: { ...defaultPOSCustomer, ...(bill.customer || {}), ...patch }
    }));
  }

  function handlePOSPhone(formId, value) {
    const phone = normalizePhone(value).slice(-10);
    const matchedCustomer = findCustomerByPhone(phone);
    updatePOSCustomer(formId, {
      phone,
      customerId: phone.length === 10 && matchedCustomer ? String(matchedCustomer.id) : "",
      name: phone.length === 10 && matchedCustomer ? matchedCustomer.name : getActiveBill(formId).customer?.name || ""
    });
  }

  function getCustomerStatus(customer) {
    const phone = normalizePhone(customer.phone).slice(-10);
    if (!phone) {
      return "";
    }
    if (phone.length !== 10) {
      return "Phone number must be exactly 10 digits.";
    }
    const matchedCustomer = findCustomerByPhone(phone);
    if (matchedCustomer) {
      return `Registered customer found: ${matchedCustomer.name}.`;
    }
    return "New customer. Enter the name once and CinchPOS will save it during billing.";
  }

  function updatePOSItemSearch(formId, updater, options = {}) {
    updatePOSInstance(formId, (instance) => {
      const currentValue = instance.itemQuery || "";
      const nextValue = typeof updater === "function" ? updater(currentValue) : updater;
      const exactBarcodeMatches = findInventoryItemsByBarcode(inventoryItems, nextValue);
      if (options.autoAdd !== false && exactBarcodeMatches.length === 1) {
        return addInventoryItemToPOSInstance(instance, exactBarcodeMatches[0]);
      }
      return {
        ...instance,
        ...buildPOSSearchPatch(inventoryItems, String(nextValue || ""))
      };
    });
  }

  function handlePOSItemSearch(formId, value) {
    updatePOSItemSearch(formId, value, { autoAdd: false });
  }

  function handlePOSSearchEnter(formId, value) {
    const query = cleanText(value);
    if (!query) {
      addPOSItem(formId, null, { query, silent: true });
      return;
    }
    const barcodeMatches = findInventoryItemsByBarcode(inventoryItems, query);
    if (barcodeMatches.length === 1) {
      addPOSItem(formId, barcodeMatches[0], { query });
      return;
    }
    addPOSItem(formId, null, { query });
  }

  function addPOSItem(formId, selectedItem = null, options = {}) {
    const instance = getPOSInstance(formId);
    const query = options.query !== undefined ? String(options.query || "") : instance.itemQuery;
    const barcodeMatches = selectedItem ? [] : findInventoryItemsByBarcode(inventoryItems, query);
    if (!selectedItem && barcodeMatches.length > 1) {
      updatePOSInstance(formId, (current) => ({
        ...current,
        ...buildPOSSearchPatch(inventoryItems, query)
      }));
      if (!options.silent) {
        showMessage("This barcode is linked to multiple products. Choose the correct item from the dropdown.");
      }
      return;
    }
    const fallbackMatch = instance.matchMode === "barcode" ? null : instance.matches?.[0];
    const liveFallbackMatch = options.query !== undefined ? findInventoryMatches(inventoryItems, query).slice(0, 1)[0] : fallbackMatch;
    const item = selectedItem
      || barcodeMatches[0]
      || findInventoryItemForPOS(inventoryItems, query)
      || liveFallbackMatch;
    if (!item) {
      if (!options.silent) {
        showMessage(instance.matchMode === "barcode"
          ? "This barcode is linked to multiple products. Choose the correct item from the dropdown."
          : "Search an inventory item by name or barcode before adding it to the bill.");
      }
      return;
    }
    updatePOSInstance(formId, (current) => addInventoryItemToPOSInstance(current, item));
  }

  function updatePOSQuantity(formId, itemId, value) {
    updateActiveBill(formId, (bill) => ({
      ...bill,
      items: updatePOSLineItemsQuantity(bill.items, itemId, value)
    }));
  }

  function updatePOSPrice(formId, itemId, field, value) {
    updateActiveBill(formId, (bill) => ({
      ...bill,
      items: updatePOSLineItemsPrice(bill.items, itemId, field, value)
    }));
  }

  function removePOSItem(formId, itemId) {
    updateActiveBill(formId, (bill) => ({
      ...bill,
      items: removePOSLineItem(bill.items, itemId)
    }));
  }

  function createNewPOSBill(formId) {
    updatePOSInstance(formId, (instance) => createNextPOSBillInstance(instance, formId));
    showMessage("New bill started. Previous bills are kept aside.");
  }

  function switchPOSBill(formId, billId) {
    updatePOSInstance(formId, (instance) => ({ ...instance, activeBillId: billId, itemQuery: "", matches: [], matchMode: "", matchMessage: "" }));
  }

  function deletePOSBill(formId, billId) {
    const { didDelete, deletedBill } = deletePOSBillFromInstance(getPOSInstance(formId), billId);
    if (!didDelete) {
      showMessage("Keep at least one bill open.");
      return;
    }
    updatePOSInstance(formId, (current) => deletePOSBillFromInstance(current, billId).nextInstance);
    showMessage(`${deletedBill?.label || "Bill"} deleted.`);
  }

  function resetActivePOSBill(formId) {
    updateActiveBill(formId, (bill) => ({ ...bill, items: [], customer: { ...defaultPOSCustomer } }));
  }

  async function ensurePOSCustomer(formId) {
    const customer = getActiveBill(formId).customer || defaultPOSCustomer;
    const phone = normalizePhone(customer.phone).slice(-10);
    const name = cleanText(customer.name);
    const existingCustomer = findCustomerByPhone(phone);
    if (existingCustomer) {
      updatePOSCustomer(formId, { customerId: String(existingCustomer.id), name: existingCustomer.name });
      return existingCustomer.id;
    }
    if (phone.length !== 10) {
      throw new Error("Enter a valid 10 digit Indian customer phone number.");
    }
    if (!name) {
      throw new Error("Enter the customer name before POS billing.");
    }
    const newCustomer = await createCustomer({ name, phone: `+91${phone}`, email: "" });
    setCustomers((current) => [...current, newCustomer].sort((first, second) => first.name.localeCompare(second.name)));
    updatePOSCustomer(formId, { customerId: String(newCustomer.id) });
    return newCustomer.id;
  }

  function printPOSBill(payload, printWindow = null) {
    const targetWindow = printWindow || window.open("", "_blank", "width=420,height=720");
    if (!targetWindow) {
      showMessage("Bill saved. Allow pop-ups to print the bill.");
      return;
    }
    const printPageWidth = payload.paperSize === "58mm" ? "58mm" : payload.paperSize === "A4" ? "210mm" : "80mm";
    const rows = payload.items.map((item) => `
      <tr>
        <td>${item.serial}</td>
        <td>${escapeHTML(item.itemName)}<span>${escapeHTML(item.barcode || "")}</span></td>
        <td>${item.quantity}</td>
        <td>${currency(item.mrp)}</td>
        <td>${currency(item.inclusivePrice)}</td>
        <td>${item.discountPercent.toFixed(2)}%</td>
        <td>${currency(item.taxableValue)}</td>
        <td>${currency(item.gstAmount * item.quantity)}<span>${item.gstRate}%</span></td>
        <td>${currency(item.lineTotal)}</td>
      </tr>
    `).join("");
    const logoMarkup = payload.logo ? `<img class="print-logo" src="${payload.logo}" alt="Store logo">` : "";
    const safeInvoiceNumber = escapeHTML(payload.invoiceNumber || "CinchPOS Bill");
    const safeBusinessName = escapeHTML(payload.businessName);
    const safeOwnerName = escapeHTML(payload.ownerName || "");
    const safeBusinessPhone = escapeHTML(payload.businessPhone || "");
    const safeBusinessEmail = escapeHTML(payload.businessEmail || "");
    const safeBusinessAddress = escapeHTML(payload.businessAddress || "").replace(/\n/g, "<br>");
    const safeGstin = escapeHTML(payload.gstin || "");
    const safeFooter = escapeHTML(payload.printFooter || "").replace(/\n/g, "<br>");
    const safeDate = escapeHTML(payload.date);
    const safeCustomerName = escapeHTML(payload.customerName);
    const safeCustomerPhone = escapeHTML(payload.customerPhone || "");
    const safePaymentMethod = escapeHTML(payload.paymentMethod);
    const safePaymentType = escapeHTML(payload.paymentType);
    const businessContact = [payload.businessPhone ? safeBusinessPhone : "", payload.businessEmail ? safeBusinessEmail : ""].filter(Boolean).join(" | ");
    targetWindow.document.open();
    targetWindow.document.write(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>${safeInvoiceNumber}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 12px; color: #111; font-family: Arial, sans-serif; font-size: 11px; }
          .print-head { display: grid; justify-items: center; gap: 4px; margin-bottom: 10px; text-align: center; }
          .print-logo { width: 52px; height: 52px; object-fit: contain; }
          h1 { margin: 0; font-size: 16px; font-weight: 700; }
          p { margin: 0; }
          .print-meta { display: grid; gap: 3px; margin: 8px 0; padding: 8px 0; border-top: 1px dashed #777; border-bottom: 1px dashed #777; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: 4px 3px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
          th { font-size: 9px; font-weight: 700; }
          td span { display: block; color: #555; font-size: 9px; }
          .totals { display: grid; gap: 4px; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #777; }
          .totals div { display: flex; justify-content: space-between; gap: 10px; }
          .grand { font-size: 14px; font-weight: 700; }
          .print-footer { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #777; text-align: center; color: #444; font-size: 10px; }
          @media print { body { width: ${printPageWidth}; } }
        </style>
      </head>
      <body>
        <div class="print-head">${logoMarkup}<h1>${safeBusinessName}</h1>${payload.ownerName ? `<p>${safeOwnerName}</p>` : ""}${businessContact ? `<p>${businessContact}</p>` : ""}${payload.businessAddress ? `<p>${safeBusinessAddress}</p>` : ""}${payload.gstin ? `<p>GSTIN: ${safeGstin}</p>` : ""}</div>
        <div class="print-meta">
          <p>Bill: ${safeInvoiceNumber}</p>
          <p>Date: ${safeDate}</p>
          <p>Customer: ${safeCustomerName} ${payload.customerPhone ? `(${safeCustomerPhone})` : ""}</p>
          <p>Payment: ${safePaymentMethod} | ${safePaymentType}</p>
        </div>
        <table>
          <thead><tr><th>No.</th><th>Item</th><th>Qty</th><th>MRP</th><th>SP</th><th>Disc</th><th>Rate</th><th>GST</th><th>Total</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="totals">
          <div><span>Items</span><span>${payload.summary.quantity}</span></div>
          <div><span>Taxable</span><span>${currency(payload.summary.subtotal)}</span></div>
          <div><span>CGST</span><span>${currency(payload.summary.cgst)}</span></div>
          <div><span>SGST</span><span>${currency(payload.summary.sgst)}</span></div>
          <div><span>Paid</span><span>${currency(payload.paidAmount)}</span></div>
          <div><span>Unpaid</span><span>${currency(payload.unpaidAmount)}</span></div>
          <div class="grand"><span>Grand Total</span><span>${currency(payload.summary.total)}</span></div>
        </div>
        ${payload.printFooter ? `<div class="print-footer">${safeFooter}</div>` : ""}
      </body>
      </html>
    `);
    targetWindow.document.close();
    setTimeout(() => {
      targetWindow.focus();
      targetWindow.print();
    }, 250);
  }

  async function submitPOSBilling(formId, { printAfter = false, closePOSModal = false } = {}) {
    const bill = getActiveBill(formId);
    const items = bill.items || [];
    const customer = bill.customer || defaultPOSCustomer;
    const summaryRows = getPOSBillSummary(items);
    const paymentType = customer.paymentType === "partial" ? "partial" : "full";
    const partialAmount = Number(customer.partialAmount || 0);
    const paidAmount = paymentType === "partial"
      ? Math.min(summaryRows.total, Math.max(0, Number.isFinite(partialAmount) ? partialAmount : 0))
      : summaryRows.total;
    const unpaidAmount = Math.max(0, summaryRows.total - paidAmount);
    const issuedOn = todayISO();
    let printWindow = null;

    if (!items.length) {
      showMessage("Add at least one inventory item to the bill.");
      return;
    }
    if (summaryRows.total <= 0) {
      showMessage("POS billing total must be greater than zero.");
      return;
    }
    if (printAfter) {
      printWindow = window.open("", "_blank", "width=420,height=720");
    }

    try {
      const customerId = await ensurePOSCustomer(formId);
      const invoice = await createInvoice({
        customer_id: customerId,
        invoice_number: buildClientInvoiceNumber(issuedOn),
        amount: summaryRows.total,
        issued_on: issuedOn,
        due_on: defaultDueDate,
        notes: [
          cleanText(settings.invoiceNotes),
          "CinchPOS bill",
          ...items.map((item) => `${item.itemName}${item.barcode ? ` (${item.barcode})` : ""} x${item.quantity} @ ${currency(item.inclusivePrice)}`),
          `Taxable: ${currency(summaryRows.subtotal)}`,
          `CGST: ${currency(summaryRows.cgst)}`,
          `SGST: ${currency(summaryRows.sgst)}`,
          `Payment: ${paymentType === "partial" ? "Partial payment" : "Full payment"}`,
          unpaidAmount > 0 ? `Unpaid: ${currency(unpaidAmount)}` : ""
        ].filter(Boolean).join(" | ")
      });
      const printPayload = {
        businessName,
        ownerName,
        businessPhone: settings.businessPhone || "",
        businessEmail: settings.businessEmail || "",
        businessAddress: settings.businessAddress || "",
        gstin: settings.gstin || "",
        logo: settings.printShopLogoOnBill && settings.printPaperSize !== "A4" ? (settings.storeLogo || settings.storeLogoUrl || "") : "",
        paperSize: settings.printPaperSize || defaultSettings.printPaperSize,
        printFooter: settings.printFooter || "",
        invoiceNumber: invoice.invoice_number || "",
        date: issuedOn,
        customerName: cleanText(customer.name, "Walk-in Customer"),
        customerPhone: customer.phone ? formatIndianPhone(customer.phone) : "",
        paymentMethod: customer.paymentMethod || "Cash",
        paymentType: paymentType === "partial" ? "Partial Payment" : "Full Payment",
        paidAmount,
        unpaidAmount,
        summary: { ...summaryRows },
        items: items.map((item, index) => ({
          serial: index + 1,
          itemName: item.itemName,
          barcode: item.barcode,
          quantity: Number(item.quantity || 1),
          mrp: Number(item.mrp || 0),
          inclusivePrice: Number(item.inclusivePrice || 0),
          discountPercent: Number(item.discountPercent || 0),
          taxableValue: Number(item.taxableValue || 0),
          gstRate: Number(item.gstRate || 0),
          gstAmount: Number(item.gstAmount || 0),
          lineTotal: Number(item.inclusivePrice || 0) * Number(item.quantity || 1)
        }))
      };
      if (paidAmount > 0) {
        await recordPayment({
          invoice_id: invoice.id,
          amount: paidAmount,
          paid_on: issuedOn,
          method: customer.paymentMethod,
          notes: paymentType === "partial" ? `Partial payment from CinchPOS billing. Unpaid: ${currency(unpaidAmount)}.` : "Paid from CinchPOS billing."
        });
      }
      resetActivePOSBill(formId);
      await loadDashboard();
      if (closePOSModal) {
        closeModal();
      }
      if (printAfter) {
        printPOSBill(printPayload, printWindow);
      }
      showMessage(unpaidAmount > 0 ? `POS billing completed. Unpaid amount: ${currency(unpaidAmount)}.` : "POS billing completed.");
    } catch (error) {
      if (printWindow && !printWindow.closed) {
        printWindow.close();
      }
      showMessage(error.message);
    }
  }

  async function submitCustomer(event) {
    event.preventDefault();
    try {
      await createCustomer(Object.fromEntries(new FormData(event.currentTarget).entries()));
      event.currentTarget.reset();
      await loadDashboard();
      closeModal();
      showMessage("Customer saved.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  async function submitInvoice(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const issuedOn = cleanText(data.issued_on, todayISO());
    const dueOn = cleanText(data.due_on, defaultDueDate);
    const invoiceNumber = cleanText(data.invoice_number) || buildClientInvoiceNumber(issuedOn);
    const invoiceNotes = cleanText(data.notes, settings.invoiceNotes);
    const invoiceAmount = Number(data.amount || 0);
    const paymentType = cleanText(data.payment_type, "pending");
    const paymentAmount = paymentType === "full"
      ? invoiceAmount
      : (paymentType === "partial" ? Math.min(invoiceAmount, Math.max(0, Number(data.payment_amount || 0))) : 0);
    try {
      const invoice = await createInvoice({
        customer_id: data.customer_id,
        invoice_number: invoiceNumber,
        amount: data.amount,
        issued_on: issuedOn,
        due_on: dueOn,
        notes: invoiceNotes
      });
      if (paymentAmount > 0) {
        await recordPayment({
          invoice_id: invoice.id,
          amount: paymentAmount,
          paid_on: issuedOn || todayISO(),
          method: cleanText(data.payment_method, "Cash"),
          notes: paymentType === "partial" ? "Partial payment recorded with invoice." : "Full payment recorded with invoice."
        });
      }
      form.reset();
      await loadDashboard();
      closeModal();
      showMessage(paymentAmount > 0 ? "Invoice created and payment recorded." : "Invoice created.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  async function submitPayment(event) {
    event.preventDefault();
    try {
      await recordPayment(Object.fromEntries(new FormData(event.currentTarget).entries()));
      event.currentTarget.reset();
      await loadDashboard();
      closeModal();
      showMessage("Payment recorded.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  function clearInventoryItems() {
    if (!window.confirm("Clear all saved inventory items from this device workspace before a fresh import? Customers, invoices, and the other modules will stay untouched.")) {
      return;
    }
    setInventoryItems([]);
    setInventorySearch("");
    setInventoryVisibleCount(120);
    showMessage("Saved inventory cleared.");
  }

  function submitPurchase(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setPurchaseRecords((current) => [{
      id: String(Date.now()),
      supplier: cleanText(data.supplier),
      item: cleanText(data.item),
      billNumber: cleanText(data.bill_number),
      purchaseDate: data.purchase_date || todayISO(),
      amount: Number(data.amount || 0),
      paymentStatus: cleanText(data.payment_status, "Pending"),
      notes: cleanText(data.notes),
      createdAt: new Date().toISOString()
    }, ...current]);
    form.reset();
    form.elements.purchase_date.value = todayISO();
    showMessage("Purchase saved.");
  }

  function submitExpense(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setExpenseRecords((current) => [{
      id: String(Date.now()),
      category: cleanText(data.category, "Other"),
      paidTo: cleanText(data.paid_to),
      expenseDate: data.expense_date || todayISO(),
      amount: Number(data.amount || 0),
      paymentMode: cleanText(data.payment_mode, "Cash"),
      notes: cleanText(data.notes),
      createdAt: new Date().toISOString()
    }, ...current]);
    form.reset();
    form.elements.expense_date.value = todayISO();
    showMessage("Expense saved.");
  }

  async function submitPurchaseBill(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const file = form.elements.bill_file.files[0];
    try {
      const fileData = await readFileAsDataURL(file);
      setPurchaseBills((current) => [{
        id: String(Date.now()),
        supplier: cleanText(data.supplier),
        billNumber: cleanText(data.bill_number),
        billDate: data.bill_date || todayISO(),
        amount: Number(data.amount || 0),
        gstAmount: Number(data.gst_amount || 0),
        fileName: file ? file.name : "",
        fileData,
        createdAt: new Date().toISOString()
      }, ...current]);
      form.reset();
      form.elements.bill_date.value = todayISO();
      showMessage("Purchase bill saved.");
    } catch (error) {
      showMessage(error.message || "Could not save the purchase bill.");
    }
  }

  function submitBank(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    setBankAccount({
      accountHolder: cleanText(data.account_holder),
      bankName: cleanText(data.bank_name),
      accountNumber: cleanText(data.account_number),
      ifsc: cleanText(data.ifsc).toUpperCase(),
      upiId: cleanText(data.upi_id),
      branch: cleanText(data.branch),
      linkedAt: new Date().toISOString()
    });
    showMessage("Bank account linked.");
  }

  async function submitDocument(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const file = form.elements.document_file.files[0];
    try {
      const fileData = await readFileAsDataURL(file);
      setStoreDocuments((current) => [{
        id: String(Date.now()),
        documentType: cleanText(data.document_type, "Other Paper"),
        title: cleanText(data.title),
        documentNumber: cleanText(data.document_number),
        issueDate: data.issue_date || "",
        expiryDate: data.expiry_date || "",
        fileName: file ? file.name : "",
        fileData,
        notes: cleanText(data.notes),
        createdAt: new Date().toISOString()
      }, ...current]);
      form.reset();
      showMessage("Document saved.");
    } catch (error) {
      showMessage(error.message || "Could not save the document.");
    }
  }

  function submitEmployee(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    setEmployees((current) => [{
      id: String(Date.now()),
      name: cleanText(data.name),
      role: cleanText(data.role, "Counter Staff"),
      phone: cleanText(data.phone),
      status: cleanText(data.status, "Active"),
      createdAt: new Date().toISOString()
    }, ...current]);
    form.reset();
    showMessage("Employee saved.");
  }

  function markEmployeeAttendance(employeeId, attendanceStatus) {
    setEmployees((current) => current.map((employee) => {
      if (employee.id !== employeeId) {
        return employee;
      }
      const remainingAttendance = (employee.attendance || []).filter((entry) => entry.date !== todayISO());
      return {
        ...employee,
        attendance: [
          { date: todayISO(), status: attendanceStatus, markedAt: new Date().toISOString() },
          ...remainingAttendance
        ]
      };
    }));
    showMessage(`Attendance marked ${attendanceStatus}.`);
  }

  function getTransferConfig(type) {
    return dataTransferConfigs.find((config) => config.type === type) || dataTransferConfigs[0];
  }

  function updateTransferDraft(type, patch) {
    setTransferDrafts((current) => ({
      ...current,
      [type]: {
        ...(current[type] || makeTransferDraftState()[type]),
        ...patch
      }
    }));
  }

  function resetTransferDraft(type, { keepSourceSoftware = false } = {}) {
    setTransferDrafts((current) => ({
      ...current,
      [type]: {
        sourceProfile: keepSourceSoftware ? current[type]?.sourceProfile || "generic" : "generic",
        sourceSoftware: keepSourceSoftware ? current[type]?.sourceSoftware || "" : "",
        transferText: "",
        preview: null,
        fileName: ""
      }
    }));
    transferFiles.current[type] = null;
    if (transferFileRefs.current[type]) {
      transferFileRefs.current[type].value = "";
    }
  }

  function findTransferCustomerMatch(candidate, collection = customers) {
    const candidateName = cleanText(candidate?.name || candidate?.customerName).toLowerCase();
    const candidatePhone = candidate?.phone || candidate?.customerPhone;
    return collection.find((customer) => (
      (candidatePhone && phonesMatch(customer.phone, candidatePhone))
      || (candidateName && cleanText(customer.name).toLowerCase() === candidateName)
    ));
  }

  function registerInventoryLookupItem(lookup, item) {
    if (!lookup || !item) {
      return;
    }
    const existingBarcodes = getInventoryItemBarcodes(item).map(normalizeKey).filter(Boolean);
    const existingName = normalizeKey(getInventoryItemName(item));
    const existingSourceItemId = normalizeKey(item?.sourceItemId);
    const existingSourceItemCode = normalizeKey(item?.sourceItemCode);
    existingBarcodes.forEach((barcode) => lookup.barcodes.set(barcode, item));
    if (existingName) {
      lookup.names.set(existingName, item);
      if (!existingBarcodes.length) {
        lookup.legacyNames.set(existingName, item);
      }
    }
    if (existingSourceItemId) {
      lookup.sourceIds.set(existingSourceItemId, item);
    }
    if (existingSourceItemCode) {
      lookup.sourceCodes.set(existingSourceItemCode, item);
    }
  }

  function buildInventoryLookup(collection = inventoryItems) {
    const lookup = {
      barcodes: new Map(),
      names: new Map(),
      sourceIds: new Map(),
      sourceCodes: new Map(),
      legacyNames: new Map()
    };
    collection.forEach((item) => registerInventoryLookupItem(lookup, item));
    return lookup;
  }

  function findExistingInventoryMatch(item, collection = inventoryItems, lookup = null) {
    const incomingBarcodes = getInventoryItemBarcodes(item).map(normalizeKey).filter(Boolean);
    const incomingName = normalizeKey(getInventoryItemName(item));
    const incomingSourceItemId = normalizeKey(item?.sourceItemId);
    const incomingSourceItemCode = normalizeKey(item?.sourceItemCode);
    const effectiveLookup = lookup || buildInventoryLookup(collection);

    for (const barcode of incomingBarcodes) {
      const matchedBarcodeItem = effectiveLookup.barcodes.get(barcode);
      if (matchedBarcodeItem) {
        return matchedBarcodeItem;
      }
    }
    if (incomingName && effectiveLookup.names.has(incomingName)) {
      return effectiveLookup.names.get(incomingName);
    }
    if (incomingSourceItemId) {
      if (effectiveLookup.sourceIds.has(incomingSourceItemId)) {
        return effectiveLookup.sourceIds.get(incomingSourceItemId);
      }
      if (effectiveLookup.legacyNames.has(incomingSourceItemId)) {
        return effectiveLookup.legacyNames.get(incomingSourceItemId);
      }
    }
    if (incomingSourceItemCode) {
      if (effectiveLookup.sourceCodes.has(incomingSourceItemCode)) {
        return effectiveLookup.sourceCodes.get(incomingSourceItemCode);
      }
      if (effectiveLookup.barcodes.has(incomingSourceItemCode)) {
        return effectiveLookup.barcodes.get(incomingSourceItemCode);
      }
    }
    return null;
  }

  function buildTransferCustomerUpdatePayload(existingCustomer, importedCustomer) {
    if (!existingCustomer) {
      return null;
    }
    const nextName = cleanText(importedCustomer?.name || importedCustomer?.customerName, cleanText(existingCustomer.name));
    const nextEmail = cleanText(importedCustomer?.email || importedCustomer?.customerEmail, cleanText(existingCustomer.email));
    const nextPhone = cleanText(importedCustomer?.phone || importedCustomer?.customerPhone, cleanText(existingCustomer.phone));
    const currentName = cleanText(existingCustomer.name);
    const currentEmail = cleanText(existingCustomer.email);
    const currentPhone = cleanText(existingCustomer.phone);
    const phoneChanged = normalizePhone(currentPhone) !== normalizePhone(nextPhone);
    const changed = nextName !== currentName || nextEmail !== currentEmail || phoneChanged;

    if (!changed || !nextName) {
      return null;
    }

    return {
      name: nextName,
      email: nextEmail,
      phone: nextPhone
    };
  }

  function replaceKnownCustomerRecord(collection, updatedCustomer) {
    return collection.map((customer) => (
      String(customer.id || "") === String(updatedCustomer.id || "")
        ? updatedCustomer
        : customer
    ));
  }

  function hasInventoryImportData(item) {
    return Boolean(item?.itemName && (item.hasInclusivePriceValue || item.hasMrpValue));
  }

  function mergeImportedInventoryItem(existingItem, importedItem) {
    const mergedBarcodes = normalizeInventoryBarcodes([
      ...getInventoryItemBarcodes(existingItem),
      ...importedItem.barcodes
    ]);
    const nextInclusivePrice = importedItem.hasInclusivePriceValue
      ? Number(importedItem.inclusivePrice || 0)
      : Number(existingItem.inclusivePrice || 0);
    const nextMrp = importedItem.hasMrpValue
      ? Number(importedItem.mrp || 0)
      : Number(existingItem.mrp || 0);
    const nextGstRate = importedItem.hasGstRateValue
      ? Number(importedItem.gstRate || 0)
      : Number(existingItem.gstRate || 0);
    const recalcPricing = importedItem.hasInclusivePriceValue || importedItem.hasMrpValue || importedItem.hasGstRateValue;
    const breakup = getInventoryGSTBreakup(nextInclusivePrice, nextGstRate);

    return {
      ...existingItem,
      itemName: importedItem.itemName || existingItem.itemName,
      sourceItemId: importedItem.sourceItemId || existingItem.sourceItemId || "",
      sourceItemCode: importedItem.sourceItemCode || existingItem.sourceItemCode || "",
      barcode: mergedBarcodes[0] || existingItem.barcode || "",
      barcodes: mergedBarcodes,
      category: importedItem.hasCategoryValue ? importedItem.category : (existingItem.category || ""),
      hsn: importedItem.hasHsnValue ? importedItem.hsn : (existingItem.hsn || ""),
      manufacturingDate: importedItem.hasManufacturingDateValue ? importedItem.manufacturingDate : (existingItem.manufacturingDate || ""),
      expiryDate: importedItem.hasExpiryDateValue ? importedItem.expiryDate : (existingItem.expiryDate || ""),
      stock: importedItem.hasStockValue ? Number(importedItem.stock || 0) : Number(existingItem.stock || 0),
      unit: importedItem.hasUnitValue ? importedItem.unit : (existingItem.unit || "pcs"),
      mrp: nextMrp,
      inclusivePrice: nextInclusivePrice,
      discountPercent: recalcPricing ? calculateDiscountPercent(nextMrp, nextInclusivePrice) : Number(existingItem.discountPercent || 0),
      gstRate: nextGstRate,
      taxableValue: recalcPricing ? Number(breakup.taxableValue.toFixed(2)) : Number(existingItem.taxableValue || 0),
      cgst: recalcPricing ? Number(breakup.cgst.toFixed(2)) : Number(existingItem.cgst || 0),
      sgst: recalcPricing ? Number(breakup.sgst.toFixed(2)) : Number(existingItem.sgst || 0),
      gstAmount: recalcPricing ? Number(breakup.gstAmount.toFixed(2)) : Number(existingItem.gstAmount || 0)
    };
  }

  function stripInventoryImportFlags(item) {
    const {
      hasStockValue,
      hasMrpValue,
      hasInclusivePriceValue,
      hasGstRateValue,
      hasCategoryValue,
      hasHsnValue,
      hasUnitValue,
      hasManufacturingDateValue,
      hasExpiryDateValue,
      ...cleanItem
    } = item || {};
    return cleanItem;
  }

  async function readTransferDraft(type) {
    const draft = transferDrafts[type] || {};
    const file = transferFiles.current[type] || transferFileRefs.current[type]?.files?.[0] || null;
    const content = file ? await readFileAsText(file) : cleanText(draft.transferText);
    const sourceProfile = cleanText(draft.sourceProfile, "generic");
    const sourceProfileInfo = getTransferSourceProfile(draft.sourceSoftware, sourceProfile);
    const sourceSoftware = cleanText(draft.sourceSoftware, sourceProfileInfo.id === "generic" ? "" : sourceProfileInfo.label);
    return {
      content: String(content || ""),
      fileName: file?.name || draft.fileName || "",
      sourceSoftware,
      sourceProfile,
      file
    };
  }

  function buildImportedInvoiceNumber(proposedNumber, usedNumbers, index) {
    const prefix = cleanText(settings.invoicePrefix, defaultSettings.invoicePrefix).toUpperCase();
    const baseNumber = cleanText(proposedNumber) || `${prefix}-IMP-${String(index + 1).padStart(4, "0")}`;
    let candidate = baseNumber;
    let counter = 1;
    while (usedNumbers.has(normalizeKey(candidate))) {
      candidate = `${baseNumber}-${counter}`;
      counter += 1;
    }
    usedNumbers.add(normalizeKey(candidate));
    return candidate;
  }

  function prepareTransferPreview(type, packageData, parsedRows, sourceSoftware, sourceProfile, fileName = "") {
    const config = getTransferConfig(type);
    const rows = packageData?.[type] || (Array.isArray(parsedRows) ? parsedRows : []);
    const preview = {
      type,
      title: config.title,
      targetLabel: config.targetLabel,
      sourceSoftware,
      fileName,
      totalRows: rows.length,
      readyRows: 0,
      issueRows: 0,
      createCount: 0,
      updateCount: 0,
      mergeCount: 0,
      renamedInvoices: 0,
      detectedFields: collectDetectedColumns(rows),
      sampleRows: [],
      warnings: [],
      smartNotes: getTransferSmartNotes(type, sourceSoftware, sourceProfile, config.smartNotes),
      guideSteps: getTransferGuideSteps(type, sourceSoftware, sourceProfile)
    };

    const addWarning = (message) => {
      if (preview.warnings.length < 4 && !preview.warnings.includes(message)) {
        preview.warnings.push(message);
      }
    };

    const addSample = (sample) => {
      if (preview.sampleRows.length < 3) {
        preview.sampleRows.push(sample);
      }
    };

    if (type === "customers") {
      rows.forEach((row, index) => {
        const customer = normalizeCustomerImport(row);
        const hasCoreData = customer.name || customer.phone || customer.email;
        if (!hasCoreData) {
          preview.issueRows += 1;
          addWarning(`Row ${index + 2} is missing customer details.`);
          return;
        }
        preview.readyRows += 1;
        const matchedCustomer = findTransferCustomerMatch(customer);
        if (matchedCustomer) {
          const updatePayload = buildTransferCustomerUpdatePayload(matchedCustomer, customer);
          if (updatePayload) {
            preview.updateCount += 1;
          } else {
            preview.mergeCount += 1;
          }
        } else {
          preview.createCount += 1;
        }
        addSample({
          primary: customer.name || customer.phone || customer.email || `Customer ${index + 1}`,
          secondary: customer.phone || customer.email || "No phone or email",
          badge: matchedCustomer
            ? (buildTransferCustomerUpdatePayload(matchedCustomer, customer) ? "Will update" : "Already matched")
            : "New customer"
        });
      });
    }

    if (type === "inventory") {
      const inventoryLookup = buildInventoryLookup();
      rows.forEach((row, index) => {
        const item = normalizeInventoryImport(row, index);
        const hasCoreData = hasInventoryImportData(item);
        if (!hasCoreData) {
          preview.issueRows += 1;
          addWarning(`Row ${index + 2} needs an item name and at least one MRP or selling price value before CinchPOS can import it.`);
          return;
        }
        preview.readyRows += 1;
        const matchedItem = findExistingInventoryMatch(item, inventoryItems, inventoryLookup);
        if (matchedItem) {
          preview.updateCount += 1;
        } else {
          preview.createCount += 1;
        }
        addSample({
          primary: item.itemName,
          secondary: summarizeInventoryImport(item),
          badge: matchedItem ? "Will update" : "Will add"
        });
      });
      if (preview.issueRows) {
        addWarning("Rows without an item name or at least one MRP or selling price value stay out of Inventory until the source file is cleaned.");
      }
    }

    if (type === "invoices") {
      const usedInvoiceNumbers = new Set(allInvoices.map((invoice) => normalizeKey(invoice.invoice_number || invoice.invoiceNumber)));
      rows.forEach((row, index) => {
        const invoice = normalizeInvoiceImport(row, index);
        const hasCustomerDetails = invoice.customerId || invoice.customerName || invoice.customerPhone;
        if (invoice.amount <= 0 || !hasCustomerDetails) {
          preview.issueRows += 1;
          addWarning(`Row ${index + 2} needs invoice amount and at least one customer detail.`);
          return;
        }
        preview.readyRows += 1;
        preview.createCount += 1;
        if (!invoice.invoiceNumber || usedInvoiceNumbers.has(normalizeKey(invoice.invoiceNumber))) {
          preview.renamedInvoices += 1;
        } else {
          usedInvoiceNumbers.add(normalizeKey(invoice.invoiceNumber));
        }
        addSample({
          primary: invoice.invoiceNumber || `Imported invoice ${index + 1}`,
          secondary: [invoice.customerName || invoice.customerPhone || "Customer needed", currency(invoice.amount), invoice.issuedOn].filter(Boolean).join(" | "),
          badge: findTransferCustomerMatch(invoice) ? "Customer matched" : "Customer will be checked"
        });
      });
    }

    if (!preview.totalRows) {
      addWarning("No rows were detected in this file. Export the old data again and keep the header row.");
    }
    if (!preview.readyRows && preview.totalRows) {
      addWarning("The file was read, but the important columns were not complete enough to import yet.");
    }

    return preview;
  }

  async function prepareTransferImport(type) {
    const { content, sourceSoftware, sourceProfile, fileName } = await readTransferDraft(type);
    if (!content.trim()) {
      throw new Error("Upload an export file or paste the data from the previous app first.");
    }
    const parsed = parseTransferRows(content, type, fileName);
    const packageData = packageRows(parsed, type);
    const preview = prepareTransferPreview(type, packageData, parsed, sourceSoftware, sourceProfile, fileName);
    updateTransferDraft(type, { preview, fileName });
    setActiveTransferGuide(type);
    return { parsed, packageData, preview, sourceSoftware, sourceProfile, fileName };
  }

  async function reviewDataTransfer(type) {
    setTransferBusy((current) => ({ ...current, [type]: true }));
    try {
      const prepared = await prepareTransferImport(type);
      if (prepared.preview.readyRows) {
        showMessage(`${prepared.preview.readyRows} rows are ready to move into ${prepared.preview.targetLabel}.`);
      } else {
        showMessage("We could read the file, but no complete rows are ready yet. Check the preview notes below.");
      }
      return prepared;
    } catch (error) {
      showMessage(error.message || "Could not review this data file.");
      return null;
    } finally {
      setTransferBusy((current) => ({ ...current, [type]: false }));
    }
  }

  async function submitDataTransfer(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const dataType = cleanText(new FormData(form).get("data_type"));
    if (!dataType) {
      return;
    }
    setTransferBusy((current) => ({ ...current, [dataType]: true }));
    try {
      const { packageData, preview, sourceSoftware } = await prepareTransferImport(dataType);
      if (!preview.readyRows) {
        showMessage("No rows are ready for import yet. Review the detected fields and guide notes first.");
        return;
      }
      const config = getTransferConfig(dataType);
      const transferSummary = {
        sourceSoftware: cleanText(sourceSoftware, "Previous billing software"),
        dataType,
        targetLabel: config.targetLabel,
        inventory: 0,
        customers: 0,
        invoices: 0,
        created: 0,
        updated: 0,
        merged: 0,
        renamedInvoices: 0,
        skipped: 0,
        readyRows: preview.readyRows,
        reviewedRows: preview.totalRows,
        total: 0,
        message: `${config.title} moved into ${config.targetLabel}.`
      };

      if (dataType === "inventory") {
        const inventoryRows = (packageData.inventory || []).map((row, index) => normalizeInventoryImport(row, index));
        setInventoryItems((current) => {
          const nextInventory = [...current];
          const inventoryLookup = buildInventoryLookup(nextInventory);
          inventoryRows.forEach((item) => {
            const hasCoreData = hasInventoryImportData(item);
            if (!hasCoreData) {
              transferSummary.skipped += 1;
              return;
            }
            const matchedItem = findExistingInventoryMatch(item, nextInventory, inventoryLookup);
            if (!matchedItem) {
              const cleanItem = stripInventoryImportFlags(item);
              nextInventory.unshift(cleanItem);
              registerInventoryLookupItem(inventoryLookup, cleanItem);
              transferSummary.inventory += 1;
              transferSummary.created += 1;
              return;
            }
            const mergedItem = mergeImportedInventoryItem(matchedItem, item);
            const matchIndex = nextInventory.findIndex((existingItem) => String(existingItem.id || "") === String(matchedItem.id || ""));
            if (matchIndex >= 0) {
              nextInventory.splice(matchIndex, 1, mergedItem);
            }
            registerInventoryLookupItem(inventoryLookup, mergedItem);
            transferSummary.inventory += 1;
            transferSummary.updated += 1;
          });
          return nextInventory;
        });
        setInventorySearch("");
        setInventoryVisibleCount(120);
      }

      if (dataType === "customers" || dataType === "invoices") {
        const knownCustomers = [...customers];
        if (dataType === "customers") {
          for (const row of (packageData.customers || [])) {
            const customer = normalizeCustomerImport(row);
            if (!customer.name && !customer.phone && !customer.email) {
              transferSummary.skipped += 1;
              continue;
            }
            const matchedCustomer = findTransferCustomerMatch(customer, knownCustomers);
            if (matchedCustomer) {
              const updatePayload = buildTransferCustomerUpdatePayload(matchedCustomer, customer);
              if (updatePayload) {
                try {
                  const updatedCustomer = await updateCustomer(matchedCustomer.id, updatePayload);
                  const nextCustomers = replaceKnownCustomerRecord(knownCustomers, updatedCustomer);
                  knownCustomers.splice(0, knownCustomers.length, ...nextCustomers);
                  transferSummary.updated += 1;
                } catch {
                  transferSummary.skipped += 1;
                  continue;
                }
              } else {
                transferSummary.merged += 1;
              }
              transferSummary.customers += 1;
              continue;
            }
            const fallbackName = customer.name || (customer.phone ? `Customer ${normalizePhone(customer.phone).slice(-4) || "Import"}` : "");
            if (!fallbackName) {
              transferSummary.skipped += 1;
              continue;
            }
            try {
              const savedCustomer = await createCustomer({
                name: fallbackName,
                email: customer.email,
                phone: customer.phone
              });
              knownCustomers.push(savedCustomer);
              transferSummary.customers += 1;
              transferSummary.created += 1;
            } catch {
              transferSummary.skipped += 1;
            }
          }
        }

        if (dataType === "invoices") {
          const usedInvoiceNumbers = new Set(allInvoices.map((invoice) => normalizeKey(invoice.invoice_number || invoice.invoiceNumber)));
          for (const row of (packageData.invoices || [])) {
            const invoice = normalizeInvoiceImport(row, transferSummary.invoices);
            const hasCustomerDetails = invoice.customerId || invoice.customerName || invoice.customerPhone;
            if (invoice.amount <= 0 || !hasCustomerDetails) {
              transferSummary.skipped += 1;
              continue;
            }
            try {
              let customerId = Number(invoice.customerId || 0);
              if (!customerId) {
                const matchedCustomer = findTransferCustomerMatch(invoice, knownCustomers);
                if (matchedCustomer) {
                  const updatePayload = buildTransferCustomerUpdatePayload(matchedCustomer, invoice);
                  if (updatePayload) {
                    const updatedCustomer = await updateCustomer(matchedCustomer.id, updatePayload);
                    const nextCustomers = replaceKnownCustomerRecord(knownCustomers, updatedCustomer);
                    knownCustomers.splice(0, knownCustomers.length, ...nextCustomers);
                    transferSummary.updated += 1;
                  } else {
                    transferSummary.merged += 1;
                  }
                  customerId = Number(matchedCustomer.id || 0);
                } else {
                  const fallbackName = invoice.customerName || (invoice.customerPhone ? `Customer ${normalizePhone(invoice.customerPhone).slice(-4) || "Import"}` : "");
                  if (!fallbackName) {
                    transferSummary.skipped += 1;
                    continue;
                  }
                  const savedCustomer = await createCustomer({
                    name: fallbackName,
                    email: invoice.customerEmail,
                    phone: invoice.customerPhone
                  });
                  knownCustomers.push(savedCustomer);
                  customerId = Number(savedCustomer.id || 0);
                  transferSummary.customers += 1;
                  transferSummary.created += 1;
                }
              }

              const safeInvoiceNumber = buildImportedInvoiceNumber(invoice.invoiceNumber, usedInvoiceNumbers, transferSummary.invoices);
              if (safeInvoiceNumber !== invoice.invoiceNumber) {
                transferSummary.renamedInvoices += 1;
              }
              const savedInvoice = await createInvoice({
                customer_id: customerId,
                invoice_number: safeInvoiceNumber,
                amount: invoice.amount,
                issued_on: invoice.issuedOn,
                due_on: invoice.dueOn,
                notes: invoice.notes
              });
              if (invoice.totalPaid > 0) {
                await recordPayment({
                  invoice_id: savedInvoice.id,
                  amount: Math.min(invoice.totalPaid, invoice.amount),
                  paid_on: invoice.issuedOn,
                  method: "Imported",
                  notes: "Imported payment"
                });
              }
              transferSummary.invoices += 1;
              transferSummary.created += 1;
            } catch {
              transferSummary.skipped += 1;
            }
          }
        }
      }

      transferSummary.total = dataType === "inventory"
        ? transferSummary.inventory
        : (dataType === "customers" ? transferSummary.customers : transferSummary.invoices);
      setDataTransferResult(transferSummary);
      resetTransferDraft(dataType, { keepSourceSoftware: true });
      await loadDashboard();
      const summaryLabel = dataType === "inventory" ? "inventory items" : (dataType === "customers" ? "customer records" : "invoices");
      showMessage(
        transferSummary.total
          ? `Retrieved ${transferSummary.total} ${summaryLabel} into ${config.targetLabel}.`
          : "No new records were needed. Existing data already covers this import."
      );
    } catch (error) {
      showMessage(error.message || "Could not import this data file.");
    } finally {
      setTransferBusy((current) => ({ ...current, [dataType]: false }));
    }
  }

  const filteredInventory = useMemo(() => {
    const query = deferredInventorySearch.trim().toLowerCase();
    if (!query) {
      return inventoryItems;
    }
    return inventoryItems.filter((item) => [
      getInventoryItemName(item),
      getInventoryBarcodeLabel(item),
      item.category,
      item.hsn,
      item.unit,
      item.inclusivePrice || item.inclusive_price,
      item.mrp
    ].some((value) => String(value || "").toLowerCase().includes(query)));
  }, [deferredInventorySearch, inventoryItems]);

  useEffect(() => {
    setInventoryVisibleCount(deferredInventorySearch.trim() ? 200 : 120);
  }, [deferredInventorySearch, inventoryItems.length]);

  const visibleInventory = useMemo(() => (
    filteredInventory.slice(0, inventoryVisibleCount)
  ), [filteredInventory, inventoryVisibleCount]);
  const hasMoreInventory = visibleInventory.length < filteredInventory.length;

  posModuleContextRef.current = {
    closeModal,
    getPOSInstance,
    getActiveBill,
    handlePOSPhone,
    updatePOSCustomer,
    getCustomerStatus,
    handlePOSItemSearch,
    updatePOSItemSearch,
    handlePOSSearchEnter,
    addPOSItem,
    createNewPOSBill,
    submitPOSBilling,
    switchPOSBill,
    deletePOSBill,
    updatePOSQuantity,
    updatePOSPrice,
    removePOSItem,
    inventoryItems
  };

  const POSModule = useMemo(() => function POSModule({ formId, modal = false }) {
    const {
      closeModal,
      getPOSInstance,
      getActiveBill,
      handlePOSPhone,
      updatePOSCustomer,
      getCustomerStatus,
      handlePOSItemSearch,
      updatePOSItemSearch,
      handlePOSSearchEnter,
      addPOSItem,
      createNewPOSBill,
      submitPOSBilling,
      switchPOSBill,
      deletePOSBill,
      updatePOSQuantity,
      updatePOSPrice,
      removePOSItem,
      inventoryItems
    } = posModuleContextRef.current;
    const [keyboardMode, setKeyboardMode] = useState("letters");
    const [keyboardShift, setKeyboardShift] = useState(false);
    const [keyboardCaps, setKeyboardCaps] = useState(false);
    const lastAutoBarcodeRef = useRef("");
    const instance = getPOSInstance(formId);
    const bill = getActiveBill(formId);
    const customer = { ...defaultPOSCustomer, ...(bill.customer || {}) };
    const items = bill.items || [];
    const posSummary = getPOSBillSummary(items);
    const matchListId = `${formId}ProductMatches`;
    const visibleMatches = instance.matchMode === "barcode"
      ? (instance.matches || [])
      : (instance.matches || []).slice(0, 8);
    const paidAmount = customer.paymentType === "partial"
      ? Math.min(posSummary.total, Math.max(0, Number(customer.partialAmount || 0)))
      : posSummary.total;
    const unpaidAmount = Math.max(0, posSummary.total - paidAmount);
    const meta = `${bill.label} | ${cleanText(customer.name, "Customer pending")} | ${customer.phone?.length === 10 ? formatIndianPhone(customer.phone) : "+91 phone pending"} | ${posSummary.quantity} item(s)`;
    const showUppercaseKeyboard = keyboardCaps || keyboardShift;
    const keyboardLetterRows = [
      ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
      ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
      ["z", "x", "c", "v", "b", "n", "m"]
    ];
    const keyboardNumberRows = [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      ["-", "/", ":", ";", "(", ")", "Rs", "&", "@", "."],
      [",", "?", "!", "'", "\"", "+", "*"]
    ];
    const activeKeyboardRows = keyboardMode === "letters" ? keyboardLetterRows : keyboardNumberRows;

    useEffect(() => {
      const query = cleanText(instance.itemQuery);
      if (!query) {
        lastAutoBarcodeRef.current = "";
        return;
      }
      const barcodeMatches = findInventoryItemsByBarcodeCandidate(inventoryItems, query);
      if (barcodeMatches.length === 1) {
        const autoBarcodeKey = `${formId}:${normalizeKey(query)}:${getInventoryItemKey(barcodeMatches[0])}`;
        if (lastAutoBarcodeRef.current === autoBarcodeKey) {
          return;
        }
        const exactMatch = findInventoryItemsByBarcode(inventoryItems, query).length === 1;
        const timer = window.setTimeout(() => {
          lastAutoBarcodeRef.current = autoBarcodeKey;
          addPOSItem(formId, barcodeMatches[0], { query, silent: true });
        }, exactMatch ? 40 : 280);
        return () => window.clearTimeout(timer);
      }
      lastAutoBarcodeRef.current = "";
    }, [formId, instance.itemQuery, inventoryItems]);

    function pressKeyboardKey(key) {
      const value = key === "Rs" ? "Rs " : key;
      const resolvedValue = keyboardMode === "letters" && value.length === 1
        ? (showUppercaseKeyboard ? value.toUpperCase() : value)
        : value;
      updatePOSItemSearch(formId, (currentValue) => `${currentValue}${resolvedValue}`);
      if (keyboardShift && !keyboardCaps) {
        setKeyboardShift(false);
      }
    }

    const form = (
      <>
        <form className="workspace-form" onSubmit={(event) => {
          event.preventDefault();
          submitPOSBilling(formId, {
            closePOSModal: modal,
            printAfter: !modal && Boolean(settings.autoPrintAfterBilling)
          });
        }}>
          <div className="pos-workstation">
            <div className="pos-left-rail">
              <section className="pos-section pos-customer-compact">
                <h3>Customer Info</h3>
                <div className="pos-customer-grid">
                  <label>
                    Phone
                    <span className="phone-input">
                      <span className="country-code">+91</span>
                      <input name="customer_phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength="14" pattern="[0-9]{10}" placeholder="10 digit number" required value={customer.phone || ""} onChange={(event) => handlePOSPhone(formId, event.target.value)} />
                    </span>
                  </label>
                  <label>
                    Name
                    <input name="customer_name" type="text" autoComplete="name" placeholder="Required for new customer" required value={customer.name || ""} onChange={(event) => updatePOSCustomer(formId, { name: event.target.value })} />
                  </label>
                  <label>
                    Payment Mode
                    <select name="payment_method" value={customer.paymentMethod || "Cash"} onChange={(event) => updatePOSCustomer(formId, { paymentMethod: event.target.value })}>
                      <option>Cash</option>
                      <option>UPI</option>
                      <option>Card</option>
                      <option>Bank Transfer</option>
                    </select>
                  </label>
                  <label>
                    Payment Type
                    <select name="payment_type" value={customer.paymentType || "full"} onChange={(event) => updatePOSCustomer(formId, { paymentType: event.target.value })}>
                      <option value="full">Full Payment</option>
                      <option value="partial">Partial Payment</option>
                    </select>
                  </label>
                  {customer.paymentType === "partial" ? (
                    <label className="partial-payment-field">
                      Amount Paid
                      <input name="partial_amount" type="number" min="0" step="0.01" max={posSummary.total} placeholder="0.00" value={customer.partialAmount || ""} onChange={(event) => updatePOSCustomer(formId, { partialAmount: event.target.value })} />
                    </label>
                  ) : null}
                </div>
                <input name="customer_country_code" type="hidden" value="+91" readOnly />
                <input name="customer_id" type="hidden" value={customer.customerId || ""} readOnly />
                <div className="pos-payment-summary">Unpaid: {currency(unpaidAmount)}</div>
                <p className={`pos-helper ${customer.customerId ? "found" : ""}`}>{getCustomerStatus(customer)}</p>
              </section>
              {!modal ? (
                <div id="workspaceVirtualKeyboard" className="virtual-keyboard" aria-label="Virtual keyboard">
                  {activeKeyboardRows.map((row, rowIndex) => (
                    <div className={`keyboard-row ${keyboardMode === "letters" ? `keyboard-letter-row-${rowIndex + 1}` : `keyboard-symbol-row-${rowIndex + 1}`}`} key={`${keyboardMode}-${row.join("")}`}>
                      {rowIndex === 2 && keyboardMode === "letters" ? (
                        <button type="button" className={`keyboard-key keyboard-mode-key ${keyboardShift ? "active" : ""}`} onClick={() => setKeyboardShift((current) => !current)}>Shift</button>
                      ) : null}
                      {row.map((key) => <button type="button" className="keyboard-key" key={key} onClick={() => pressKeyboardKey(key)}>{keyboardMode === "letters" && key.length === 1 && showUppercaseKeyboard ? key.toUpperCase() : key}</button>)}
                      {rowIndex === 2 ? (
                        <button type="button" className="keyboard-key keyboard-backspace" onClick={() => updatePOSItemSearch(formId, (currentValue) => currentValue.slice(0, -1))}>Backspace</button>
                      ) : null}
                    </div>
                  ))}
                  <div className="keyboard-row keyboard-control-row">
                    <button type="button" className="keyboard-key keyboard-mode-key" onClick={() => setKeyboardMode((current) => current === "letters" ? "numbers" : "letters")}>{keyboardMode === "letters" ? "123" : "ABC"}</button>
                    <button type="button" className={`keyboard-key keyboard-mode-key ${keyboardCaps ? "active" : ""}`} onClick={() => setKeyboardCaps((current) => !current)}>Caps</button>
                    <button type="button" className="keyboard-key keyboard-wide" onClick={() => updatePOSItemSearch(formId, (currentValue) => `${currentValue} `)}>Space</button>
                    <button type="button" className="keyboard-key" onClick={() => updatePOSItemSearch(formId, "")}>Esc</button>
                    <button type="button" className="keyboard-key keyboard-enter" onClick={() => handlePOSSearchEnter(formId, instance.itemQuery)}>Enter</button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="pos-billing-main">
              <section className="pos-section pos-billing-section">
                <div className="pos-section-head">
                  <h3>Start Billing</h3>
                  <div className="pos-bill-actions">
                    <button type="button" className="button button-secondary" onClick={() => createNewPOSBill(formId)}>Create New Bill</button>
                    {!modal ? <button type="submit" className="button button-primary">Complete Billing</button> : null}
                    {!modal ? <button type="button" className="button button-primary" onClick={() => submitPOSBilling(formId, { printAfter: true })}>Save & Print Bill</button> : null}
                  </div>
                </div>
                <div className="pos-item-entry">
                  <label>
                    Search Item
                    <input name="item_name" type="text" autoComplete="off" placeholder="Scan barcode or search item name" value={instance.itemQuery || ""} aria-expanded={Boolean(instance.matches?.length)} aria-controls={matchListId} onChange={(event) => handlePOSItemSearch(formId, event.target.value)} onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handlePOSSearchEnter(formId, event.currentTarget.value);
                      }
                    }} />
                  </label>
                  <button type="button" className="button button-secondary" onClick={() => addPOSItem(formId, null, { query: instance.itemQuery })}>Add Item</button>
                </div>
                <div id={matchListId} className={`pos-match-list ${instance.matchMode === "barcode" ? "barcode-match-list" : ""}`} hidden={!instance.matches?.length}>
                  <div className="pos-match-title">{instance.matchMessage || "Choose the product to add"}</div>
                  <div className="pos-match-grid">
                    {visibleMatches.map((item, index) => (
                      <button key={getInventoryItemKey(item, index)} type="button" className="pos-match-card" onClick={() => addPOSItem(formId, item)}>
                        <span>{getInventoryItemName(item) || "Inventory item"}</span>
                        <small>{currency(item.inclusivePrice || item.inclusive_price || 0)}</small>
                        <em>{getInventoryBarcodeLabel(item)}{Number(item.stock || 0) ? ` | Stock ${item.stock}` : ""}</em>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pos-bill-tabs" aria-label="Open bills">
                  {instance.bills.map((openBill) => {
                    const openBillTotal = getPOSBillSummary(openBill.items || []).total;
                    return (
                      <div key={openBill.id} className={`bill-tab-group ${openBill.id === instance.activeBillId ? "active" : ""}`}>
                        <button type="button" className="bill-tab" onClick={() => switchPOSBill(formId, openBill.id)}>
                          {openBill.label}
                          <span>{currency(openBillTotal)}</span>
                        </button>
                        <button type="button" className="bill-delete" aria-label={`Delete ${openBill.label}`} title={`Delete ${openBill.label}`} disabled={instance.bills.length <= 1} onClick={() => deletePOSBill(formId, openBill.id)}>&times;</button>
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className={`pos-preview-panel ${modal ? "modal-receipt" : ""}`} aria-label="Bill preview">
                <div className="pos-preview-head">
                  <div>
                    <h3>Bill Preview</h3>
                    <p className="pos-helper">{meta}</p>
                  </div>
                  <div className="pos-total">
                    <span>Grand Total</span>
                    <strong>{currency(posSummary.total)}</strong>
                  </div>
                </div>
                <div className={`pos-preview-scroll ${items.length ? "" : "empty"}`}>
                  <table className="bill-preview-table">
                    <thead>
                      <tr>
                        <th>S.No.</th>
                        <th>Item</th>
                        <th>Qty</th>
                        <th>MRP</th>
                        <th>Sale</th>
                        <th>Disc</th>
                        <th>Taxable</th>
                        <th>GST</th>
                        <th>Total</th>
                        <th className="line-action-col" aria-label="Actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length ? items.map((item, index) => {
                        const quantity = Number(item.quantity || 1);
                        const gstTotal = Number(item.gstAmount || 0) * quantity;
                        const lineTotal = Number(item.inclusivePrice || 0) * quantity;
                        return (
                          <tr key={item.id}>
                            <td>{index + 1}</td>
                            <td><strong>{item.itemName}</strong><span>{item.barcode || "No barcode"}</span></td>
                            <td><input className="line-edit-input qty-input" type="number" min="1" step="1" value={quantity} onChange={(event) => updatePOSQuantity(formId, item.id, event.target.value)} aria-label={`Quantity for ${item.itemName}`} /></td>
                            <td><input className="line-edit-input price-input" type="number" min="0" step="0.01" value={Number(item.mrp || 0)} onChange={(event) => updatePOSPrice(formId, item.id, "mrp", event.target.value)} aria-label={`MRP for ${item.itemName}`} /></td>
                            <td><input className="line-edit-input price-input" type="number" min="0" step="0.01" value={Number(item.inclusivePrice || 0)} onChange={(event) => updatePOSPrice(formId, item.id, "inclusivePrice", event.target.value)} aria-label={`Selling price for ${item.itemName}`} /></td>
                            <td>{Number(item.discountPercent || 0).toFixed(2)}%</td>
                            <td>{currency(item.taxableValue)}</td>
                            <td>{currency(gstTotal)}<span>{Number(item.gstRate || 0)}%</span></td>
                            <td><strong>{currency(lineTotal)}</strong></td>
                            <td><button type="button" className="line-remove" onClick={() => removePOSItem(formId, item.id)} aria-label={`Remove ${item.itemName}`}>&times;</button></td>
                          </tr>
                        );
                      }) : (
                        <tr>
                          <td colSpan="10" className="bill-empty">
                            <div className="bill-empty-state">
                              <img className="bill-empty-logo" src="/brand/cinchpos-logo.png" alt="" aria-hidden="true" />
                              <span>Scan a barcode or search an inventory item to start billing.</span>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  <div className="bill-summary-row">
                    <span>Items {posSummary.quantity}</span>
                    <span>Taxable {currency(posSummary.subtotal)}</span>
                    <span>GST {currency(posSummary.gst)}</span>
                    <strong>Grand Total {currency(posSummary.total)}</strong>
                  </div>
                </div>
              </section>
            </div>
          </div>
          {modal ? (
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="button button-primary">Complete Billing</button>
              <button type="button" className="button button-primary" onClick={() => submitPOSBilling(formId, { printAfter: true, closePOSModal: true })}>Save & Print Bill</button>
            </div>
          ) : null}
        </form>
      </>
    );
    return form;
  }, []);

  return (
    <>
      <IconSprite />
      <main className="desktop-app" data-active-view={activeView} data-pos-navigation={isPOSView && posNavigationOpen ? "open" : "closed"}>
        {isPOSView ? (
          <button
            className="pos-navigation-toggle"
            type="button"
            aria-label={posNavigationOpen ? "Hide navigation" : "Show navigation"}
            aria-expanded={posNavigationOpen}
            onClick={() => setPosNavigationOpen((open) => !open)}
          >
            <span></span>
            <span></span>
            <span></span>
          </button>
        ) : null}
        <section className="app-workspace" ref={appWorkspaceRef}>
          <header id="dashboard" className="app-toolbar">
            <div className="window-title">
              <StoreLogo source={storeLogoSource} fallback={fallbackInitials} alt={settings.logoName || `${businessName} logo`} className="toolbar-store-logo" />
              <HeaderTitle storeName={businessName} title={currentTitle} eyebrow={ownerName} />
            </div>
            <HeaderSupportMenu />
          </header>

          <div id="appMessage" className={`message ${message ? "show" : ""}`}>{message}</div>

          <div className="app-view-stack">
            {renderedViews.dashboardView ? <section id="dashboardView" className={`app-view ${activeView === "dashboardView" ? "active" : ""}`} data-title="Dashboard">
              <section className="quick-strip" aria-label="Quick Actions">
                <div>
                  <p className="action-label">Quick Actions</p>
                  <h2>Counter-ready billing tools</h2>
                </div>
                <div className="action-group">
                  <button className="button button-primary pos-launch" type="button" onClick={() => openModal("pos")}>CinchPOS</button>
                  <button className="button button-secondary" type="button" onClick={() => openModal("invoice")}>Create Invoice</button>
                  <button className="button button-secondary" type="button" onClick={() => openModal("customer")}>Add Customer</button>
                </div>
              </section>
              <section id="summaryGrid" className="summary-grid" aria-label="Billing summary">
                {[
                  ["revenue", "Revenue (Current Month)", currency(currentSummary.monthly_revenue), "Collections captured from the start of the current month."],
                  ["outstanding", "Outstanding Payments", currency(currentSummary.outstanding_payments), "Unpaid balances that still need follow-up."],
                  ["invoices", "Total Invoices", Number(currentSummary.invoice_count || 0), "Overall invoice count currently tracked in billing."],
                  ["balance", "Net Balance", currency(currentSummary.net_balance), "Revenue - Expenses"]
                ].map(([key, label, value, note]) => (
                  <article key={key} className={`summary-card ${key === "balance" ? `balance-${currentSummary.net_balance_direction}` : ""}`}>
                    <div className="summary-top">
                      <span className="summary-label">{label}</span>
                      <SummaryIcon type={key} />
                    </div>
                    <strong className="summary-value">{value}</strong>
                    <p className="summary-note">{note}</p>
                    {key === "balance" ? (
                      <div className={`balance-helper ${currentSummary.net_balance_direction === "negative" ? "negative" : ""}`}>
                        <span>{currentSummary.net_balance_direction === "negative" ? "Down" : "Up"}</span>
                        <span>{currentSummary.net_balance_direction === "negative" ? "Below zero" : "Above zero"}</span>
                        <span className="summary-tooltip" data-tooltip={`Revenue: ${currency(currentSummary.monthly_revenue)}\nExpenses: ${currency(currentSummary.expenses_total || currentSummary.outstanding_payments)}`}>i</span>
                      </div>
                    ) : null}
                  </article>
                ))}
              </section>

              <section id="reports" className="dashboard-grid">
                <div>
                  <section className="panel" id="sales-trend">
                    <div className="panel-header">
                      <div>
                        <h2>Sales Trend</h2>
                        <div className="panel-subtitle">Daily, weekly, monthly, and custom range collections.</div>
                      </div>
                      <div className="trend-controls">
                        <div className="segmented-control">
                          {["daily", "weekly", "monthly", "custom"].map((view) => (
                            <button key={view} className={trendView === view ? "active" : ""} type="button" onClick={async () => {
                              setTrendView(view);
                              try {
                                await refreshTrend(view);
                              } catch (error) {
                                showMessage(error.message);
                              }
                            }}>{view[0].toUpperCase() + view.slice(1)}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div id="rangeControls" className={`range-controls ${trendView === "custom" ? "visible" : ""}`}>
                      <input className="range-input" type="date" value={trendStartDate} onChange={(event) => setTrendStartDate(event.target.value)} />
                      <input className="range-input" type="date" value={trendEndDate} onChange={(event) => setTrendEndDate(event.target.value)} />
                      <button className="button button-secondary" type="button" onClick={() => refreshTrend("custom").catch((error) => showMessage(error.message))}>Apply Range</button>
                    </div>
                    <div className="chart-meta">
                      <span id="trendCaption">{trendCaption}</span>
                      <span id="trendPeak">Peak {currency(trendPeak)}</span>
                    </div>
                    <TrendChart points={trend} />
                    <div id="mockTrendNote" className="mock-note" hidden={!isWorkspaceEmpty}>No billing activity yet. Start POS billing, create invoices, or record payments to populate live dashboard data.</div>
                  </section>

                  <section className="panel" id="invoice-list-panel">
                    <div className="panel-header">
                      <div>
                        <h2>Recent Invoices</h2>
                        <div className="panel-subtitle">Latest invoice health with payment status.</div>
                      </div>
                      <button className="button button-secondary" type="button" onClick={() => openModal("allInvoices")}>View All</button>
                    </div>
                    <div id="recentInvoiceList" className="invoice-list">
                      {recentInvoices.length ? recentInvoices.slice(0, 6).map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} />) : <Empty>No invoices yet. Create your first invoice to start your billing history.</Empty>}
                    </div>
                  </section>
                </div>
                <aside className="alerts-panel" id="alerts-panel">
                  <section className="panel">
                    <div className="panel-header">
                      <div>
                        <h3>Alerts & Notifications</h3>
                        <div className="panel-subtitle">Overdue balances and due-today reminders.</div>
                      </div>
                    </div>
                    <div id="alertsList" className="alert-list">
                      {alerts.length ? alerts.map((alert, index) => (
                        <article className="alert-card" key={`${alert.title}-${index}`}>
                          <h4>{alert.title}</h4>
                          <p className="alert-copy">{alert.detail}</p>
                          <p className="alert-copy" style={{ marginTop: 8 }}>Date {alert.date}</p>
                        </article>
                      )) : <Empty>No critical alerts. The dashboard stays intentionally quiet until action is needed.</Empty>}
                    </div>
                  </section>
                </aside>
              </section>
            </section> : null}

            {renderedViews.cinchPOSView ? <section id="cinchPOSView" className={`app-view ${activeView === "cinchPOSView" ? "active" : ""}`} data-title="CinchPOS">
              <section className="panel">
                <div className="panel-header"><div><h2>CinchPOS</h2></div></div>
                <POSModule formId="workspacePosForm" />
              </section>
            </section> : null}

            {renderedViews.invoicesView ? <section id="invoicesView" className={`app-view ${activeView === "invoicesView" ? "active" : ""}`} data-title="Invoices">
              <section className="panel">
                <div className="panel-header">
                  <div><h2>Invoices</h2><div className="panel-subtitle">Full invoice list with status and payment health.</div></div>
                  <button className="button button-primary" type="button" onClick={() => openModal("invoice")}>Create Invoice</button>
                </div>
                <div id="invoicesWorkspaceList" className="data-table-shell">
                  {allInvoices.length ? (
                    <table className="data-table invoice-data-table">
                      <thead>
                        <tr>
                          <th>Serial No.</th>
                          <th>Customer Name</th>
                          <th>Phone No.</th>
                          <th>Date</th>
                          <th>Invoice Number</th>
                          <th>Amount</th>
                          <th>Paid</th>
                          <th>Outstanding</th>
                          <th>Payment Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allInvoices.map((invoice, index) => (
                          <tr key={invoice.id || invoice.invoice_number || index}>
                            <td>{index + 1}</td>
                            <td>{cleanText(invoice.customer_name, "Walk-in Customer")}</td>
                            <td>{getInvoicePhone(invoice)}</td>
                            <td>{formatDate(invoice.issued_on)}</td>
                            <td>{invoice.invoice_number || "Auto"}</td>
                            <td>{currency(invoice.amount)}</td>
                            <td>{currency(invoicePaidAmount(invoice))}</td>
                            <td>{currency(invoiceOutstandingAmount(invoice))}</td>
                            <td><span className={`status-badge ${statusClass(invoice.status)}`}>{invoice.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : <Empty>No invoice history available yet.</Empty>}
                </div>
              </section>
            </section> : null}

            {renderedViews.customerInfoView ? <section id="customerInfoView" className={`app-view ${activeView === "customerInfoView" ? "active" : ""}`} data-title="Customer Info">
              <section className="panel">
                <div className="panel-header">
                  <div><h2>Customer Info</h2><div className="panel-subtitle">Customer contact records for billing and follow-up.</div></div>
                  <button className="button button-primary" type="button" onClick={() => openModal("customer")}>Add Customer</button>
                </div>
                <div id="customerInfoList" className="data-table-shell customer-data-shell">
                  {customers.length ? (
                    <table className="data-table customer-data-table">
                      <thead>
                        <tr>
                          <th>Serial No.</th>
                          <th>Customer Name</th>
                          <th>Phone No.</th>
                          <th>Email</th>
                          <th>Total Invoices</th>
                          <th>Outstanding</th>
                        </tr>
                      </thead>
                      <tbody>
                        {customers.map((customer, index) => {
                          const stats = getCustomerInvoiceStats(customer);
                          return (
                            <tr key={customer.id || customer.name || index}>
                              <td>{index + 1}</td>
                              <td>{customer.name}</td>
                              <td>{customer.phone || "Not added"}</td>
                              <td>{customer.email || "Not added"}</td>
                              <td>{stats.count}</td>
                              <td>{currency(stats.outstanding)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : <Empty>No customer records yet. Add a customer before billing or invoicing.</Empty>}
                </div>
              </section>
            </section> : null}

            {renderedViews.inventoryView ? <InventoryView active={activeView === "inventoryView"} /> : null}
            {renderedViews.purchaseView ? <PurchaseView active={activeView === "purchaseView"} /> : null}
            {renderedViews.expensesView ? <ExpensesView active={activeView === "expensesView"} /> : null}
            {renderedViews.salesReportView ? <SalesReportView active={activeView === "salesReportView"} /> : null}
            {renderedViews.employeeView ? <EmployeeView active={activeView === "employeeView"} /> : null}
            {renderedViews.bankView ? <BankView active={activeView === "bankView"} /> : null}
            {renderedViews.documentsView ? <DocumentsView active={activeView === "documentsView"} /> : null}
            {renderedViews.dataTransferView ? <DataTransferView active={activeView === "dataTransferView"} /> : null}
          </div>
        </section>

        <aside className="right-navigation" aria-label="Application navigation">
          <button className={`brand ${activeView === "dashboardView" ? "active" : ""}`} type="button" onClick={() => switchView("dashboardView")}>
            <span className="brand-logo-wrap"><AppLogo /></span>
            <span><span>{APP_NAME}</span><small>{businessName} workspace</small></span>
          </button>
          <nav className="right-nav-links">
            {navigationViews.map((view) => (
              <button key={view.id} className={`nav-item ${view.billing ? "nav-billing" : ""} ${activeView === view.id ? "active" : ""}`} type="button" onClick={() => switchView(view.id)}>
                <span className="nav-icon"><svg><use href={`#icon-${view.icon}`}></use></svg></span>
                {view.title}
              </button>
            ))}
            <button className="nav-item" type="button" onClick={() => openModal("settings")}><span className="nav-icon"><svg><use href="#icon-settings"></use></svg></span>Settings</button>
          </nav>
        </aside>
      </main>

      <Modal open={activeModal === "customer"} title="Add Customer" subtitle="Create a customer record for invoices and future payment activity." onClose={closeModal}>
        <form onSubmit={submitCustomer}>
          <label>Customer Name<input name="name" type="text" placeholder="Northwind Labs" required /></label>
          <div className="form-grid">
            <label>Email<input name="email" type="email" placeholder="Optional" /></label>
            <label>Phone<input name="phone" type="text" placeholder="Optional" /></label>
          </div>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button><button type="submit" className="button button-primary">Save Customer</button></div>
        </form>
      </Modal>

      <Modal open={activeModal === "invoice"} title="Create Invoice" subtitle="Capture a customer, amount, and dates with a minimal billing form." onClose={closeModal}>
        <form onSubmit={submitInvoice}>
          <label>Customer<select name="customer_id" required disabled={!customers.length}>{customers.length ? customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>) : <option value="">Add a customer first</option>}</select></label>
          <div className="form-grid settings-form-grid">
            <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
            <label>Invoice Number<input name="invoice_number" type="text" placeholder={`Auto generated as ${buildClientInvoiceNumber(todayISO())}`} /></label>
          </div>
          <div className="form-grid settings-form-grid">
            <label>Issued On<input name="issued_on" type="date" defaultValue={todayISO()} required /></label>
            <label>Due On<input name="due_on" type="date" defaultValue={defaultDueDate} required /></label>
          </div>
          <label>Notes<textarea name="notes" placeholder="Optional note for the invoice" defaultValue={settings.invoiceNotes || ""}></textarea></label>
          <p className="settings-inline-copy">If the invoice number is left blank, CinchPOS uses {buildClientInvoiceNumber(todayISO())}. The due date follows the current invoicing setting.</p>
          <div className="form-grid settings-form-grid">
            <label>Payment Status<select name="payment_type" defaultValue="pending"><option value="pending">Pending</option><option value="full">Full Payment</option><option value="partial">Partial Payment</option></select></label>
            <label>Payment Method<select name="payment_method"><option>Cash</option><option>UPI</option><option>Card</option><option>Bank Transfer</option></select></label>
            <label className="settings-span-2">Paid Amount<input name="payment_amount" type="number" min="0" step="0.01" placeholder="Only for partial payment" /></label>
          </div>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button><button type="submit" className="button button-primary" disabled={!customers.length}>Create Invoice</button></div>
        </form>
      </Modal>

      <Modal open={activeModal === "pos"} title="CinchPOS" large onClose={closeModal}>
        <POSModule formId="posForm" modal />
      </Modal>

      <Modal open={activeModal === "payment"} title="Record Payment" subtitle="Apply a payment to an outstanding invoice and update totals immediately." onClose={closeModal}>
        <form onSubmit={submitPayment}>
          <label>Invoice<select key={prefillInvoiceId || outstandingInvoices[0]?.id || "none"} name="invoice_id" required disabled={!outstandingInvoices.length} defaultValue={prefillInvoiceId || outstandingInvoices[0]?.id || ""}>{outstandingInvoices.length ? outstandingInvoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} | {invoice.customer_name} | {currency(invoice.outstanding)}</option>) : <option value="">Create an invoice before recording a payment</option>}</select></label>
          <div className="form-grid">
            <label>Payment Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
            <label>Paid On<input name="paid_on" type="date" defaultValue={todayISO()} required /></label>
          </div>
          <div className="form-grid">
            <label>Method<select name="method"><option>Bank Transfer</option><option>UPI</option><option>Card</option><option>Cash</option></select></label>
            <label>Notes<input name="notes" type="text" placeholder="Optional" /></label>
          </div>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button><button type="submit" className="button button-primary" disabled={!outstandingInvoices.length}>Record Payment</button></div>
        </form>
      </Modal>

      <Modal open={activeModal === "allInvoices"} title="All Invoices" subtitle="Every invoice with customer, date, payment status, and balances." large onClose={closeModal}>
        <div id="allInvoiceList" className="data-table-shell">
          {allInvoices.length ? (
            <table className="data-table invoice-data-table">
              <thead>
                <tr>
                  <th>Serial No.</th>
                  <th>Customer Name</th>
                  <th>Phone No.</th>
                  <th>Date</th>
                  <th>Invoice Number</th>
                  <th>Amount</th>
                  <th>Paid</th>
                  <th>Outstanding</th>
                  <th>Payment Status</th>
                </tr>
              </thead>
              <tbody>
                {allInvoices.map((invoice, index) => (
                  <tr key={invoice.id || invoice.invoice_number || index}>
                    <td>{index + 1}</td>
                    <td>{cleanText(invoice.customer_name, "Walk-in Customer")}</td>
                    <td>{getInvoicePhone(invoice)}</td>
                    <td>{formatDate(invoice.issued_on)}</td>
                    <td>{invoice.invoice_number || "Auto"}</td>
                    <td>{currency(invoice.amount)}</td>
                    <td>{currency(invoicePaidAmount(invoice))}</td>
                    <td>{currency(invoiceOutstandingAmount(invoice))}</td>
                    <td><span className={`status-badge ${statusClass(invoice.status)}`}>{invoice.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No invoice history available yet.</Empty>}
        </div>
      </Modal>

      <Modal open={activeModal === "settings"} title="Settings" subtitle="Change appearance and personalize this billing workspace." large cardClass="settings-modal-card" onClose={closeModal}>
        <SettingsForm />
      </Modal>

      <Modal open={activeModal === "login"} title="Login or Sign Up" subtitle="Login to an existing account or create one for this billing counter." onClose={closeModal}>
        <form onSubmit={(event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(event.currentTarget).entries());
          setAccount({ loggedIn: true, name: data.name.trim(), contact: data.contact.trim() });
          event.currentTarget.reset();
          closeModal();
          showMessage("Logged in.");
        }}>
          <label>Operator Name<input name="name" type="text" placeholder="Shopkeeper name" required /></label>
          <label>Phone or Email<input name="contact" type="text" placeholder="Phone or email" required /></label>
          <label>PIN<input name="pin" type="password" inputMode="numeric" placeholder="Counter PIN" required /></label>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button><button type="submit" className="button button-primary">Login or Sign Up</button></div>
        </form>
      </Modal>
    </>
  );

  function InventoryView({ active }) {
    function makeEmptyInventoryDraft() {
      return {
        item_name: "",
        category: "",
        hsn: "",
        manufacturing_date: "",
        expiry_date: "",
        mrp: "",
        inclusive_price: "",
        gst_rate: "18",
        stock: "1",
        stock_adjustment: "1",
        unit: "pcs"
      };
    }
    function buildInventoryDraft(item) {
      if (!item) {
        return makeEmptyInventoryDraft();
      }
      return {
        item_name: getInventoryItemName(item),
        category: cleanText(item.category),
        hsn: cleanText(item.hsn),
        manufacturing_date: item.manufacturingDate || item.manufacturing_date || "",
        expiry_date: item.expiryDate || item.expiry_date || "",
        mrp: item.mrp !== undefined && item.mrp !== null ? String(item.mrp) : "",
        inclusive_price: item.inclusivePrice !== undefined && item.inclusivePrice !== null
          ? String(item.inclusivePrice)
          : (item.inclusive_price !== undefined && item.inclusive_price !== null ? String(item.inclusive_price) : ""),
        gst_rate: item.gstRate !== undefined && item.gstRate !== null
          ? String(item.gstRate)
          : (item.gst_rate !== undefined && item.gst_rate !== null ? String(item.gst_rate) : "18"),
        stock: item.stock !== undefined && item.stock !== null ? String(item.stock) : "1",
        stock_adjustment: "1",
        unit: cleanText(item.unit, "pcs")
      };
    }
    const [draft, setDraft] = useState(makeEmptyInventoryDraft);
    const [barcodeInputs, setBarcodeInputs] = useState([""]);
    const [selectedInventoryItemId, setSelectedInventoryItemId] = useState("");
    const mrp = Number(draft.mrp || 0);
    const sellingPrice = Number(draft.inclusive_price || 0);
    const discountPercent = calculateDiscountPercent(mrp, sellingPrice);
    const breakup = getInventoryGSTBreakup(sellingPrice, draft.gst_rate);
    function updateBarcodeInput(index, value) {
      setBarcodeInputs((current) => current.map((barcode, barcodeIndex) => (barcodeIndex === index ? value : barcode)));
    }
    function updateDraftField(name, value) {
      setDraft((current) => ({ ...current, [name]: value }));
    }
    function changeDraftStock(delta) {
      const adjustment = Math.max(1, Math.round(Number(draft.stock_adjustment || 0) || 0));
      setDraft((current) => ({
        ...current,
        stock: String(Math.max(0, Number(current.stock || 0) + (delta * adjustment)))
      }));
    }
    const selectedInventoryItem = useMemo(() => (
      selectedInventoryItemId
        ? inventoryItems.find((item) => String(item.id || "") === selectedInventoryItemId) || null
        : null
    ), [inventoryItems, selectedInventoryItemId]);
    function resetInventoryEditor() {
      setSelectedInventoryItemId("");
      setBarcodeInputs([""]);
      setDraft(makeEmptyInventoryDraft());
    }
    function selectInventoryItem(item) {
      const nextBarcodes = getInventoryItemBarcodes(item);
      setSelectedInventoryItemId(String(item?.id || ""));
      setBarcodeInputs(nextBarcodes.length ? nextBarcodes : [""]);
      setDraft(buildInventoryDraft(item));
    }
    useEffect(() => {
      if (selectedInventoryItemId && !inventoryItems.some((item) => String(item.id || "") === selectedInventoryItemId)) {
        resetInventoryEditor();
      }
    }, [inventoryItems, selectedInventoryItemId]);
    function handleSubmitInventory(event) {
      event.preventDefault();
      const itemName = cleanText(draft.item_name);
      const nextMrp = Number(draft.mrp || 0);
      const nextInclusivePrice = Number(draft.inclusive_price || 0);
      const nextGstRate = Number(draft.gst_rate || 0);
      const nextStock = Number(draft.stock || 0);
      const nextBarcodes = normalizeInventoryBarcodes(barcodeInputs);
      if (!itemName || !nextBarcodes.length || nextMrp <= 0 || nextInclusivePrice <= 0) {
        showMessage("Add item name, barcode, MRP, and selling price greater than zero.");
        return;
      }
      if (nextInclusivePrice > nextMrp) {
        showMessage("Selling price should not be higher than MRP.");
        return;
      }
      const nextBreakup = getInventoryGSTBreakup(nextInclusivePrice, nextGstRate);
      const nextItem = {
        ...(selectedInventoryItem || {}),
        id: selectedInventoryItem?.id ? String(selectedInventoryItem.id) : String(Date.now()),
        itemName,
        barcode: nextBarcodes[0],
        barcodes: nextBarcodes,
        category: cleanText(draft.category),
        hsn: cleanText(draft.hsn),
        manufacturingDate: draft.manufacturing_date || "",
        expiryDate: draft.expiry_date || "",
        stock: nextStock,
        unit: cleanText(draft.unit, "pcs"),
        mrp: nextMrp,
        inclusivePrice: nextInclusivePrice,
        discountPercent: calculateDiscountPercent(nextMrp, nextInclusivePrice),
        gstRate: nextGstRate,
        taxableValue: Number(nextBreakup.taxableValue.toFixed(2)),
        cgst: Number(nextBreakup.cgst.toFixed(2)),
        sgst: Number(nextBreakup.sgst.toFixed(2)),
        gstAmount: Number(nextBreakup.gstAmount.toFixed(2)),
        createdAt: selectedInventoryItem?.createdAt || todayISO()
      };
      setInventoryItems((current) => (
        selectedInventoryItem
          ? current.map((item) => (String(item.id || "") === String(selectedInventoryItem.id || "") ? nextItem : item))
          : [nextItem, ...current]
      ));
      setSelectedInventoryItemId(String(nextItem.id));
      const savedBarcodes = getInventoryItemBarcodes(nextItem);
      setBarcodeInputs(savedBarcodes.length ? savedBarcodes : [""]);
      setDraft(buildInventoryDraft(nextItem));
      showMessage(selectedInventoryItem ? "Inventory item updated." : "Inventory item saved with barcode, stock, pricing, and date details.");
    }
    if (!active) {
      return <section id="inventoryView" className="app-view" data-title="Inventory"></section>;
    }
    return (
      <section id="inventoryView" className={`app-view ${active ? "active" : ""}`} data-title="Inventory">
        <div className="inventory-workspace">
          <section className="panel inventory-editor-panel">
            <div className="panel-header">
              <div>
                <h2>{selectedInventoryItem ? "Inventory Details" : "Inventory"}</h2>
                <div className="panel-subtitle">
                  {selectedInventoryItem
                    ? "Complete item details appear here. Update the fields and save changes."
                    : "Prices are inclusive of GST. CGST and SGST split equally for intra-state sales."}
                </div>
              </div>
              {selectedInventoryItem ? <button type="button" className="button button-secondary" onClick={resetInventoryEditor}>Add New Item</button> : null}
            </div>
            <form id="inventoryForm" className="inventory-form" onSubmit={handleSubmitInventory}>
              <section className="inventory-form-section">
                <h3>Item Description</h3>
                <div className="inventory-grid">
                  <label>Item Name<input name="item_name" type="text" placeholder="Product name" required value={draft.item_name} onChange={(event) => updateDraftField("item_name", event.target.value)} /></label>
                  <label>Category<input name="category" type="text" placeholder="Grocery, dairy, medicine" value={draft.category} onChange={(event) => updateDraftField("category", event.target.value)} /></label>
                  <label>HSN/SAC<input name="hsn" type="text" placeholder="Optional" value={draft.hsn} onChange={(event) => updateDraftField("hsn", event.target.value)} /></label>
                  <label>Manufacturing Date<input name="manufacturing_date" type="date" value={draft.manufacturing_date} onChange={(event) => updateDraftField("manufacturing_date", event.target.value)} /></label>
                  <label>Expiry Date<input name="expiry_date" type="date" value={draft.expiry_date} onChange={(event) => updateDraftField("expiry_date", event.target.value)} /></label>
                </div>
                <div className="barcode-entry-list">
                  {barcodeInputs.map((barcode, index) => (
                    <div className="barcode-entry" key={`barcode-${index}`}>
                      <label>{index === 0 ? "Barcode" : `Barcode ${index + 1}`}<input name="barcode" type="text" inputMode="numeric" placeholder={index === 0 ? "Scan or enter barcode" : "Additional barcode"} required={index === 0} value={barcode} onChange={(event) => updateBarcodeInput(index, event.target.value)} /></label>
                      {barcodeInputs.length > 1 ? <button className="button button-secondary barcode-remove-button" type="button" onClick={() => setBarcodeInputs((current) => current.filter((_, barcodeIndex) => barcodeIndex !== index))}>Remove</button> : null}
                    </div>
                  ))}
                  <button className="button button-secondary barcode-add-button" type="button" onClick={() => setBarcodeInputs((current) => [...current, ""])}>Add Barcode</button>
                </div>
              </section>
              <section className="inventory-form-section">
                <h3>Stock Count</h3>
                <div className="inventory-stock-grid">
                  <label className="stock-count-field">Stock Count
                    <input name="stock" type="number" min="0" step="1" value={draft.stock} required onChange={(event) => updateDraftField("stock", event.target.value)} />
                  </label>
                  <label>Unit<select name="unit" value={draft.unit} onChange={(event) => updateDraftField("unit", event.target.value)}><option value="pcs">Pieces</option><option value="kg">Kilogram</option><option value="g">Gram</option><option value="l">Litre</option><option value="ml">Millilitre</option><option value="box">Box</option><option value="pack">Pack</option></select></label>
                  <label className="stock-adjustment-field">Adjust By
                    <input name="stock_adjustment" type="number" min="1" step="1" value={draft.stock_adjustment} onChange={(event) => updateDraftField("stock_adjustment", event.target.value)} />
                  </label>
                  <div className="stock-current-display" aria-live="polite">
                    <span>Current stock</span>
                    <strong>{Number(draft.stock || 0)} {draft.unit || "pcs"}</strong>
                  </div>
                  <div className="stock-adjustment-actions">
                    <button type="button" className="button button-secondary" onClick={() => changeDraftStock(-1)}>Subtract Stock</button>
                    <button type="button" className="button button-secondary" onClick={() => changeDraftStock(1)}>Add Stock</button>
                  </div>
                </div>
              </section>
              <section className="inventory-form-section">
                <h3>Pricing Details</h3>
                <div className="inventory-pricing-grid">
                  <label>MRP<input name="mrp" type="number" min="0.01" step="0.01" placeholder="0.00" required value={draft.mrp} onChange={(event) => updateDraftField("mrp", event.target.value)} /></label>
                  <label>Selling Price (Incl. GST)<input name="inclusive_price" type="number" min="0.01" step="0.01" placeholder="0.00" required value={draft.inclusive_price} onChange={(event) => updateDraftField("inclusive_price", event.target.value)} /></label>
                  <label>Discount (%)<input name="discount_percent" type="number" min="0" max="100" step="0.01" value={discountPercent.toFixed(2)} readOnly /></label>
                  <label>GST Rate<select name="gst_rate" value={draft.gst_rate} onChange={(event) => updateDraftField("gst_rate", event.target.value)}><option value="0">0% GST</option><option value="0.25">0.25% GST (0.125% CGST + 0.125% SGST)</option><option value="1.5">1.5% GST (0.75% CGST + 0.75% SGST)</option><option value="3">3% GST (1.5% CGST + 1.5% SGST)</option><option value="5">5% GST (2.5% CGST + 2.5% SGST)</option><option value="12">12% GST (6% CGST + 6% SGST)</option><option value="18">18% GST (9% CGST + 9% SGST)</option><option value="28">28% GST (14% CGST + 14% SGST)</option></select></label>
                </div>
                <div className="gst-preview" aria-live="polite">
                  <span>MRP <strong>{currency(mrp)}</strong></span>
                  <span>Selling price <strong>{currency(sellingPrice)}</strong></span>
                  <span>Discount <strong>{discountPercent.toFixed(2)}%</strong></span>
                  <span>Taxable value <strong>{currency(breakup.taxableValue)}</strong></span>
                  <span>CGST <strong>{currency(breakup.cgst)} ({Number(draft.gst_rate || 0) / 2}%)</strong></span>
                  <span>SGST <strong>{currency(breakup.sgst)} ({Number(draft.gst_rate || 0) / 2}%)</strong></span>
                  <span>Total GST <strong>{currency(breakup.gstAmount)}</strong></span>
                </div>
                <p className="settings-help">Select the GST rate applicable to the item/HSN or SAC. The app splits inclusive GST into CGST and SGST for intra-state billing.</p>
              </section>
              <div className="modal-actions inventory-form-actions">
                {selectedInventoryItem ? <button type="button" className="button button-secondary" onClick={resetInventoryEditor}>Cancel Selection</button> : null}
                <button type="submit" className="button button-primary">{selectedInventoryItem ? "Save Item Details" : "Add Item"}</button>
              </div>
            </form>
          </section>
          <section className="panel inventory-list-panel">
            <div className="panel-header"><div><h2>Inventory Items</h2><div className="panel-subtitle">Saved locally in this app workspace.</div></div></div>
            <label className="inventory-search">Search Products<input id="inventorySearch" type="search" placeholder="Search by item name or barcode" value={inventorySearch} onChange={(event) => setInventorySearch(event.target.value)} /></label>
            {inventoryItems.length ? <p className="inventory-list-summary">Showing {visibleInventory.length} of {filteredInventory.length} items. Click an item for full details.</p> : null}
            <div id="inventoryList" className="inventory-list">
              {!inventoryItems.length ? <Empty>No inventory items yet. Add an item with an inclusive GST price to see CGST and SGST breakup here.</Empty> : null}
              {inventoryItems.length && !filteredInventory.length ? <Empty>No products match your search. Try item name, barcode, category, HSN/SAC, or price.</Empty> : null}
              {visibleInventory.map((item, index) => {
                const itemKey = getInventoryItemKey(item, index);
                const itemName = getInventoryItemName(item) || "Untitled item";
                const inclusivePrice = Number(item.inclusivePrice || item.inclusive_price || 0);
                const barcode = getInventoryBarcodeLabel(item);
                const quantityLabel = `${Number(item.stock || 0)} ${item.unit || "pcs"}`;
                const isSelected = selectedInventoryItemId === String(item.id || "");
                return (
                  <article
                    className={`inventory-item inventory-item-compact ${isSelected ? "selected" : ""}`}
                    key={itemKey}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    onClick={() => selectInventoryItem(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectInventoryItem(item);
                      }
                    }}
                  >
                      <div className="inventory-item-compact-top">
                        <div className="inventory-item-copy">
                          <h3>{itemName}</h3>
                          <p className="inventory-compact-meta">Barcode {barcode}</p>
                        </div>
                        <div className="inventory-item-qty">
                          <span>Qty</span>
                          <strong>{quantityLabel}</strong>
                        </div>
                      </div>
                      <div className="inventory-item-compact-bottom">
                        <span className="inventory-item-price">Price <strong>{currency(inclusivePrice)}</strong></span>
                        <span className="inventory-item-open">{isSelected ? "Selected" : "View details"}</span>
                      </div>
                  </article>
                );
              })}
            </div>
            {hasMoreInventory ? (
              <div className="inventory-load-more">
                <button type="button" className="button button-secondary" onClick={() => setInventoryVisibleCount((current) => current + (deferredInventorySearch.trim() ? 200 : 120))}>
                  Load More Items
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </section>
    );
  }

  function PurchaseView({ active }) {
    return (
      <section id="purchaseView" className={`app-view ${active ? "active" : ""}`} data-title="Purchase">
        <section className="panel">
          <div className="panel-header"><div><h2>Purchase</h2><div className="panel-subtitle">Supplier purchases, inward stock, and payment status.</div></div></div>
          <form id="purchaseForm" className="workspace-form" onSubmit={submitPurchase}>
            <div className="module-grid">
              <label>Supplier<input name="supplier" type="text" placeholder="Supplier name" required /></label>
              <label>Item / Material<input name="item" type="text" placeholder="Purchase item" required /></label>
              <label>Bill Number<input name="bill_number" type="text" placeholder="Optional" /></label>
              <label>Purchase Date<input name="purchase_date" type="date" defaultValue={todayISO()} required /></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
              <label>Payment Status<select name="payment_status"><option>Paid</option><option>Pending</option><option>Partial</option></select></label>
            </div>
            <label>Notes<input name="notes" type="text" placeholder="Optional" /></label>
            <div className="modal-actions"><button type="submit" className="button button-primary">Save Purchase</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Purchase Records</h2><div className="panel-subtitle">Recent supplier purchases saved in this workspace.</div></div></div>
          <div id="purchaseList" className="record-list">{purchaseRecords.length ? purchaseRecords.map((purchase) => <article className="record-card" key={purchase.id}><div className="record-top"><div><h3>{purchase.supplier}</h3><p className="record-meta">{purchase.item} | Bill {purchase.billNumber || "Not added"} | {purchase.purchaseDate}</p></div><strong className="record-amount">{currency(purchase.amount)}</strong></div><div className="record-meta-grid"><span>{purchase.paymentStatus}</span><span>{purchase.notes || "No notes"}</span></div></article>) : <Empty>No purchases saved yet. Supplier purchases will appear here.</Empty>}</div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Purchase Bills</h2><div className="panel-subtitle">Keep supplier bill copies with amount and GST details.</div></div></div>
          <form id="purchaseBillForm" className="workspace-form" onSubmit={submitPurchaseBill}>
            <div className="module-grid">
              <label>Supplier<input name="supplier" type="text" placeholder="Supplier name" required /></label>
              <label>Bill Number<input name="bill_number" type="text" placeholder="Bill or invoice number" required /></label>
              <label>Bill Date<input name="bill_date" type="date" defaultValue={todayISO()} required /></label>
              <label>Bill Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
              <label>GST Amount<input name="gst_amount" type="number" min="0" step="0.01" placeholder="0.00" /></label>
              <label>Bill File<input name="bill_file" type="file" accept="image/*,.pdf" /></label>
            </div>
            <div className="modal-actions"><button type="submit" className="button button-primary">Save Bill</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Saved Purchase Bills</h2><div className="panel-subtitle">Supplier bills stored in this device workspace.</div></div></div>
          <div id="purchaseBillList" className="record-list">{purchaseBills.length ? purchaseBills.map((bill) => <article className="record-card" key={bill.id}><div className="record-top"><div><h3>{bill.supplier}</h3><p className="record-meta">Bill {bill.billNumber} | {bill.billDate}</p></div><strong className="record-amount">{currency(bill.amount)}</strong></div><div className="record-meta-grid"><span>GST {currency(bill.gstAmount)}</span><span>{bill.fileName || "No file attached"}</span></div><div className="record-actions"><FileAction record={bill} label="Download Bill" /></div></article>) : <Empty>No purchase bills stored yet. Upload supplier bill copies here.</Empty>}</div>
        </section>
      </section>
    );
  }

  function ExpensesView({ active }) {
    return (
      <section id="expensesView" className={`app-view ${active ? "active" : ""}`} data-title="Expenses">
        <section className="panel">
          <div className="panel-header"><div><h2>Expenses</h2><div className="panel-subtitle">Daily store expenses, overheads, and payment mode.</div></div></div>
          <form id="expenseForm" className="workspace-form" onSubmit={submitExpense}>
            <div className="module-grid">
              <label>Category<select name="category"><option>Rent</option><option>Utilities</option><option>Salary</option><option>Transport</option><option>Maintenance</option><option>Other</option></select></label>
              <label>Paid To<input name="paid_to" type="text" placeholder="Vendor or employee" /></label>
              <label>Expense Date<input name="expense_date" type="date" defaultValue={todayISO()} required /></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
              <label>Payment Mode<select name="payment_mode"><option>Cash</option><option>UPI</option><option>Card</option><option>Bank Transfer</option></select></label>
            </div>
            <label>Notes<input name="notes" type="text" placeholder="Optional" /></label>
            <div className="modal-actions"><button type="submit" className="button button-primary">Save Expense</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Expense Records</h2><div className="panel-subtitle">Store expenses saved in this workspace.</div></div></div>
          <div id="expenseList" className="record-list">{expenseRecords.length ? expenseRecords.map((expense) => <article className="record-card" key={expense.id}><div className="record-top"><div><h3>{expense.category}</h3><p className="record-meta">{expense.paidTo || "Paid to not added"} | {expense.expenseDate}</p></div><strong className="record-amount">{currency(expense.amount)}</strong></div><div className="record-meta-grid"><span>{expense.paymentMode}</span><span>{expense.notes || "No notes"}</span></div></article>) : <Empty>No expenses saved yet. Daily overheads will appear here.</Empty>}</div>
        </section>
      </section>
    );
  }

  function SalesReportView({ active }) {
    const paidInvoices = allInvoices.filter((invoice) => invoice.status === "Paid").length;
    const pendingInvoices = allInvoices.filter((invoice) => invoice.status === "Pending").length;
    const overdueInvoices = allInvoices.filter((invoice) => invoice.status === "Overdue").length;
    return (
      <section id="salesReportView" className={`app-view ${active ? "active" : ""}`} data-title="Sales Report">
        <section className="panel">
          <div className="panel-header"><div><h2>Sales Report</h2><div className="panel-subtitle">Sales performance, collections, and invoice status reporting.</div></div></div>
          <div className="record-list">
            <article className="record-card"><div className="record-top"><div><h3>Collections</h3><p className="record-meta">Current month payment revenue</p></div><strong className="record-amount">{currency(currentSummary.monthly_revenue)}</strong></div></article>
            <article className="record-card"><div className="record-top"><div><h3>Outstanding</h3><p className="record-meta">Pending balances across invoices</p></div><strong className="record-amount">{currency(currentSummary.outstanding_payments)}</strong></div></article>
            <article className="record-card"><div className="record-top"><div><h3>Invoice Health</h3><p className="record-meta">Paid, pending, and overdue invoice counts</p></div><strong className="record-amount">{allInvoices.length}</strong></div><div className="record-meta-grid"><span>Paid {paidInvoices}</span><span>Pending {pendingInvoices}</span><span>Overdue {overdueInvoices}</span></div></article>
          </div>
        </section>
      </section>
    );
  }

  function EmployeeView({ active }) {
    return (
      <section id="employeeView" className={`app-view ${active ? "active" : ""}`} data-title="Manage Employee">
        <section className="panel">
          <div className="panel-header"><div><h2>Manage Employee</h2><div className="panel-subtitle">Employee roles, access, and counter responsibilities.</div></div></div>
          <form className="workspace-form" onSubmit={submitEmployee}>
            <div className="module-grid">
              <label>Employee Name<input name="name" type="text" placeholder="Employee name" required /></label>
              <label>Role<input name="role" type="text" placeholder="Counter Staff" required /></label>
              <label>Phone<input name="phone" type="tel" placeholder="Phone number" /></label>
              <label>Status<select name="status"><option>Active</option><option>Inactive</option></select></label>
            </div>
            <div className="modal-actions"><button type="submit" className="button button-primary">Save Employee</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Employee Records</h2><div className="panel-subtitle">Staff saved in this workspace.</div></div></div>
          <div className="record-list">{employees.length ? employees.map((employee) => {
            const attendanceToday = (employee.attendance || []).find((entry) => entry.date === todayISO());
            return (
              <article className="record-card" key={employee.id}>
                <div className="record-top">
                  <div><h3>{employee.name}</h3><p className="record-meta">{employee.role} | {employee.phone || "No phone"}</p></div>
                  <span className="record-chip">{employee.status}</span>
                </div>
                <div className="attendance-row">
                  <span className="attendance-status">Today: {attendanceToday?.status || "Not marked"}</span>
                  <div className="attendance-actions">
                    {["Present", "Absent", "Half Day"].map((status) => (
                      <button key={status} className="button button-secondary file-action" type="button" onClick={() => markEmployeeAttendance(employee.id, status)}>{status}</button>
                    ))}
                  </div>
                </div>
              </article>
            );
          }) : <Empty>No employees saved yet.</Empty>}</div>
        </section>
      </section>
    );
  }

  function BankView({ active }) {
    return (
      <section id="bankView" className={`app-view ${active ? "active" : ""}`} data-title="Your Bank">
        <section className="panel">
          <div className="panel-header"><div><h2>Your Bank</h2><div className="panel-subtitle">Link the store bank account used for settlements.</div></div></div>
          <form id="bankForm" className="workspace-form" onSubmit={submitBank}>
            <div className="module-grid">
              <label>Account Holder<input name="account_holder" type="text" placeholder="Store or owner name" defaultValue={bankAccount?.accountHolder || ""} required /></label>
              <label>Bank Name<input name="bank_name" type="text" placeholder="Bank name" defaultValue={bankAccount?.bankName || ""} required /></label>
              <label>Account Number<input name="account_number" type="text" inputMode="numeric" placeholder="Account number" defaultValue={bankAccount?.accountNumber || ""} required /></label>
              <label>IFSC<input name="ifsc" type="text" placeholder="IFSC code" defaultValue={bankAccount?.ifsc || ""} required /></label>
              <label>UPI ID<input name="upi_id" type="text" placeholder="Optional" defaultValue={bankAccount?.upiId || ""} /></label>
              <label>Branch<input name="branch" type="text" placeholder="Optional" defaultValue={bankAccount?.branch || ""} /></label>
            </div>
            <div className="modal-actions"><button type="submit" className="button button-primary">Link Bank Account</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Linked Account</h2><div className="panel-subtitle">Settlement account details for this store.</div></div></div>
          <div id="bankAccountCard" className="record-list">{bankAccount ? <article className="record-card bank-card"><div className="record-top"><div><h3>{bankAccount.bankName || "Linked Bank"}</h3><p className="record-meta">{bankAccount.accountHolder || "Account holder not added"}</p></div><strong className="record-amount">{maskAccountNumber(bankAccount.accountNumber)}</strong></div><div className="record-meta-grid"><span>IFSC {bankAccount.ifsc || "Not added"}</span><span>UPI {bankAccount.upiId || "Not added"}</span><span>Branch {bankAccount.branch || "Not added"}</span></div></article> : <Empty>No bank account linked yet. Add the store account used for settlements.</Empty>}</div>
        </section>
      </section>
    );
  }

  function DocumentsView({ active }) {
    return (
      <section id="documentsView" className={`app-view ${active ? "active" : ""}`} data-title="Store Documents">
        <div className="documents-workspace">
          <section className="panel documents-editor-panel">
            <div className="panel-header"><div><h2>Store Documents</h2><div className="panel-subtitle">Trade license, GST papers, FSSAI license, and other store records.</div></div></div>
            <form id="documentForm" className="workspace-form" onSubmit={submitDocument}>
              <section className="inventory-form-section">
                <h3>Document Details</h3>
                <div className="module-grid">
                  <label>Document Type<select name="document_type"><option>Trade License</option><option>GST Document</option><option>FSSAI License</option><option>Rent Agreement</option><option>Insurance</option><option>Other Paper</option></select></label>
                  <label>Document Title<input name="title" type="text" placeholder="Document name" required /></label>
                  <label>Document Number<input name="document_number" type="text" placeholder="Optional" /></label>
                  <label>Issue Date<input name="issue_date" type="date" /></label>
                  <label>Expiry Date<input name="expiry_date" type="date" /></label>
                  <label>File<input name="document_file" type="file" accept="image/*,.pdf" /></label>
                </div>
                <label>Notes<input name="notes" type="text" placeholder="Optional" /></label>
              </section>
              <div className="modal-actions"><button type="submit" className="button button-primary">Save Document</button></div>
            </form>
          </section>
          <section className="panel documents-list-panel">
            <div className="panel-header"><div><h2>Saved Documents</h2><div className="panel-subtitle">Important papers stored in this device workspace.</div></div></div>
            <div id="documentList" className="record-list">{storeDocuments.length ? storeDocuments.map((documentItem) => <article className="record-card" key={documentItem.id}><div className="record-top"><div><h3>{documentItem.title}</h3><p className="record-meta">{documentItem.documentType} | {documentItem.documentNumber || "No number"}</p></div><span className="record-chip">{documentItem.expiryDate ? `Expires ${documentItem.expiryDate}` : "No expiry"}</span></div><div className="record-meta-grid"><span>Issue {documentItem.issueDate || "Not added"}</span><span>{documentItem.fileName || "No file attached"}</span><span>{documentItem.notes || "No notes"}</span></div><div className="record-actions"><FileAction record={documentItem} label="Download Document" /></div></article>) : <Empty>No store documents saved yet. Trade license, GST papers, FSSAI license, and other documents will appear here.</Empty>}</div>
          </section>
        </div>
      </section>
    );
  }

  function DataTransferPanel() {
    const activeConfig = getTransferConfig(activeTransferGuide);
    const activeDraft = transferDrafts[activeConfig.type] || makeTransferDraftState()[activeConfig.type];
    const activePreview = activeDraft.preview;
    const activeProfile = getTransferSourceProfile(activeDraft.sourceSoftware, activeDraft.sourceProfile);
    const activeBusy = !!transferBusy[activeConfig.type];
    const guideSteps = activePreview?.guideSteps || getTransferGuideSteps(activeConfig.type, activeDraft.sourceSoftware, activeDraft.sourceProfile);
    const guideNotes = activePreview?.smartNotes || getTransferSmartNotes(activeConfig.type, activeDraft.sourceSoftware, activeDraft.sourceProfile, activeConfig.smartNotes);

    function clearTransferSelection(type) {
      transferFiles.current[type] = null;
      if (transferFileRefs.current[type]) {
        transferFileRefs.current[type].value = "";
      }
      updateTransferDraft(type, {
        fileName: "",
        preview: null
      });
    }

    return (
      <>
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2>Retrieve Data</h2>
              <div className="panel-subtitle">Choose what you are bringing in, follow the export steps, then let CinchPOS review the file before anything touches the live workspace.</div>
            </div>
          </div>
          <div className="transfer-type-switch" role="tablist" aria-label="Retrieve data sections">
            {dataTransferConfigs.map((config) => {
              const draft = transferDrafts[config.type] || makeTransferDraftState()[config.type];
              const preview = draft.preview;
              const meta = preview?.readyRows
                ? `${preview.readyRows} ready`
                : (draft.fileName ? "File selected" : config.targetLabel);
              return (
                <button
                  key={config.type}
                  type="button"
                  className={`transfer-type-button ${activeTransferGuide === config.type ? "active" : ""}`}
                  aria-pressed={activeTransferGuide === config.type}
                  onClick={() => setActiveTransferGuide(config.type)}
                >
                  <span className="transfer-type-label">{config.title}</span>
                  <span className="transfer-type-meta">{meta}</span>
                </button>
              );
            })}
          </div>
          <div className="transfer-layout">
            <aside className="transfer-guide-shell">
              <div>
                <h3>{activeConfig.title} from {activeProfile.label} to {activeConfig.targetLabel}</h3>
                <p className="record-meta">Use the matching export from the old software, then let CinchPOS review the file before import.</p>
                <p className="transfer-step-note">{activeConfig.destinationHelp}</p>
                <p className="transfer-source-copy">{activeProfile.exportAction}</p>
                <div className="transfer-guide-pills">
                  {activeProfile.supportedFormats.map((format) => (
                    <span key={`${activeConfig.type}-${format}`} className="transfer-guide-pill">{format}</span>
                  ))}
                </div>
                <div className="transfer-guide-pills">
                  {activeConfig.acceptedFields.map((field) => (
                    <span key={field} className="transfer-guide-pill">{field}</span>
                  ))}
                </div>
              </div>
              <div className="transfer-guide-steps">
                {guideSteps.map((step, index) => (
                  <article key={`${activeConfig.type}-${step.title}`} className="transfer-guide-step">
                    <span className="transfer-guide-number">{index + 1}</span>
                    <div className="transfer-guide-detail">
                      <strong>{step.title}</strong>
                      <p>{step.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
              <div className="transfer-smart-list">
                {guideNotes.map((note) => (
                  <span key={note} className="transfer-step-note">{note}</span>
                ))}
              </div>
            </aside>
            <form
              key={activeConfig.type}
              className="workspace-form transfer-card transfer-card-active"
              onSubmit={submitDataTransfer}
            >
              <input type="hidden" name="data_type" value={activeConfig.type} />
              <div className="transfer-card-head">
                <div>
                  <h3>{activeConfig.title}</h3>
                  <p className="record-meta">{activeConfig.subtitle}</p>
                </div>
                <span className="record-chip">{activeConfig.targetLabel}</span>
              </div>
              <section className="transfer-step-block">
                <div className="transfer-step-heading">
                  <span className="transfer-guide-number">1</span>
                  <div className="transfer-guide-detail">
                    <strong>Choose the previous software</strong>
                    <p>Pick the old software so CinchPOS can show the correct export steps and detect the file more accurately.</p>
                  </div>
                </div>
                <label>
                  Old Software
                  <select
                    name="source_profile"
                    value={activeDraft.sourceProfile || "generic"}
                    onChange={(event) => {
                      const nextProfileId = event.target.value;
                      const nextProfile = getTransferSourceProfile("", nextProfileId);
                      updateTransferDraft(activeConfig.type, {
                        sourceProfile: nextProfileId,
                        sourceSoftware: nextProfileId === "custom" ? activeDraft.sourceSoftware || "" : (nextProfile.id === "generic" ? "" : nextProfile.label),
                        preview: null
                      });
                    }}
                  >
                    {transferSourceProfiles.map((profile) => (
                      <option key={`${activeConfig.type}-${profile.id}`} value={profile.id}>{profile.label}</option>
                    ))}
                  </select>
                </label>
                {(activeDraft.sourceProfile || "generic") === "custom" ? (
                  <label>
                    Software Name
                    <input
                      name="source_software"
                      type="text"
                      placeholder="Type the old billing app name"
                      value={activeDraft.sourceSoftware || ""}
                      onChange={(event) => updateTransferDraft(activeConfig.type, { sourceSoftware: event.target.value, preview: null })}
                    />
                  </label>
                ) : null}
              </section>
              <section className="transfer-step-block">
                <div className="transfer-step-heading">
                  <span className="transfer-guide-number">2</span>
                  <div className="transfer-guide-detail">
                    <strong>Upload the export file</strong>
                    <p>Choose the original export directly. CinchPOS accepts spreadsheet, CSV, JSON, and XML formats here.</p>
                  </div>
                </div>
                <label className="transfer-file-field">
                  <span>Upload Export File</span>
                  <input
                    ref={(element) => {
                      if (element) {
                        transferFileRefs.current[activeConfig.type] = element;
                      }
                    }}
                    className="transfer-file-input"
                    name="transfer_file"
                    type="file"
                    accept=".csv,.json,.txt,.xml,.xls,.xlsx,text/csv,application/json,text/plain,application/xml,text/xml,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={(event) => {
                      const selectedFile = event.target.files?.[0] || null;
                      transferFiles.current[activeConfig.type] = selectedFile;
                      updateTransferDraft(activeConfig.type, {
                        transferText: "",
                        fileName: selectedFile?.name || "",
                        preview: null
                      });
                    }}
                  />
                </label>
                {activeDraft.fileName ? (
                  <div className="transfer-file-chip-row">
                    <span className="record-chip">{activeDraft.fileName}</span>
                    <button type="button" className="button button-secondary" onClick={() => clearTransferSelection(activeConfig.type)}>
                      Remove File
                    </button>
                  </div>
                ) : null}
                <div className="transfer-divider">or paste exported rows instead</div>
                <label>
                  Paste Export Data
                  <textarea
                    name="transfer_text"
                    placeholder={activeConfig.placeholder}
                    value={activeDraft.transferText || ""}
                    onChange={(event) => {
                      if (transferFileRefs.current[activeConfig.type]) {
                        transferFileRefs.current[activeConfig.type].value = "";
                      }
                      transferFiles.current[activeConfig.type] = null;
                      updateTransferDraft(activeConfig.type, {
                        transferText: event.target.value,
                        fileName: "",
                        preview: null
                      });
                    }}
                  ></textarea>
                </label>
              </section>
              <section className="transfer-step-block">
                <div className="transfer-step-heading">
                  <span className="transfer-guide-number">3</span>
                  <div className="transfer-guide-detail">
                    <strong>Review first, then import</strong>
                    <p>Review Import checks what is complete, what will update, and what still needs attention before the actual import.</p>
                  </div>
                </div>
                <div className="transfer-guide-pills">
                  {activeProfile.supportedFormats.map((format) => (
                    <span key={`${activeConfig.type}-format-${format}`} className="transfer-guide-pill">{format}</span>
                  ))}
                </div>
                <div className="transfer-guide-pills">
                  {activeConfig.acceptedFields.slice(0, 6).map((field) => (
                    <span key={`${activeConfig.type}-${field}`} className="transfer-guide-pill">{field}</span>
                  ))}
                </div>
                <div className="transfer-actions">
                  <button type="button" className="button button-secondary" disabled={activeBusy} onClick={() => reviewDataTransfer(activeConfig.type)}>
                    {activeBusy ? "Checking..." : "Review Import"}
                  </button>
                  <button type="submit" className="button button-primary" disabled={activeBusy}>
                    {activeBusy ? "Importing..." : `Import ${activeConfig.title}`}
                  </button>
                </div>
                {activePreview ? (
                  <div className="transfer-preview">
                    <div className="transfer-preview-grid">
                      {[
                        ["Rows found", activePreview.totalRows],
                        ["Ready", activePreview.readyRows],
                        ["Will create", activePreview.createCount],
                        ["Will update", activePreview.updateCount],
                        ["Will merge", activePreview.mergeCount],
                        ["Will rename invoice no.", activePreview.renamedInvoices],
                        ["Needs attention", activePreview.issueRows]
                      ].filter(([, value]) => Number(value || 0) > 0).map(([label, value]) => (
                        <div key={label}>
                          <strong>{value}</strong>
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                    {activePreview.detectedFields.length ? (
                      <div className="transfer-preview-fields">
                        {activePreview.detectedFields.map((field) => (
                          <span key={`${activeConfig.type}-${field}`}>{formatTransferFieldLabel(field)}</span>
                        ))}
                      </div>
                    ) : null}
                    {activePreview.warnings.length ? (
                      <div className="transfer-smart-list">
                        {activePreview.warnings.map((warning) => (
                          <span key={warning} className="transfer-step-note">{warning}</span>
                        ))}
                      </div>
                    ) : null}
                    {activePreview.sampleRows.length ? (
                      <div className="transfer-preview-samples">
                        {activePreview.sampleRows.map((sample, index) => (
                          <article key={`${activeConfig.type}-sample-${index}`} className="transfer-preview-sample">
                            <div>
                              <strong>{sample.primary}</strong>
                              <p>{sample.secondary}</p>
                            </div>
                            <span className="record-chip">{sample.badge}</span>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </form>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Transfer Result</h2><div className="panel-subtitle">Imported records are saved into this workspace after validation.</div></div></div>
          <div id="dataTransferResult" className="record-list">{dataTransferResult ? <article className="record-card"><div className="record-top"><div><h3>{dataTransferResult.targetLabel || "Data import"}</h3><p className="record-meta">{dataTransferResult.sourceSoftware || "Previous software"} | {dataTransferResult.message || "Import completed."}</p></div><strong className="record-amount">{Number(dataTransferResult.total || 0)}</strong></div><div className="record-meta-grid">{[["Rows Checked", dataTransferResult.reviewedRows], ["Ready Rows", dataTransferResult.readyRows], ["Customers", dataTransferResult.customers], ["Inventory", dataTransferResult.inventory], ["Invoices", dataTransferResult.invoices], ["Created", dataTransferResult.created], ["Updated", dataTransferResult.updated], ["Merged", dataTransferResult.merged], ["Invoice No. Renamed", dataTransferResult.renamedInvoices], ["Skipped", dataTransferResult.skipped]].filter(([, value], index) => index < 2 || Number(value || 0) > 0).map(([label, value]) => <span key={label}>{label} {Number(value || 0)}</span>)}</div></article> : <Empty>Import customer, inventory, or invoice data after reviewing the file. The result here will clearly show what CinchPOS created, updated, or matched.</Empty>}</div>
        </section>
      </>
    );
  }

  function DataTransferView({ active }) {
    return (
      <section id="dataTransferView" className={`app-view ${active ? "active" : ""}`} data-title="Retrieve Data">
        <DataTransferPanel />
      </section>
    );
  }

  function SettingsForm() {
    const draft = settingsDraft;
    const setDraft = setSettingsDraft;
    const activeSettingsSection = settingsPanelSection;
    const setActiveSettingsSection = setSettingsPanelSection;
    const settingsSections = [
      ["account", "Account Info"],
      ["business", "Business Management"],
      ["personalize", "Personalize"],
      ["invoicing", "Invoicing"],
      ["printing", "Printing"],
      ["data", "Data & Safety"],
      ["support", "Support"],
      ["app", "App Info"],
      ["logout", "Logout"]
    ];
    const invoicePreviewNumber = buildClientInvoiceNumber(todayISO());
    const backupModuleSummary = [
      ["Inventory", workspaceStats.inventory],
      ["Purchases", workspaceStats.purchases],
      ["Purchase Bills", workspaceStats.purchaseBills],
      ["Expenses", workspaceStats.expenses],
      ["Employees", workspaceStats.employees],
      ["Documents", workspaceStats.documents]
    ];
    const apiModuleSummary = [
      ["Customers", workspaceStats.customers],
      ["Invoices", workspaceStats.invoices],
      ["Outstanding", workspaceStats.outstandingInvoices]
    ];
    const workspaceRecordTotal = backupModuleSummary.reduce((total, [, value]) => total + Number(value || 0), 0) + workspaceStats.customers + workspaceStats.invoices;

    function saveSettings(event) {
      event?.preventDefault();
      const sanitizedStartupView = navigationViews.some((view) => view.id === draft.startupView)
        ? draft.startupView
        : defaultSettings.startupView;
      setSettings({
        ...draft,
        businessName: cleanText(draft.businessName, defaultSettings.businessName),
        ownerName: cleanText(draft.ownerName, defaultSettings.ownerName),
        businessPhone: cleanText(draft.businessPhone),
        businessEmail: cleanText(draft.businessEmail),
        businessAddress: cleanText(draft.businessAddress),
        gstin: cleanText(draft.gstin).toUpperCase(),
        storeLogoUrl: cleanText(draft.storeLogoUrl),
        invoicePrefix: cleanText(draft.invoicePrefix, defaultSettings.invoicePrefix),
        defaultDueDays: cleanText(draft.defaultDueDays, defaultSettings.defaultDueDays),
        invoiceNotes: cleanText(draft.invoiceNotes),
        startupView: sanitizedStartupView,
        printPaperSize: cleanText(draft.printPaperSize, defaultSettings.printPaperSize),
        printFooter: cleanText(draft.printFooter),
        printShopLogoOnBill: Boolean(draft.printShopLogoOnBill),
        autoPrintAfterBilling: Boolean(draft.autoPrintAfterBilling),
        showPreviewWatermark: draft.showPreviewWatermark !== false
      });
      showMessage("Settings saved.");
    }

    function exportLocalBackup() {
      const snapshot = {
        app: APP_NAME,
        company: APP_COMPANY,
        exportedAt: new Date().toISOString(),
        scope: "local-workspace",
        version: 1,
        data: {
          settings: { ...defaultSettings, ...settings },
          account,
          inventory: inventoryItems,
          bankAccount,
          purchaseRecords,
          expenseRecords,
          purchaseBills,
          storeDocuments,
          employees,
          posState
        }
      };
      const backupBlob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const backupUrl = URL.createObjectURL(backupBlob);
      const downloadLink = document.createElement("a");
      downloadLink.href = backupUrl;
      downloadLink.download = `cinchpos-local-backup-${todayISO()}.json`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      URL.revokeObjectURL(backupUrl);
      showMessage("Local workspace backup exported.");
    }

    async function handleRestoreBackup(event) {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const content = await readFileAsText(file);
        const payload = JSON.parse(content);
        const snapshot = payload?.data && typeof payload.data === "object" ? payload.data : payload;
        if (!snapshot || typeof snapshot !== "object") {
          throw new Error("This backup file is not a valid CinchPOS workspace export.");
        }
        setSettings({ ...defaultSettings, ...(snapshot.settings || {}) });
        setAccount({ ...defaultAccount, ...(snapshot.account || {}) });
        setInventoryItems(Array.isArray(snapshot.inventory) ? snapshot.inventory : []);
        setBankAccount(snapshot.bankAccount ?? null);
        setPurchaseRecords(Array.isArray(snapshot.purchaseRecords) ? snapshot.purchaseRecords : []);
        setExpenseRecords(Array.isArray(snapshot.expenseRecords) ? snapshot.expenseRecords : []);
        setPurchaseBills(Array.isArray(snapshot.purchaseBills) ? snapshot.purchaseBills : []);
        setStoreDocuments(Array.isArray(snapshot.storeDocuments) ? snapshot.storeDocuments : []);
        setEmployees(Array.isArray(snapshot.employees) ? snapshot.employees : []);
        setPosState(snapshot.posState ? { ...makeInitialPOSState(), ...snapshot.posState } : makeInitialPOSState());
        setDataTransferResult(null);
        setTransferDrafts(makeTransferDraftState());
        showMessage("Local workspace backup restored.");
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "Could not restore the selected backup file.");
      } finally {
        event.target.value = "";
      }
    }

    function resetLocalModules() {
      if (!window.confirm("Clear local inventory, purchases, expenses, employees, documents, and open POS bills on this device? API customers and invoices will stay untouched.")) {
        return;
      }
      setInventoryItems([]);
      setBankAccount(null);
      setPurchaseRecords([]);
      setExpenseRecords([]);
      setPurchaseBills([]);
      setStoreDocuments([]);
      setEmployees([]);
      setPosState(makeInitialPOSState());
      setDataTransferResult(null);
      setTransferDrafts(makeTransferDraftState());
      showMessage("Local workspace modules reset.");
    }

    function renderSettingsScreen() {
      if (activeSettingsSection === "account") {
        return (
          <section className="settings-section">
            <h4>Account Info</h4>
            <div className="settings-account">
              <div className="account-person">
                <span className="account-avatar">{account.loggedIn ? cleanText(account.name, "Operator").charAt(0).toUpperCase() : "?"}</span>
                <div>
                  <strong>{account.loggedIn ? cleanText(account.name, "Operator") : "Not logged in"}</strong>
                  <span>{account.loggedIn ? (account.contact || "Signed in on this counter") : "Login or Sign Up to save account info for this device."}</span>
                </div>
              </div>
              <div className="account-actions">
                <button className="button button-primary" type="button" hidden={account.loggedIn} onClick={() => openModal("login")}>Login or Sign Up</button>
                <button className="button button-secondary" type="button" hidden={!account.loggedIn} onClick={() => { setAccount(defaultAccount); showMessage("Logged out."); }}>Logout</button>
              </div>
            </div>
            <div className="settings-metric-grid">
              {apiModuleSummary.map(([label, value]) => (
                <article className="settings-metric" key={label}>
                  <strong>{Number(value || 0)}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
            <p className="settings-help">Account login is local to this counter right now. Billing data continues to stay in the Flask billing API, while device modules stay inside the workspace storage.</p>
          </section>
        );
      }

      if (activeSettingsSection === "business") {
        const businessStatus = draft.gstin ? "GST Ready" : "Basic Setup";
        return (
          <section className="settings-section">
            <h4>Business Management</h4>
            <div className="form-grid settings-form-grid">
              <label>Store Name<input name="businessName" type="text" placeholder="Store Name" value={draft.businessName || ""} onChange={(event) => setDraft((current) => ({ ...current, businessName: event.target.value }))} /></label>
              <label>Workspace Label<input name="ownerName" type="text" placeholder="Billing Workspace" value={draft.ownerName || ""} onChange={(event) => setDraft((current) => ({ ...current, ownerName: event.target.value }))} /></label>
              <label>Business Phone<input name="businessPhone" type="tel" placeholder="Store contact number" value={draft.businessPhone || ""} onChange={(event) => setDraft((current) => ({ ...current, businessPhone: event.target.value }))} /></label>
              <label>Business Email<input name="businessEmail" type="email" placeholder="store@example.com" value={draft.businessEmail || ""} onChange={(event) => setDraft((current) => ({ ...current, businessEmail: event.target.value }))} /></label>
              <label>GSTIN<input name="gstin" type="text" placeholder="Optional GSTIN" value={draft.gstin || ""} onChange={(event) => setDraft((current) => ({ ...current, gstin: event.target.value.toUpperCase() }))} /></label>
              <label className="settings-span-2">Business Address<textarea name="businessAddress" placeholder="Business address used on printed receipts" value={draft.businessAddress || ""} onChange={(event) => setDraft((current) => ({ ...current, businessAddress: event.target.value }))}></textarea></label>
            </div>
            <div className="record-list">
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Receipt Identity Preview</h3>
                    <p className="record-meta">This is the business information used in printed bills and identity cards inside the workspace.</p>
                  </div>
                  <span className="record-chip">{businessStatus}</span>
                </div>
                <div className="record-meta-grid">
                  <span>{cleanText(draft.businessName, defaultSettings.businessName)}</span>
                  <span>{draft.businessPhone || "No business phone"}</span>
                  <span>{draft.businessEmail || "No business email"}</span>
                  <span>{draft.gstin || "GSTIN not added"}</span>
                </div>
                {draft.businessAddress ? <p className="settings-inline-copy">{draft.businessAddress}</p> : null}
              </article>
            </div>
            <div className="logo-settings">
              <div className="logo-preview" aria-hidden="true">
                <StoreLogo source={draft.storeLogo || draft.storeLogoUrl || ""} fallback={fallbackInitials} alt={draft.logoName || "Business logo preview"} className="settings-store-logo" />
              </div>
              <div className="logo-upload-field">
                <span>Business Logo</span>
                <small>This is the only editable logo in the standard plan. It is used for the current business workspace and thermal receipt branding.</small>
                <input
                  name="storeLogo"
                  type="file"
                  accept="image/*"
                  onChange={async (event) => {
                    const file = event.target.files[0];
                    if (!file) return;
                    try {
                      const logo = await readFileAsDataURL(file);
                      setDraft((current) => ({ ...current, storeLogo: logo, storeLogoUrl: "", logoName: file.name }));
                    } catch (error) {
                      showMessage(error.message);
                    }
                  }}
                />
              </div>
              <button className="button button-secondary" type="button" onClick={() => setDraft((current) => ({ ...current, storeLogo: "", storeLogoUrl: "", logoName: "" }))}>Remove Logo</button>
            </div>
            <div className="record-list">
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Additional Business & Logo</h3>
                    <p className="record-meta">Another logo can be added only when another business is created under this account.</p>
                  </div>
                  <span className="record-chip">Chargeable</span>
                </div>
                <div className="record-meta-grid">
                  <span>Multi-business management is not included in the standard build.</span>
                  <span>Each added business can keep its own logo after the add-on is enabled.</span>
                </div>
                <div className="record-actions">
                  <button className="button button-secondary" type="button" disabled>Paid Add-on Required</button>
                </div>
              </article>
            </div>
            <p className="settings-help">Business details identify this shop workspace. The billing app logo remains fixed, while the business logo and printed identity stay under this section.</p>
          </section>
        );
      }

      if (activeSettingsSection === "personalize") {
        return (
          <section className="settings-section">
            <h4>Personalize</h4>
            <div className="theme-options" role="radiogroup" aria-label="Appearance mode">
              {[
                ["system", "System Default", "Follow device", "theme-system"],
                ["light", "Light Mode", "Bright counter view", "theme-light"],
                ["dark", "Dark Mode", "Low-light workspace", "theme-dark"]
              ].map(([value, title, copy, swatch]) => (
                <label className={`theme-option ${draft.appearance === value ? "active" : ""}`} key={value}>
                  <input type="radio" name="appearance" value={value} checked={draft.appearance === value} onChange={() => setDraft((current) => ({ ...current, appearance: value }))} />
                  <span className={`theme-swatch ${swatch}`}></span>
                  <strong>{title}</strong>
                  <small>{copy}</small>
                </label>
              ))}
            </div>
            <div className="form-grid settings-form-grid">
              <label>Layout Density<select name="density" value={draft.density || "comfortable"} onChange={(event) => setDraft((current) => ({ ...current, density: event.target.value }))}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
              <label>POS Device Type<select name="deviceType" value={draft.deviceType || "desktop"} onChange={(event) => setDraft((current) => ({ ...current, deviceType: event.target.value }))}><option value="desktop">Desktop POS</option><option value="touch">Touch POS</option></select></label>
              <label className="settings-span-2">Start On<select name="startupView" value={draft.startupView || defaultSettings.startupView} onChange={(event) => setDraft((current) => ({ ...current, startupView: event.target.value }))}>{navigationViews.map((view) => <option key={view.id} value={view.id}>{view.title}</option>)}</select></label>
            </div>
            <div className="settings-metric-grid">
              <article className="settings-metric"><strong>{draft.appearance === "system" ? "System" : cleanText(draft.appearance, "System")}</strong><span>Appearance</span></article>
              <article className="settings-metric"><strong>{cleanText(draft.density, "comfortable")}</strong><span>Density</span></article>
              <article className="settings-metric"><strong>{navigationViews.find((view) => view.id === (draft.startupView || defaultSettings.startupView))?.title || "Dashboard"}</strong><span>Startup screen</span></article>
            </div>
            <p className="settings-help">Appearance, density, startup screen, and POS device type stay local to this workspace. Direct route links like /pos still open their own module first.</p>
          </section>
        );
      }

      if (activeSettingsSection === "invoicing") {
        return (
          <section className="settings-section">
            <h4>Invoicing</h4>
            <div className="form-grid settings-form-grid">
              <label>Invoice Prefix<input name="invoicePrefix" type="text" value={draft.invoicePrefix || ""} onChange={(event) => setDraft((current) => ({ ...current, invoicePrefix: event.target.value.toUpperCase() }))} /></label>
              <label>Default Due Days<input name="defaultDueDays" type="number" min="0" step="1" value={draft.defaultDueDays || "0"} onChange={(event) => setDraft((current) => ({ ...current, defaultDueDays: event.target.value }))} /></label>
            </div>
            <label>Default Invoice Notes<textarea name="invoiceNotes" placeholder="Optional invoice note" value={draft.invoiceNotes || ""} onChange={(event) => setDraft((current) => ({ ...current, invoiceNotes: event.target.value }))}></textarea></label>
            <div className="settings-metric-grid">
              <article className="settings-metric"><strong>{invoicePreviewNumber}</strong><span>Next invoice sample</span></article>
              <article className="settings-metric"><strong>{formatDate(defaultDueDate)}</strong><span>Default due date</span></article>
              <article className="settings-metric"><strong>{draft.invoiceNotes ? "Saved" : "Blank"}</strong><span>Default invoice note</span></article>
            </div>
            <p className="settings-help">Manual invoices and POS bills now use the saved prefix when the invoice number field is left blank. Default due days also carry into new invoices.</p>
          </section>
        );
      }

      if (activeSettingsSection === "printing") {
        return (
          <section className="settings-section">
            <h4>Printing</h4>
            <div className="form-grid settings-form-grid">
              <label>Paper Size<select name="printPaperSize" value={draft.printPaperSize || "80mm"} onChange={(event) => setDraft((current) => ({ ...current, printPaperSize: event.target.value }))}><option value="58mm">58mm Receipt</option><option value="80mm">80mm Receipt</option><option value="A4">A4 Invoice</option></select></label>
              <label>Print Footer<input name="printFooter" type="text" value={draft.printFooter || ""} onChange={(event) => setDraft((current) => ({ ...current, printFooter: event.target.value }))} /></label>
            </div>
            <label className="settings-check">
              <input
                name="printShopLogoOnBill"
                type="checkbox"
                checked={Boolean(draft.printShopLogoOnBill)}
                onChange={(event) => setDraft((current) => ({ ...current, printShopLogoOnBill: event.target.checked }))}
              />
              <span>
                <strong>Print shop logo on thermal bill</strong>
                <small>Uses the current business logo and prints it at the top of 58mm and 80mm receipts only.</small>
              </span>
            </label>
            <label className="settings-check">
              <input
                name="autoPrintAfterBilling"
                type="checkbox"
                checked={Boolean(draft.autoPrintAfterBilling)}
                onChange={(event) => setDraft((current) => ({ ...current, autoPrintAfterBilling: event.target.checked }))}
              />
              <span>
                <strong>Auto print after complete billing</strong>
                <small>The regular Complete Billing action will also open the print window when this is enabled.</small>
              </span>
            </label>
            <label className="settings-check">
              <input
                name="showPreviewWatermark"
                type="checkbox"
                checked={draft.showPreviewWatermark !== false}
                onChange={(event) => setDraft((current) => ({ ...current, showPreviewWatermark: event.target.checked }))}
              />
              <span>
                <strong>Show watermark in bill preview</strong>
                <small>This affects only the on-screen CinchPOS bill preview. It does not print on the receipt.</small>
              </span>
            </label>
            <div className="settings-metric-grid">
              <article className="settings-metric"><strong>{draft.printPaperSize || "80mm"}</strong><span>Receipt size</span></article>
              <article className="settings-metric"><strong>{draft.autoPrintAfterBilling ? "On" : "Off"}</strong><span>Auto print</span></article>
              <article className="settings-metric"><strong>{draft.showPreviewWatermark === false ? "Hidden" : "Visible"}</strong><span>Preview watermark</span></article>
            </div>
            <p className="settings-help">Printing now uses the saved business identity, footer, and receipt controls for POS billing.</p>
          </section>
        );
      }

      if (activeSettingsSection === "data") {
        return (
          <section className="settings-section">
            <h4>Data & Safety</h4>
            <div className="record-list settings-card-stack">
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Local Workspace Backup</h3>
                    <p className="record-meta">Export or restore settings, inventory, purchases, expenses, employees, documents, and open POS state saved on this device.</p>
                  </div>
                  <span className="record-chip">JSON</span>
                </div>
                <div className="settings-metric-grid">
                  {backupModuleSummary.map(([label, value]) => (
                    <article className="settings-metric" key={label}>
                      <strong>{Number(value || 0)}</strong>
                      <span>{label}</span>
                    </article>
                  ))}
                </div>
                <p className="settings-inline-copy">Customers and invoices are API-backed, so this local backup does not rewrite server billing data. Use Retrieve Data or backend migration for those records.</p>
                <div className="record-actions settings-data-actions">
                  <button className="button button-secondary" type="button" onClick={exportLocalBackup}>Export Local Backup</button>
                  <button className="button button-primary" type="button" onClick={() => settingsRestoreInputRef.current?.click()}>Restore Local Backup</button>
                </div>
              </article>
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Reset Local Modules</h3>
                    <p className="record-meta">Clear device-only modules while keeping backend billing data untouched.</p>
                  </div>
                  <span className="record-chip">Careful</span>
                </div>
                <div className="record-meta-grid">
                  <span>Clears Inventory, Purchase, Expense, Employee, Document, and open POS data from this device workspace.</span>
                  <span>Does not delete API customers or API invoices.</span>
                </div>
                <div className="record-actions settings-data-actions">
                  <button className="button button-secondary" type="button" onClick={resetLocalModules}>Reset Local Modules</button>
                </div>
              </article>
              <details className="settings-advanced-panel">
                <summary>Advanced Inventory Settings</summary>
                <div className="settings-advanced-body">
                  <div className="record-top">
                    <div>
                      <h3>Clear Saved Inventory</h3>
                      <p className="record-meta">Use this only when you want to remove the full local inventory before a clean reimport.</p>
                    </div>
                    <span className="record-chip">Inventory</span>
                  </div>
                  <div className="settings-metric-grid">
                    <article className="settings-metric"><strong>{workspaceStats.inventory}</strong><span>Items saved</span></article>
                    <article className="settings-metric"><strong>{inventoryItems.length ? "Loaded" : "Empty"}</strong><span>Current state</span></article>
                  </div>
                  <div className="record-meta-grid">
                    <span>Clears only Inventory from this device workspace.</span>
                    <span>Customers, invoices, and the rest of the workspace stay untouched.</span>
                  </div>
                  <div className="record-actions settings-data-actions">
                    <button className="button button-secondary" type="button" onClick={clearInventoryItems} disabled={!inventoryItems.length}>Clear Saved Inventory</button>
                  </div>
                </div>
              </details>
            </div>
          </section>
        );
      }

      if (activeSettingsSection === "support") {
        return (
          <section className="settings-section">
            <h4>Support</h4>
            <div className="record-list settings-card-stack">
              <article className="record-card">
                <h3>Contact Us</h3>
                <p className="record-meta">For setup, data import, branding, printing, and billing workflow help.</p>
                <div className="record-meta-grid"><span>Email support@cinchlive.com</span><span>Business hours support</span></div>
              </article>
              <article className="record-card">
                <h3>Migration Support</h3>
                <p className="record-meta">Use this when moving from myBillBook, Tally, Vyapar, or a CSV-based billing system.</p>
                <div className="record-meta-grid"><span>Retrieve Data wizard</span><span>Review-first import flow</span></div>
              </article>
              <article className="record-card">
                <h3>Help Center</h3>
                <p className="record-meta">Best practice: export a local backup before bulk imports, branding updates, or restoring a migrated workspace.</p>
                <div className="record-meta-grid"><span>Backup before import</span><span>Verify dashboard after import</span></div>
              </article>
              <article className="record-card">
                <h3>Data Safety</h3>
                <p className="record-meta">Customer and invoice records are API-backed. Inventory, purchases, expenses, documents, employees, and settings stay in this workspace unless moved explicitly.</p>
              </article>
            </div>
          </section>
        );
      }

      if (activeSettingsSection === "app") {
        return (
          <section className="settings-section">
            <h4>App Info</h4>
            <div className="record-list settings-card-stack">
              <article className="record-card">
                <div className="record-top">
                  <div className="app-info-title">
                    <AppLogo />
                    <div>
                      <h3>{APP_NAME}</h3>
                      <p className="record-meta">Modern ERP workspace with Flask API billing and Next.js frontend.</p>
                    </div>
                  </div>
                  <span className="record-chip">Desktop Ready</span>
                </div>
                <div className="record-meta-grid"><span>Next.js Frontend</span><span>Flask Billing API</span><span>Local Workspace Storage</span><span>{appPlatform}</span></div>
              </article>
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Workspace Coverage</h3>
                    <p className="record-meta">Everything currently saved across the billing API and this local workspace.</p>
                  </div>
                  <strong className="record-amount">{workspaceRecordTotal}</strong>
                </div>
                <div className="settings-metric-grid">
                  <article className="settings-metric"><strong>{workspaceStats.customers}</strong><span>Customers</span></article>
                  <article className="settings-metric"><strong>{workspaceStats.invoices}</strong><span>Invoices</span></article>
                  <article className="settings-metric"><strong>{workspaceStats.inventory}</strong><span>Inventory Items</span></article>
                  <article className="settings-metric"><strong>{workspaceStats.lowStock}</strong><span>Low Stock (&lt;=5)</span></article>
                  <article className="settings-metric"><strong>{workspaceStats.employees}</strong><span>Employees</span></article>
                  <article className="settings-metric"><strong>{workspaceStats.documents}</strong><span>Documents</span></article>
                </div>
              </article>
            </div>
          </section>
        );
      }

      return (
        <section className="settings-section">
          <h4>Logout</h4>
          <p className="settings-help">End the current local operator session for this counter.</p>
          <div className="record-list">
            <article className="record-card">
              <div className="record-top">
                <div>
                  <h3>{account.loggedIn ? cleanText(account.name, "Operator") : "No active operator"}</h3>
                  <p className="record-meta">{account.loggedIn ? (account.contact || "Signed in on this device") : "Login is currently inactive for this counter."}</p>
                </div>
                <span className="record-chip">{account.loggedIn ? "Active" : "Offline"}</span>
              </div>
              <div className="record-actions settings-data-actions">
                <button className="button button-secondary" type="button" disabled={!account.loggedIn} onClick={() => { setAccount(defaultAccount); showMessage("Logged out."); }}>Logout</button>
              </div>
            </article>
          </div>
        </section>
      );
    }

    return (
      <div id="settingsForm" className="settings-center">
        <input ref={settingsRestoreInputRef} className="settings-hidden-input" type="file" accept=".json,application/json" onChange={handleRestoreBackup} />
        <section className="settings-screen-panel">
          {renderSettingsScreen()}
          <div className="modal-actions">
            <button type="button" className="button button-secondary" onClick={() => { setDraft({ ...defaultSettings }); setSettings({ ...defaultSettings }); showMessage("Settings reset."); }}>Reset</button>
            <button type="button" className="button button-secondary" onClick={closeModal}>Close</button>
            <button type="button" className="button button-primary" onClick={saveSettings}>Save Settings</button>
          </div>
        </section>
        <aside className="settings-nav-panel">
          <div className="settings-nav-list">
            {settingsSections.map(([id, label]) => (
              <button key={id} type="button" className={`settings-nav-item ${activeSettingsSection === id ? "active" : ""}`} onClick={() => setActiveSettingsSection(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="settings-brand-note">{APP_NAME} by {APP_COMPANY}</div>
        </aside>
      </div>
    );
  }
}

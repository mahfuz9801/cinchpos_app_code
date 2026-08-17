"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  createOfflineSession,
  createCustomer,
  createInvoice,
  deleteInvoice,
  getAuthContext,
  getAuthRoles,
  getCustomers,
  getDashboard,
  getInvoices,
  getOnlineStoreProfile,
  getRecoverableLocalBillingData,
  getTrend,
  getWorkspaceSnapshot,
  isApiNetworkError,
  inviteEmployeeAccount,
  loginCinchAccount,
  logoutCinchAccount,
  publishOnlineStore,
  recordPayment,
  recoverLocalBillingData,
  registerCinchAccount,
  requestCinchAccountOtp,
  saveWorkspaceSnapshot,
  setAuthContextProvider,
  setAuthTokenProvider,
  updateCustomer,
  verifyCinchAccountOtp
} from "@/lib/api";
import {
  applyInventorySaleDeductions,
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
  DEFAULT_WALK_IN_CUSTOMER_NAME,
  DEFAULT_WALK_IN_CUSTOMER_PHONE,
  SUPPORT_EMAIL,
  SUPPORT_PHONE,
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
  buildGstr1Workbook,
  makeGstr1ReportFileName,
  writeGstr1Workbook
} from "@/lib/cinchpos/gstr1Report";
import {
  accountFromAuthState,
  clearAccountAuthSession,
  clearOfflineAuthSession,
  getClerkSessionToken,
  hasPermission,
  loadClerkClient,
  makeLocalOwnerAuthState,
  makeSignedOutAuthState,
  normalizeBackendAuthContext,
  normalizeCinchAccountAuth,
  permissionsForRole,
  readAccountAuthSession,
  readOfflineAuthSession,
  writeAccountAuthSession,
  viewPermissionMap,
  writeOfflineAuthSession
} from "@/lib/cinchpos/auth";
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
  normalizePOSState,
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
  transferSourceProfiles
} from "@/lib/cinchpos/transfer";
import { mergePurchaseCollections } from "@/lib/cinchpos/purchases";
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

function sortCustomersByName(collection = []) {
  return [...collection].sort((first, second) => (
    cleanText(first?.name).localeCompare(cleanText(second?.name), undefined, { sensitivity: "base" })
  ));
}

function buildPOSCustomerFromRecord(customer) {
  if (!customer) {
    return {};
  }
  return {
    customerId: customer.id ? String(customer.id) : "",
    name: cleanText(customer.name),
    phone: normalizePhone(customer.phone).slice(-10),
    email: cleanText(customer.email),
    address: cleanText(customer.address)
  };
}

function compactCurrency(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    return currency(0);
  }
  const absolute = Math.abs(amount);
  if (absolute >= 10000000) {
    return `Rs ${(amount / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (absolute >= 100000) {
    return `Rs ${(amount / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  }
  return currency(amount);
}

function buildSmartInventoryReview(items = []) {
  const barcodeGroups = new Map();
  const nameGroups = new Map();
  const lowStock = [];
  const reorder = [];
  const overstock = [];
  const slowMoving = [];
  const fastMoving = [];
  const cleanupCandidates = [];

  items.forEach((item, index) => {
    const id = getInventoryItemKey(item, index);
    const name = cleanText(getInventoryItemName(item), "Untitled item");
    const normalizedName = normalizeKey(name);
    const barcodes = getInventoryItemBarcodes(item);
    const price = Number(item.inclusivePrice || item.inclusive_price || item.price || 0);
    const stock = Number(item.stock || 0);
    const reorderLevel = Math.max(0, Number(item.reorderLevel || item.reorder_level || 5));
    const maxStockLevel = Math.max(reorderLevel + 1, Number(item.maxStockLevel || item.max_stock_level || Math.max(25, reorderLevel * 4)));
    const sold30 = Math.max(0, Number(item.sold30 || item.soldLast30Days || item.monthlySales || 0));
    const summaryEntry = { id, name, barcodes, price, stock, reorderLevel, maxStockLevel, sold30 };

    if (normalizedName) {
      const known = nameGroups.get(normalizedName) || [];
      known.push(summaryEntry);
      nameGroups.set(normalizedName, known);
    }

    barcodes.forEach((barcode) => {
      const normalizedBarcode = normalizeKey(barcode);
      if (!normalizedBarcode) {
        return;
      }
      const known = barcodeGroups.get(normalizedBarcode) || [];
      known.push(summaryEntry);
      barcodeGroups.set(normalizedBarcode, known);
    });

    if (stock <= 0 || price <= 0) {
      cleanupCandidates.push(summaryEntry);
    }
    if (stock <= reorderLevel) {
      lowStock.push(summaryEntry);
    }
    if (stock <= reorderLevel && price > 0) {
      reorder.push(summaryEntry);
    }
    if (stock >= maxStockLevel) {
      overstock.push(summaryEntry);
    }
    if (stock > 8 && sold30 === 0) {
      slowMoving.push(summaryEntry);
    }
    if (sold30 >= Math.max(10, stock * 0.8)) {
      fastMoving.push(summaryEntry);
    }
  });

  const suggestions = [];
  let overlapCount = 0;

  barcodeGroups.forEach((entries, normalizedBarcode) => {
    const uniqueIds = new Set(entries.map((entry) => entry.id));
    if (uniqueIds.size <= 1) {
      return;
    }
    overlapCount += 1;
    const labels = [...new Set(entries.map((entry) => entry.name))].slice(0, 3);
    suggestions.push({
      type: "overlap",
      title: "Shared barcode detected",
      problem: `Barcode ${normalizedBarcode} is assigned to more than one product.`,
      affectedItems: labels,
      itemIds: [...uniqueIds],
      recommendedAction: "Open these products and keep the barcode only on the correct item before billing.",
      detail: `${labels.join(", ")} ${labels.length > 1 ? "use" : "uses"} barcode ${normalizedBarcode}. Review these items before billing.`
    });
  });

  nameGroups.forEach((entries) => {
    const uniqueIds = new Set(entries.map((entry) => entry.id));
    if (uniqueIds.size <= 1) {
      return;
    }
    overlapCount += 1;
    const prices = [...new Set(entries.map((entry) => currency(entry.price)))];
    suggestions.push({
      type: "overlap",
      title: "Possible duplicate item name",
      problem: `${entries[0].name} appears ${entries.length} times${prices.length > 1 ? ` with different prices (${prices.join(", ")})` : ""}.`,
      affectedItems: entries.map((entry) => entry.name),
      itemIds: [...uniqueIds],
      recommendedAction: "Review the duplicate records, merge stock into the right item, and archive or delete unnecessary copies.",
      detail: `${entries[0].name} appears ${entries.length} times${prices.length > 1 ? ` with different prices (${prices.join(", ")})` : ""}. Check whether all copies are needed.`
    });
  });

  const groupedSuggestions = [
    {
      type: "low-stock",
      title: "Low stock alerts",
      entries: lowStock,
      problem: "These products are at or below their reorder level.",
      recommendedAction: "Update stock after physical verification or create a purchase/reorder plan."
    },
    {
      type: "reorder",
      title: "Reorder recommendations",
      entries: reorder,
      problem: "Stock is low enough that the next billing cycle may run out.",
      recommendedAction: "Reorder enough quantity to reach the preferred stock level."
    },
    {
      type: "overstock",
      title: "Overstock alerts",
      entries: overstock,
      problem: "These items are carrying more stock than their expected maximum level.",
      recommendedAction: "Review demand, slow purchases, or run offers to reduce holding cost."
    },
    {
      type: "slow-moving",
      title: "Slow-moving inventory",
      entries: slowMoving,
      problem: "These products have stock but no recent movement data.",
      recommendedAction: "Check expiry, shelf placement, and whether the item should stay active."
    },
    {
      type: "fast-moving",
      title: "Fast-moving inventory",
      entries: fastMoving,
      problem: "These products are moving quickly against available stock.",
      recommendedAction: "Raise reorder level and keep buffer stock available."
    }
  ].filter((suggestion) => suggestion.entries.length).map((suggestion) => ({
    type: suggestion.type,
    title: suggestion.title,
    problem: suggestion.problem,
    affectedItems: suggestion.entries.slice(0, 8).map((entry) => entry.name),
    itemIds: suggestion.entries.map((entry) => entry.id),
    recommendedAction: suggestion.recommendedAction,
    detail: `${suggestion.entries.length} item(s) need attention. ${suggestion.recommendedAction}`
  }));

  const cleanupSuggestions = cleanupCandidates.slice(0, 8).map((entry) => {
    const reasons = [];
    if (entry.stock <= 0) {
      reasons.push("zero or negative stock");
    }
    if (entry.price <= 0) {
      reasons.push("missing price");
    }
    return {
      type: "cleanup",
      title: "Possible cleanup candidate",
      problem: `${entry.name} has ${reasons.join(", ")}.`,
      affectedItems: [entry.name],
      itemIds: [entry.id],
      recommendedAction: "Open this product, complete missing data, or remove it from active inventory.",
      detail: `${entry.name} has ${reasons.join(", ")}. Review whether it still belongs in active inventory.`
    };
  });

  const allSuggestions = [...groupedSuggestions, ...suggestions, ...cleanupSuggestions].slice(0, 18);
  return {
    overlapCount,
    cleanupCount: cleanupCandidates.length,
    lowStockCount: lowStock.length,
    reorderCount: reorder.length,
    overstockCount: overstock.length,
    slowMovingCount: slowMoving.length,
    fastMovingCount: fastMoving.length,
    suggestionCount: allSuggestions.length,
    suggestions: allSuggestions
  };
}

const PRINT_PAPER_PROFILES = {
  "58mm": {
    label: "58mm Thermal Bill",
    pageWidth: "58mm",
    printableWidth: "50.8mm",
    margin: "0",
    layout: "thermal",
    padding: { top: 2, bottom: 2.5, left: 3.7, right: 3 }
  },
  "76mm": {
    label: "76mm Thermal Bill",
    pageWidth: "76mm",
    printableWidth: "68mm",
    margin: "0",
    layout: "thermal",
    padding: { top: 2, bottom: 2.5, left: 4, right: 4 }
  },
  "80mm": {
    label: "80mm Thermal Bill",
    pageWidth: "80mm",
    printableWidth: "72.2mm",
    margin: "0",
    layout: "thermal",
    padding: { top: 2, bottom: 2.5, left: 3.7, right: 3.7 }
  },
  A5: { label: "A5 Standard Bill", pageWidth: "148mm", pageSize: "A5", margin: "8mm", layout: "invoice" },
  A4: { label: "A4 Standard Bill", pageWidth: "210mm", pageSize: "A4", margin: "10mm", layout: "invoice" },
  Letter: { label: "Letter Standard Bill", pageWidth: "216mm", pageSize: "letter", margin: "10mm", layout: "invoice" }
};

const MAX_THERMAL_PAGE_HEIGHT_MM = 280;

const THERMAL_RECEIPT_CSS = `
  .thermal-receipt { display: block; width: 100%; max-width: none; overflow: visible; color: #000; background: #fff; font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; break-inside: auto; page-break-inside: auto; font-variant-numeric: tabular-nums; }
  .thermal-receipt * { box-sizing: border-box; color: #000; }
  .thermal-receipt--58 { font-size: 8.8px; line-height: 1.16; }
  .thermal-receipt--80 { font-size: 10.2px; line-height: 1.17; }
  .thermal-receipt p, .thermal-receipt h1, .thermal-receipt h2, .thermal-receipt h3 { margin: 0; }
  .thermal-header { text-align: center; }
  .thermal-shop-logo { display: block; width: 14mm; max-width: 42%; max-height: 14mm; object-fit: contain; margin: 0 auto 2px; }
  .thermal-receipt--58 .thermal-shop-logo { width: 11mm; max-height: 11mm; }
  .thermal-tax-title { font-size: 1.2em; line-height: 1.08; font-weight: 900; text-transform: uppercase; }
  .thermal-business-name { margin-top: 1px; font-size: 1.08em; line-height: 1.08; font-weight: 900; }
  .thermal-header-line { overflow-wrap: anywhere; }
  .thermal-separator { height: 0; margin: 4px 0; border-top: 1px dashed #000; }
  .thermal-info-block { display: grid; gap: 1px; }
  .thermal-info-line { display: flex; align-items: flex-start; gap: 3px; }
  .thermal-info-line strong { flex: 0 0 auto; font-weight: 900; }
  .thermal-info-line span { min-width: 0; overflow-wrap: anywhere; }
  .thermal-item-table { display: grid; gap: 0; }
  .thermal-item-head, .thermal-item-row { display: grid; grid-template-columns: 12px minmax(0, 1.2fr) 32px 28px 30px 38px 40px; column-gap: 2px; align-items: start; }
  .thermal-receipt--58 .thermal-item-head, .thermal-receipt--58 .thermal-item-row { grid-template-columns: 10px minmax(0, 1.1fr) 23px 22px 24px 29px 31px; column-gap: 1px; }
  .thermal-item-head { padding: 2px 0; border-top: 1px dashed #000; border-bottom: 1px dashed #000; font-size: 0.9em; font-weight: 900; line-height: 1.08; }
  .thermal-item-head span { display: block; min-width: 0; overflow-wrap: anywhere; }
  .thermal-item-head strong { display: block; font-weight: 900; }
  .thermal-item-head small { display: block; font-size: 0.96em; font-weight: 900; line-height: 1.06; }
  .thermal-item-row { padding: 4px 0 3px; border-bottom: 1px dashed #000; break-inside: avoid; page-break-inside: avoid; }
  .thermal-item-row:last-child { border-bottom: 0; }
  .thermal-col-center { text-align: center; }
  .thermal-col-right { text-align: right; }
  .thermal-item-name { min-width: 0; overflow-wrap: anywhere; }
  .thermal-item-name strong { display: block; font-size: 1.06em; line-height: 1.08; font-weight: 900; overflow-wrap: anywhere; }
  .thermal-item-name small { display: block; margin-top: 1px; font-size: 0.86em; line-height: 1.08; font-weight: 700; overflow-wrap: anywhere; }
  .thermal-col-center small, .thermal-col-right small { display: block; margin-top: 1px; font-size: 0.92em; line-height: 1.08; font-weight: 700; }
  .thermal-item-amount { font-weight: 900; }
  .thermal-summary-block, .thermal-payment-block, .thermal-policy-block { display: grid; gap: 2px; break-inside: avoid; page-break-inside: avoid; }
  .thermal-summary-row, .thermal-payment-row { display: flex; justify-content: space-between; gap: 8px; }
  .thermal-summary-row strong, .thermal-payment-row strong { text-align: right; white-space: nowrap; font-weight: 900; }
  .thermal-grand-total { margin-top: 2px; padding: 3px 0; border-top: 1px solid #000; border-bottom: 1px solid #000; font-size: 1.22em; font-weight: 900; text-transform: uppercase; }
  .thermal-grand-total strong { font-size: 1.12em; }
  .thermal-savings { padding: 3px 0; text-align: center; font-size: 1.06em; font-weight: 900; }
  .thermal-policy-block strong { display: block; margin-bottom: 1px; font-weight: 900; }
  .thermal-policy-block p { margin: 0; overflow-wrap: anywhere; white-space: normal; }
  .thermal-footer { padding-top: 6px; text-align: center; font-weight: 800; }
  .thermal-footer strong { display: block; font-size: 1.02em; font-weight: 900; }
`;

function getPrintProfile(paperSize, layout = "") {
  const profile = PRINT_PAPER_PROFILES[paperSize] || PRINT_PAPER_PROFILES["80mm"];
  return {
    ...profile,
    layout: layout || profile.layout
  };
}

function toMicrons(mm) {
  return Math.max(1000, Math.round(Number(mm || 0) * 1000));
}

function getThermalReceiptHeightMm(itemsOrCount = 0, { hasLogo = false, hasFooter = false, hasNotes = false } = {}) {
  const items = Array.isArray(itemsOrCount) ? itemsOrCount : [];
  const itemCount = items.length || Number(itemsOrCount || 0);
  const itemHeight = items.length
    ? items.reduce((total, item) => {
      const textLength = [
        item?.itemName,
        item?.description,
        item?.batch,
        item?.barcode,
        item?.hsn || item?.hsnSac || item?.hsn_sac || item?.sac
      ].map((value) => cleanText(value)).join(" ").length;
      const wrappedLines = Math.max(0, Math.ceil((textLength - 28) / 26));
      return total + 16 + wrappedLines * 4;
    }, 0)
    : itemCount * 18;
  const estimatedHeight = 128 + itemHeight + (hasLogo ? 16 : 0) + (hasNotes ? 42 : 0) + (hasFooter ? 22 : 0);
  return Math.max(180, Math.min(MAX_THERMAL_PAGE_HEIGHT_MM, estimatedHeight));
}

function getElectronPrintPageSize(profile, payload = {}) {
  if (profile.layout === "invoice") {
    return profile.pageSize || "A4";
  }
  const widthMm = Number(String(profile.pageWidth || "80mm").replace(/[^\d.]/g, "")) || 80;
  return {
    width: toMicrons(widthMm),
    height: toMicrons(getThermalReceiptHeightMm(payload.items || [], {
      hasLogo: Boolean(payload.logo),
      hasFooter: Boolean(payload.printFooter),
      hasNotes: Boolean(payload.notes || payload.paymentTerms || payload.terms)
    }))
  };
}

function getThermalBasePadding(profile = {}) {
  return profile.padding || { top: 2, bottom: 2.5, left: 3.7, right: 3.7 };
}

function getPrintPadding(profile = {}, calibration = {}, isInvoice = false) {
  const normalized = normalizePrintCalibration(calibration);
  const base = isInvoice
    ? { top: 10, bottom: 10, left: 10, right: 10 }
    : getThermalBasePadding(profile);
  return [
    Math.max(0, base.top + normalized.top),
    Math.max(0, base.right + normalized.right),
    Math.max(0, base.bottom + normalized.bottom),
    Math.max(0, base.left + normalized.left)
  ].map((value) => `${value}mm`).join(" ");
}

const DEFAULT_PRINT_CALIBRATION = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  scale: 100
};

function getPrintProfileKey(paperSize = "80mm", layout = "") {
  const profile = getPrintProfile(paperSize, layout);
  return `${paperSize || "80mm"}-${profile.layout}`;
}

function normalizePrintCalibration(value = {}) {
  return {
    top: Math.max(-20, Math.min(40, Number(value.top ?? DEFAULT_PRINT_CALIBRATION.top) || 0)),
    bottom: Math.max(-20, Math.min(40, Number(value.bottom ?? DEFAULT_PRINT_CALIBRATION.bottom) || 0)),
    left: Math.max(-20, Math.min(40, Number(value.left ?? DEFAULT_PRINT_CALIBRATION.left) || 0)),
    right: Math.max(-20, Math.min(40, Number(value.right ?? DEFAULT_PRINT_CALIBRATION.right) || 0)),
    scale: Math.max(70, Math.min(130, Number(value.scale ?? DEFAULT_PRINT_CALIBRATION.scale) || 100))
  };
}

function receiptNumber(value, fractionDigits = 2) {
  const number = Number(value || 0);
  const safeNumber = Number.isFinite(number) ? number : 0;
  return safeNumber.toLocaleString("en-IN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  });
}

function receiptQuantity(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return "0";
  }
  return Number.isInteger(number) ? String(number) : receiptNumber(number, 2);
}

function receiptPercent(value) {
  return `${receiptNumber(value, 2)}%`;
}

function receiptMoney(value) {
  return `Rs ${receiptNumber(value, 2)}`;
}

function receiptHTML(value) {
  return escapeHTML(cleanText(value)).replace(/\n/g, "<br>");
}

function limitReceiptText(value, maxLength = 380) {
  const text = cleanText(value).replace(/\s*\|\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}...`;
}

function isAutoGeneratedPOSNote(value = "") {
  const text = cleanText(value);
  return Boolean(
    text
    && /CinchPOS bill/i.test(text)
    && (/Taxable:/i.test(text) || /CGST:/i.test(text) || /SGST:/i.test(text) || /\sx\d+(\.\d+)?\s*@\s*Rs/i.test(text))
  );
}

function getPrintableInvoiceNotes(primaryNote = "", fallbackNote = "", defaultNote = "") {
  const candidates = [primaryNote, fallbackNote, defaultNote]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .filter((value) => value.toLowerCase() !== "cinchpos bill")
    .filter((value) => !isAutoGeneratedPOSNote(value));
  return limitReceiptText(candidates[0] || "");
}

function getDesktopUpdateBridge() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.cinchposDesktop?.updates || null;
}

function getThermalReceiptWidthKey(paperSize = "80mm") {
  return String(paperSize).startsWith("58") ? "58mm" : "80mm";
}

function buildReceiptSettings(settingsLike = {}) {
  return {
    template: cleanText(settingsLike.printReceiptTemplate, defaultSettings.printReceiptTemplate || "retail"),
    showGSTNumber: settingsLike.printShowGSTNumber !== false,
    showCustomerDetails: settingsLike.printShowCustomerDetails !== false,
    showTaxBreakdown: settingsLike.printShowTaxBreakdown !== false,
    showHSN: Boolean(settingsLike.printShowHSN),
    showSavings: settingsLike.printShowSavings !== false,
    showPaymentDetails: settingsLike.printShowPaymentDetails !== false,
    showQRCode: Boolean(settingsLike.printShowQRCode),
    showFooterMessage: settingsLike.printShowFooterMessage !== false,
    showTerms: settingsLike.printShowTerms !== false,
    showCashierName: settingsLike.printShowCashierName !== false,
    showCounterName: settingsLike.printShowCounterName !== false,
    fssai: cleanText(settingsLike.printFssai),
    website: cleanText(settingsLike.printWebsite),
    cashierName: cleanText(settingsLike.printCashierName, defaultSettings.printCashierName || "Admin"),
    counterName: cleanText(settingsLike.printCounterName, defaultSettings.printCounterName || "Counter 1"),
    orderType: cleanText(settingsLike.printOrderType, defaultSettings.printOrderType || "Retail"),
    terms: cleanText(settingsLike.printTermsAndConditions || settingsLike.printFooterTerms),
    refundPolicy: cleanText(settingsLike.printRefundPolicy),
    returnPolicy: cleanText(settingsLike.printReturnPolicy),
    exchangePolicy: cleanText(settingsLike.printExchangePolicy),
    warrantyInfo: cleanText(settingsLike.printWarrantyInfo),
    visitAgainMessage: cleanText(settingsLike.printVisitAgainMessage),
    socialMedia: cleanText(settingsLike.printSocialMedia),
    loyaltyMessage: cleanText(settingsLike.printLoyaltyMessage)
  };
}

function getPayloadReceiptSettings(payload = {}) {
  return {
    ...buildReceiptSettings(defaultSettings),
    ...(payload.receiptSettings || {})
  };
}

function getReceiptTime(payload = {}) {
  if (payload.time) {
    return cleanText(payload.time);
  }
  return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function makeReceiptMetaRow(label, value) {
  const displayValue = cleanText(value);
  if (!displayValue) {
    return "";
  }
  return `<div class="thermal-meta-row"><span>${escapeHTML(label)}</span><strong>${receiptHTML(displayValue)}</strong></div>`;
}

function makeReceiptInfoLine(label, value) {
  const displayValue = cleanText(value);
  if (!displayValue) {
    return "";
  }
  return `<div class="thermal-info-line"><strong>${escapeHTML(label)}</strong><span>${receiptHTML(displayValue)}</span></div>`;
}

function makeThermalSeparator() {
  return `<div class="thermal-separator" aria-hidden="true"></div>`;
}

function buildReceiptTaxRows(items = [], summary = {}) {
  const rows = new Map();
  (items || []).forEach((item) => {
    const quantity = Math.max(0, Number(item.quantity || 0));
    const gstRate = Math.max(0, Number(item.gstRate || 0));
    const gstAmount = Math.max(0, Number(item.gstAmount || 0) * quantity);
    if (!gstRate || !gstAmount) {
      return;
    }
    const label = `GST @${receiptNumber(gstRate, gstRate % 1 ? 2 : 0)}%`;
    rows.set(label, Number(rows.get(label) || 0) + Number(gstAmount || 0));
  });
  if (!rows.size && Number(summary.gst || 0) > 0) {
    rows.set("GST", Number(summary.gst || 0));
  }
  return Array.from(rows.entries()).filter(([, amount]) => Number(amount || 0) > 0);
}

function getReceiptPaymentRows(payload = {}) {
  const explicitRows = Array.isArray(payload.payments) ? payload.payments : [];
  if (explicitRows.length) {
    return explicitRows
      .map((payment) => ({
        method: cleanText(payment.method || payment.label || "Payment"),
        amount: Number(payment.amount || 0)
      }))
      .filter((payment) => payment.amount > 0);
  }
  const paidAmount = Number(payload.paidAmount || 0);
  return paidAmount > 0 ? [{ method: cleanText(payload.paymentMethod, "Cash"), amount: paidAmount }] : [];
}

function buildReceiptPolicyRows(receiptSettings = {}, payload = {}) {
  if (!receiptSettings.showTerms) {
    return [];
  }
  return [
    ["Notes", limitReceiptText(payload.notes, 280)],
    ["Terms & Conditions", limitReceiptText(payload.terms || receiptSettings.terms, 520)]
  ].filter(([, value]) => cleanText(value));
}

function getReceiptItemDescription(item = {}) {
  return cleanText(item.description || item.itemDescription || item.desc || item.notes || item.shortDescription);
}

function getReceiptItemBatch(item = {}) {
  return cleanText(item.batch || item.batchNo || item.batchNumber || item.batch_no || item.lot || item.lotNumber);
}

function getReceiptItemUnit(item = {}) {
  return cleanText(item.unit || item.uom || item.unitName, "Pcs");
}

function buildThermalItemsMarkup(payload = {}) {
  const rows = payload.items || [];

  if (!rows.length) {
    return `<section class="thermal-item-table"><p>No items added.</p></section>`;
  }

  return `<section class="thermal-item-table">
    <div class="thermal-item-head"><span>#</span><span><strong>Item Name</strong><small>HSN</small></span><span class="thermal-col-right"><strong>MRP</strong><small>Disc</small></span><span class="thermal-col-center">Qty</span><span class="thermal-col-right">SP</span><span class="thermal-col-right"><strong>Rate</strong><small>Tax</small></span><span class="thermal-col-right">Amt</span></div>
    ${rows.map((item) => {
      const quantity = Math.max(0, Number(item.quantity || 0));
      const taxableValue = Number(item.taxableValue || 0);
      const taxRate = Number(item.gstRate || 0);
      const description = getReceiptItemDescription(item);
      const batch = getReceiptItemBatch(item);
      const barcode = cleanText(item.barcode);
      const hsn = cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac || barcode, "-");
      const discount = Number(item.discountPercent || 0);
      return `<div class="thermal-item-row">
        <span>${receiptHTML(item.serial || "")}</span>
        <span class="thermal-item-name"><strong>${receiptHTML(item.itemName)}</strong><small>${receiptHTML(hsn)}</small>${description ? `<small>Desc: ${receiptHTML(description)}</small>` : ""}${batch ? `<small>Batch: ${receiptHTML(batch)}</small>` : ""}</span>
        <span class="thermal-col-right">${receiptNumber(item.mrp)}<small>${discount ? `${receiptNumber(discount, discount % 1 ? 2 : 0)}%` : "-"}</small></span>
        <span class="thermal-col-center">${receiptQuantity(quantity)} ${receiptHTML(getReceiptItemUnit(item))}</span>
        <span class="thermal-col-right">${receiptNumber(item.inclusivePrice)}</span>
        <span class="thermal-col-right">${receiptNumber(taxableValue)}<small>${taxRate ? `${receiptNumber(taxRate, taxRate % 1 ? 2 : 0)}%` : "-"}</small></span>
        <span class="thermal-col-right thermal-item-amount">${receiptNumber(item.lineTotal)}</span>
      </div>`;
    }).join("")}
  </section>`;
}

function buildThermalReceiptMarkup(payload = {}) {
  const receiptSettings = getPayloadReceiptSettings(payload);
  const widthKey = getThermalReceiptWidthKey(payload.paperSize);
  const summary = calculatePrintPayloadSummary(payload.items || [], payload.summary);
  const taxRows = buildReceiptTaxRows(payload.items || [], summary);
  const paymentRows = getReceiptPaymentRows(payload);
  const policyRows = buildReceiptPolicyRows(receiptSettings, payload);
  const discountTotal = Number(summary.discountTotal || 0);
  const paidTotal = paymentRows.reduce((total, payment) => total + Number(payment.amount || 0), 0);
  const balanceAmount = Math.max(0, Number(payload.unpaidAmount ?? (Number(summary.total || 0) - paidTotal)) || 0);
  const displayDate = [formatDate(payload.date), getReceiptTime(payload)].filter(Boolean).join(", ");
  const shippingDetails = cleanText(payload.shippingDetails || payload.shipTo || payload.shippingAddress);
  const subTotalAmount = Number(summary.mrpTotal || 0) || Number(summary.total || 0);

  return `<div class="thermal-receipt thermal-receipt--${widthKey === "58mm" ? "58" : "80"}">
    <header class="thermal-header">
      ${payload.logo ? `<img class="thermal-shop-logo" src="${escapeHTML(payload.logo)}" alt="">` : ""}
      <h1 class="thermal-tax-title">TAX INVOICE</h1>
      <h2 class="thermal-business-name">${receiptHTML(payload.businessName || "Store Name")}</h2>
      ${payload.businessAddress ? `<p class="thermal-header-line">${receiptHTML(payload.businessAddress)}</p>` : ""}
      ${payload.businessPhone ? `<p class="thermal-header-line">Phone No : ${receiptHTML(payload.businessPhone)}</p>` : ""}
      ${receiptSettings.showGSTNumber && payload.gstin ? `<p class="thermal-header-line">GST : ${receiptHTML(payload.gstin)}</p>` : ""}
    </header>
    ${makeThermalSeparator()}
    <section class="thermal-info-block">
      ${makeReceiptInfoLine("Invoice No :", payload.invoiceNumber)}
      ${makeReceiptInfoLine("Date :", displayDate)}
      ${receiptSettings.showCustomerDetails ? makeReceiptInfoLine("Bill To :", payload.customerName) : ""}
      ${receiptSettings.showCustomerDetails ? makeReceiptInfoLine("Address :", payload.customerAddress) : ""}
      ${receiptSettings.showCustomerDetails ? makeReceiptInfoLine("Mobile :", payload.customerPhone) : ""}
      ${receiptSettings.showCustomerDetails ? makeReceiptInfoLine("GSTIN :", payload.customerGstin) : ""}
      ${makeReceiptInfoLine("Place Of Supply :", payload.placeOfSupply)}
      ${makeReceiptInfoLine("Shipping Details :", shippingDetails)}
    </section>
    ${makeThermalSeparator()}
    ${buildThermalItemsMarkup(payload)}
    ${makeThermalSeparator()}
    <section class="thermal-summary-block">
      <div class="thermal-summary-row"><span>Sub Total</span><strong>${receiptMoney(subTotalAmount)}</strong></div>
      <div class="thermal-summary-row"><span>Taxable Amount</span><strong>${receiptMoney(summary.subtotal)}</strong></div>
      ${receiptSettings.showTaxBreakdown ? taxRows.map(([label, amount]) => `<div class="thermal-summary-row"><span>${escapeHTML(label)}</span><strong>${receiptMoney(amount)}</strong></div>`).join("") : ""}
      ${discountTotal > 0 ? `<div class="thermal-summary-row"><span>Total Discount</span><strong>${receiptMoney(discountTotal)}</strong></div>` : ""}
      ${Number(payload.roundOff || 0) ? `<div class="thermal-summary-row"><span>Round Off</span><strong>${receiptMoney(payload.roundOff)}</strong></div>` : ""}
      <div class="thermal-summary-row thermal-grand-total"><span>Total Amount</span><strong>${receiptMoney(summary.total)}</strong></div>
    </section>
    ${receiptSettings.showPaymentDetails ? `<section class="thermal-payment-block">
      <div class="thermal-payment-row"><span>Paid Amount</span><strong>${receiptMoney(Number(payload.paidAmount || paidTotal || 0))}</strong></div>
      <div class="thermal-payment-row"><span>Balance Amount</span><strong>${receiptMoney(balanceAmount)}</strong></div>
    </section>` : ""}
    ${receiptSettings.showSavings && discountTotal > 0 ? `<section class="thermal-savings">*** YOU SAVED ${receiptMoney(discountTotal)} ***</section>` : ""}
    ${policyRows.length ? makeThermalSeparator() : ""}
    ${policyRows.length ? `<section class="thermal-policy-block">${policyRows.map(([label, value]) => `<div><strong>${escapeHTML(label)}</strong><p>${receiptHTML(value)}</p></div>`).join("")}</section>` : ""}
    <footer class="thermal-footer">
      ${receiptSettings.showFooterMessage && payload.printFooter ? `<strong>${receiptHTML(payload.printFooter)}</strong>` : ""}
    </footer>
  </div>`;
}

function getCalibrationForSettings(settingsLike = {}) {
  const key = getPrintProfileKey(settingsLike.printPaperSize, settingsLike.printLayout);
  return normalizePrintCalibration(settingsLike.printCalibrationProfiles?.[key]);
}

function buildSamplePrintPayload(settingsLike, businessName, ownerName, logo = "") {
  const sampleItems = [
    { serial: 1, itemName: "Samsung A30", barcode: "1234", description: "Samsung phone", batch: "A30-001", unit: "Pcs", quantity: 1, mrp: 12000, inclusivePrice: 10620, discountPercent: 11.5, taxableValue: 9000, gstRate: 18, gstAmount: 1620, lineTotal: 10620 },
    { serial: 2, itemName: "Parle-G 200g", barcode: "40511209", description: "Best biscuit", batch: "PG-200", unit: "Box", quantity: 1, mrp: 400, inclusivePrice: 306, discountPercent: 23.5, taxableValue: 291.43, gstRate: 5, gstAmount: 14.57, lineTotal: 306 },
    { serial: 3, itemName: "Puma Blue Round Neck T-Shirt", barcode: "2032", description: "Round neck T-shirt", batch: "PUMA-032", unit: "Pcs", quantity: 2, mrp: 1200, inclusivePrice: 945, discountPercent: 21.25, taxableValue: 900, gstRate: 5, gstAmount: 45, lineTotal: 1890 }
  ];
  const summary = calculatePrintPayloadSummary(sampleItems);
  return {
    businessName,
    ownerName,
    businessPhone: settingsLike.businessPhone || "+91 90389 56555",
    businessEmail: settingsLike.businessEmail || "store@example.com",
    businessAddress: settingsLike.businessAddress || "73/S/6, Rajkumar Mukherjee Road, Kolkata",
    gstin: settingsLike.gstin || "GSTIN SAMPLE",
    receiptSettings: buildReceiptSettings(settingsLike),
    cashierName: settingsLike.printCashierName || defaultSettings.printCashierName,
    counterName: settingsLike.printCounterName || defaultSettings.printCounterName,
    orderType: settingsLike.printOrderType || defaultSettings.printOrderType,
    logo: settingsLike.printShopLogoOnBill ? (settingsLike.storeLogo || settingsLike.storeLogoUrl || logo || "") : "",
    paperSize: settingsLike.printPaperSize || defaultSettings.printPaperSize,
    printLayout: settingsLike.printLayout || defaultSettings.printLayout,
    printMargin: settingsLike.printMargin || defaultSettings.printMargin,
    printFooter: settingsLike.printFooter || defaultSettings.printFooter,
    printCalibration: getCalibrationForSettings(settingsLike),
    invoiceNumber: "PREVIEW-0001",
    date: todayISO(),
    dueDate: todayISO(),
    customerName: "Sample Party",
    customerPhone: "7400417400",
    customerEmail: "preview@example.com",
    customerAddress: "No F2, Outer Circle, Connaught Circus, New Delhi, Delhi, 110001",
    customerGstin: "07ABCCH2702H4ZZ",
    placeOfSupply: "Karnataka",
    shippingDetails: "Sample Shipping Company, Plot No. 123, Industrial Area, Andheri East, Mumbai, Maharashtra, 400001",
    paymentMethod: "Cash",
    paymentType: "Full Payment",
    paidAmount: summary.total,
    unpaidAmount: 0,
    notes: "Sample Note",
    paymentTerms: "Payment due on receipt.",
    terms: settingsLike.printTermsAndConditions || settingsLike.printFooterTerms || "Please check MRP and expiry before leaving the counter.\nAll disputes are subject to Kolkata jurisdiction only.",
    summary,
    items: sampleItems
  };
}

function normalizeIFSC(value) {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11);
}

function isValidIFSC(value) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalizeIFSC(value));
}

function isValidUPI(value) {
  const upi = cleanText(value).toLowerCase();
  return !upi || /^[a-z0-9.\-_]{2,256}@[a-z][a-z0-9.\-_]{2,64}$/.test(upi);
}

function normalizeAccountNumber(value) {
  return cleanText(value).replace(/\D/g, "").slice(0, 24);
}

function makeInvoiceBuilderLine(overrides = {}) {
  return {
    id: overrides.id || `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    itemId: overrides.itemId || "",
    itemName: overrides.itemName || "",
    barcode: overrides.barcode || "",
    quantity: overrides.quantity ?? 1,
    mrp: overrides.mrp ?? 0,
    inclusivePrice: overrides.inclusivePrice ?? 0,
    discountPercent: overrides.discountPercent ?? 0,
    gstRate: overrides.gstRate ?? 18
  };
}

function makeInvoiceBuilderDraft(overrides = {}) {
  return {
    template: "gst",
    layout: "standard",
    customerId: "",
    customerName: "",
    customerPhone: "",
    customerEmail: "",
    customerAddress: "",
    invoiceNumber: "",
    issuedOn: todayISO(),
    dueOn: todayISO(),
    paymentTerms: "Payment due on receipt.",
    notes: "",
    terms: "Goods once sold will not be taken back unless required by law.",
    paymentStatus: "pending",
    paymentMethod: "Cash",
    paymentAmount: "",
    headerPlacement: "center",
    logoPlacement: "top",
    businessDetails: "full",
    customerSection: "standard",
    tableLayout: "detailed",
    footerSection: "standard",
    lines: [makeInvoiceBuilderLine()],
    ...overrides
  };
}

function buildInvoiceBuilderLineFromInventory(item = {}) {
  const inclusivePrice = Number(item.inclusivePrice || item.inclusive_price || item.price || 0);
  const mrp = Number(item.mrp || inclusivePrice || 0);
  const barcodes = getInventoryItemBarcodes(item);
  return makeInvoiceBuilderLine({
    itemId: cleanText(item.id),
    itemName: getInventoryItemName(item),
    barcode: barcodes[0] || "",
    quantity: 1,
    mrp,
    inclusivePrice,
    discountPercent: calculateDiscountPercent(mrp, inclusivePrice),
    gstRate: Number(item.gstRate || item.gst_rate || 18)
  });
}

function calculateInvoiceBuilderSummary(lines = []) {
  return lines.reduce((summary, line) => {
    const quantity = Math.max(0, Number(line.quantity || 0));
    const mrp = Math.max(0, Number(line.mrp || 0));
    const inclusivePrice = Math.max(0, Number(line.inclusivePrice || 0));
    const gstRate = Math.max(0, Number(line.gstRate || 0));
    const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
    const lineTotal = inclusivePrice * quantity;
    return {
      quantity: summary.quantity + quantity,
      subtotal: summary.subtotal + (Number(breakup.taxableValue || 0) * quantity),
      cgst: summary.cgst + (Number(breakup.cgst || 0) * quantity),
      sgst: summary.sgst + (Number(breakup.sgst || 0) * quantity),
      gst: summary.gst + (Number(breakup.gstAmount || 0) * quantity),
      mrpTotal: summary.mrpTotal + (mrp * quantity),
      discountTotal: summary.discountTotal + Math.max(0, (mrp - inclusivePrice) * quantity),
      total: summary.total + lineTotal
    };
  }, {
    quantity: 0,
    subtotal: 0,
    cgst: 0,
    sgst: 0,
    gst: 0,
    mrpTotal: 0,
    discountTotal: 0,
    total: 0
  });
}

function calculateLineDiscountAmount(item = {}) {
  const quantity = Math.max(0, Number(item.quantity || 0));
  const mrp = Math.max(0, Number(item.mrp || item.inclusivePrice || 0));
  const sale = Math.max(0, Number(item.inclusivePrice || item.price || 0));
  return Math.max(0, (mrp - sale) * quantity);
}

function calculatePrintPayloadSummary(items = [], summary = {}) {
  const calculated = (items || []).reduce((next, item) => {
    const quantity = Math.max(0, Number(item.quantity || 0));
    const mrp = Math.max(0, Number(item.mrp || item.inclusivePrice || 0));
    const sale = Math.max(0, Number(item.inclusivePrice || item.price || 0));
    const taxable = Math.max(0, Number(item.taxableValue || 0));
    const gstAmount = Math.max(0, Number(item.gstAmount || 0));
    return {
      quantity: next.quantity + quantity,
      mrpTotal: next.mrpTotal + (mrp * quantity),
      discountTotal: next.discountTotal + Math.max(0, (mrp - sale) * quantity),
      subtotal: next.subtotal + (taxable * quantity),
      gst: next.gst + (gstAmount * quantity),
      total: next.total + (sale * quantity)
    };
  }, { quantity: 0, mrpTotal: 0, discountTotal: 0, subtotal: 0, gst: 0, total: 0 });
  const cgst = Number(summary.cgst ?? calculated.gst / 2);
  const sgst = Number(summary.sgst ?? calculated.gst / 2);
  return {
    quantity: Number(summary.quantity ?? calculated.quantity),
    mrpTotal: Number(summary.mrpTotal ?? calculated.mrpTotal),
    discountTotal: Number(summary.discountTotal ?? calculated.discountTotal),
    subtotal: Number(summary.subtotal ?? calculated.subtotal),
    cgst,
    sgst,
    gst: Number(summary.gst ?? (cgst + sgst || calculated.gst)),
    total: Number(summary.total ?? calculated.total)
  };
}

function getInvoiceStorageKey(invoice = {}) {
  return cleanText(invoice.id || invoice.invoice_id || invoice.invoiceNumber || invoice.invoice_number);
}

function makeDownloadFileName(value, fallback = "cinchpos-invoice") {
  const cleaned = cleanText(value, fallback)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
  return cleaned || fallback;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values = []) {
  return values.map(csvCell).join(",");
}

function buildInvoiceDownloadHTML(payload, detail = {}) {
  const summary = calculatePrintPayloadSummary(payload.items, payload.summary);
  const rows = (payload.items || []).map((item) => `
    <tr>
      <td>${item.serial}</td>
      <td class="item-cell"><strong>${escapeHTML(item.itemName)}</strong><span>HSN ${escapeHTML(cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac, "Not added"))}</span>${item.barcode ? `<span>Barcode ${escapeHTML(item.barcode)}</span>` : ""}</td>
      <td class="numeric">${currency(item.mrp)}<span>Disc ${Number(item.discountPercent || 0).toFixed(2)}%</span></td>
      <td class="numeric">${item.quantity}</td>
      <td class="numeric">${currency(item.inclusivePrice)}</td>
      <td class="numeric">${currency(item.taxableValue)}<span>Tax ${Number(item.gstRate || 0)}%</span></td>
      <td class="numeric"><strong>${currency(item.lineTotal)}</strong></td>
    </tr>
  `).join("");
  const logoMarkup = payload.logo ? `<img class="invoice-logo" src="${payload.logo}" alt="Store logo">` : "";
  const businessContact = [payload.businessPhone, payload.businessEmail].filter(Boolean).map((value) => escapeHTML(value)).join(" | ");
  const businessAddress = escapeHTML(payload.businessAddress || "").replace(/\n/g, "<br>");
  const notes = escapeHTML(detail?.notes || "").replace(/\n/g, "<br>");
  const paymentTerms = escapeHTML(detail?.paymentTerms || "").replace(/\n/g, "<br>");
  const terms = escapeHTML(detail?.terms || "").replace(/\n/g, "<br>");
  const safeInvoiceNumber = escapeHTML(payload.invoiceNumber || "CinchPOS Invoice");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeInvoiceNumber}</title>
  <style>
    * { box-sizing: border-box; }
    @page { size: A4; margin: 12mm; }
    body { margin: 0; background: #f3f6f4; color: #111; font-family: Arial, sans-serif; font-size: 12px; }
    .invoice-page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 14mm; background: #fff; }
    .invoice-head { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: start; border-bottom: 2px solid #111; padding-bottom: 14px; }
    .invoice-logo { width: 72px; height: 72px; object-fit: contain; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 22px; }
    .muted { color: #555; }
    .invoice-title { text-align: right; }
    .invoice-title h2 { font-size: 20px; text-transform: uppercase; }
    .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 16px 0; }
    .box { border: 1px solid #ccc; padding: 10px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 8px 6px; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
    th { background: #f2f5f3; font-size: 10px; text-transform: uppercase; }
    th span { display: block; line-height: 1.15; }
    td span { display: block; color: #555; font-size: 10px; margin-top: 2px; }
    .numeric { text-align: right; }
    .item-cell strong { display: block; }
    .totals { max-width: 280px; margin: 14px 0 0 auto; display: grid; gap: 6px; }
    .totals div { display: flex; justify-content: space-between; gap: 16px; }
    .grand { border-top: 2px solid #111; padding-top: 8px; font-size: 15px; font-weight: 700; }
    .notes { display: grid; gap: 8px; margin-top: 18px; }
    @media print {
      body { background: #fff; }
      .invoice-page { margin: 0; padding: 0; width: auto; min-height: auto; }
    }
  </style>
</head>
<body>
  <main class="invoice-page">
    <header class="invoice-head">
      ${logoMarkup}
      <section>
        <h1>${escapeHTML(payload.businessName)}</h1>
        ${payload.ownerName ? `<p>${escapeHTML(payload.ownerName)}</p>` : ""}
        ${businessContact ? `<p>${businessContact}</p>` : ""}
        ${payload.businessAddress ? `<p>${businessAddress}</p>` : ""}
        ${payload.gstin ? `<p>GSTIN: ${escapeHTML(payload.gstin)}</p>` : ""}
      </section>
      <section class="invoice-title">
        <h2>Invoice</h2>
        <p>${safeInvoiceNumber}</p>
        <p class="muted">${escapeHTML(formatDate(payload.date))}</p>
      </section>
    </header>
    <section class="meta-grid">
      <div class="box">
        <h3>Bill To</h3>
        <p>${escapeHTML(payload.customerName)}</p>
        ${payload.customerPhone ? `<p>${escapeHTML(payload.customerPhone)}</p>` : ""}
        ${detail?.customer?.email ? `<p>${escapeHTML(detail.customer.email)}</p>` : ""}
        ${detail?.customer?.address ? `<p>${escapeHTML(detail.customer.address)}</p>` : ""}
      </div>
      <div class="box">
        <h3>Payment</h3>
        <p>Method: ${escapeHTML(payload.paymentMethod)}</p>
        <p>Status: ${escapeHTML(payload.paymentType)}</p>
        <p>Paid: ${currency(payload.paidAmount)}</p>
        <p>Unpaid: ${currency(payload.unpaidAmount)}</p>
      </div>
    </section>
    <table>
      <thead><tr><th>#</th><th><span>Item Name</span><span>HSN</span></th><th><span>MRP</span><span>Disc</span></th><th>Qty</th><th>SP</th><th><span>Rate</span><span>Tax</span></th><th>Amt</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <section class="totals">
      <div><span>Total Qty</span><span>${summary.quantity}</span></div>
      <div><span>Total Rate</span><span>${currency(summary.subtotal)}</span></div>
      <div><span>Total GST</span><span>${currency(summary.gst)}</span></div>
      <div><span>Total Disc</span><span>${currency(summary.discountTotal)}</span></div>
      <div class="grand"><span>Total Amount</span><span>${currency(summary.total)}</span></div>
    </section>
    <section class="notes">
      ${notes ? `<div class="box"><h3>Notes</h3><p>${notes}</p></div>` : ""}
      ${paymentTerms ? `<div class="box"><h3>Payment Terms</h3><p>${paymentTerms}</p></div>` : ""}
      ${terms ? `<div class="box"><h3>Terms & Conditions</h3><p>${terms}</p></div>` : ""}
    </section>
  </main>
</body>
</html>`;
}

function PrintPreviewDocument({ payload }) {
  const profile = getPrintProfile(payload.paperSize, payload.printLayout);
  const calibration = normalizePrintCalibration(payload.printCalibration);
  const isStandard = profile.layout === "invoice";
  const previewPadding = getPrintPadding(profile, calibration, isStandard);
  const rows = payload.items || [];
  const summary = calculatePrintPayloadSummary(rows, payload.summary);
  const thermalMarkup = !isStandard ? buildThermalReceiptMarkup(payload) : "";
  return (
    <div className={`print-preview-stage ${profile.layout}`}>
      <div
        className="print-preview-paper"
        style={{
          "--preview-paper-width": profile.layout === "invoice" ? "210mm" : profile.pageWidth,
          "--preview-padding": previewPadding,
          "--preview-scale": calibration.scale / 100
        }}
      >
        <div className={`print-preview-content ${isStandard ? "" : "thermal-preview-content"}`}>
          {isStandard ? (
            <>
              <div className="print-preview-head">
                {payload.logo ? <img src={payload.logo} alt="Store logo preview" /> : null}
                <h3>{payload.businessName}</h3>
                {payload.ownerName ? <p>{payload.ownerName}</p> : null}
                <p>{[payload.businessPhone, payload.businessEmail].filter(Boolean).join(" | ")}</p>
                {payload.businessAddress ? <p>{payload.businessAddress}</p> : null}
                {payload.gstin ? <p>GSTIN: {payload.gstin}</p> : null}
              </div>
              <div className="print-preview-meta">
                <span><strong>Invoice:</strong> {payload.invoiceNumber}</span>
                <span><strong>Date:</strong> {payload.date}</span>
                {payload.dueDate ? <span>Due {payload.dueDate}</span> : null}
                <span><strong>Customer:</strong> {payload.customerName} {payload.customerPhone ? `(${payload.customerPhone})` : ""}</span>
                {payload.customerEmail ? <span>Email {payload.customerEmail}</span> : null}
                {payload.customerAddress ? <span>Address {payload.customerAddress}</span> : null}
                <span><strong>Payment:</strong> {payload.paymentMethod} | {payload.paymentType}</span>
              </div>
              <table className="print-preview-table standard grouped">
                <thead>
                  <tr>
                    <th>#</th>
                    <th><span>Item Name</span><span>HSN</span></th>
                    <th><span>MRP</span><span>Disc</span></th>
                    <th>Qty</th>
                    <th>SP</th>
                    <th><span>Rate</span><span>Tax</span></th>
                    <th>Amt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={`${item.serial}-${item.itemName}`}>
                      <td>{item.serial}</td>
                      <td>
                        <strong>{item.itemName}</strong>
                        <span>HSN {cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac, "Not added")}</span>
                        {item.barcode ? <span>Barcode {item.barcode}</span> : null}
                      </td>
                      <td>{currency(item.mrp)}<span>Disc {Number(item.discountPercent || 0).toFixed(2)}%</span></td>
                      <td>{item.quantity}</td>
                      <td>{currency(item.inclusivePrice)}</td>
                      <td>{currency(item.taxableValue)}<span>Tax {Number(item.gstRate || 0)}%</span></td>
                      <td><strong>{currency(item.lineTotal)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="print-preview-totals">
                <span>Total Qty <strong>{summary.quantity}</strong></span>
                <span>Total Rate <strong>{currency(summary.subtotal)}</strong></span>
                <span>Total GST <strong>{currency(summary.gst)}</strong></span>
                <span>Total Disc <strong>{currency(summary.discountTotal)}</strong></span>
                <span className="grand">Total Amount <strong>{currency(summary.total)}</strong></span>
              </div>
              {(payload.notes || payload.paymentTerms || payload.terms) ? (
                <div className="print-preview-notes">
                  {payload.notes ? <p><strong>Notes:</strong> {payload.notes}</p> : null}
                  {(payload.paymentTerms || payload.terms) ? (
                    <p><strong>Terms & Conditions:</strong> {[payload.paymentTerms, payload.terms].filter(Boolean).join(" ")}</p>
                  ) : null}
                </div>
              ) : null}
              {payload.printFooter ? <p className="print-preview-footer">{payload.printFooter}</p> : null}
            </>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: thermalMarkup }} />
          )}
        </div>
      </div>
    </div>
  );
}

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
  const [salesReportFilters, setSalesReportFilters] = useState({
    startDate: "",
    endDate: "",
    status: "all",
    content: "full",
    format: "xlsx"
  });
  const [inventorySearch, setInventorySearch] = useState("");
  const [inventorySort, setInventorySort] = useState("nameAsc");
  const [inventoryItems, setInventoryItems] = useState([]);
  const [inventoryVisibleCount, setInventoryVisibleCount] = useState(120);
  const [sellOnlineSearch, setSellOnlineSearch] = useState("");
  const [sellOnlineCatalog, setSellOnlineCatalog] = useState({});
  const [onlineStoreProfile, setOnlineStoreProfile] = useState(null);
  const [onlineStoreBusy, setOnlineStoreBusy] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState(defaultSettings);
  const [settingsPanelSection, setSettingsPanelSection] = useState("account");
  const [bankAccount, setBankAccount] = useState(null);
  const [purchaseRecords, setPurchaseRecords] = useState([]);
  const [expenseRecords, setExpenseRecords] = useState([]);
  const [storeDocuments, setStoreDocuments] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [account, setAccount] = useState(defaultAccount);
  const [authState, setAuthState] = useState(() => makeSignedOutAuthState({ configured: true, required: true }));
  const [authBusy, setAuthBusy] = useState(false);
  const [authRoles, setAuthRoles] = useState([]);
  const [authPermissionCatalog, setAuthPermissionCatalog] = useState({});
  const [employeeAccessRole, setEmployeeAccessRole] = useState("salesman");
  const [employeePermissionDraft, setEmployeePermissionDraft] = useState(() => permissionsForRole("salesman"));
  const [clerkClient, setClerkClient] = useState(null);
  const [authFormMode, setAuthFormMode] = useState("login");
  const [authForm, setAuthForm] = useState({
    customerId: "",
    identifier: "",
    contact: "",
    password: "",
    confirmPassword: "",
    name: "",
    email: "",
    phone: "",
    businessName: "",
    otpIdentifier: "",
    otpCode: "",
    otpSent: false,
    otpMessage: ""
  });
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);
  const [posState, setPosState] = useState(makeInitialPOSState);
  const [posNavigationOpen, setPosNavigationOpen] = useState(false);
  const [dataTransferResult, setDataTransferResult] = useState(null);
  const [transferDrafts, setTransferDrafts] = useState(makeTransferDraftState);
  const [transferBusy, setTransferBusy] = useState(() => dataTransferConfigs.reduce((flags, config) => {
    flags[config.type] = false;
    return flags;
  }, {}));
  const [activeTransferGuide, setActiveTransferGuide] = useState("customers");
  const [invoiceDetails, setInvoiceDetails] = useState({});
  const [supportRequests, setSupportRequests] = useState([]);
  const [supportDraft, setSupportDraft] = useState({
    type: "Support Request",
    name: "",
    email: "",
    phone: "",
    subject: "",
    message: ""
  });
  const [desktopUpdateState, setDesktopUpdateState] = useState({
    currentVersion: "",
    status: "idle",
    message: "Update checks are available in the desktop app.",
    updateInfo: null,
    progress: null,
    canInstall: false,
    packaged: false,
    source: ""
  });
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [invoiceStatusMenu, setInvoiceStatusMenu] = useState(null);
  const [invoiceBuilderDraft, setInvoiceBuilderDraft] = useState(() => makeInvoiceBuilderDraft());
  const [invoiceBuilderSearch, setInvoiceBuilderSearch] = useState("");
  const messageTimer = useRef(null);
  const appWorkspaceRef = useRef(null);
  const posModuleContextRef = useRef(null);
  const inventoryViewContextRef = useRef(null);
  const transferFileRefs = useRef({});
  const transferFiles = useRef({});
  const dashboardRetryTimer = useRef(null);
  const cloudSnapshotTimer = useRef(null);
  const settingsRestoreInputRef = useRef(null);
  const startupViewApplied = useRef(false);
  const authInitStarted = useRef(false);

  const showMessage = useCallback((text) => {
    setMessage(text);
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    messageTimer.current = window.setTimeout(() => setMessage(""), 3200);
  }, []);

  useEffect(() => {
    if (!invoiceStatusMenu) {
      return undefined;
    }
    const closeMenu = () => setInvoiceStatusMenu(null);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [invoiceStatusMenu]);

  useEffect(() => {
    const updates = getDesktopUpdateBridge();
    if (!updates) {
      return undefined;
    }

    let mounted = true;
    updates.getState()
      .then((state) => {
        if (mounted && state) {
          setDesktopUpdateState(state);
        }
      })
      .catch(() => {});

    const unsubscribe = updates.onStatus((state) => {
      if (mounted && state) {
        setDesktopUpdateState(state);
      }
    });

    return () => {
      mounted = false;
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  const runDesktopUpdateAction = useCallback(async (action) => {
    const updates = getDesktopUpdateBridge();
    if (!updates || typeof updates[action] !== "function") {
      showMessage("Desktop updates are available only in the packaged CinchPOS app.");
      return;
    }

    try {
      const nextState = await updates[action]();
      if (nextState && nextState.status) {
        setDesktopUpdateState(nextState);
      }
      if (nextState?.message) {
        showMessage(nextState.message);
      }
    } catch (error) {
      const detail = error?.message || String(error);
      showMessage(`Update action failed. ${detail}`);
      setDesktopUpdateState((current) => ({ ...current, status: "error", message: detail }));
    }
  }, [showMessage]);

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
  const managedBusinesses = useMemo(() => {
    const savedBusinesses = Array.isArray(settings.businesses) ? settings.businesses.filter(Boolean) : [];
    const primaryBusiness = {
      id: "primary",
      name: businessName,
      ownerName,
      phone: settings.businessPhone || "",
      email: settings.businessEmail || "",
      address: settings.businessAddress || "",
      gstin: settings.gstin || "",
      logo: settings.storeLogo || settings.storeLogoUrl || "",
      status: "Active"
    };
    const normalized = savedBusinesses.length ? savedBusinesses : [primaryBusiness];
    return normalized.map((business, index) => ({
      ...primaryBusiness,
      ...business,
      id: cleanText(business.id, index === 0 ? "primary" : `business-${index + 1}`),
      name: cleanText(business.name, index === 0 ? businessName : `Business ${index + 1}`)
    }));
  }, [businessName, ownerName, settings]);
  const activeBusinessId = settings.activeBusinessId || managedBusinesses[0]?.id || "primary";
  const activeBusiness = managedBusinesses.find((business) => business.id === activeBusinessId) || managedBusinesses[0] || null;
  const managedWarehouses = useMemo(() => {
    const savedWarehouses = Array.isArray(settings.warehouses) ? settings.warehouses.filter(Boolean) : [];
    const fallbackWarehouse = {
      id: "main",
      name: "Main Warehouse",
      businessId: activeBusinessId,
      location: settings.businessAddress || "",
      status: "Active"
    };
    const normalized = savedWarehouses.length ? savedWarehouses : [fallbackWarehouse];
    return normalized.map((warehouse, index) => ({
      ...fallbackWarehouse,
      ...warehouse,
      id: cleanText(warehouse.id, index === 0 ? "main" : `warehouse-${index + 1}`),
      name: cleanText(warehouse.name, index === 0 ? "Main Warehouse" : `Warehouse ${index + 1}`),
      businessId: cleanText(warehouse.businessId || warehouse.business_id, activeBusinessId)
    }));
  }, [activeBusinessId, settings.businessAddress, settings.warehouses]);
  const activeWarehouseId = settings.activeWarehouseId || managedWarehouses[0]?.id || "main";
  const activeWarehouse = managedWarehouses.find((warehouse) => warehouse.id === activeWarehouseId) || managedWarehouses[0] || null;
  const fallbackInitials = businessName.split(/\s+/).map((word) => word.charAt(0)).join("").slice(0, 2).toUpperCase() || "CP";
  const currentTitle = appViews.find((view) => view.id === activeView)?.title || "Dashboard";
  const storeLogoSource = settings.storeLogo || settings.storeLogoUrl || "";
  const can = useCallback((permission) => !authState.required || hasPermission(authState, permission), [authState]);
  const canAccessView = useCallback((viewId) => !authState.required || hasPermission(authState, viewPermissionMap[viewId]), [authState]);
  const canManageEmployeeAccess = can("roles:manage");
  const defaultPermissionCatalog = useMemo(() => ({
    "billing:read": "View POS billing",
    "billing:write": "Create and complete bills",
    "invoices:read": "View invoices",
    "invoices:write": "Create and update invoices",
    "payments:write": "Record payments",
    "inventory:read": "View inventory",
    "inventory:write": "Update inventory",
    "purchases:read": "View purchase records",
    "purchases:write": "Manage purchase records",
    "sales:read": "View sales reports",
    "reports:read": "View dashboard and reports",
    "employees:read": "View employees",
    "employees:write": "Manage employees",
    "customers:read": "View customers",
    "customers:write": "Manage customers",
    "suppliers:read": "View suppliers",
    "suppliers:write": "Manage suppliers",
    "business:read": "View business settings",
    "business:write": "Manage businesses",
    "warehouses:read": "View warehouses",
    "warehouses:write": "Manage warehouses",
    "roles:manage": "Manage roles and permissions",
    "ai:use": "Use smart tools",
    "support:use": "Use support"
  }), []);
  const permissionCatalog = useMemo(() => ({
    ...defaultPermissionCatalog,
    ...(authPermissionCatalog || {})
  }), [authPermissionCatalog, defaultPermissionCatalog]);
  const employeePermissionOptions = useMemo(() => Object.entries(permissionCatalog), [permissionCatalog]);
  const getPermissionLabel = useCallback((permission) => permissionCatalog[permission] || cleanText(permission).replace(/[:_]/g, " "), [permissionCatalog]);
  const getRoleDefaultPermissions = useCallback((roleKey) => {
    const normalizedRole = cleanText(roleKey, "employee").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "employee";
    const apiRole = authRoles.find((role) => role.role_key === normalizedRole || role.key === normalizedRole);
    return Array.isArray(apiRole?.permissions) && apiRole.permissions.length
      ? apiRole.permissions
      : permissionsForRole(normalizedRole);
  }, [authRoles]);
  const updateEmployeeAccessRole = useCallback((roleKey) => {
    const normalizedRole = cleanText(roleKey, "salesman").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "salesman";
    setEmployeeAccessRole(normalizedRole);
    setEmployeePermissionDraft(getRoleDefaultPermissions(normalizedRole));
  }, [getRoleDefaultPermissions]);
  const toggleEmployeePermission = useCallback((permission) => {
    setEmployeePermissionDraft((current) => (
      current.includes(permission)
        ? current.filter((entry) => entry !== permission)
        : [...current, permission]
    ));
  }, []);
  const currentSummary = summary || {
    monthly_revenue: 0,
    outstanding_payments: 0,
    expenses_total: 0,
    invoice_count: 0,
    net_balance: 0,
    net_balance_direction: "positive"
  };
  const inventoryStockValue = useMemo(() => inventoryItems.reduce((total, item) => {
    const stock = Math.max(0, Number(item.stock || 0));
    const sellingPrice = Math.max(0, Number(item.inclusivePrice || item.inclusive_price || item.price || item.sellingPrice || 0));
    return total + (stock * sellingPrice);
  }, 0), [inventoryItems]);
  const dashboardExpensesValue = Number(currentSummary.expenses_total || 0);
  const dashboardNetBalance = inventoryStockValue - dashboardExpensesValue;
  const dashboardNetBalanceDirection = dashboardNetBalance < 0 ? "negative" : "positive";
  const isWorkspaceEmpty = !customers.length && !allInvoices.length && Number(currentSummary.invoice_count || 0) === 0;
  const outstandingInvoices = realInvoices.filter((invoice) => invoiceOutstandingAmount(invoice) > 0);
  const trendPeak = Math.max(...(trend.length ? trend : [{ value: 0 }]).map((point) => Number(point.value || 0)), 0);
  const trendCaption = {
    daily: "Collections in the last 7 days",
    weekly: "Collections by week over the last 8 weeks",
    monthly: "Collections in the last 6 months",
    custom: trendStartDate && trendEndDate ? `Collections from ${trendStartDate} to ${trendEndDate}` : "Collections in the selected custom range"
  }[trendView] || "Collections by week over the last 8 weeks";
  const navigationViews = appViews.filter((view) => !view.settingsOnly && canAccessView(view.id));
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
    expenses: expenseRecords.length,
    employees: employees.length,
    documents: storeDocuments.length,
    sellOnline: Object.values(sellOnlineCatalog || {}).filter(Boolean).length,
    businesses: managedBusinesses.length,
    warehouses: managedWarehouses.length,
    supportRequests: supportRequests.length
  }), [
    allInvoices.length,
    customers.length,
    employees.length,
    expenseRecords.length,
    inventoryItems,
    outstandingInvoices.length,
    purchaseRecords.length,
    managedBusinesses.length,
    managedWarehouses.length,
    sellOnlineCatalog,
    storeDocuments.length,
    supportRequests.length
  ]);
  const smartInventoryReview = useMemo(() => buildSmartInventoryReview(inventoryItems), [inventoryItems]);
  const sellOnlineProducts = useMemo(() => {
    const search = normalizeKey(sellOnlineSearch);
    return inventoryItems.map((item, index) => {
      const id = getInventoryItemKey(item, index);
      const name = getInventoryItemName(item);
      const barcode = getInventoryBarcodeLabel(item);
      const stock = Number(item.stock || 0);
      const price = Number(item.inclusivePrice || item.inclusive_price || item.price || 0);
      const catalogEntry = sellOnlineCatalog?.[id] || {};
      const onlinePrice = Number(catalogEntry.onlinePrice || price || 0);
      const searchable = normalizeKey(`${name} ${barcode} ${item.category || ""} ${item.hsn || item.hsnSac || ""}`);
      return {
        id,
        name,
        barcode,
        stock,
        price,
        onlinePrice,
        selected: Boolean(catalogEntry),
        searchable
      };
    }).filter((item) => !search || item.searchable.includes(search));
  }, [inventoryItems, sellOnlineCatalog, sellOnlineSearch]);
  const selectedSellOnlineProducts = useMemo(() => (
    inventoryItems.map((item, index) => {
      const id = getInventoryItemKey(item, index);
      if (!sellOnlineCatalog?.[id]) {
        return null;
      }
      return {
        id,
        name: getInventoryItemName(item),
        barcode: getInventoryBarcodeLabel(item),
        barcodes: getInventoryItemBarcodes(item),
        category: cleanText(item.category),
        hsn: cleanText(item.hsn || item.hsnSac),
        unit: cleanText(item.unit, "Pcs"),
        price: Number(item.inclusivePrice || item.inclusive_price || item.price || 0),
        offlinePrice: Number(item.inclusivePrice || item.inclusive_price || item.price || 0),
        onlinePrice: Number(sellOnlineCatalog[id]?.onlinePrice || item.inclusivePrice || item.inclusive_price || item.price || 0),
        mrp: Number(item.mrp || item.inclusivePrice || item.inclusive_price || item.price || 0),
        gstRate: Number(item.gstRate || item.gst_rate || 0),
        stock: Number(item.stock || 0),
        imageUrl: cleanText(item.imageUrl || item.image_url)
      };
    }).filter(Boolean)
  ), [inventoryItems, sellOnlineCatalog]);
  const invoiceBuilderMatches = useMemo(() => (
    findInventoryMatches(inventoryItems, invoiceBuilderSearch).slice(0, 8)
  ), [inventoryItems, invoiceBuilderSearch]);
  const invoiceBuilderSummary = useMemo(() => (
    calculateInvoiceBuilderSummary(invoiceBuilderDraft.lines || [])
  ), [invoiceBuilderDraft.lines]);
  const selectedInvoice = useMemo(() => (
    selectedInvoiceId
      ? allInvoices.find((invoice) => (
          getInvoiceStorageKey(invoice) === selectedInvoiceId
          || cleanText(invoice.invoice_number || invoice.invoiceNumber) === selectedInvoiceId
        )) || null
      : null
  ), [allInvoices, selectedInvoiceId]);
  const selectedInvoiceDetail = useMemo(() => (
    selectedInvoice ? getInvoiceDetail(selectedInvoice) : null
  ), [invoiceDetails, selectedInvoice]);
  const isOwner = cleanText(authState.role).toLowerCase() === "owner" || authState.userId === "local-owner" || hasPermission(authState, "*");
  const authGateActive = authState.required && !authState.authenticated;
  const visibleBusinessName = authGateActive ? APP_NAME : businessName;
  const visibleOwnerName = authGateActive ? "Secure Workspace" : ownerName;
  const visibleTitle = authGateActive ? "Login Required" : currentTitle;
  const visibleLogoSource = authGateActive ? "" : storeLogoSource;
  const visibleInitials = authGateActive ? "CP" : fallbackInitials;
  const invoiceStatusMenuInvoice = useMemo(() => {
    if (!invoiceStatusMenu?.invoiceId) {
      return null;
    }
    return allInvoices.find((invoice) => getInvoiceStorageKey(invoice) === invoiceStatusMenu.invoiceId) || null;
  }, [allInvoices, invoiceStatusMenu]);
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

  function getInvoiceDetail(invoice) {
    const key = getInvoiceStorageKey(invoice);
    const invoiceNumberKey = cleanText(invoice?.invoice_number || invoice?.invoiceNumber);
    return (key && invoiceDetails[key]) || (invoiceNumberKey && invoiceDetails[invoiceNumberKey]) || null;
  }

  function saveInvoiceDetail(invoice, detail) {
    const key = getInvoiceStorageKey(invoice);
    const numberKey = cleanText(invoice?.invoice_number || invoice?.invoiceNumber || detail?.invoiceNumber);
    if (!key && !numberKey) {
      return;
    }
    setInvoiceDetails((current) => ({
      ...current,
      ...(key ? { [key]: detail } : {}),
      ...(numberKey ? { [numberKey]: detail } : {})
    }));
  }

  function makePrintPayloadFromInvoice(invoice, detail = null) {
    const invoiceDetail = detail || getInvoiceDetail(invoice);
    const lines = Array.isArray(invoiceDetail?.items) ? invoiceDetail.items : [];
    const summaryRows = invoiceDetail?.summary || calculateInvoiceBuilderSummary(lines.map((line) => ({
      quantity: line.quantity,
      mrp: line.mrp,
      inclusivePrice: line.inclusivePrice || line.price || 0,
      gstRate: line.gstRate || 0
    })));
    const customer = invoiceDetail?.customer || findCustomerForInvoice(invoice) || {};
    const normalizedItems = lines.length ? lines.map((item, index) => {
      const quantity = Math.max(1, Number(item.quantity || 1));
      const inclusivePrice = Number(item.inclusivePrice || item.price || 0);
      const gstRate = Number(item.gstRate || 0);
      const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
      return {
        serial: index + 1,
        itemName: cleanText(item.itemName || item.name, `Item ${index + 1}`),
        barcode: cleanText(item.barcode),
        description: cleanText(item.description || item.itemDescription || item.desc || item.shortDescription),
        batch: cleanText(item.batch || item.batchNo || item.batchNumber || item.batch_no || item.lot || item.lotNumber),
        unit: cleanText(item.unit || item.uom || item.unitName, "Pcs"),
        quantity,
        mrp: Number(item.mrp || inclusivePrice || 0),
        inclusivePrice,
        discountPercent: Number(item.discountPercent || calculateDiscountPercent(item.mrp, inclusivePrice) || 0),
        taxableValue: Number(item.taxableValue || breakup.taxableValue || 0),
        gstRate,
        gstAmount: Number(item.gstAmount || breakup.gstAmount || 0),
        hsn: cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac),
        lineTotal: inclusivePrice * quantity
      };
    }) : [{
      serial: 1,
      itemName: "Invoice Amount",
      barcode: "",
      description: "",
      batch: "",
      unit: "Pcs",
      quantity: 1,
      mrp: Number(invoice?.amount || 0),
      inclusivePrice: Number(invoice?.amount || 0),
      discountPercent: 0,
      taxableValue: Number(invoice?.amount || 0),
      gstRate: 0,
      gstAmount: 0,
      lineTotal: Number(invoice?.amount || 0)
    }];
    const printableSummary = calculatePrintPayloadSummary(normalizedItems, {
      ...summaryRows,
      total: Number(invoice?.amount || invoiceDetail?.amount || summaryRows.total || 0)
    });
    return {
      businessName,
      ownerName,
      businessPhone: settings.businessPhone || "",
      businessEmail: settings.businessEmail || "",
      businessAddress: settings.businessAddress || "",
      gstin: settings.gstin || "",
      receiptSettings: buildReceiptSettings(settings),
      cashierName: settings.printCashierName || defaultSettings.printCashierName,
      counterName: settings.printCounterName || defaultSettings.printCounterName,
      orderType: settings.printOrderType || defaultSettings.printOrderType,
      logo: settings.printShopLogoOnBill ? (settings.storeLogo || settings.storeLogoUrl || "") : "",
      paperSize: settings.printPaperSize || defaultSettings.printPaperSize,
      printLayout: settings.printLayout || defaultSettings.printLayout,
      printMargin: settings.printMargin || defaultSettings.printMargin,
      printFooter: settings.printFooter || "",
      printCalibration: getCalibrationForSettings(settings),
      invoiceNumber: invoice?.invoice_number || invoice?.invoiceNumber || invoiceDetail?.invoiceNumber || "",
      date: invoice?.issued_on || invoice?.issuedOn || invoiceDetail?.issuedOn || todayISO(),
      dueDate: invoice?.due_on || invoice?.dueOn || invoiceDetail?.dueOn || "",
      customerName: cleanText(invoice?.customer_name || invoice?.customerName || customer.name, DEFAULT_WALK_IN_CUSTOMER_NAME),
      customerPhone: cleanText(invoice?.customer_phone || invoice?.customerPhone || customer.phone),
      customerEmail: cleanText(customer.email),
      customerAddress: cleanText(customer.address),
      paymentMethod: invoiceDetail?.paymentMethod || "Cash",
      paymentType: invoiceOutstandingAmount(invoice) > 0 ? "Partial / Pending" : "Full Payment",
      paidAmount: invoicePaidAmount(invoice),
      unpaidAmount: invoiceOutstandingAmount(invoice),
      notes: getPrintableInvoiceNotes(invoiceDetail?.notes, invoice?.notes, settings.invoiceNotes),
      paymentTerms: invoiceDetail?.paymentTerms || "",
      terms: invoiceDetail?.terms || "",
      summary: printableSummary,
      items: normalizedItems
    };
  }

  function openInvoiceViewer(invoice) {
    const key = getInvoiceStorageKey(invoice);
    setSelectedInvoiceId(key || cleanText(invoice?.invoice_number || invoice?.invoiceNumber));
    setActiveModal("invoiceViewer");
  }

  function openInvoiceBuilder(overrides = {}) {
    const nextDraft = makeInvoiceBuilderDraft({
      invoiceNumber: buildClientInvoiceNumber(todayISO()),
      dueOn: defaultDueDate,
      notes: settings.invoiceNotes || "",
      ...overrides
    });
    setInvoiceBuilderDraft(nextDraft);
    setInvoiceBuilderSearch("");
    setActiveModal("invoice");
  }

  function duplicateInvoiceToBuilder(invoice) {
    const detail = getInvoiceDetail(invoice);
    const customer = detail?.customer || findCustomerForInvoice(invoice) || {};
    openInvoiceBuilder({
      customerId: cleanText(customer.id || invoice.customer_id),
      customerName: cleanText(customer.name || invoice.customer_name),
      customerPhone: cleanText(customer.phone || getInvoicePhone(invoice)),
      customerEmail: cleanText(customer.email),
      customerAddress: cleanText(customer.address),
      notes: cleanText(detail?.notes || invoice.notes || settings.invoiceNotes),
      paymentStatus: "pending",
      paymentAmount: "",
      lines: detail?.items?.length
        ? detail.items.map((line) => makeInvoiceBuilderLine({
            itemId: line.itemId || "",
            itemName: line.itemName || line.name || "",
            barcode: line.barcode || "",
            quantity: line.quantity || 1,
            mrp: line.mrp || line.inclusivePrice || line.price || 0,
            inclusivePrice: line.inclusivePrice || line.price || 0,
            discountPercent: line.discountPercent || 0,
            gstRate: line.gstRate || 0
          }))
        : [makeInvoiceBuilderLine({ itemName: `Duplicate of ${invoice.invoice_number || "invoice"}`, inclusivePrice: invoice.amount || 0, mrp: invoice.amount || 0, gstRate: 0 })]
    });
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

  function getInvoicePaymentStatus(invoice) {
    const outstandingAmount = invoiceOutstandingAmount(invoice);
    const amount = Number(invoice?.amount || 0);
    if (amount > 0 && outstandingAmount <= 0) {
      return "Paid";
    }
    const rawStatus = cleanText(invoice?.status);
    const dueDate = cleanText(invoice?.due_on || invoice?.dueOn);
    if (rawStatus.toLowerCase() === "overdue" || (dueDate && dueDate < todayISO())) {
      return "Overdue";
    }
    return "Unpaid";
  }

  function openInvoicePaymentAction(invoice) {
    if (invoiceOutstandingAmount(invoice) <= 0) {
      showMessage("This invoice is already marked as paid.");
      return;
    }
    openModal("payment", invoice?.id || invoice?.invoice_id || "");
  }

  function openInvoiceStatusMenu(event, invoice) {
    event.preventDefault();
    event.stopPropagation();
    const invoiceId = getInvoiceStorageKey(invoice);
    if (!invoiceId) {
      showMessage("This invoice has no saved invoice id.");
      return;
    }
    setInvoiceStatusMenu({
      invoiceId,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 190)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 146))
    });
  }

  async function markInvoiceAsPaid(invoice) {
    if (!invoice) {
      setInvoiceStatusMenu(null);
      return;
    }
    const outstandingAmount = invoiceOutstandingAmount(invoice);
    if (outstandingAmount <= 0) {
      setInvoiceStatusMenu(null);
      showMessage("This invoice is already marked as paid.");
      return;
    }
    const invoiceId = invoice.id || invoice.invoice_id;
    if (!invoiceId) {
      setInvoiceStatusMenu(null);
      showMessage("This invoice cannot be updated because it has no saved invoice id.");
      return;
    }

    try {
      await recordPayment({
        invoice_id: invoiceId,
        amount: outstandingAmount,
        paid_on: todayISO(),
        method: "Cash",
        notes: "Marked as paid from invoice status menu."
      });
      setInvoiceStatusMenu(null);
      await loadDashboard();
      showMessage("Invoice marked as paid.");
    } catch (error) {
      setInvoiceStatusMenu(null);
      showMessage(error.message || "Could not mark this invoice as paid.");
    }
  }

  async function deleteInvoiceRecord(invoice) {
    if (!isOwner) {
      showMessage("Only the owner can delete invoices.");
      return;
    }
    const invoiceId = invoice?.id || invoice?.invoice_id;
    if (!invoiceId) {
      showMessage("This invoice cannot be deleted because it has no saved invoice id.");
      return;
    }
    const invoiceNumber = cleanText(invoice.invoice_number || invoice.invoiceNumber, "this invoice");
    if (!window.confirm(`Delete ${invoiceNumber}? This will also remove its payment records.`)) {
      return;
    }

    try {
      await deleteInvoice(invoiceId);
      setInvoiceDetails((current) => {
        const next = { ...current };
        const storageKey = getInvoiceStorageKey(invoice);
        const numberKey = cleanText(invoice.invoice_number || invoice.invoiceNumber);
        if (storageKey) {
          delete next[storageKey];
        }
        if (numberKey) {
          delete next[numberKey];
        }
        return next;
      });
      if (selectedInvoiceId === getInvoiceStorageKey(invoice) || selectedInvoiceId === cleanText(invoice.invoice_number || invoice.invoiceNumber)) {
        setSelectedInvoiceId("");
      }
      if (activeModal === "invoiceViewer") {
        closeModal();
      }
      setInvoiceStatusMenu(null);
      await loadDashboard();
      showMessage("Invoice deleted.");
    } catch (error) {
      showMessage(error.message || "Could not delete this invoice.");
    }
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
    const storedPurchaseRecords = readStoredJSON(storageKeys.purchases, []);
    const legacyPurchaseBills = readStoredJSON(storageKeys.purchaseBills, []);
    const mergedPurchaseRecords = mergePurchaseCollections(storedPurchaseRecords, legacyPurchaseBills);
    setPurchaseRecords(mergedPurchaseRecords);
    if (legacyPurchaseBills.length) {
      writeStoredJSON(storageKeys.purchases, mergedPurchaseRecords, { immediate: true });
      writeStoredJSON(storageKeys.purchaseBills, [], { immediate: true });
    }
    setExpenseRecords(readStoredJSON(storageKeys.expenses, []));
    setStoreDocuments(readStoredJSON(storageKeys.documents, []));
    setEmployees(readStoredJSON(storageKeys.employees, []));
    setSellOnlineCatalog(readStoredJSON(storageKeys.sellOnline, {}));
    setInvoiceDetails(readStoredJSON(storageKeys.invoiceDetails, {}));
    setSupportRequests(readStoredJSON(storageKeys.supportRequests, []));
    setPosState(normalizePOSState(readStoredJSON(storageKeys.pos, makeInitialPOSState())));
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

  const buildWorkspaceSnapshotPayload = useCallback(() => ({
    settings,
    account,
    inventoryItems,
    bankAccount,
    purchaseRecords,
    expenseRecords,
    storeDocuments,
    employees,
    sellOnlineCatalog,
    invoiceDetails,
    supportRequests,
    posState
  }), [
    account,
    bankAccount,
    employees,
    expenseRecords,
    inventoryItems,
    invoiceDetails,
    posState,
    purchaseRecords,
    sellOnlineCatalog,
    settings,
    storeDocuments,
    supportRequests
  ]);

  const applyWorkspaceSnapshotPayload = useCallback((payload) => {
    if (!payload || typeof payload !== "object") {
      return false;
    }
    if (payload.settings && typeof payload.settings === "object") {
      setSettings({ ...defaultSettings, ...payload.settings });
    }
    if (payload.account && typeof payload.account === "object") {
      setAccount({ ...defaultAccount, ...payload.account });
    }
    if (Array.isArray(payload.inventoryItems)) {
      setInventoryItems(payload.inventoryItems);
    }
    if ("bankAccount" in payload) {
      setBankAccount(payload.bankAccount || null);
    }
    if (Array.isArray(payload.purchaseRecords) || Array.isArray(payload.purchaseBills)) {
      setPurchaseRecords(mergePurchaseCollections(payload.purchaseRecords, payload.purchaseBills));
    }
    if (Array.isArray(payload.expenseRecords)) {
      setExpenseRecords(payload.expenseRecords);
    }
    if (Array.isArray(payload.storeDocuments)) {
      setStoreDocuments(payload.storeDocuments);
    }
    if (Array.isArray(payload.employees)) {
      setEmployees(payload.employees);
    }
    if (payload.sellOnlineCatalog && typeof payload.sellOnlineCatalog === "object") {
      setSellOnlineCatalog(payload.sellOnlineCatalog);
    }
    if (payload.invoiceDetails && typeof payload.invoiceDetails === "object") {
      setInvoiceDetails(payload.invoiceDetails);
    }
    if (Array.isArray(payload.supportRequests)) {
      setSupportRequests(payload.supportRequests);
    }
    if (payload.posState && typeof payload.posState === "object") {
      setPosState(normalizePOSState(payload.posState));
    }
    return true;
  }, []);

  const pullCloudWorkspace = useCallback(async () => {
    if (!authState.authenticated || authState.offline) {
      return false;
    }
    setCloudSyncBusy(true);
    try {
      const snapshot = await getWorkspaceSnapshot();
      const applied = applyWorkspaceSnapshotPayload(snapshot?.payload);
      if (applied) {
        showMessage("Cloud workspace synced.");
      }
      return applied;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not sync cloud workspace.");
      return false;
    } finally {
      setCloudSyncBusy(false);
    }
  }, [applyWorkspaceSnapshotPayload, authState.authenticated, authState.offline, showMessage]);

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
    writeStoredJSON(storageKeys.sellOnline, sellOnlineCatalog);
  }, [sellOnlineCatalog, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.invoiceDetails, invoiceDetails);
  }, [invoiceDetails, workspaceLoaded]);
  useEffect(() => {
    if (!workspaceLoaded) {
      return;
    }
    writeStoredJSON(storageKeys.supportRequests, supportRequests);
  }, [supportRequests, workspaceLoaded]);
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
    if (!workspaceLoaded || !authState.authenticated || authState.offline || !can("business:write")) {
      return undefined;
    }
    if (cloudSnapshotTimer.current) {
      window.clearTimeout(cloudSnapshotTimer.current);
    }
    cloudSnapshotTimer.current = window.setTimeout(() => {
      cloudSnapshotTimer.current = null;
      saveWorkspaceSnapshot(buildWorkspaceSnapshotPayload()).catch(() => {
        // Snapshot sync is best-effort; local saved data remains available on this device.
      });
    }, 1800);
    return () => {
      if (cloudSnapshotTimer.current) {
        window.clearTimeout(cloudSnapshotTimer.current);
        cloudSnapshotTimer.current = null;
      }
    };
  }, [authState.authenticated, authState.offline, buildWorkspaceSnapshotPayload, can, workspaceLoaded]);

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

  useEffect(() => {
    setAuthContextProvider(() => ({
      businessId: activeBusinessId,
      warehouseId: activeWarehouseId
    }));
    setAuthTokenProvider(async () => authState.token || getClerkSessionToken(clerkClient));
  }, [activeBusinessId, activeWarehouseId, authState.token, clerkClient]);

  useEffect(() => {
    if (!workspaceLoaded || authGateActive || !can("sales:read")) {
      return;
    }
    loadOnlineStoreProfile();
  }, [activeBusinessId, authGateActive, can, workspaceLoaded]);

  const syncAuthContext = useCallback(async (client = clerkClient, options = {}) => {
    setAuthBusy(true);
    try {
      const payload = await getAuthContext();
      let nextAuthState = normalizeBackendAuthContext(payload);

      if (client?.user) {
        const primaryEmail = client.user.primaryEmailAddress?.emailAddress || "";
        nextAuthState = {
          ...nextAuthState,
          authenticated: true,
          userId: nextAuthState.userId || client.user.id || "",
          name: nextAuthState.name || client.user.fullName || client.user.firstName || primaryEmail || "Operator",
          email: nextAuthState.email || primaryEmail,
          emailVerified: nextAuthState.emailVerified || Boolean(client.user.primaryEmailAddress?.verification?.status === "verified"),
          sessionId: nextAuthState.sessionId || client.session?.id || ""
        };
      }

      if (!nextAuthState.authenticated && !payload?.auth_required) {
        nextAuthState = makeLocalOwnerAuthState({ reason: "auth-not-required" });
      }

      setAuthState(nextAuthState);
      setAccount(accountFromAuthState(nextAuthState));

      if (client?.session && nextAuthState.authenticated) {
        try {
          const grant = await createOfflineSession({ deviceInfo: navigator.userAgent || "CinchPOS Desktop" });
          await writeOfflineAuthSession(nextAuthState, grant);
        } catch {
          await writeOfflineAuthSession(nextAuthState, { status: "local-cache-only" });
        }
      }

      return nextAuthState;
    } catch (error) {
      const offlineSession = authState.token ? null : await readOfflineAuthSession();
      if (offlineSession?.authState) {
        const cachedAuthState = {
          ...offlineSession.authState,
          authenticated: true,
          offline: true
        };
        setAuthState(cachedAuthState);
        setAccount(accountFromAuthState(cachedAuthState));
        if (!options.silent) {
          showMessage("Using encrypted offline auth cache. New logins need internet.");
        }
        return cachedAuthState;
      }

      const fallbackState = authState.required
        ? makeSignedOutAuthState({ configured: true, required: true, reason: "auth-context-unavailable" })
        : makeLocalOwnerAuthState({ reason: "auth-context-unavailable" });
      setAuthState(fallbackState);
      setAccount(accountFromAuthState(fallbackState));
      if (!options.silent) {
        showMessage(error instanceof Error ? error.message : "Could not refresh auth context.");
      }
      return fallbackState;
    } finally {
      setAuthBusy(false);
    }
  }, [authState.required, authState.token, clerkClient, showMessage]);

  useEffect(() => {
    if (!workspaceLoaded || authInitStarted.current) {
      return undefined;
    }
    authInitStarted.current = true;
    let cancelled = false;
    let removeListener = null;

    async function initializeAuth() {
      setAuthBusy(true);
      const cachedAccountSession = await readAccountAuthSession();
      if (cachedAccountSession?.authState?.token && !cancelled) {
        const cachedAuthState = {
          ...cachedAccountSession.authState,
          authenticated: true,
          offline: false
        };
        setAuthState(cachedAuthState);
        setAccount(accountFromAuthState(cachedAuthState));
        setAuthTokenProvider(async () => cachedAuthState.token);
        try {
          const snapshot = await getWorkspaceSnapshot();
          if (!cancelled) {
            applyWorkspaceSnapshotPayload(snapshot?.payload);
          }
        } catch {
          // Keep the saved account session active; the next API call can reconnect when the service is ready.
        }
        setAuthBusy(false);
        return;
      }
      const cachedSession = await readOfflineAuthSession();
      if (cachedSession?.authState && !cancelled) {
        const cachedAuthState = { ...cachedSession.authState, authenticated: true, offline: true };
        setAuthState(cachedAuthState);
        setAccount(accountFromAuthState(cachedAuthState));
      }

      const client = await loadClerkClient();
      if (cancelled) {
        return;
      }
      if (client) {
        setClerkClient(client);
        setAuthTokenProvider(async () => getClerkSessionToken(client));
        if (typeof client.addListener === "function") {
          removeListener = client.addListener(() => {
            syncAuthContext(client, { silent: true });
          });
        }
        await syncAuthContext(client, { silent: true });
      } else if (!cachedSession?.authState) {
        await syncAuthContext(null, { silent: true });
      }
      setAuthBusy(false);
    }

    initializeAuth().catch(() => setAuthBusy(false));

    return () => {
      cancelled = true;
      if (typeof removeListener === "function") {
        removeListener();
      }
    };
  }, [applyWorkspaceSnapshotPayload, syncAuthContext, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || !can("employees:read")) {
      return;
    }
    getAuthRoles()
      .then((payload) => {
        const roles = Array.isArray(payload) ? payload : (Array.isArray(payload?.roles) ? payload.roles : []);
        setAuthRoles(roles);
        setAuthPermissionCatalog(payload?.permissions && typeof payload.permissions === "object" ? payload.permissions : {});
      })
      .catch(() => {
        setAuthRoles([]);
        setAuthPermissionCatalog({});
      });
  }, [can, workspaceLoaded]);

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

  const recoverPreviousLocalBilling = useCallback(async () => {
    if (!authState.authenticated || authState.offline) {
      showMessage("Login as the owner before recovering previous local billing data.");
      return false;
    }
    setCloudSyncBusy(true);
    try {
      const preview = await getRecoverableLocalBillingData();
      const localCounts = preview?.local_counts || {};
      const recoverableTotal = Number(localCounts.customers || 0) + Number(localCounts.invoices || 0) + Number(localCounts.payments || 0);
      if (!preview?.recoverable || recoverableTotal <= 0) {
        showMessage("No previous local invoices or customers were found to recover.");
        return false;
      }
      const confirmed = window.confirm(
        `Recover ${Number(localCounts.invoices || 0)} invoice(s), ${Number(localCounts.customers || 0)} customer(s), and ${Number(localCounts.payments || 0)} payment record(s) from the previous local workspace into this account? CinchPOS will make a database backup first.`
      );
      if (!confirmed) {
        return false;
      }
      const result = await recoverLocalBillingData();
      await loadDashboard();
      showMessage(`${result.message || "Previous local billing data recovered."} Recovered ${Number(result.recovered?.invoices || 0)} invoice(s).`);
      return true;
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not recover previous billing data.");
      return false;
    } finally {
      setCloudSyncBusy(false);
    }
  }, [authState.authenticated, authState.offline, loadDashboard, showMessage]);

  useEffect(() => {
    let cancelled = false;

    const attemptLoad = async (attempt = 1) => {
      try {
        await loadDashboard();
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (isApiNetworkError(error)) {
          const retryDelay = Math.min(5000, 650 + attempt * 500);
          dashboardRetryTimer.current = window.setTimeout(() => {
            dashboardRetryTimer.current = null;
            attemptLoad(attempt + 1);
          }, retryDelay);
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

    if (authGateActive) {
      return () => {
        cancelled = true;
      };
    }

    attemptLoad();

    return () => {
      cancelled = true;
      if (dashboardRetryTimer.current) {
        window.clearTimeout(dashboardRetryTimer.current);
        dashboardRetryTimer.current = null;
      }
    };
  }, [authGateActive, loadDashboard, showMessage]);

  function switchView(viewId) {
    setActiveView(viewId);
    setPosNavigationOpen(false);
    appWorkspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openModal(name, invoiceId = "") {
    setPrefillInvoiceId(invoiceId || "");
    if (name === "invoice") {
      openInvoiceBuilder();
      return;
    }
    if (name === "settings") {
      setSettingsDraft(settings);
      setSettingsPanelSection("account");
    }
    setActiveModal(name);
  }

  function closeModal() {
    setActiveModal("");
    setPrefillInvoiceId("");
    setSelectedInvoiceId("");
  }

  function updateAuthForm(field, value) {
    setAuthForm((current) => ({ ...current, [field]: value }));
  }

  async function activateCinchAccountSession(payload, { persistInitialSnapshot = false, successMessage = "Logged in successfully." } = {}) {
    const nextAuthState = normalizeCinchAccountAuth(payload);
    await writeAccountAuthSession(nextAuthState, payload.expires_at || "");
    await clearOfflineAuthSession();
    setAuthState(nextAuthState);
    setAccount(accountFromAuthState(nextAuthState));
    setAuthTokenProvider(async () => nextAuthState.token);
    setAuthForm((current) => ({
      ...current,
      password: "",
      confirmPassword: "",
      otpCode: "",
      otpSent: false,
      otpMessage: ""
    }));
    closeModal();

    try {
      const snapshot = await getWorkspaceSnapshot();
      const applied = applyWorkspaceSnapshotPayload(snapshot?.payload);
      if (!applied && persistInitialSnapshot) {
        await saveWorkspaceSnapshot(buildWorkspaceSnapshotPayload());
      }
    } catch {
      if (persistInitialSnapshot) {
        await saveWorkspaceSnapshot(buildWorkspaceSnapshotPayload()).catch(() => {});
      }
    }
    await loadDashboard().catch(() => {});
    showMessage(successMessage);
  }

  async function submitCinchAccountAuth(event) {
    event.preventDefault();
    if (authBusy) {
      return;
    }
    const password = String(authForm.password || "");
    const businessName = cleanText(authForm.businessName);
    if (authFormMode === "register") {
      const contact = cleanText(authForm.contact || authForm.email || authForm.phone);
      const isEmail = contact.includes("@");
      const email = isEmail ? contact.toLowerCase() : "";
      const phone = isEmail ? "" : normalizePhone(contact).slice(-10);
      if (!businessName || !contact || !password) {
        showMessage("Add business name, email id or phone number, and password.");
        return;
      }
      if (isEmail && !email.includes("@")) {
        showMessage("Enter a valid email id.");
        return;
      }
      if (!isEmail && phone.length !== 10) {
        showMessage("Phone number must be 10 digits.");
        return;
      }
      setAuthBusy(true);
      try {
        const payload = await registerCinchAccount({
          business_name: businessName,
          contact,
          email,
          phone,
          password
        });
        await activateCinchAccountSession(payload, {
          persistInitialSnapshot: true,
          successMessage: "CinchPOS account created."
        });
      } catch (error) {
        showMessage(error instanceof Error ? error.message : "Could not create account.");
      } finally {
        setAuthBusy(false);
      }
      return;
    }

    const identifier = cleanText(authForm.identifier || authForm.otpIdentifier || authForm.customerId);
    if (!identifier || !password) {
      showMessage("Enter email id or phone number and password.");
      return;
    }
    setAuthBusy(true);
    try {
      const payload = await loginCinchAccount({ identifier, password });
      await activateCinchAccountSession(payload, {
        successMessage: "Logged in successfully."
      });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Login failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function requestCinchOtp() {
    if (authBusy) {
      return;
    }
    const identifier = cleanText(authForm.identifier || authForm.otpIdentifier || authForm.contact);
    if (!identifier) {
      showMessage("Enter your email id or phone number.");
      return;
    }
    setAuthBusy(true);
    try {
      const payload = await requestCinchAccountOtp({
        identifier,
        channel: identifier.includes("@") ? "email" : "phone"
      });
      setAuthForm((current) => ({
        ...current,
        identifier,
        otpIdentifier: identifier,
        otpSent: true,
        otpCode: payload.dev_otp || "",
        otpMessage: payload.message || "OTP sent. Enter it below."
      }));
      showMessage(payload.delivery_warning ? `${payload.message} (${payload.delivery_warning})` : (payload.message || "OTP sent."));
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not send OTP.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function verifyCinchOtp(event) {
    event?.preventDefault?.();
    if (authBusy) {
      return;
    }
    const identifier = cleanText(authForm.identifier || authForm.otpIdentifier || authForm.contact);
    const otp = normalizePhone(authForm.otpCode);
    if (!identifier || !otp) {
      showMessage("Enter your email id or phone number and OTP.");
      return;
    }
    setAuthBusy(true);
    try {
      const payload = await verifyCinchAccountOtp({ identifier, otp });
      await activateCinchAccountSession(payload, { successMessage: "Logged in with OTP." });
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "OTP login failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function openClerkFlow(flow = "signIn") {
    setAuthBusy(true);
    try {
      const client = clerkClient || await loadClerkClient();
      if (!client) {
        showMessage("Add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to enable online login.");
        return;
      }
      setClerkClient(client);
      if (flow === "signUp" && typeof client.openSignUp === "function") {
        client.openSignUp({});
        return;
      }
      if (flow === "profile" && typeof client.openUserProfile === "function") {
        client.openUserProfile({});
        return;
      }
      if (typeof client.openSignIn === "function") {
        client.openSignIn({});
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOutOfAuth() {
    setAuthBusy(true);
    try {
      if (authState.token) {
        await logoutCinchAccount().catch(() => {});
      }
      if (clerkClient?.signOut) {
        await clerkClient.signOut();
      }
      await clearAccountAuthSession();
      await clearOfflineAuthSession();
      const signedOutState = makeSignedOutAuthState({
        configured: true,
        required: true
      });
      setAuthState(signedOutState);
      setAccount(defaultAccount);
      setAuthTokenProvider(async () => "");
      setActiveView("dashboardView");
      setRenderedViews({ dashboardView: true });
      setActiveModal("login");
      showMessage("Signed out of this device.");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not sign out.");
    } finally {
      setAuthBusy(false);
    }
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

  function replaceCustomerInState(customerRecord) {
    setCustomers((current) => sortCustomersByName([
      ...current.filter((customer) => String(customer.id || "") !== String(customerRecord.id || "")),
      customerRecord
    ]));
  }

  async function ensureDefaultWalkInCustomer() {
    const existingCustomer = customers.find((customer) => (
      phonesMatch(customer.phone, DEFAULT_WALK_IN_CUSTOMER_PHONE)
      || cleanText(customer.name).toLowerCase() === DEFAULT_WALK_IN_CUSTOMER_NAME.toLowerCase()
    ));
    if (existingCustomer) {
      return existingCustomer;
    }
    const walkInCustomer = await createCustomer({
      name: DEFAULT_WALK_IN_CUSTOMER_NAME,
      phone: DEFAULT_WALK_IN_CUSTOMER_PHONE,
      email: "",
      address: ""
    });
    replaceCustomerInState(walkInCustomer);
    return walkInCustomer;
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
    updateActiveBill(formId, (bill) => {
      const currentCustomer = { ...defaultPOSCustomer, ...(bill.customer || {}) };
      const matchedCustomer = phone.length === 10 ? findCustomerByPhone(phone) : null;
      return {
        ...bill,
        customer: matchedCustomer
          ? {
              ...currentCustomer,
              ...buildPOSCustomerFromRecord(matchedCustomer),
              paymentMethod: currentCustomer.paymentMethod,
              paymentType: currentCustomer.paymentType,
              partialAmount: currentCustomer.partialAmount
            }
          : {
              ...currentCustomer,
              phone,
              customerId: ""
            }
      };
    });
  }

  function getCustomerStatus(customer) {
    const phone = normalizePhone(customer.phone).slice(-10);
    const name = cleanText(customer.name);
    const email = cleanText(customer.email);
    const address = cleanText(customer.address);
    if (!phone && !name && !email && !address) {
      return `Customer details are optional. ${DEFAULT_WALK_IN_CUSTOMER_NAME} (${formatIndianPhone(DEFAULT_WALK_IN_CUSTOMER_PHONE)}) will be used if you save the bill without filling this section.`;
    }
    if (!phone && name) {
      return "Customer will be saved without a phone number unless you add one.";
    }
    if (phone.length !== 10) {
      return "Phone number should be 10 digits to match an existing customer.";
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
    const { didDelete } = deletePOSBillFromInstance(getPOSInstance(formId), billId);
    if (!didDelete) {
      showMessage("Keep at least one bill open.");
      return;
    }
    updatePOSInstance(formId, (current) => deletePOSBillFromInstance(current, billId).nextInstance);
    showMessage("Bill deleted.");
  }

  function resetActivePOSBill(formId) {
    updateActiveBill(formId, (bill) => ({ ...bill, items: [], customer: { ...defaultPOSCustomer } }));
  }

  async function ensurePOSCustomer(formId) {
    const customer = getActiveBill(formId).customer || defaultPOSCustomer;
    const phone = normalizePhone(customer.phone).slice(-10);
    const name = cleanText(customer.name);
    const email = cleanText(customer.email);
    const address = cleanText(customer.address);
    const existingCustomer = phone.length === 10 ? findCustomerByPhone(phone) : null;
    if (existingCustomer) {
      updatePOSCustomer(formId, buildPOSCustomerFromRecord(existingCustomer));
      return { record: existingCustomer, usedWalkInCustomer: false };
    }
    if (!phone && !name && !email && !address) {
      const walkInCustomer = await ensureDefaultWalkInCustomer();
      updatePOSCustomer(formId, buildPOSCustomerFromRecord(walkInCustomer));
      return { record: walkInCustomer, usedWalkInCustomer: true };
    }
    const newCustomer = await createCustomer({
      name: name || DEFAULT_WALK_IN_CUSTOMER_NAME,
      phone: phone.length === 10 ? `+91${phone}` : "",
      email,
      address
    });
    replaceCustomerInState(newCustomer);
    updatePOSCustomer(formId, buildPOSCustomerFromRecord(newCustomer));
    return { record: newCustomer, usedWalkInCustomer: false };
  }

  function deductSoldInventory(soldItems = []) {
    const result = applyInventorySaleDeductions(inventoryItems, soldItems);
    if (result.deductions.length) {
      setInventoryItems(result.items);
    }
    return result;
  }

  function printPOSBill(payload) {
    const printProfile = getPrintProfile(payload.paperSize, payload.printLayout);
    const printPageWidth = printProfile.pageWidth;
    const isInvoicePrint = printProfile.layout === "invoice";
    const printPageSize = printProfile.pageSize || "auto";
    const printMargin = payload.printMargin === "none" ? "0" : printProfile.margin;
    const printClass = isInvoicePrint ? "invoice-print" : "thermal-print";
    const calibration = normalizePrintCalibration(payload.printCalibration);
    const printPadding = getPrintPadding(printProfile, calibration, isInvoicePrint);
    const printScale = isInvoicePrint ? calibration.scale / 100 : 1;
    const printScaleFactor = isInvoicePrint ? Math.max(70, Math.min(130, Math.round(calibration.scale || 100))) : 100;
    const printableSummary = calculatePrintPayloadSummary(payload.items, payload.summary);
    const printRows = payload.items.map((item) => `
      <tr>
        <td>${item.serial}</td>
        <td><strong>${escapeHTML(item.itemName)}</strong><span>HSN ${escapeHTML(cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac, "Not added"))}</span>${item.barcode ? `<span>Barcode ${escapeHTML(item.barcode)}</span>` : ""}</td>
        <td>${currency(item.mrp)}<span>Disc ${Number(item.discountPercent || 0).toFixed(2)}%</span></td>
        <td>${item.quantity}</td>
        <td>${currency(item.inclusivePrice)}</td>
        <td>${currency(item.taxableValue)}<span>Tax ${Number(item.gstRate || 0)}%</span></td>
        <td><strong>${currency(item.lineTotal)}</strong></td>
      </tr>
    `).join("");
    const itemsMarkup = isInvoicePrint ? `<table>
      <thead><tr><th>#</th><th><span>Item Name</span><span>HSN</span></th><th><span>MRP</span><span>Disc</span></th><th>Qty</th><th>SP</th><th><span>Rate</span><span>Tax</span></th><th>Amt</th></tr></thead>
      <tbody>${printRows}</tbody>
    </table>` : buildThermalReceiptMarkup(payload);
    const logoMarkup = payload.logo ? `<img class="print-logo" src="${payload.logo}" alt="Store logo">` : "";
    const safeInvoiceNumber = escapeHTML(payload.invoiceNumber || "CinchPOS Bill");
    const safeBusinessName = escapeHTML(payload.businessName);
    const safeOwnerName = escapeHTML(payload.ownerName || "");
    const safeBusinessPhone = escapeHTML(payload.businessPhone || "");
    const safeBusinessEmail = escapeHTML(payload.businessEmail || "");
    const safeBusinessAddress = escapeHTML(payload.businessAddress || "").replace(/\n/g, "<br>");
    const safeCustomerEmail = escapeHTML(payload.customerEmail || "");
    const safeCustomerAddress = escapeHTML(payload.customerAddress || "").replace(/\n/g, "<br>");
    const safeGstin = escapeHTML(payload.gstin || "");
    const safeFooter = escapeHTML(payload.printFooter || "").replace(/\n/g, "<br>");
    const safeDate = escapeHTML(payload.date);
    const safeDueDate = escapeHTML(payload.dueDate || "");
    const safeCustomerName = escapeHTML(payload.customerName);
    const safeCustomerPhone = escapeHTML(payload.customerPhone || "");
    const safePaymentMethod = escapeHTML(payload.paymentMethod);
    const safePaymentType = escapeHTML(payload.paymentType);
    const safeNotes = escapeHTML(limitReceiptText(payload.notes, 280)).replace(/\n/g, "<br>");
    const safePaymentTerms = escapeHTML(payload.paymentTerms || "").replace(/\n/g, "<br>");
    const safeTerms = escapeHTML(payload.terms || "").replace(/\n/g, "<br>");
    const businessContact = [payload.businessPhone ? safeBusinessPhone : "", payload.businessEmail ? safeBusinessEmail : ""].filter(Boolean).join(" | ");
    const standardDetails = isInvoicePrint ? [
      payload.dueDate ? `<p>Due: ${safeDueDate}</p>` : "",
      payload.customerEmail ? `<p>Email: ${safeCustomerEmail}</p>` : "",
      payload.customerAddress ? `<p>Address: ${safeCustomerAddress}</p>` : ""
    ].filter(Boolean).join("") : "";
    const safeTermsCombined = [safePaymentTerms, safeTerms].filter(Boolean).join("<br>");
    const noteMarkup = (payload.notes || payload.paymentTerms || payload.terms) ? `
      <div class="print-notes">
        ${payload.notes ? `<p><strong>Notes:</strong> ${safeNotes}</p>` : ""}
        ${safeTermsCombined ? `<p><strong>Terms & Conditions:</strong><br>${safeTermsCombined}</p>` : ""}
      </div>
    ` : "";
    const invoiceBodyMarkup = `
      <div class="print-head">${logoMarkup}<h1>${safeBusinessName}</h1>${payload.ownerName ? `<p>${safeOwnerName}</p>` : ""}${businessContact ? `<p>${businessContact}</p>` : ""}${payload.businessAddress ? `<p>${safeBusinessAddress}</p>` : ""}${payload.gstin ? `<p>GSTIN: ${safeGstin}</p>` : ""}</div>
      <div class="print-meta">
        <p>Bill: ${safeInvoiceNumber}</p>
        <p>Date: ${safeDate}</p>
        <p>Customer: ${safeCustomerName} ${payload.customerPhone ? `(${safeCustomerPhone})` : ""}</p>
        ${standardDetails}
        <p>Payment: ${safePaymentMethod} | ${safePaymentType}</p>
      </div>
      ${itemsMarkup}
      <div class="totals">
        <div><span>Total Qty</span><span>${printableSummary.quantity}</span></div>
        <div><span>Total Rate</span><span>${currency(printableSummary.subtotal)}</span></div>
        <div><span>Total GST</span><span>${currency(printableSummary.gst)}</span></div>
        <div><span>Total Disc</span><span>${currency(printableSummary.discountTotal)}</span></div>
        <div class="grand"><span>Total Amount</span><span>${currency(printableSummary.total)}</span></div>
      </div>
      ${noteMarkup}
      ${payload.printFooter ? `<div class="print-footer">${safeFooter}</div>` : ""}
    `;
    const printBodyMarkup = isInvoicePrint ? invoiceBodyMarkup : itemsMarkup;

    const markup = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>${safeInvoiceNumber}</title>
        <style>
          * { box-sizing: border-box; }
          ${isInvoicePrint
            ? `@page { size: ${printPageSize}; margin: ${printMargin}; }`
            : "@page { margin: 0; }"}
          html, body { width: ${printPageWidth}; min-height: 0; overflow: visible; }
          body { margin: 0; padding: ${printPadding}; color: #111; font-family: Arial, sans-serif; font-size: ${isInvoicePrint ? "12px" : "10.2px"}; line-height: 1.22; }
          .print-content { transform: ${isInvoicePrint ? `scale(${printScale})` : "none"}; transform-origin: top left; width: ${isInvoicePrint && printScale ? `${100 / printScale}%` : "100%"}; break-inside: auto; page-break-inside: auto; }
          .print-head { display: grid; justify-items: center; gap: ${isInvoicePrint ? "4px" : "1px"}; margin-bottom: ${isInvoicePrint ? "10px" : "5px"}; text-align: center; }
          .print-logo { width: ${isInvoicePrint ? "72px" : "28px"}; height: ${isInvoicePrint ? "72px" : "28px"}; object-fit: contain; }
          h1 { margin: 0; font-size: ${isInvoicePrint ? "20px" : "12px"}; font-weight: 700; }
          p { margin: 0; }
          .print-meta { display: grid; gap: ${isInvoicePrint ? "3px" : "1px"}; margin: ${isInvoicePrint ? "8px 0" : "5px 0"}; padding: ${isInvoicePrint ? "8px 0" : "4px 0"}; border-top: 1px dashed #777; border-bottom: 1px dashed #777; }
          table { width: 100%; border-collapse: collapse; }
          th, td { padding: ${isInvoicePrint ? "6px 5px" : "3px 2px"}; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; }
          th { font-size: ${isInvoicePrint ? "10px" : "8px"}; font-weight: 700; }
          th span,
          th small { display: block; line-height: 1.12; }
          td strong { display: block; font-weight: 700; }
          td span { display: block; color: #555; font-size: ${isInvoicePrint ? "10px" : "8px"}; }
          .invoice-print table th:nth-child(1),
          .invoice-print table td:nth-child(1) { width: 5%; }
          .invoice-print table th:nth-child(2),
          .invoice-print table td:nth-child(2) { width: 32%; }
          .invoice-print table th:nth-child(3),
          .invoice-print table td:nth-child(3) { width: 12%; text-align: right; }
          .invoice-print table th:nth-child(4),
          .invoice-print table td:nth-child(4) { width: 8%; text-align: center; }
          .invoice-print table th:nth-child(5),
          .invoice-print table td:nth-child(5),
          .invoice-print table th:nth-child(6),
          .invoice-print table td:nth-child(6),
          .invoice-print table th:nth-child(7),
          .invoice-print table td:nth-child(7) { width: 14%; text-align: right; }
          .invoice-print .totals { max-width: 280px; margin-left: auto; }
          .totals { display: grid; gap: ${isInvoicePrint ? "4px" : "2px"}; margin-top: ${isInvoicePrint ? "10px" : "5px"}; padding-top: ${isInvoicePrint ? "8px" : "5px"}; border-top: 1px dashed #777; }
          .totals div { display: flex; justify-content: space-between; gap: 10px; }
          .grand { margin-top: ${isInvoicePrint ? "2px" : "3px"}; padding-top: ${isInvoicePrint ? "0" : "3px"}; border-top: ${isInvoicePrint ? "0" : "1px dashed #999"}; font-size: ${isInvoicePrint ? "15px" : "11.5px"}; font-weight: 700; }
          .print-notes { display: grid; gap: 4px; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #777; color: #333; }
          .print-footer { margin-top: ${isInvoicePrint ? "16px" : "14px"}; padding-top: ${isInvoicePrint ? "10px" : "9px"}; border-top: 1px dashed #777; text-align: center; color: #444; font-size: ${isInvoicePrint ? "10px" : "8.8px"}; }
          ${isInvoicePrint ? "" : THERMAL_RECEIPT_CSS}
          @media print { html, body { width: ${printPageWidth}; height: auto; overflow: visible; } .thermal-print .print-content { transform: none !important; width: 100% !important; } }
        </style>
      </head>
      <body class="${printClass}">
        <div class="print-content">
        ${printBodyMarkup}
        </div>
      </body>
      </html>
    `;

    const desktopPrinter = typeof window !== "undefined" ? window.cinchposDesktop?.printHTML : null;
    if (typeof desktopPrinter === "function") {
      desktopPrinter({
        html: markup,
        title: payload.invoiceNumber || "CinchPOS Bill",
        pageSize: getElectronPrintPageSize(printProfile, payload),
        isThermal: !isInvoicePrint,
        scaleFactor: printScaleFactor
      })
        .then((result) => {
          if (result?.cancelled) {
            showMessage("Print cancelled.");
          }
        })
        .catch((error) => {
          showMessage(error?.message || "The system print dialog could not open.");
        });
      return;
    }

    const frame = document.createElement("iframe");
    frame.className = "print-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.right = "100%";
    frame.style.bottom = "100%";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.visibility = "hidden";
    document.body.appendChild(frame);

    const frameWindow = frame.contentWindow;
    const frameDocument = frame.contentDocument || frameWindow?.document;
    if (!frameWindow || !frameDocument) {
      frame.remove();
      showMessage("Bill saved, but the print view could not open.");
      return;
    }

    const cleanup = () => {
      window.setTimeout(() => {
        frame.remove();
      }, 400);
    };

    const finalizePrint = () => {
      frameWindow.focus();
      frameWindow.print();
      cleanup();
    };

    const waitForAssetsAndPrint = () => {
      const images = Array.from(frameDocument.images || []);
      if (!images.length) {
        window.setTimeout(finalizePrint, 80);
        return;
      }

      let pending = 0;
      let finished = false;
      const settle = () => {
        if (finished) {
          return;
        }
        finished = true;
        window.setTimeout(finalizePrint, 80);
      };
      const onAssetDone = () => {
        pending -= 1;
        if (pending <= 0) {
          settle();
        }
      };

      images.forEach((image) => {
        if (image.complete) {
          return;
        }
        pending += 1;
        image.addEventListener("load", onAssetDone, { once: true });
        image.addEventListener("error", onAssetDone, { once: true });
      });

      if (pending <= 0) {
        settle();
        return;
      }

      window.setTimeout(settle, 900);
    };

    frameWindow.addEventListener("afterprint", cleanup, { once: true });
    frameDocument.open();
    frameDocument.write(markup);
    frameDocument.close();
    window.setTimeout(waitForAssetsAndPrint, 40);
  }

  function downloadInvoice(invoice) {
    if (!invoice || typeof document === "undefined") {
      showMessage("Select an invoice before downloading.");
      return;
    }
    const detail = getInvoiceDetail(invoice);
    const payload = {
      ...makePrintPayloadFromInvoice(invoice, detail),
      paperSize: "A4",
      printLayout: "invoice",
      printCalibration: getCalibrationForSettings({ ...settings, printPaperSize: "A4", printLayout: "invoice" })
    };
    const markup = buildInvoiceDownloadHTML(payload, detail || {});
    const blob = new Blob([markup], { type: "text/html;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${makeDownloadFileName(payload.invoiceNumber, "cinchpos-invoice")}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 800);
    showMessage("Invoice downloaded.");
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
    if (!items.length) {
      showMessage("Add at least one inventory item to the bill.");
      return;
    }
    if (summaryRows.total <= 0) {
      showMessage("POS billing total must be greater than zero.");
      return;
    }

    try {
      const { record: savedCustomer, usedWalkInCustomer } = await ensurePOSCustomer(formId);
      const invoice = await createInvoice({
        customer_id: savedCustomer.id,
        auto_invoice_number: true,
        amount: summaryRows.total,
        issued_on: issuedOn,
        due_on: defaultDueDate,
        notes: cleanText(settings.invoiceNotes) || "CinchPOS bill"
      });
      const printPayload = {
        businessName,
        ownerName,
        businessPhone: settings.businessPhone || "",
        businessEmail: settings.businessEmail || "",
        businessAddress: settings.businessAddress || "",
      gstin: settings.gstin || "",
      receiptSettings: buildReceiptSettings(settings),
      cashierName: settings.printCashierName || defaultSettings.printCashierName,
      counterName: settings.printCounterName || defaultSettings.printCounterName,
      orderType: settings.printOrderType || defaultSettings.printOrderType,
      logo: settings.printShopLogoOnBill ? (settings.storeLogo || settings.storeLogoUrl || "") : "",
        paperSize: settings.printPaperSize || defaultSettings.printPaperSize,
        printLayout: settings.printLayout || defaultSettings.printLayout,
        printMargin: settings.printMargin || defaultSettings.printMargin,
        printFooter: settings.printFooter || "",
        printCalibration: getCalibrationForSettings(settings),
        invoiceNumber: invoice.invoice_number || "",
        date: issuedOn,
        dueDate: defaultDueDate,
        customerName: cleanText(savedCustomer?.name || customer.name, DEFAULT_WALK_IN_CUSTOMER_NAME),
        customerPhone: savedCustomer?.phone
          ? formatIndianPhone(savedCustomer.phone)
          : (usedWalkInCustomer ? formatIndianPhone(DEFAULT_WALK_IN_CUSTOMER_PHONE) : ""),
        customerEmail: cleanText(savedCustomer?.email || customer.email),
        customerAddress: cleanText(savedCustomer?.address || customer.address),
        paymentMethod: customer.paymentMethod || "Cash",
        paymentType: paymentType === "partial" ? "Partial Payment" : "Full Payment",
        paidAmount,
        unpaidAmount,
        notes: settings.invoiceNotes || "",
        paymentTerms: "",
        terms: "",
        summary: { ...summaryRows },
        items: items.map((item, index) => ({
          serial: index + 1,
          itemId: item.itemId || item.inventoryItemId || "",
          inventoryItemId: item.inventoryItemId || item.itemId || "",
          itemName: item.itemName,
          barcode: item.barcode,
          hsn: cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac),
          description: cleanText(item.description || item.itemDescription || item.desc || item.shortDescription),
          batch: cleanText(item.batch || item.batchNo || item.batchNumber || item.batch_no || item.lot || item.lotNumber),
          unit: cleanText(item.unit || item.uom || item.unitName, "Pcs"),
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
      saveInvoiceDetail(invoice, {
        source: "pos",
        invoiceNumber: invoice.invoice_number || "",
        issuedOn,
        dueOn: defaultDueDate,
        customer: {
          id: savedCustomer.id,
          name: cleanText(savedCustomer.name, DEFAULT_WALK_IN_CUSTOMER_NAME),
          phone: savedCustomer.phone || "",
          email: savedCustomer.email || "",
          address: savedCustomer.address || ""
        },
        paymentMethod: customer.paymentMethod || "Cash",
        paymentType,
        paidAmount,
        unpaidAmount,
        notes: settings.invoiceNotes || "",
        summary: { ...summaryRows },
        items: printPayload.items.map((item) => ({
          itemId: item.itemId || item.inventoryItemId || "",
          inventoryItemId: item.inventoryItemId || item.itemId || "",
          itemName: item.itemName,
          barcode: item.barcode,
          hsn: item.hsn,
          description: item.description,
          batch: item.batch,
          unit: item.unit,
          quantity: item.quantity,
          mrp: item.mrp,
          inclusivePrice: item.inclusivePrice,
          discountPercent: item.discountPercent,
          taxableValue: item.taxableValue,
          gstRate: item.gstRate,
          gstAmount: item.gstAmount,
          lineTotal: item.lineTotal
        }))
      });
      const stockResult = deductSoldInventory(items);
      resetActivePOSBill(formId);
      await loadDashboard();
      if (closePOSModal) {
        closeModal();
      }
      if (printAfter) {
        printPOSBill(printPayload);
      }
      const stockMessage = stockResult.deductions.length
        ? ` Stock updated for ${stockResult.deductions.length} item(s).`
        : "";
      showMessage(`${unpaidAmount > 0 ? `POS billing completed. Unpaid amount: ${currency(unpaidAmount)}.` : "POS billing completed."}${stockMessage}`);
    } catch (error) {
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

  function updateSupportDraft(field, value) {
    setSupportDraft((current) => ({ ...current, [field]: value }));
  }

  function submitSupportRequest(event) {
    event.preventDefault();
    const name = cleanText(supportDraft.name);
    const email = cleanText(supportDraft.email);
    const phone = cleanText(supportDraft.phone);
    const subject = cleanText(supportDraft.subject);
    const requestMessage = cleanText(supportDraft.message);
    if (!name || (!email && !phone) || !subject || !requestMessage) {
      showMessage("Add name, email or phone, subject, and message before submitting support.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMessage("Enter a valid email address for support follow-up.");
      return;
    }
    setSupportRequests((current) => [{
      id: String(Date.now()),
      type: cleanText(supportDraft.type, "Support Request"),
      name,
      email,
      phone,
      subject,
      message: requestMessage,
      status: "Submitted",
      createdAt: new Date().toISOString()
    }, ...current]);
    setSupportDraft({
      type: "Support Request",
      name: "",
      email: "",
      phone: "",
      subject: "",
      message: ""
    });
    showMessage("Support request saved. The configured support contact is shown below.");
  }

  function toggleSellOnlineProduct(productId) {
    setSellOnlineCatalog((current) => {
      const next = { ...(current || {}) };
      if (next[productId]) {
        delete next[productId];
      } else {
        const product = sellOnlineProducts.find((entry) => entry.id === productId);
        next[productId] = {
          selectedAt: new Date().toISOString(),
          onlinePrice: Number(product?.price || 0)
        };
      }
      return next;
    });
  }

  function updateSellOnlinePrice(productId, value) {
    setSellOnlineCatalog((current) => {
      const next = { ...(current || {}) };
      if (!next[productId]) {
        return next;
      }
      next[productId] = {
        ...next[productId],
        onlinePrice: value
      };
      return next;
    });
  }

  function selectVisibleSellOnlineProducts(productIds = []) {
    if (!productIds.length) {
      showMessage("No matching products to add online.");
      return;
    }
    setSellOnlineCatalog((current) => {
      const next = { ...(current || {}) };
      productIds.forEach((productId) => {
        const product = sellOnlineProducts.find((entry) => entry.id === productId);
        next[productId] = next[productId] || {
          selectedAt: new Date().toISOString(),
          onlinePrice: Number(product?.price || 0)
        };
      });
      return next;
    });
    showMessage("Visible products added to Sell Online.");
  }

  function clearSellOnlineProducts() {
    setSellOnlineCatalog({});
    showMessage("Sell Online product selection cleared.");
  }

  async function loadOnlineStoreProfile() {
    try {
      const payload = await getOnlineStoreProfile();
      setOnlineStoreProfile(payload?.store || null);
      if (Array.isArray(payload?.products) && payload.products.length) {
        setSellOnlineCatalog((current) => {
          const next = { ...(current || {}) };
          payload.products.forEach((product) => {
            const id = cleanText(product.product_key || product.id);
            if (!id) {
              return;
            }
            next[id] = {
              ...(next[id] || {}),
              selectedAt: next[id]?.selectedAt || product.updated_at || new Date().toISOString(),
              onlinePrice: Number(product.online_price || product.onlinePrice || 0)
            };
          });
          return next;
        });
      }
    } catch {
      setOnlineStoreProfile(null);
    }
  }

  async function publishSellOnlineCatalog() {
    if (!selectedSellOnlineProducts.length) {
      showMessage("Select products before publishing the online store.");
      return;
    }
    setOnlineStoreBusy(true);
    try {
      const payload = await publishOnlineStore({
        store: {
          store_name: businessName,
          contact_phone: settings.businessPhone,
          contact_email: settings.businessEmail,
          address: settings.businessAddress,
          logo_url: settings.storeLogoUrl || settings.storeLogo
        },
        products: selectedSellOnlineProducts
      });
      const synced = payload.sync?.status === "synced";
      setOnlineStoreProfile(payload.store ? {
        ...payload.store,
        public_url: synced ? (payload.sync?.store_url || payload.store.public_url) : "",
        sync_status: payload.sync?.status || "unknown",
        sync_error: payload.sync?.error || payload.sync?.reason || ""
      } : null);
      if (!synced) {
        showMessage(`Online store saved locally, but public website sync is not ready: ${payload.sync?.error || payload.sync?.reason || "check connection"}`);
      } else {
        showMessage(`Online store published with ${payload.published_count || selectedSellOnlineProducts.length} products.`);
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Could not publish online store.");
    } finally {
      setOnlineStoreBusy(false);
    }
  }

  async function submitInvoice(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const issuedOn = cleanText(data.issued_on, todayISO());
    const dueOn = cleanText(data.due_on, defaultDueDate);
    const invoiceNumber = cleanText(data.invoice_number);
    const invoiceNotes = cleanText(data.notes, settings.invoiceNotes);
    const invoiceAmount = Number(data.amount || 0);
    const paymentType = cleanText(data.payment_type, "pending");
    const paymentAmount = paymentType === "full"
      ? invoiceAmount
      : (paymentType === "partial" ? Math.min(invoiceAmount, Math.max(0, Number(data.payment_amount || 0))) : 0);
    try {
      const invoice = await createInvoice({
        customer_id: data.customer_id,
        ...(invoiceNumber ? { invoice_number: invoiceNumber } : { auto_invoice_number: true }),
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
      const selectedCustomer = customers.find((customer) => String(customer.id || "") === String(data.customer_id || ""));
      saveInvoiceDetail(invoice, {
        source: "quick-invoice",
        invoiceNumber: invoice.invoice_number || invoiceNumber,
        issuedOn,
        dueOn,
        customer: selectedCustomer || {},
        paymentMethod: cleanText(data.payment_method, "Cash"),
        paymentType,
        paidAmount: paymentAmount,
        unpaidAmount: Math.max(0, invoiceAmount - paymentAmount),
        notes: invoiceNotes,
        summary: {
          quantity: 1,
          subtotal: invoiceAmount,
          cgst: 0,
          sgst: 0,
          gst: 0,
          total: invoiceAmount
        },
        items: [{
          itemName: "Invoice Amount",
          barcode: "",
          quantity: 1,
          mrp: invoiceAmount,
          inclusivePrice: invoiceAmount,
          discountPercent: 0,
          taxableValue: invoiceAmount,
          gstRate: 0,
          gstAmount: 0,
          lineTotal: invoiceAmount
        }]
      });
      form.reset();
      await loadDashboard();
      closeModal();
      showMessage(paymentAmount > 0 ? "Invoice created and payment recorded." : "Invoice created.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  function updateInvoiceBuilderField(field, value) {
    setInvoiceBuilderDraft((current) => ({ ...current, [field]: value }));
  }

  function updateInvoiceBuilderLine(lineId, field, value) {
    setInvoiceBuilderDraft((current) => ({
      ...current,
      lines: (current.lines || []).map((line) => {
        if (line.id !== lineId) {
          return line;
        }
        const nextLine = { ...line, [field]: value };
        const mrp = Number(nextLine.mrp || 0);
        const inclusivePrice = Number(nextLine.inclusivePrice || 0);
        return {
          ...nextLine,
          discountPercent: calculateDiscountPercent(mrp, inclusivePrice)
        };
      })
    }));
  }

  function addInvoiceBuilderLine(line = makeInvoiceBuilderLine()) {
    setInvoiceBuilderDraft((current) => ({
      ...current,
      lines: [...(current.lines || []), line]
    }));
    setInvoiceBuilderSearch("");
  }

  function removeInvoiceBuilderLine(lineId) {
    setInvoiceBuilderDraft((current) => {
      const nextLines = (current.lines || []).filter((line) => line.id !== lineId);
      return { ...current, lines: nextLines.length ? nextLines : [makeInvoiceBuilderLine()] };
    });
  }

  async function resolveInvoiceBuilderCustomer() {
    const phone = normalizePhone(invoiceBuilderDraft.customerPhone).slice(-10);
    const name = cleanText(invoiceBuilderDraft.customerName);
    const email = cleanText(invoiceBuilderDraft.customerEmail);
    const address = cleanText(invoiceBuilderDraft.customerAddress);
    const selectedCustomer = invoiceBuilderDraft.customerId
      ? customers.find((customer) => String(customer.id || "") === String(invoiceBuilderDraft.customerId))
      : null;
    if (selectedCustomer) {
      return selectedCustomer;
    }
    const matchedCustomer = phone.length === 10 ? findCustomerByPhone(phone) : null;
    if (matchedCustomer) {
      const updatePayload = buildTransferCustomerUpdatePayload(matchedCustomer, {
        name: name || matchedCustomer.name,
        phone: `+91${phone}`,
        email: email || matchedCustomer.email,
        address: address || matchedCustomer.address
      });
      if (updatePayload) {
        const updatedCustomer = await updateCustomer(matchedCustomer.id, updatePayload);
        replaceCustomerInState(updatedCustomer);
        return updatedCustomer;
      }
      return matchedCustomer;
    }
    if (!name && !phone && !email && !address) {
      return ensureDefaultWalkInCustomer();
    }
    const newCustomer = await createCustomer({
      name: name || DEFAULT_WALK_IN_CUSTOMER_NAME,
      phone: phone.length === 10 ? `+91${phone}` : "",
      email,
      address
    });
    replaceCustomerInState(newCustomer);
    return newCustomer;
  }

  async function submitStandardInvoice(event) {
    event.preventDefault();
    const lines = (invoiceBuilderDraft.lines || []).filter((line) => cleanText(line.itemName) && Number(line.quantity || 0) > 0 && Number(line.inclusivePrice || 0) > 0);
    if (!lines.length) {
      showMessage("Add at least one invoice item with name, quantity, and price.");
      return;
    }
    const issuedOn = cleanText(invoiceBuilderDraft.issuedOn, todayISO());
    const dueOn = cleanText(invoiceBuilderDraft.dueOn, defaultDueDate);
    const summaryRows = calculateInvoiceBuilderSummary(lines);
    const paymentStatus = cleanText(invoiceBuilderDraft.paymentStatus, "pending");
    const requestedPaidAmount = paymentStatus === "full"
      ? summaryRows.total
      : (paymentStatus === "partial" ? Math.min(summaryRows.total, Math.max(0, Number(invoiceBuilderDraft.paymentAmount || 0))) : 0);
    const invoiceNumber = cleanText(invoiceBuilderDraft.invoiceNumber);

    try {
      const savedCustomer = await resolveInvoiceBuilderCustomer();
      const savedInvoice = await createInvoice({
        customer_id: savedCustomer.id,
        ...(invoiceNumber ? { invoice_number: invoiceNumber } : { auto_invoice_number: true }),
        amount: summaryRows.total,
        issued_on: issuedOn,
        due_on: dueOn,
        notes: [
          cleanText(invoiceBuilderDraft.notes),
          cleanText(invoiceBuilderDraft.paymentTerms),
          cleanText(invoiceBuilderDraft.terms)
        ].filter(Boolean).join(" | ")
      });
      if (requestedPaidAmount > 0) {
        await recordPayment({
          invoice_id: savedInvoice.id,
          amount: requestedPaidAmount,
          paid_on: issuedOn,
          method: cleanText(invoiceBuilderDraft.paymentMethod, "Cash"),
          notes: paymentStatus === "partial" ? "Partial payment recorded from standard invoice." : "Full payment recorded from standard invoice."
        });
      }
      const storedLines = lines.map((line) => {
        const inclusivePrice = Number(line.inclusivePrice || 0);
        const gstRate = Number(line.gstRate || 0);
        const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
        return {
          itemId: line.itemId || "",
          itemName: cleanText(line.itemName),
          barcode: cleanText(line.barcode),
          quantity: Number(line.quantity || 0),
          mrp: Number(line.mrp || inclusivePrice || 0),
          inclusivePrice,
          discountPercent: Number(line.discountPercent || calculateDiscountPercent(line.mrp, inclusivePrice)),
          taxableValue: Number(breakup.taxableValue.toFixed(2)),
          gstRate,
          gstAmount: Number(breakup.gstAmount.toFixed(2)),
          lineTotal: inclusivePrice * Number(line.quantity || 0)
        };
      });
      saveInvoiceDetail(savedInvoice, {
        source: "standard-invoice",
        template: invoiceBuilderDraft.template,
        layout: invoiceBuilderDraft.layout,
        invoiceNumber: savedInvoice.invoice_number || invoiceNumber,
        issuedOn,
        dueOn,
        customer: {
          id: savedCustomer.id,
          name: savedCustomer.name,
          phone: savedCustomer.phone,
          email: savedCustomer.email,
          address: savedCustomer.address
        },
        paymentMethod: cleanText(invoiceBuilderDraft.paymentMethod, "Cash"),
        paymentType: paymentStatus,
        paidAmount: requestedPaidAmount,
        unpaidAmount: Math.max(0, summaryRows.total - requestedPaidAmount),
        paymentTerms: invoiceBuilderDraft.paymentTerms,
        notes: invoiceBuilderDraft.notes,
        terms: invoiceBuilderDraft.terms,
        layoutOptions: {
          headerPlacement: invoiceBuilderDraft.headerPlacement,
          logoPlacement: invoiceBuilderDraft.logoPlacement,
          businessDetails: invoiceBuilderDraft.businessDetails,
          customerSection: invoiceBuilderDraft.customerSection,
          tableLayout: invoiceBuilderDraft.tableLayout,
          footerSection: invoiceBuilderDraft.footerSection
        },
        summary: summaryRows,
        items: storedLines
      });
      deductSoldInventory(storedLines);
      await loadDashboard();
      closeModal();
      showMessage(requestedPaidAmount > 0 ? "Standard invoice created and payment recorded." : "Standard invoice created.");
    } catch (error) {
      showMessage(error.message || "Could not create the standard invoice.");
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

  async function submitPurchase(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const supplier = cleanText(data.supplier);
    const item = cleanText(data.item);
    const amount = Number(data.amount || 0);
    const file = form.elements.bill_file?.files?.[0];

    if (!supplier || !item || amount <= 0) {
      showMessage("Add supplier, item, and a valid amount before saving purchase.");
      return;
    }

    try {
      const fileData = await readFileAsDataURL(file);
      setPurchaseRecords((current) => [{
        id: String(Date.now()),
        supplier,
        item,
        billNumber: cleanText(data.bill_number),
        purchaseDate: data.purchase_date || todayISO(),
        amount,
        gstAmount: Math.max(0, Number(data.gst_amount || 0)),
        paymentStatus: cleanText(data.payment_status, "Pending"),
        notes: cleanText(data.notes),
        fileName: file?.name || "",
        fileData,
        createdAt: new Date().toISOString()
      }, ...current]);
      form.reset();
      form.elements.purchase_date.value = todayISO();
      showMessage("Purchase saved.");
    } catch (error) {
      showMessage(error.message || "Could not save the purchase.");
    }
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

  async function submitBank(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const accountNumber = normalizeAccountNumber(data.account_number);
    const confirmAccountNumber = normalizeAccountNumber(data.confirm_account_number || data.account_number);
    const ifsc = normalizeIFSC(data.ifsc);
    const upiId = cleanText(data.upi_id).toLowerCase();
    const qrFile = form.elements.qr_file?.files?.[0];

    if (accountNumber.length < 9) {
      showMessage("Enter a valid bank account number.");
      return;
    }
    if (accountNumber !== confirmAccountNumber) {
      showMessage("Account number and confirmation do not match.");
      return;
    }
    if (!isValidIFSC(ifsc)) {
      showMessage("Enter a valid IFSC code.");
      return;
    }
    if (!isValidUPI(upiId)) {
      showMessage("Enter a valid UPI ID, for example store@bank.");
      return;
    }

    try {
      const qrFileData = await readFileAsDataURL(qrFile);
      setBankAccount({
        accountHolder: cleanText(data.account_holder),
        bankName: cleanText(data.bank_name),
        accountType: cleanText(data.account_type, "Current"),
        accountNumber,
        ifsc,
        upiId,
        branch: cleanText(data.branch),
        settlementMode: cleanText(data.settlement_mode, "Manual reconciliation"),
        reconciliationFrequency: cleanText(data.reconciliation_frequency, "Daily"),
        qrFileName: qrFile ? qrFile.name : bankAccount?.qrFileName || "",
        qrFileData: qrFileData || bankAccount?.qrFileData || "",
        notes: cleanText(data.notes),
        linkedAt: new Date().toISOString()
      });
      showMessage("Bank details saved.");
    } catch (error) {
      showMessage(error.message || "Could not save bank details.");
    }
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

  async function submitEmployee(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const aadharFile = form.elements.aadhar_file?.files?.[0];
    const panFile = form.elements.pan_file?.files?.[0];
    try {
      const [aadharFileData, panFileData] = await Promise.all([
        readFileAsDataURL(aadharFile),
        readFileAsDataURL(panFile)
      ]);
      const employeeEmail = cleanText(data.email).toLowerCase();
      const roleKey = cleanText(data.role_key || employeeAccessRole, "salesman").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "salesman";
      const permissionSet = Array.from(new Set(
        (employeePermissionDraft.length ? employeePermissionDraft : getRoleDefaultPermissions(roleKey))
          .filter((permission) => permissionCatalog[permission] || permission === "*")
      ));
      let inviteResult = null;
      if (employeeEmail && can("employees:write")) {
        inviteResult = await inviteEmployeeAccount({
          email: employeeEmail,
          name: cleanText(data.name),
          role: roleKey,
          permissions: permissionSet
        }).catch((error) => ({ status: "failed", error: error.message }));
      }
      setEmployees((current) => [{
        id: String(Date.now()),
        name: cleanText(data.name),
        role: cleanText(data.role, "Counter Staff"),
        roleKey,
        email: employeeEmail,
        phone: cleanText(data.phone),
        address: cleanText(data.address),
        salary: Number(data.salary || 0),
        permissions: permissionSet.map(getPermissionLabel).join(", "),
        permissionSet,
        authStatus: inviteResult?.status || (employeeEmail ? "Pending invite" : "Local record"),
        invitationId: inviteResult?.id || "",
        aadharFileName: aadharFile ? aadharFile.name : "",
        aadharFileData,
        panFileName: panFile ? panFile.name : "",
        panFileData,
        status: cleanText(data.status, "Active"),
        createdAt: new Date().toISOString()
      }, ...current]);
      form.reset();
      updateEmployeeAccessRole("salesman");
      showMessage(employeeEmail ? "Employee saved and auth invitation prepared." : "Employee saved.");
    } catch (error) {
      showMessage(error.message || "Could not save employee documents.");
    }
  }

  function deleteEmployee(employeeId) {
    const employee = employees.find((entry) => String(entry.id) === String(employeeId));
    if (!window.confirm(`Delete ${employee?.name || "this employee"} from employee records?`)) {
      return;
    }
    setEmployees((current) => current.filter((entry) => String(entry.id) !== String(employeeId)));
    showMessage("Employee deleted.");
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
    const nextAddress = cleanText(importedCustomer?.address || importedCustomer?.customerAddress, cleanText(existingCustomer.address));
    const nextPhone = cleanText(importedCustomer?.phone || importedCustomer?.customerPhone, cleanText(existingCustomer.phone));
    const currentName = cleanText(existingCustomer.name);
    const currentEmail = cleanText(existingCustomer.email);
    const currentAddress = cleanText(existingCustomer.address);
    const currentPhone = cleanText(existingCustomer.phone);
    const phoneChanged = normalizePhone(currentPhone) !== normalizePhone(nextPhone);
    const changed = nextName !== currentName || nextEmail !== currentEmail || nextAddress !== currentAddress || phoneChanged;

    if (!changed || !nextName) {
      return null;
    }

    return {
      name: nextName,
      email: nextEmail,
      address: nextAddress,
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
            if (!customer.name && !customer.phone && !customer.email && !customer.address) {
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
                address: customer.address,
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
                    address: invoice.customerAddress,
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
    const matchedInventory = query
      ? inventoryItems.filter((item) => [
          getInventoryItemName(item),
          getInventoryBarcodeLabel(item),
          item.category,
          item.hsn,
          item.unit,
          item.inclusivePrice || item.inclusive_price,
          item.mrp
        ].some((value) => String(value || "").toLowerCase().includes(query)))
      : inventoryItems;
    const compareByName = (first, second) => cleanText(getInventoryItemName(first)).localeCompare(
      cleanText(getInventoryItemName(second)),
      undefined,
      { sensitivity: "base", numeric: true }
    );
    return [...matchedInventory].sort((first, second) => {
      if (inventorySort === "stockAsc") {
        return (Number(first.stock || 0) - Number(second.stock || 0)) || compareByName(first, second);
      }
      if (inventorySort === "stockDesc") {
        return (Number(second.stock || 0) - Number(first.stock || 0)) || compareByName(first, second);
      }
      if (inventorySort === "sellingDesc") {
        const firstPrice = Number(first.inclusivePrice || first.inclusive_price || first.price || 0);
        const secondPrice = Number(second.inclusivePrice || second.inclusive_price || second.price || 0);
        return (secondPrice - firstPrice) || compareByName(first, second);
      }
      return compareByName(first, second);
    });
  }, [deferredInventorySearch, inventoryItems, inventorySort]);

  useEffect(() => {
    setInventoryVisibleCount(deferredInventorySearch.trim() ? 200 : 120);
  }, [deferredInventorySearch, inventoryItems.length, inventorySort]);

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
    showMessage,
    inventoryItems
  };

  inventoryViewContextRef.current = {
    inventoryItems,
    setInventoryItems,
    inventorySearch,
    setInventorySearch,
    inventorySort,
    setInventorySort,
    inventoryVisibleCount,
    setInventoryVisibleCount,
    deferredInventorySearch,
    filteredInventory,
    visibleInventory,
    hasMoreInventory,
    smartInventoryReview,
    showMessage,
    managedWarehouses,
    activeWarehouseId
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
      showMessage,
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
    const hasCustomerDraft = Boolean(cleanText(customer.name) || cleanText(customer.email) || cleanText(customer.address) || cleanText(customer.phone));
    const activeBillIndex = Math.max(0, (instance.bills || []).findIndex((openBill) => openBill.id === bill.id));
    const activeBillDisplayLabel = `Bill ${activeBillIndex + 1}`;
    const meta = `${activeBillDisplayLabel} | ${cleanText(customer.name, hasCustomerDraft ? "Customer draft" : DEFAULT_WALK_IN_CUSTOMER_NAME)} | ${customer.phone?.length === 10 ? formatIndianPhone(customer.phone) : formatIndianPhone(DEFAULT_WALK_IN_CUSTOMER_PHONE)} | ${posSummary.quantity} item(s)`;
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

    function editLinePrice(item) {
      const currentPrice = Number(item.inclusivePrice || 0);
      const value = window.prompt(`Enter selling price for ${item.itemName}`, currentPrice.toFixed(2));
      if (value === null) {
        return;
      }
      const nextPrice = Number(value);
      if (!Number.isFinite(nextPrice) || nextPrice < 0) {
        showMessage("Enter a valid selling price.");
        return;
      }
      updatePOSPrice(formId, item.id, "inclusivePrice", nextPrice.toFixed(2));
      showMessage("Item price updated.");
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
                      <input name="customer_phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength="14" pattern="[0-9]{10}" placeholder="10 digit number" value={customer.phone || ""} onChange={(event) => handlePOSPhone(formId, event.target.value)} />
                    </span>
                  </label>
                  <label>
                    Name
                    <input name="customer_name" type="text" autoComplete="name" placeholder="Optional customer name" value={customer.name || ""} onChange={(event) => updatePOSCustomer(formId, { name: event.target.value })} />
                  </label>
                  <label>
                    Email
                    <input name="customer_email" type="email" autoComplete="email" placeholder="Optional email address" value={customer.email || ""} onChange={(event) => updatePOSCustomer(formId, { email: event.target.value })} />
                  </label>
                  <label className="pos-customer-address-field">
                    Address
                    <textarea name="customer_address" rows="2" placeholder="Optional address" value={customer.address || ""} onChange={(event) => updatePOSCustomer(formId, { address: event.target.value })}></textarea>
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
                  {instance.bills.map((openBill, billIndex) => {
                    const openBillTotal = getPOSBillSummary(openBill.items || []).total;
                    const openBillDisplayLabel = `Bill ${billIndex + 1}`;
                    return (
                      <div key={openBill.id} className={`bill-tab-group ${openBill.id === instance.activeBillId ? "active" : ""}`}>
                        <button type="button" className="bill-tab" onClick={() => switchPOSBill(formId, openBill.id)}>
                          {openBillDisplayLabel}
                          <span>{currency(openBillTotal)}</span>
                        </button>
                        <button type="button" className="bill-delete" aria-label={`Delete ${openBillDisplayLabel}`} title={`Delete ${openBillDisplayLabel}`} disabled={instance.bills.length <= 1} onClick={() => deletePOSBill(formId, openBill.id)}>&times;</button>
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
                        <th>#</th>
                        <th><span>Item Name</span><span>HSN</span></th>
                        <th><span>MRP</span><span>Disc</span></th>
                        <th>Qty</th>
                        <th>SP</th>
                        <th><span>Rate</span><span>Tax</span></th>
                        <th>Amt</th>
                        <th className="line-action-col" aria-label="Actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length ? items.map((item, index) => {
                        const quantity = Number(item.quantity || 1);
                        const lineTotal = Number(item.inclusivePrice || 0) * quantity;
                        const hsnLabel = cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac, "Not added");
                        return (
                          <tr key={item.id}>
                            <td>{index + 1}</td>
                            <td className="bill-item-cell">
                              <strong>{item.itemName}</strong>
                              <span>HSN {hsnLabel}</span>
                              {item.barcode ? <span>Barcode {item.barcode}</span> : null}
                            </td>
                            <td className="bill-mrp-cell">
                              <input className="line-edit-input price-input" type="number" min="0" step="0.01" value={Number(item.mrp || 0)} onChange={(event) => updatePOSPrice(formId, item.id, "mrp", event.target.value)} aria-label={`MRP for ${item.itemName}`} />
                              <span>Disc {Number(item.discountPercent || 0).toFixed(2)}%</span>
                            </td>
                            <td className="bill-qty-cell">
                              <input className="line-edit-input qty-input" type="number" min="1" step="1" value={quantity} onChange={(event) => updatePOSQuantity(formId, item.id, event.target.value)} aria-label={`Quantity for ${item.itemName}`} />
                            </td>
                            <td className="bill-sp-cell">
                              <strong className="bill-sp-value">{currency(item.inclusivePrice)}</strong>
                              <button type="button" className="line-price-edit" onClick={() => editLinePrice(item)} aria-label={`Edit price for ${item.itemName}`}>Edit price</button>
                            </td>
                            <td className="bill-rate-cell">
                              <input className="line-edit-input price-input" type="number" min="0" step="0.01" value={Number(item.taxableValue || 0)} onChange={(event) => {
                                const taxableRate = Math.max(0, Number(event.target.value || 0));
                                const inclusiveRate = taxableRate * (1 + (Number(item.gstRate || 0) / 100));
                                updatePOSPrice(formId, item.id, "inclusivePrice", inclusiveRate.toFixed(2));
                              }} aria-label={`Rate without GST for ${item.itemName}`} />
                              <span>Tax {Number(item.gstRate || 0)}%</span>
                            </td>
                            <td className="bill-amount-cell"><strong>{currency(lineTotal)}</strong></td>
                            <td><button type="button" className="line-remove" onClick={() => removePOSItem(formId, item.id)} aria-label={`Remove ${item.itemName}`}>&times;</button></td>
                          </tr>
                        );
                      }) : (
                        <tr>
                          <td colSpan="8" className="bill-empty">
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
                    <span>Total Qty {posSummary.quantity}</span>
                    <span>Total Rate {currency(posSummary.subtotal)}</span>
                    <span>Total GST {currency(posSummary.gst)}</span>
                    <span>Total Disc {currency(posSummary.discountTotal)}</span>
                    <strong>Total Amount {currency(posSummary.total)}</strong>
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

  const StableInventoryView = useMemo(() => function StableInventoryView(props) {
    return InventoryView(props);
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
              <StoreLogo source={visibleLogoSource} fallback={visibleInitials} alt={`${visibleBusinessName} logo`} className="toolbar-store-logo" />
              <HeaderTitle storeName={visibleBusinessName} title={visibleTitle} eyebrow={visibleOwnerName} />
            </div>
            <HeaderSupportMenu />
          </header>

          <div id="appMessage" className={`message ${message ? "show" : ""}`}>{message}</div>

          {authGateActive ? (
            <section className="auth-lock-screen" aria-label="CinchPOS account login required">
              <div className="auth-lock-card">
                <StoreLogo source={visibleLogoSource} fallback={visibleInitials} alt={`${APP_NAME} logo`} className="auth-lock-logo" />
                <p className="action-label">Secure Workspace</p>
                <h2>Login to view this shop data</h2>
                <p>Customer, inventory, invoices, and billing records stay hidden on this device until a valid CinchPOS account is active.</p>
                <div className="auth-lock-actions">
                  <button className="button button-primary" type="button" onClick={() => { setAuthFormMode("login"); openModal("login"); }}>Login</button>
                  <button className="button button-secondary" type="button" onClick={() => { setAuthFormMode("register"); openModal("login"); }}>Create Account</button>
                </div>
              </div>
            </section>
          ) : (
          <div className="app-view-stack">
            {renderedViews.dashboardView ? <section id="dashboardView" className={`app-view ${activeView === "dashboardView" ? "active" : ""}`} data-title="Dashboard">
              <section className="quick-strip" aria-label="Quick Actions">
                <div>
                  <p className="action-label">Quick Actions</p>
                  <h2>Counter-ready billing tools</h2>
                </div>
                <div className="action-group">
                  <button className="button button-primary pos-launch" type="button" onClick={() => setActiveView("cinchPOSView")}>CinchPOS</button>
                  <button className="button button-secondary" type="button" onClick={() => openModal("invoice")}>Create Standard Invoice</button>
                  <button className="button button-secondary" type="button" onClick={() => openModal("customer")}>Add Customer</button>
                </div>
              </section>
              <section id="summaryGrid" className="summary-grid" aria-label="Billing summary">
                {[
                  ["revenue", "Revenue (Stock Value)", compactCurrency(inventoryStockValue), "Total selling value of current inventory stock."],
                  ["outstanding", "Outstanding Payments", compactCurrency(currentSummary.outstanding_payments), "Unpaid balances that still need follow-up."],
                  ["invoices", "Total Invoices", Number(currentSummary.invoice_count || 0), "Overall invoice count currently tracked in billing."],
                  ["balance", "Net Balance", compactCurrency(dashboardNetBalance), "Stock value - Expenses"]
                ].map(([key, label, value, note]) => (
                  <article key={key} className={`summary-card ${key === "balance" ? `balance-${dashboardNetBalanceDirection}` : ""}`}>
                    <div className="summary-top">
                      <span className="summary-label">{label}</span>
                      <SummaryIcon type={key} />
                    </div>
                    <strong className="summary-value">{value}</strong>
                    <p className="summary-note">{note}</p>
                    {key === "balance" ? (
                      <div className={`balance-helper ${dashboardNetBalanceDirection === "negative" ? "negative" : ""}`}>
                        <span>{dashboardNetBalanceDirection === "negative" ? "Down" : "Up"}</span>
                        <span>{dashboardNetBalanceDirection === "negative" ? "Below zero" : "Above zero"}</span>
                        <span className="summary-tooltip" data-tooltip={`Stock value: ${currency(inventoryStockValue)}\nExpenses: ${currency(dashboardExpensesValue)}`}>i</span>
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
                  <div className="panel-actions">
                    <button className="button button-primary" type="button" onClick={() => openModal("invoice")}>Create Standard Invoice</button>
                  </div>
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
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allInvoices.map((invoice, index) => {
                          const paymentStatus = getInvoicePaymentStatus(invoice);
                          return (
                            <tr key={invoice.id || invoice.invoice_number || index}>
                              <td>{index + 1}</td>
                              <td>{cleanText(invoice.customer_name, "Walk-in Customer")}</td>
                              <td>{getInvoicePhone(invoice)}</td>
                              <td>{formatDate(invoice.issued_on)}</td>
                              <td>{invoice.invoice_number || "Auto"}</td>
                              <td>{currency(invoice.amount)}</td>
                              <td>{currency(invoicePaidAmount(invoice))}</td>
                              <td>{currency(invoiceOutstandingAmount(invoice))}</td>
                              <td>
                                <button
                                  type="button"
                                  className={`status-badge status-button ${statusClass(paymentStatus)}`}
                                  title="Left click to record payment. Right click for status options."
                                  onClick={() => openInvoicePaymentAction(invoice)}
                                  onContextMenu={(event) => openInvoiceStatusMenu(event, invoice)}
                                >
                                  {paymentStatus}
                                </button>
                              </td>
                              <td>
                                <div className="table-actions">
                                  <button type="button" className="button button-secondary file-action" onClick={() => openInvoiceViewer(invoice)}>View</button>
                                  {isOwner ? <button type="button" className="button button-secondary file-action danger-action" onClick={() => deleteInvoiceRecord(invoice)}>Delete</button> : null}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
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
                          <th>Address</th>
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
                              <td>{customer.address || "Not added"}</td>
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

            {renderedViews.inventoryView ? <StableInventoryView active={activeView === "inventoryView"} /> : null}
            {renderedViews.sellOnlineView ? SellOnlineView({ active: activeView === "sellOnlineView" }) : null}
            {renderedViews.purchaseView ? PurchaseView({ active: activeView === "purchaseView" }) : null}
            {renderedViews.expensesView ? ExpensesView({ active: activeView === "expensesView" }) : null}
            {renderedViews.salesReportView ? SalesReportView({ active: activeView === "salesReportView" }) : null}
            {renderedViews.employeeView ? EmployeeView({ active: activeView === "employeeView" }) : null}
            {renderedViews.bankView ? BankView({ active: activeView === "bankView" }) : null}
            {renderedViews.documentsView ? DocumentsView({ active: activeView === "documentsView" }) : null}
            {renderedViews.dataTransferView ? DataTransferView({ active: activeView === "dataTransferView" }) : null}
          </div>
          )}
        </section>

        <aside className="right-navigation" aria-label="Application navigation">
          <button className={`brand ${activeView === "dashboardView" ? "active" : ""}`} type="button" onClick={() => switchView("dashboardView")}>
            <StoreLogo source={visibleLogoSource} fallback={visibleInitials} alt={`${visibleBusinessName} logo`} className="nav-store-logo" />
            <span><span>{visibleBusinessName}</span><small>{authGateActive ? "Locked workspace" : "Store workspace"}</small></span>
          </button>
          <nav className="right-nav-links">
            {navigationViews.map((view) => (
              <button key={view.id} className={`nav-item ${view.billing ? "nav-billing" : ""} ${activeView === view.id ? "active" : ""}`} type="button" onClick={() => switchView(view.id)}>
                <span className="nav-icon"><svg><use href={`#icon-${view.icon}`}></use></svg></span>
                {view.title}
              </button>
            ))}
            {authGateActive ? (
              <button className="nav-item" type="button" onClick={() => openModal("login")}><span className="nav-icon"><svg><use href="#icon-settings"></use></svg></span>Login</button>
            ) : (
              <button className="nav-item" type="button" onClick={() => openModal("settings")}><span className="nav-icon"><svg><use href="#icon-settings"></use></svg></span>Settings</button>
            )}
          </nav>
        </aside>
      </main>

      {invoiceStatusMenu && invoiceStatusMenuInvoice ? (
        <div
          className="context-menu invoice-status-menu"
          style={{ left: invoiceStatusMenu.x, top: invoiceStatusMenu.y }}
          role="menu"
          aria-label="Invoice status actions"
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" disabled={invoiceOutstandingAmount(invoiceStatusMenuInvoice) <= 0} onClick={() => markInvoiceAsPaid(invoiceStatusMenuInvoice)}>
            Mark as paid
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setInvoiceStatusMenu(null);
            openInvoicePaymentAction(invoiceStatusMenuInvoice);
          }}>
            Record payment
          </button>
          <button type="button" role="menuitem" onClick={() => {
            setInvoiceStatusMenu(null);
            openInvoiceViewer(invoiceStatusMenuInvoice);
          }}>
            View invoice
          </button>
        </div>
      ) : null}

      <Modal open={activeModal === "customer"} title="Add Customer" subtitle="Create a customer record for invoices and future payment activity." onClose={closeModal}>
        <form onSubmit={submitCustomer}>
          <label>Customer Name<input name="name" type="text" placeholder="Northwind Labs" required /></label>
          <div className="form-grid">
            <label>Email<input name="email" type="email" placeholder="Optional" /></label>
            <label>Phone<input name="phone" type="text" placeholder="Optional" /></label>
          </div>
          <label>Address<textarea name="address" rows="3" placeholder="Optional"></textarea></label>
          <div className="modal-actions"><button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button><button type="submit" className="button button-primary">Save Customer</button></div>
        </form>
      </Modal>

      <Modal open={activeModal === "pos"} title="CinchPOS" large onClose={closeModal}>
        <POSModule formId="posForm" modal />
      </Modal>

      <Modal open={activeModal === "payment"} title="Record Payment" subtitle="Apply a payment to an outstanding invoice and update totals immediately." onClose={closeModal}>
        <form onSubmit={submitPayment}>
          <label>Invoice<select key={prefillInvoiceId || outstandingInvoices[0]?.id || "none"} name="invoice_id" required disabled={!outstandingInvoices.length} defaultValue={prefillInvoiceId || outstandingInvoices[0]?.id || ""}>{outstandingInvoices.length ? outstandingInvoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} | {invoice.customer_name} | {currency(invoiceOutstandingAmount(invoice))}</option>) : <option value="">Create an invoice before recording a payment</option>}</select></label>
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
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {allInvoices.map((invoice, index) => {
                  const paymentStatus = getInvoicePaymentStatus(invoice);
                  return (
                    <tr key={invoice.id || invoice.invoice_number || index}>
                      <td>{index + 1}</td>
                      <td>{cleanText(invoice.customer_name, "Walk-in Customer")}</td>
                      <td>{getInvoicePhone(invoice)}</td>
                      <td>{formatDate(invoice.issued_on)}</td>
                      <td>{invoice.invoice_number || "Auto"}</td>
                      <td>{currency(invoice.amount)}</td>
	                      <td>{currency(invoicePaidAmount(invoice))}</td>
	                      <td>{currency(invoiceOutstandingAmount(invoice))}</td>
	                      <td>
	                        <button
	                          type="button"
	                          className={`status-badge status-button ${statusClass(paymentStatus)}`}
	                          title="Left click to record payment. Right click for status options."
	                          onClick={() => openInvoicePaymentAction(invoice)}
	                          onContextMenu={(event) => openInvoiceStatusMenu(event, invoice)}
	                        >
	                          {paymentStatus}
	                        </button>
	                      </td>
	                      <td>
	                        <div className="table-actions">
	                          <button type="button" className="button button-secondary file-action" onClick={() => openInvoiceViewer(invoice)}>View</button>
	                          {isOwner ? <button type="button" className="button button-secondary file-action danger-action" onClick={() => deleteInvoiceRecord(invoice)}>Delete</button> : null}
	                        </div>
	                      </td>
	                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <Empty>No invoice history available yet.</Empty>}
        </div>
      </Modal>

      <Modal open={activeModal === "invoiceViewer"} title="Invoice View" subtitle="Complete invoice details, items, taxes, payments, and actions." large onClose={closeModal}>
        {selectedInvoice ? (
          <div className="invoice-viewer">
            <div className="invoice-viewer-head">
              <div>
                <h3>{selectedInvoice.invoice_number || selectedInvoice.invoiceNumber || "Invoice"}</h3>
                <p>{cleanText(selectedInvoice.customer_name || selectedInvoice.customerName, selectedInvoiceDetail?.customer?.name || DEFAULT_WALK_IN_CUSTOMER_NAME)} | {getInvoicePhone(selectedInvoice)}</p>
              </div>
              <div className="invoice-viewer-actions">
                <button type="button" className="button button-secondary" onClick={() => printPOSBill(makePrintPayloadFromInvoice(selectedInvoice, selectedInvoiceDetail))}>Print Invoice</button>
	                <button type="button" className="button button-secondary" onClick={() => downloadInvoice(selectedInvoice)}>Download Invoice</button>
	                <button type="button" className="button button-secondary" onClick={() => duplicateInvoiceToBuilder(selectedInvoice)}>Duplicate Invoice</button>
	                {isOwner ? <button type="button" className="button button-secondary danger-action" onClick={() => deleteInvoiceRecord(selectedInvoice)}>Delete Invoice</button> : null}
	                <button type="button" className="button button-secondary" disabled title="Existing API invoices are locked from direct editing in this build.">Edit Locked</button>
	              </div>
            </div>
            <div className="invoice-viewer-grid">
              <article className="record-card">
                <h3>Customer Details</h3>
                <div className="record-meta-grid">
                  <span>Name {cleanText(selectedInvoice.customer_name || selectedInvoiceDetail?.customer?.name, DEFAULT_WALK_IN_CUSTOMER_NAME)}</span>
                  <span>Phone {getInvoicePhone(selectedInvoice)}</span>
                  <span>Email {selectedInvoiceDetail?.customer?.email || "Not added"}</span>
                  <span>Address {selectedInvoiceDetail?.customer?.address || "Not added"}</span>
                </div>
              </article>
              <article className="record-card">
                <h3>Payment Information</h3>
                <div className="record-meta-grid">
                  <span>Date {formatDate(selectedInvoice.issued_on || selectedInvoice.issuedOn)}</span>
                  <span>Due {formatDate(selectedInvoice.due_on || selectedInvoice.dueOn)}</span>
                  <span>Paid {currency(invoicePaidAmount(selectedInvoice))}</span>
                  <span>Outstanding {currency(invoiceOutstandingAmount(selectedInvoice))}</span>
                  <span>Status {selectedInvoice.status}</span>
                  <span>Method {selectedInvoiceDetail?.paymentMethod || "Not added"}</span>
                </div>
              </article>
            </div>
            <div className="data-table-shell invoice-line-shell">
              {(selectedInvoiceDetail?.items || []).length ? (
                <table className="data-table invoice-line-table">
                  <thead>
                    <tr><th>S.No.</th><th>Item</th><th>Barcode</th><th>Qty</th><th>MRP</th><th>Sale</th><th>Taxable</th><th>GST</th><th>Total</th></tr>
                  </thead>
                  <tbody>
                    {selectedInvoiceDetail.items.map((item, index) => (
                      <tr key={`${item.itemName}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{item.itemName}</td>
                        <td>{item.barcode || "Not added"}</td>
                        <td>{item.quantity}</td>
                        <td>{currency(item.mrp)}</td>
                        <td>{currency(item.inclusivePrice)}</td>
                        <td>{currency(item.taxableValue)}</td>
                        <td>{currency(Number(item.gstAmount || 0) * Number(item.quantity || 1))} ({Number(item.gstRate || 0)}%)</td>
                        <td>{currency(item.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <Empty>Detailed item lines were not saved for this older invoice. The invoice total and payment details are still available.</Empty>}
            </div>
            <div className="invoice-viewer-totals">
              <span>Taxable {currency(selectedInvoiceDetail?.summary?.subtotal || 0)}</span>
              <span>CGST {currency(selectedInvoiceDetail?.summary?.cgst || 0)}</span>
              <span>SGST {currency(selectedInvoiceDetail?.summary?.sgst || 0)}</span>
              <strong>Grand Total {currency(selectedInvoice.amount || selectedInvoiceDetail?.summary?.total || 0)}</strong>
            </div>
            <div className="record-card">
              <h3>Notes & Terms</h3>
              <p className="record-meta">{selectedInvoiceDetail?.notes || selectedInvoice.notes || "No notes added."}</p>
              {selectedInvoiceDetail?.paymentTerms ? <p className="record-meta">Payment terms: {selectedInvoiceDetail.paymentTerms}</p> : null}
              {selectedInvoiceDetail?.terms ? <p className="record-meta">Terms: {selectedInvoiceDetail.terms}</p> : null}
            </div>
          </div>
        ) : <Empty>Select an invoice to view complete details.</Empty>}
      </Modal>

      <Modal open={activeModal === "invoice"} title="Create Standard Invoice" subtitle="Create a standard bill with items, customer details, taxes, discounts, terms, and a live print-ready preview." large cardClass="invoice-builder-modal" onClose={closeModal}>
        <form className="invoice-builder" onSubmit={submitStandardInvoice}>
          <section className="invoice-builder-editor">
            <div className="invoice-builder-toolbar">
              <label>Template<select value={invoiceBuilderDraft.template} onChange={(event) => updateInvoiceBuilderField("template", event.target.value)}><option value="standard">Standard Invoice</option><option value="gst">GST Invoice</option><option value="proforma">Proforma Invoice</option><option value="custom">Custom Invoice</option></select></label>
              <label>Invoice Number<input type="text" value={invoiceBuilderDraft.invoiceNumber} onChange={(event) => updateInvoiceBuilderField("invoiceNumber", event.target.value)} placeholder={buildClientInvoiceNumber(todayISO())} /></label>
              <label>Issued On<input type="date" value={invoiceBuilderDraft.issuedOn} onChange={(event) => updateInvoiceBuilderField("issuedOn", event.target.value)} /></label>
              <label>Due On<input type="date" value={invoiceBuilderDraft.dueOn} onChange={(event) => updateInvoiceBuilderField("dueOn", event.target.value)} /></label>
            </div>
            <section className="invoice-builder-section">
              <h3>Customer Details</h3>
              <div className="form-grid settings-form-grid">
                <label>Saved Customer<select value={invoiceBuilderDraft.customerId} onChange={(event) => {
                  const customer = customers.find((entry) => String(entry.id) === String(event.target.value));
                  setInvoiceBuilderDraft((current) => ({
                    ...current,
                    customerId: event.target.value,
                    customerName: customer?.name || current.customerName,
                    customerPhone: normalizePhone(customer?.phone || current.customerPhone).slice(-10),
                    customerEmail: customer?.email || current.customerEmail,
                    customerAddress: customer?.address || current.customerAddress
                  }));
                }}><option value="">New / Walk-in customer</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
                <label>Name<input type="text" value={invoiceBuilderDraft.customerName} onChange={(event) => updateInvoiceBuilderField("customerName", event.target.value)} placeholder="Optional customer name" /></label>
                <label>Phone<input type="tel" value={invoiceBuilderDraft.customerPhone} onChange={(event) => updateInvoiceBuilderField("customerPhone", event.target.value)} placeholder="10 digit phone" /></label>
                <label>Email<input type="email" value={invoiceBuilderDraft.customerEmail} onChange={(event) => updateInvoiceBuilderField("customerEmail", event.target.value)} placeholder="Optional" /></label>
                <label className="settings-span-2">Address<textarea rows="2" value={invoiceBuilderDraft.customerAddress} onChange={(event) => updateInvoiceBuilderField("customerAddress", event.target.value)} placeholder="Optional address"></textarea></label>
              </div>
            </section>
            <section className="invoice-builder-section">
              <h3>Items</h3>
              <div className="invoice-builder-search">
                <label>Search Inventory<input type="search" value={invoiceBuilderSearch} onChange={(event) => setInvoiceBuilderSearch(event.target.value)} placeholder="Search and add inventory items" /></label>
                <button type="button" className="button button-secondary" onClick={() => addInvoiceBuilderLine()}>Add Manual Item</button>
              </div>
              {invoiceBuilderMatches.length ? (
                <div className="invoice-builder-matches">
                  {invoiceBuilderMatches.map((item, index) => (
                    <button type="button" key={getInventoryItemKey(item, index)} onClick={() => addInvoiceBuilderLine(buildInvoiceBuilderLineFromInventory(item))}>
                      <span>{getInventoryItemName(item)}</span>
                      <small>{getInventoryBarcodeLabel(item)} | {currency(item.inclusivePrice || item.inclusive_price || 0)}</small>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="invoice-builder-lines">
                {(invoiceBuilderDraft.lines || []).map((line, index) => (
                  <article className="invoice-builder-line" key={line.id}>
                    <span className="line-index">{index + 1}</span>
                    <input type="text" value={line.itemName} onChange={(event) => updateInvoiceBuilderLine(line.id, "itemName", event.target.value)} placeholder="Item name" required />
                    <input type="text" value={line.barcode} onChange={(event) => updateInvoiceBuilderLine(line.id, "barcode", event.target.value)} placeholder="Barcode" />
                    <input type="number" min="1" step="1" value={line.quantity} onChange={(event) => updateInvoiceBuilderLine(line.id, "quantity", event.target.value)} aria-label="Quantity" required />
                    <input type="number" min="0" step="0.01" value={line.mrp} onChange={(event) => updateInvoiceBuilderLine(line.id, "mrp", event.target.value)} aria-label="MRP" />
                    <input type="number" min="0.01" step="0.01" value={line.inclusivePrice} onChange={(event) => updateInvoiceBuilderLine(line.id, "inclusivePrice", event.target.value)} aria-label="Selling price" required />
                    <input type="number" min="0" max="100" step="0.01" value={Number(line.discountPercent || 0).toFixed(2)} onChange={(event) => updateInvoiceBuilderLine(line.id, "discountPercent", event.target.value)} aria-label="Discount" />
                    <select value={line.gstRate} onChange={(event) => updateInvoiceBuilderLine(line.id, "gstRate", event.target.value)} aria-label="GST Rate"><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select>
                    <strong>{currency(Number(line.inclusivePrice || 0) * Number(line.quantity || 0))}</strong>
                    <button type="button" className="line-remove" onClick={() => removeInvoiceBuilderLine(line.id)}>&times;</button>
                  </article>
                ))}
              </div>
            </section>
            <section className="invoice-builder-section">
              <h3>Terms, Payment & Layout</h3>
              <div className="form-grid settings-form-grid">
                <label>Payment Status<select value={invoiceBuilderDraft.paymentStatus} onChange={(event) => updateInvoiceBuilderField("paymentStatus", event.target.value)}><option value="pending">Pending</option><option value="full">Full Payment</option><option value="partial">Partial Payment</option></select></label>
                <label>Payment Method<select value={invoiceBuilderDraft.paymentMethod} onChange={(event) => updateInvoiceBuilderField("paymentMethod", event.target.value)}><option>Cash</option><option>UPI</option><option>Card</option><option>Bank Transfer</option></select></label>
                <label>Paid Amount<input type="number" min="0" step="0.01" value={invoiceBuilderDraft.paymentAmount} onChange={(event) => updateInvoiceBuilderField("paymentAmount", event.target.value)} placeholder="For partial payment" /></label>
                <label>Header Placement<select value={invoiceBuilderDraft.headerPlacement} onChange={(event) => updateInvoiceBuilderField("headerPlacement", event.target.value)}><option value="center">Centered</option><option value="left">Left aligned</option><option value="split">Logo left, details right</option></select></label>
                <label>Logo Placement<select value={invoiceBuilderDraft.logoPlacement} onChange={(event) => updateInvoiceBuilderField("logoPlacement", event.target.value)}><option value="top">Top</option><option value="left">Left</option><option value="hidden">Hidden</option></select></label>
                <label>Table Layout<select value={invoiceBuilderDraft.tableLayout} onChange={(event) => updateInvoiceBuilderField("tableLayout", event.target.value)}><option value="detailed">Detailed GST Table</option><option value="compact">Compact Table</option></select></label>
                <label className="settings-span-2">Payment Terms<textarea rows="2" value={invoiceBuilderDraft.paymentTerms} onChange={(event) => updateInvoiceBuilderField("paymentTerms", event.target.value)}></textarea></label>
                <label className="settings-span-2">Notes<textarea rows="2" value={invoiceBuilderDraft.notes} onChange={(event) => updateInvoiceBuilderField("notes", event.target.value)} placeholder="Optional invoice notes"></textarea></label>
                <label className="settings-span-2">Terms & Conditions<textarea rows="2" value={invoiceBuilderDraft.terms} onChange={(event) => updateInvoiceBuilderField("terms", event.target.value)}></textarea></label>
              </div>
            </section>
          </section>
          <aside className="invoice-builder-preview-panel">
            <div className={`a4-preview ${invoiceBuilderDraft.headerPlacement} logo-${invoiceBuilderDraft.logoPlacement}`}>
              <header>
                {invoiceBuilderDraft.logoPlacement !== "hidden" ? <StoreLogo source={storeLogoSource} fallback={fallbackInitials} className="a4-preview-logo" /> : null}
                <div>
                  <h3>{businessName}</h3>
                  <p>{ownerName}</p>
                  <p>{settings.businessPhone || settings.businessEmail || "Business contact not added"}</p>
                  <p>{settings.gstin ? `GSTIN ${settings.gstin}` : "GSTIN not added"}</p>
                </div>
              </header>
              <section className="a4-preview-meta">
                <div><strong>Invoice</strong><span>{invoiceBuilderDraft.invoiceNumber || buildClientInvoiceNumber(todayISO())}</span></div>
                <div><strong>Date</strong><span>{invoiceBuilderDraft.issuedOn}</span></div>
                <div><strong>Customer</strong><span>{invoiceBuilderDraft.customerName || DEFAULT_WALK_IN_CUSTOMER_NAME}</span></div>
              </section>
              <table>
                <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST</th><th>Total</th></tr></thead>
                <tbody>
                  {(invoiceBuilderDraft.lines || []).filter((line) => cleanText(line.itemName)).slice(0, 8).map((line) => (
                    <tr key={`preview-${line.id}`}><td>{line.itemName}</td><td>{line.quantity}</td><td>{currency(line.inclusivePrice)}</td><td>{line.gstRate}%</td><td>{currency(Number(line.inclusivePrice || 0) * Number(line.quantity || 0))}</td></tr>
                  ))}
                </tbody>
              </table>
              <div className="a4-preview-totals">
                <span>Taxable {currency(invoiceBuilderSummary.subtotal)}</span>
                <span>GST {currency(invoiceBuilderSummary.gst)}</span>
                <strong>Grand Total {currency(invoiceBuilderSummary.total)}</strong>
              </div>
              <p>{invoiceBuilderDraft.terms}</p>
            </div>
            <div className="modal-actions invoice-builder-actions">
              <button type="button" className="button button-secondary" onClick={closeModal}>Cancel</button>
              <button type="submit" className="button button-primary">Create Standard Invoice</button>
            </div>
          </aside>
        </form>
      </Modal>

      <Modal open={activeModal === "settings"} title="Settings" subtitle="Change appearance and personalize this billing workspace." large cardClass="settings-modal-card" onClose={closeModal}>
        {SettingsForm()}
      </Modal>

      <Modal open={activeModal === "login"} title="CinchPOS Account" subtitle="Login or create your shop account." cardClass="auth-modal-card" onClose={closeModal}>
        <div className="auth-panel">
          <div className="auth-workspace-card">
            <div className="auth-simple-head">
              <AppLogo />
              <div>
                <span>{authFormMode === "register" ? "Create Account" : "Login"}</span>
                <p>{authFormMode === "register" ? "Business name, one contact detail, and a strong password are enough." : "Use your email id or phone number with password, or login with OTP."}</p>
              </div>
            </div>
            <div className="auth-mode-tabs" role="tablist" aria-label="Account action">
              <button type="button" className={authFormMode === "login" ? "active" : ""} onClick={() => setAuthFormMode("login")}>Login</button>
              <button type="button" className={authFormMode === "register" ? "active" : ""} onClick={() => setAuthFormMode("register")}>Create Account</button>
            </div>
            {authFormMode === "register" ? (
              <form className="auth-form" onSubmit={submitCinchAccountAuth}>
                <label>Business Name
                  <input type="text" value={authForm.businessName} onChange={(event) => updateAuthForm("businessName", event.target.value)} placeholder="Store or company name" required />
                </label>
                <label>Email ID or Phone Number
                  <input type="text" autoComplete="email tel" value={authForm.contact} onChange={(event) => updateAuthForm("contact", event.target.value)} placeholder="owner email or 10 digit phone" required />
                </label>
                <label>Password
                  <input type="password" autoComplete="new-password" value={authForm.password} onChange={(event) => updateAuthForm("password", event.target.value)} placeholder="Password" required />
                </label>
                <div className="password-rules">
                  <span>8+ characters</span>
                  <span>Upper & lower case</span>
                  <span>Number</span>
                  <span>Special character</span>
                  <span>No spaces</span>
                </div>
                <div className="modal-actions auth-form-actions">
                  <button type="button" className="button button-secondary" onClick={closeModal} disabled={authGateActive}>Cancel</button>
                  <button type="submit" className="button button-primary" disabled={authBusy}>{authBusy ? "Creating..." : "Create Account"}</button>
                </div>
              </form>
            ) : (
              <form className="auth-form auth-form-single" onSubmit={submitCinchAccountAuth}>
                <label>Email ID or Phone Number
                  <input type="text" autoComplete="email tel" value={authForm.identifier} onChange={(event) => updateAuthForm("identifier", event.target.value)} placeholder="registered email or phone" required />
                </label>
                <label>Password
                  <input type="password" autoComplete="current-password" value={authForm.password} onChange={(event) => updateAuthForm("password", event.target.value)} placeholder="Password" />
                </label>
                <button type="submit" className="button button-primary" disabled={authBusy}>{authBusy ? "Checking..." : "Login"}</button>
                <div className="auth-divider"><span>or login with OTP</span></div>
                <div className="auth-otp-row">
                  <button type="button" className="button button-secondary" onClick={requestCinchOtp} disabled={authBusy}>{authBusy ? "Sending..." : (authForm.otpSent ? "Resend OTP" : "Send OTP")}</button>
                  <input type="text" inputMode="numeric" value={authForm.otpCode} onChange={(event) => updateAuthForm("otpCode", event.target.value)} placeholder="Enter OTP" />
                  <button type="button" className="button button-primary" onClick={verifyCinchOtp} disabled={authBusy || !authForm.otpSent}>{authBusy ? "Verifying..." : "Verify OTP"}</button>
                </div>
                {authForm.otpMessage ? <p className="auth-otp-note">{authForm.otpMessage}</p> : null}
              </form>
            )}
            <p className="auth-simple-note">CinchPOS keeps the customer ID hidden and generated automatically. Your password is never stored in the app.</p>
            {authState.authenticated ? (
              <div className="modal-actions auth-form-actions">
                <button type="button" className="button button-secondary" onClick={pullCloudWorkspace} disabled={cloudSyncBusy}>Pull Cloud Data</button>
                <button type="button" className="button button-secondary" onClick={signOutOfAuth} disabled={authBusy}>Logout</button>
                <button type="button" className="button button-primary" onClick={closeModal}>Done</button>
              </div>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );

  function InventoryView({ active }) {
    const {
      inventoryItems,
      setInventoryItems,
      inventorySearch,
      setInventorySearch,
      inventorySort,
      setInventorySort,
      inventoryVisibleCount,
      setInventoryVisibleCount,
      deferredInventorySearch,
      filteredInventory,
      visibleInventory,
      hasMoreInventory,
      smartInventoryReview,
      showMessage,
      managedWarehouses,
      activeWarehouseId
    } = inventoryViewContextRef.current;
    const inventorySortOptions = [
      ["nameAsc", "Alphabetically"],
      ["stockAsc", "Qty low to high"],
      ["stockDesc", "Qty high to low"],
      ["sellingDesc", "Selling high to low"]
    ];
    const activeInventorySortLabel = inventorySortOptions.find(([value]) => value === inventorySort)?.[1] || "Sort";

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
        unit: "pcs",
        reorder_level: "5",
        max_stock_level: "25",
        warehouse_id: activeWarehouseId || "main"
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
        unit: cleanText(item.unit, "pcs"),
        reorder_level: item.reorderLevel !== undefined && item.reorderLevel !== null
          ? String(item.reorderLevel)
          : (item.reorder_level !== undefined && item.reorder_level !== null ? String(item.reorder_level) : "5"),
        max_stock_level: item.maxStockLevel !== undefined && item.maxStockLevel !== null
          ? String(item.maxStockLevel)
          : (item.max_stock_level !== undefined && item.max_stock_level !== null ? String(item.max_stock_level) : "25"),
        warehouse_id: cleanText(item.warehouseId || item.warehouse_id, activeWarehouseId || "main")
      };
    }
    const [draft, setDraft] = useState(makeEmptyInventoryDraft);
    const [barcodeInputs, setBarcodeInputs] = useState([""]);
    const [selectedInventoryItemId, setSelectedInventoryItemId] = useState("");
    const [smartInventoryOpen, setSmartInventoryOpen] = useState(false);
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
        ? inventoryItems.find((item, index) => getInventoryItemKey(item, index) === selectedInventoryItemId || String(item.id || "") === selectedInventoryItemId) || null
        : null
    ), [inventoryItems, selectedInventoryItemId]);
    function resetInventoryEditor() {
      setSelectedInventoryItemId("");
      setBarcodeInputs([""]);
      setDraft(makeEmptyInventoryDraft());
    }
    function selectInventoryItem(item) {
      const nextBarcodes = getInventoryItemBarcodes(item);
      const itemIndex = inventoryItems.findIndex((entry) => entry === item || String(entry.id || "") === String(item?.id || ""));
      setSelectedInventoryItemId(getInventoryItemKey(item, Math.max(0, itemIndex)));
      setBarcodeInputs(nextBarcodes.length ? nextBarcodes : [""]);
      setDraft(buildInventoryDraft(item));
    }
    useEffect(() => {
      if (selectedInventoryItemId && !inventoryItems.some((item, index) => getInventoryItemKey(item, index) === selectedInventoryItemId || String(item.id || "") === selectedInventoryItemId)) {
        resetInventoryEditor();
      }
    }, [inventoryItems, selectedInventoryItemId]);
    function openSmartInventorySuggestion(suggestion) {
      const affectedIds = new Set(suggestion.itemIds || []);
      const matchedItem = inventoryItems.find((item, index) => affectedIds.has(getInventoryItemKey(item, index)) || affectedIds.has(String(item.id || "")));
      if (!matchedItem) {
        showMessage("The affected inventory item could not be found.");
        return;
      }
      selectInventoryItem(matchedItem);
      setInventorySearch(getInventoryItemName(matchedItem));
      setSmartInventoryOpen(false);
      showMessage("Affected item opened in Inventory Details.");
    }
    function handleSubmitInventory(event) {
      event.preventDefault();
      const itemName = cleanText(draft.item_name);
      const nextMrp = Number(draft.mrp || 0);
      const nextInclusivePrice = Number(draft.inclusive_price || 0);
      const nextGstRate = Number(draft.gst_rate || 0);
      const nextStock = Number(draft.stock || 0);
      const nextReorderLevel = Math.max(0, Number(draft.reorder_level || 0));
      const nextMaxStockLevel = Math.max(nextReorderLevel + 1, Number(draft.max_stock_level || 0) || (nextReorderLevel + 1));
      const nextBarcodes = normalizeInventoryBarcodes(barcodeInputs);
      if (!itemName || nextMrp <= 0 || nextInclusivePrice <= 0) {
        showMessage("Add item name, MRP, and selling price greater than zero. Barcode is optional.");
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
        barcode: nextBarcodes[0] || "",
        barcodes: nextBarcodes,
        category: cleanText(draft.category),
        hsn: cleanText(draft.hsn),
        manufacturingDate: draft.manufacturing_date || "",
        expiryDate: draft.expiry_date || "",
        stock: nextStock,
        unit: cleanText(draft.unit, "pcs"),
        reorderLevel: nextReorderLevel,
        maxStockLevel: nextMaxStockLevel,
        warehouseId: cleanText(draft.warehouse_id, activeWarehouseId || "main"),
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
      showMessage(selectedInventoryItem ? "Inventory item updated." : "Inventory item saved with stock, pricing, and date details.");
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
                      <label>{index === 0 ? "Barcode" : `Barcode ${index + 1}`}<input name="barcode" type="text" inputMode="numeric" placeholder={index === 0 ? "Optional barcode" : "Additional barcode"} value={barcode} onChange={(event) => updateBarcodeInput(index, event.target.value)} /></label>
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
                  <label>Reorder Level<input name="reorder_level" type="number" min="0" step="1" value={draft.reorder_level} onChange={(event) => updateDraftField("reorder_level", event.target.value)} /></label>
                  <label>Max Stock<input name="max_stock_level" type="number" min="1" step="1" value={draft.max_stock_level} onChange={(event) => updateDraftField("max_stock_level", event.target.value)} /></label>
                  <label>Warehouse<select name="warehouse_id" value={draft.warehouse_id} onChange={(event) => updateDraftField("warehouse_id", event.target.value)}>
                    {managedWarehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
                  </select></label>
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
            <div className="panel-header inventory-list-header">
              <div><h2>Inventory Items</h2><div className="panel-subtitle">Saved locally in this app workspace.</div></div>
              <div className="inventory-header-stack">
                <span className="inventory-total-chip">{inventoryItems.length} products</span>
                <button type="button" className="inventory-smart-button" aria-expanded={smartInventoryOpen} onClick={() => setSmartInventoryOpen((current) => !current)}>
                  <span>Smart Inventory</span>
                  <strong>{smartInventoryReview.suggestionCount}</strong>
                </button>
              </div>
            </div>
            <div className="inventory-list-controls">
              <label className="inventory-search">Search Products<input id="inventorySearch" type="search" placeholder="Search by item name or barcode" value={inventorySearch} onChange={(event) => setInventorySearch(event.target.value)} /></label>
              <label className="inventory-sort-icon-control inventory-sort-inline" title={`Sort products: ${activeInventorySortLabel}`}>
                <span className="inventory-sort-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M4 7h10M4 12h7M4 17h4M16 5v14M12 15l4 4 4-4" />
                  </svg>
                </span>
                <span className="inventory-sort-current">{activeInventorySortLabel}</span>
                <select aria-label="Sort Products" value={inventorySort} onChange={(event) => setInventorySort(event.target.value)}>
                  {inventorySortOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
              </label>
              {smartInventoryOpen ? (
                <div className="inventory-smart-panel" role="region" aria-label="Smart inventory suggestions">
                  {smartInventoryReview.suggestions.length ? smartInventoryReview.suggestions.map((suggestion, suggestionIndex) => (
                    <article className={`inventory-smart-item ${suggestion.type}`} key={`${suggestion.title}-${suggestionIndex}`}>
                      <div>
                        <strong>{suggestion.title}</strong>
                        <span>{suggestion.problem}</span>
                        <small>{suggestion.recommendedAction}</small>
                      </div>
                      <button type="button" className="button button-secondary" onClick={() => openSmartInventorySuggestion(suggestion)}>Open Items</button>
                    </article>
                  )) : <p>No inventory suggestions right now.</p>}
                </div>
              ) : null}
            </div>
            <div id="inventoryList" className="inventory-list">
              {!inventoryItems.length ? <Empty>No inventory items yet. Add an item with an inclusive GST price to see CGST and SGST breakup here.</Empty> : null}
              {inventoryItems.length && !filteredInventory.length ? <Empty>No products match your search. Try item name, barcode, category, HSN/SAC, or price.</Empty> : null}
              {visibleInventory.map((item, index) => {
                const itemKey = getInventoryItemKey(item, index);
                const itemName = getInventoryItemName(item) || "Untitled item";
                const inclusivePrice = Number(item.inclusivePrice || item.inclusive_price || 0);
                const barcode = getInventoryBarcodeLabel(item);
                const quantityLabel = `${Number(item.stock || 0)} ${item.unit || "pcs"}`;
                const warehouseName = managedWarehouses.find((warehouse) => warehouse.id === (item.warehouseId || item.warehouse_id))?.name;
                const isSelected = selectedInventoryItemId === itemKey || selectedInventoryItemId === String(item.id || "");
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
                          <p className="inventory-compact-meta">Barcode {barcode}{warehouseName ? ` | ${warehouseName}` : ""}</p>
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

  function SellOnlineView({ active }) {
    const visibleProducts = sellOnlineProducts.slice(0, 180);
    const hiddenCount = Math.max(0, sellOnlineProducts.length - visibleProducts.length);
    const onlineStoreUrl = onlineStoreProfile?.public_url || "";

    return (
      <section id="sellOnlineView" className={`app-view ${active ? "active" : ""}`} data-title="Sell Online">
        <section className="panel sell-online-panel">
          <div className="panel-header sell-online-header">
            <div>
              <h2>Sell Online</h2>
              <div className="panel-subtitle">Publish selected inventory products to your public CinchPOS online store.</div>
            </div>
            <div className="sell-online-stats">
              <span>{selectedSellOnlineProducts.length} selected</span>
              <span>{inventoryItems.length} inventory items</span>
              {onlineStoreProfile?.slug ? <span>{onlineStoreProfile.slug}</span> : null}
            </div>
          </div>

          <div className="sell-online-controls">
            <label>Search Products
              <input
                type="search"
                placeholder="Search by item name or barcode"
                value={sellOnlineSearch}
                onChange={(event) => setSellOnlineSearch(event.target.value)}
              />
            </label>
            <div className="sell-online-actions">
              <button type="button" className="button button-secondary" onClick={() => selectVisibleSellOnlineProducts(visibleProducts.map((product) => product.id))}>Select Visible</button>
              <button type="button" className="button button-secondary" onClick={clearSellOnlineProducts} disabled={!selectedSellOnlineProducts.length}>Clear Selection</button>
            </div>
          </div>

          <div className="sell-online-layout">
            <div className="sell-online-list" aria-label="Inventory products available for online selling">
              {!inventoryItems.length ? <Empty>Add inventory items first, then choose which products should be sold online.</Empty> : null}
              {inventoryItems.length && !sellOnlineProducts.length ? <Empty>No products match this search.</Empty> : null}
              {visibleProducts.map((product) => (
                <article className={`sell-online-card ${product.selected ? "selected" : ""}`} key={product.id}>
                  <div className="sell-online-card-copy">
                    <h3>{product.name || "Untitled item"}</h3>
                    <p>Barcode {product.barcode || "Not added"}</p>
                    <span>Offline {currency(product.price)} | Online {currency(product.onlinePrice)} | Qty {product.stock}</span>
                  </div>
                  {product.selected ? (
                    <label className="sell-online-price-field">Online Price
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={sellOnlineCatalog[product.id]?.onlinePrice ?? product.price}
                        onChange={(event) => updateSellOnlinePrice(product.id, event.target.value)}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className={`button ${product.selected ? "button-secondary" : "button-primary"}`}
                    onClick={() => toggleSellOnlineProduct(product.id)}
                  >
                    {product.selected ? "Remove" : "Sell Online"}
                  </button>
                </article>
              ))}
              {hiddenCount ? <p className="sell-online-more-note">Showing first 180 matches. Search by name or barcode to narrow the list.</p> : null}
            </div>

            <aside className="sell-online-summary">
              <h3>Online Catalog</h3>
              <p className="panel-subtitle">The online store URL uses your shop name and the unique store ID generated by the CinchPOS database.</p>
              <div className="sell-online-count-card">
                <span>Ready to sell online</span>
                <strong>{selectedSellOnlineProducts.length}</strong>
              </div>
              <div className="online-store-url-card">
                <span>Public Store URL</span>
                <strong>{onlineStoreUrl || "Publish once to generate URL"}</strong>
                {onlineStoreUrl ? (
                  <div className="sell-online-url-actions">
                    <button type="button" className="button button-secondary" onClick={() => navigator.clipboard?.writeText(onlineStoreUrl).then(() => showMessage("Online store URL copied."))}>Copy URL</button>
                    <a className="button button-secondary" href={onlineStoreUrl} target="_blank" rel="noreferrer">Open Store</a>
                  </div>
                ) : null}
              </div>
              <button type="button" className="button button-primary" onClick={publishSellOnlineCatalog} disabled={onlineStoreBusy || !selectedSellOnlineProducts.length}>
                {onlineStoreBusy ? "Publishing..." : "Publish Online Store"}
              </button>
              <div className="sell-online-selected-list">
                {selectedSellOnlineProducts.length ? selectedSellOnlineProducts.slice(0, 12).map((product) => (
                  <article key={product.id}>
                    <span>{product.name || "Untitled item"}</span>
                    <small>Online {currency(product.onlinePrice)} | Offline {currency(product.offlinePrice)} | Qty {product.stock}</small>
                  </article>
                )) : <Empty>No products selected yet.</Empty>}
              </div>
            </aside>
          </div>
        </section>
      </section>
    );
  }

  function PurchaseView({ active }) {
    return (
      <section id="purchaseView" className={`app-view ${active ? "active" : ""}`} data-title="Purchase">
        <section className="panel purchase-entry-panel">
          <div className="panel-header"><div><h2>Purchase</h2><div className="panel-subtitle">Record the supplier purchase and attach its bill in one place.</div></div></div>
          <form id="purchaseForm" className="workspace-form purchase-form" noValidate onSubmit={submitPurchase}>
            <div className="module-grid purchase-grid">
              <label>Supplier<input name="supplier" type="text" placeholder="Supplier name" required /></label>
              <label>Item / Material<input name="item" type="text" placeholder="Purchase item" required /></label>
              <label>Bill Number<input name="bill_number" type="text" placeholder="Optional" /></label>
              <label>Purchase Date<input name="purchase_date" type="date" defaultValue={todayISO()} required /></label>
              <label>Amount<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>
              <label>GST Amount<input name="gst_amount" type="number" min="0" step="0.01" placeholder="0.00" /></label>
              <label>Payment Status<select name="payment_status"><option>Paid</option><option>Pending</option><option>Partial</option></select></label>
              <label>Supplier Bill<input name="bill_file" type="file" accept="image/*,.pdf" /></label>
            </div>
            <label className="purchase-notes-field">Notes<input name="notes" type="text" placeholder="Optional" /></label>
            <div className="modal-actions purchase-actions"><button type="submit" className="button button-primary">Save Purchase</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Purchase Records</h2><div className="panel-subtitle">Every supplier purchase, payment status, GST amount, and attached bill.</div></div></div>
          <div id="purchaseList" className="record-list">
            {purchaseRecords.length ? purchaseRecords.map((purchase) => (
              <article className="record-card" key={purchase.id}>
                <div className="record-top">
                  <div>
                    <h3>{purchase.supplier}</h3>
                    <p className="record-meta">{purchase.item || "Item not added"} | Bill {purchase.billNumber || "Not added"} | {purchase.purchaseDate || "Date not added"}</p>
                  </div>
                  <strong className="record-amount">{currency(purchase.amount)}</strong>
                </div>
                <div className="record-meta-grid">
                  <span>{purchase.paymentStatus || "Status not recorded"}</span>
                  <span>GST {currency(purchase.gstAmount)}</span>
                  <span>{purchase.notes || "No notes"}</span>
                  <span>{purchase.fileName || "No bill attached"}</span>
                </div>
                <div className="record-actions"><FileAction record={purchase} label="Download Bill" /></div>
              </article>
            )) : <Empty>No purchases saved yet. Supplier purchases will appear here.</Empty>}
          </div>
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
    const paidInvoices = allInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Paid").length;
    const pendingInvoices = allInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Unpaid").length;
    const overdueInvoices = allInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Overdue").length;
    const totalCollections = allInvoices.reduce((total, invoice) => total + invoicePaidAmount(invoice), 0);
    const totalOutstanding = allInvoices.reduce((total, invoice) => total + invoiceOutstandingAmount(invoice), 0);
    const averageInvoiceValue = allInvoices.length ? allInvoices.reduce((total, invoice) => total + Number(invoice.amount || 0), 0) / allInvoices.length : 0;
    const reportStartDate = cleanText(salesReportFilters.startDate);
    const reportEndDate = cleanText(salesReportFilters.endDate);
    const reportStatus = cleanText(salesReportFilters.status, "all").toLowerCase();
    const reportContent = cleanText(salesReportFilters.content, "full");
    const reportFormat = cleanText(salesReportFilters.format, "xlsx").toLowerCase();
    const invoiceDateISO = (invoice) => cleanText(invoice.issued_on || invoice.issuedOn || invoice.date).slice(0, 10);
    const customReportInvoices = allInvoices.filter((invoice) => {
      const invoiceDate = invoiceDateISO(invoice);
      const invoiceStatus = getInvoicePaymentStatus(invoice).toLowerCase();
      const matchesStart = !reportStartDate || (invoiceDate && invoiceDate >= reportStartDate);
      const matchesEnd = !reportEndDate || (invoiceDate && invoiceDate <= reportEndDate);
      const matchesStatus = reportStatus === "all" || invoiceStatus === reportStatus;
      return matchesStart && matchesEnd && matchesStatus;
    });
    const customReportSummary = {
      invoiceCount: customReportInvoices.length,
      totalAmount: customReportInvoices.reduce((total, invoice) => total + Number(invoice.amount || 0), 0),
      collected: customReportInvoices.reduce((total, invoice) => total + invoicePaidAmount(invoice), 0),
      outstanding: customReportInvoices.reduce((total, invoice) => total + invoiceOutstandingAmount(invoice), 0),
      paid: customReportInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Paid").length,
      unpaid: customReportInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Unpaid").length,
      overdue: customReportInvoices.filter((invoice) => getInvoicePaymentStatus(invoice) === "Overdue").length
    };
    const downloadCustomizedSalesReport = () => {
      if (reportStartDate && reportEndDate && reportStartDate > reportEndDate) {
        showMessage("Select a valid report date range.");
        return;
      }
      const reportRows = customReportInvoices.map((invoice, index) => ({
        serialNo: index + 1,
        invoiceNumber: invoice.invoice_number || invoice.invoiceNumber || "",
        date: invoiceDateISO(invoice),
        customer: cleanText(invoice.customer_name || invoice.customerName, DEFAULT_WALK_IN_CUSTOMER_NAME),
        phone: getInvoicePhone(invoice),
        amount: Number(invoice.amount || 0).toFixed(2),
        paid: invoicePaidAmount(invoice).toFixed(2),
        outstanding: invoiceOutstandingAmount(invoice).toFixed(2),
        status: getInvoicePaymentStatus(invoice)
      }));
      const filterSummary = {
        generatedOn: new Date().toLocaleString("en-IN"),
        business: businessName,
        startDate: reportStartDate || "All dates",
        endDate: reportEndDate || "All dates",
        status: reportStatus === "all" ? "All statuses" : reportStatus,
        content: reportContent,
        stockValue: Number(inventoryStockValue || 0).toFixed(2),
        ...customReportSummary
      };
      if (reportFormat === "xlsx") {
        const workbook = buildGstr1Workbook({
          businessName,
          businessPhone: settings.businessPhone,
          businessGstin: settings.gstin,
          businessAddress: settings.businessAddress,
          businessStateCode: settings.businessStateCode,
          businessStateName: settings.businessState,
          startDate: reportStartDate,
          endDate: reportEndDate,
          records: customReportInvoices.map((invoice) => ({
            invoice,
            detail: getInvoiceDetail(invoice)
          }))
        });
        const blob = new Blob([writeGstr1Workbook(workbook)], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = makeGstr1ReportFileName({
          businessName,
          startDate: reportStartDate,
          endDate: reportEndDate
        });
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 800);
        showMessage("GSTR-1 Excel report downloaded.");
        return;
      }
      if (reportFormat === "json") {
        const blob = new Blob([JSON.stringify({
          title: "CinchPOS Custom Sales Report",
          summary: filterSummary,
          trend: reportContent === "summary" ? [] : trend,
          invoices: reportContent === "summary" ? [] : reportRows
        }, null, 2)], { type: "application/json;charset=utf-8" });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${makeDownloadFileName(`${businessName}-${reportStartDate || "all"}-${reportEndDate || todayISO()}`, "cinchpos-custom-sales-report")}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => window.URL.revokeObjectURL(url), 800);
        showMessage("Custom sales report downloaded.");
        return;
      }
      const lines = [
        csvRow(["CinchPOS Custom Sales Report"]),
        csvRow(["Generated On", filterSummary.generatedOn]),
        csvRow(["Business", filterSummary.business]),
        csvRow(["Date Range", filterSummary.startDate, filterSummary.endDate]),
        csvRow(["Payment Status", filterSummary.status]),
        "",
        csvRow(["Summary"]),
        csvRow(["Stock Value", filterSummary.stockValue]),
        csvRow(["Invoice Count", filterSummary.invoiceCount]),
        csvRow(["Total Sales Amount", customReportSummary.totalAmount.toFixed(2)]),
        csvRow(["Total Collected", customReportSummary.collected.toFixed(2)]),
        csvRow(["Outstanding", customReportSummary.outstanding.toFixed(2)]),
        csvRow(["Paid Invoices", customReportSummary.paid]),
        csvRow(["Unpaid Invoices", customReportSummary.unpaid]),
        csvRow(["Overdue Invoices", customReportSummary.overdue])
      ];
      if (reportContent !== "summary") {
        lines.push(
          "",
          csvRow(["Trend", trendView]),
          csvRow(["Label", "Value"]),
          ...trend.map((point) => csvRow([point.label, point.value])),
          "",
          csvRow(["Invoices"]),
          csvRow(["Serial No.", "Invoice Number", "Date", "Customer", "Phone", "Amount", "Paid", "Outstanding", "Status"]),
          ...reportRows.map((invoice) => csvRow([
            invoice.serialNo,
            invoice.invoiceNumber,
            invoice.date,
            invoice.customer,
            invoice.phone,
            invoice.amount,
            invoice.paid,
            invoice.outstanding,
            invoice.status
          ]))
        );
      }
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${makeDownloadFileName(`${businessName}-${reportStartDate || "all"}-${reportEndDate || todayISO()}`, "cinchpos-custom-sales-report")}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 800);
      showMessage("Custom sales report downloaded.");
    };
    return (
      <section id="salesReportView" className={`app-view ${active ? "active" : ""}`} data-title="Sales Report">
        <section className="panel sales-report-panel">
          <div className="panel-header">
            <div>
              <h2>Sales Report</h2>
              <div className="panel-subtitle">Sales performance, collections, outstanding invoices, and billing health.</div>
            </div>
            <div className="panel-actions">
              <button className="button button-secondary" type="button" onClick={() => setActiveView("invoicesView")}>Open Invoices</button>
              <button className="button button-primary" type="button" onClick={downloadCustomizedSalesReport}>Download Custom Report</button>
            </div>
          </div>
          <section className="sales-report-customizer" aria-label="Custom sales report filters">
            <div>
              <strong>Custom Report</strong>
              <span>{customReportInvoices.length} matching invoice(s)</span>
            </div>
            <label>From<input type="date" value={salesReportFilters.startDate} onChange={(event) => setSalesReportFilters((current) => ({ ...current, startDate: event.target.value }))} /></label>
            <label>To<input type="date" value={salesReportFilters.endDate} onChange={(event) => setSalesReportFilters((current) => ({ ...current, endDate: event.target.value }))} /></label>
            <label>Status<select value={salesReportFilters.status} onChange={(event) => setSalesReportFilters((current) => ({ ...current, status: event.target.value }))}><option value="all">All</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option><option value="overdue">Overdue</option></select></label>
            <label>Content<select value={salesReportFilters.content} disabled={reportFormat === "xlsx"} onChange={(event) => setSalesReportFilters((current) => ({ ...current, content: event.target.value }))}><option value="full">{reportFormat === "xlsx" ? "Complete GSTR-1" : "Summary + Invoices"}</option><option value="summary">Summary only</option></select></label>
            <label>Format<select value={salesReportFilters.format} onChange={(event) => setSalesReportFilters((current) => ({ ...current, format: event.target.value, ...(event.target.value === "xlsx" ? { content: "full" } : {}) }))}><option value="xlsx">GSTR-1 Excel (.xlsx)</option><option value="csv">CSV Summary</option><option value="json">JSON Data</option></select></label>
          </section>
	          <div className="sales-report-grid">
	            <article className="sales-report-card">
	              <span>Stock Value</span>
	              <strong>{compactCurrency(inventoryStockValue)}</strong>
	              <small>Current inventory quantity x selling price</small>
	            </article>
            <article className="sales-report-card">
              <span>Total Collected</span>
              <strong>{compactCurrency(totalCollections)}</strong>
              <small>Across all saved invoices</small>
            </article>
            <article className="sales-report-card warning">
              <span>Outstanding</span>
              <strong>{compactCurrency(totalOutstanding || currentSummary.outstanding_payments)}</strong>
              <small>Pending customer balances</small>
            </article>
            <article className="sales-report-card">
              <span>Average Invoice</span>
              <strong>{compactCurrency(averageInvoiceValue)}</strong>
              <small>{allInvoices.length} invoice(s) tracked</small>
            </article>
          </div>
          <div className="sales-report-lower">
            <section className="sales-health-card">
              <div className="sales-health-top">
                <div>
                  <h3>Invoice Health</h3>
                  <p className="record-meta">Click a status to review invoices and collect pending payments.</p>
                </div>
                <strong>{allInvoices.length}</strong>
              </div>
              <div className="sales-status-actions">
                <button type="button" className="status-badge status-button status-paid" onClick={() => setActiveView("invoicesView")}>Paid {paidInvoices}</button>
                <button type="button" className="status-badge status-button status-pending" onClick={() => setActiveView("invoicesView")}>Unpaid {pendingInvoices}</button>
                <button type="button" className="status-badge status-button status-overdue" onClick={() => setActiveView("invoicesView")}>Overdue {overdueInvoices}</button>
              </div>
            </section>
            <section className="sales-trend-mini">
              <div className="sales-health-top">
                <div>
                  <h3>Collection Trend</h3>
                  <p className="record-meta">{trendCaption}</p>
                </div>
                <span>Peak {currency(trendPeak)}</span>
              </div>
              <div className="segmented-control sales-trend-controls">
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
              <TrendChart points={trend} />
            </section>
          </div>
        </section>
      </section>
    );
  }

  function EmployeeView({ active }) {
    const activeEmployees = employees.filter((employee) => cleanText(employee.status, "Active") === "Active").length;
    const attendanceMarked = employees.filter((employee) => (employee.attendance || []).some((entry) => entry.date === todayISO())).length;
    const suggestedRoles = [
      { role_key: "salesman", name: "Salesman" },
      { role_key: "store_manager", name: "Store Manager" },
      { role_key: "stock_manager", name: "Stock Manager" },
      { role_key: "cashier", name: "Cashier" },
      { role_key: "manager", name: "Manager" },
      { role_key: "warehouse_manager", name: "Warehouse Manager" },
      { role_key: "accountant", name: "Accountant" },
      { role_key: "employee", name: "Employee" }
    ];
    const roleOptionMap = new Map();
    [...suggestedRoles, ...authRoles.filter((role) => (role.role_key || role.key) !== "owner")].forEach((role) => {
      const key = role.role_key || role.key;
      if (key) {
        roleOptionMap.set(key, { role_key: key, name: role.name || key.replace(/_/g, " ") });
      }
    });
    const employeeRoleOptions = Array.from(roleOptionMap.values());
    const permissionSummary = employeePermissionDraft.includes("*")
      ? "All modules"
      : `${employeePermissionDraft.length} module permission${employeePermissionDraft.length === 1 ? "" : "s"}`;
    return (
      <section id="employeeView" className={`app-view ${active ? "active" : ""}`} data-title="Manage Employee">
        <div className="employee-dashboard">
          <section className="panel employee-editor-panel">
            <div className="panel-header"><div><h2>Manage Employee</h2><div className="panel-subtitle">Employee roles, permissions, attendance, salary, and documents.</div></div></div>
            <div className="employee-metrics">
              <article><strong>{employees.length}</strong><span>Total staff</span></article>
              <article><strong>{activeEmployees}</strong><span>Active</span></article>
              <article><strong>{attendanceMarked}</strong><span>Attendance today</span></article>
            </div>
            <form className="workspace-form employee-form" onSubmit={submitEmployee}>
              <div className="module-grid employee-form-grid">
                <label>Employee Name<input name="name" type="text" placeholder="Employee name" required /></label>
                <label>Role<input name="role" type="text" placeholder="Counter Staff" required /></label>
                <label>Email<input name="email" type="email" placeholder="employee@example.com" /></label>
                <label>Access Role<select name="role_key" value={employeeAccessRole} onChange={(event) => updateEmployeeAccessRole(event.target.value)}>{employeeRoleOptions.map((role) => <option key={role.role_key} value={role.role_key}>{role.name || role.role_key}</option>)}</select></label>
                <label>Phone<input name="phone" type="tel" placeholder="Phone number" /></label>
                <label>Status<select name="status"><option>Active</option><option>Inactive</option></select></label>
                <label>Monthly Salary<input name="salary" type="number" min="0" step="0.01" placeholder="0.00" /></label>
                <label>Aadhaar Card<input name="aadhar_file" type="file" accept="image/*,.pdf" /></label>
                <label>PAN Card<input name="pan_file" type="file" accept="image/*,.pdf" /></label>
                <label className="module-span-2">Address<textarea name="address" rows="2" placeholder="Employee address"></textarea></label>
                <div className="employee-access-panel module-span-2">
                  <div className="employee-permission-head">
                    <div>
                      <strong>Feature Access</strong>
                      <span>{canManageEmployeeAccess ? `Owner control active: ${permissionSummary}` : "Only the owner can customize module access."}</span>
                    </div>
                    <div className="employee-permission-actions">
                      <button type="button" className="button button-secondary file-action" disabled={!canManageEmployeeAccess} onClick={() => setEmployeePermissionDraft(getRoleDefaultPermissions(employeeAccessRole))}>Role Default</button>
                      <button type="button" className="button button-secondary file-action" disabled={!canManageEmployeeAccess} onClick={() => setEmployeePermissionDraft([])}>Lock All</button>
                    </div>
                  </div>
                  <div className="employee-permission-grid">
                    {employeePermissionOptions.map(([permission, label]) => (
                      <label key={permission} className={`employee-permission-toggle ${employeePermissionDraft.includes(permission) || employeePermissionDraft.includes("*") ? "active" : ""}`}>
                        <input
                          type="checkbox"
                          name="permission_set"
                          value={permission}
                          checked={employeePermissionDraft.includes(permission) || employeePermissionDraft.includes("*")}
                          disabled={!canManageEmployeeAccess || employeePermissionDraft.includes("*")}
                          onChange={() => toggleEmployeePermission(permission)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="modal-actions"><button type="submit" className="button button-primary">Save Employee</button></div>
            </form>
          </section>
          <section className="panel employee-list-panel">
            <div className="panel-header"><div><h2>Employee Records</h2><div className="panel-subtitle">Compact staff list with daily attendance controls.</div></div></div>
            <div className="employee-table-shell">{employees.length ? (
              <table className="data-table employee-table">
                <thead>
                  <tr><th>Name</th><th>Role</th><th>Contact</th><th>Salary</th><th>Status</th><th>Attendance</th><th>Docs</th><th>Actions</th></tr>
                </thead>
                <tbody>
                  {employees.map((employee) => {
                    const attendanceToday = (employee.attendance || []).find((entry) => entry.date === todayISO());
                    return (
                      <tr key={employee.id}>
                        <td><strong>{employee.name}</strong><span>{employee.address || "Address not added"}</span></td>
                        <td>{employee.role}<span>{employee.roleKey || "employee"} | {(employee.permissionSet || []).length || 0} access rules</span></td>
                        <td>{employee.phone || "No phone"}<span>{employee.email || "No email"} | {employee.authStatus || "Local record"}</span></td>
                        <td>{currency(employee.salary || 0)}</td>
                        <td><span className="record-chip">{employee.status}</span></td>
                        <td>
                          <div className="attendance-actions compact">
                            <span>{attendanceToday?.status || "Not marked"}</span>
                            {["Present", "Absent", "Half Day"].map((status) => (
                              <button key={status} className="button button-secondary file-action" type="button" onClick={() => markEmployeeAttendance(employee.id, status)}>{status}</button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="employee-doc-actions">
                            {employee.aadharFileData ? <FileAction record={{ fileData: employee.aadharFileData, fileName: employee.aadharFileName }} label="Aadhaar" /> : <span>Aadhaar missing</span>}
                            {employee.panFileData ? <FileAction record={{ fileData: employee.panFileData, fileName: employee.panFileName }} label="PAN" /> : <span>PAN missing</span>}
                          </div>
                        </td>
                        <td><button type="button" className="button button-danger file-action" onClick={() => deleteEmployee(employee.id)}>Delete</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <Empty>No employees saved yet.</Empty>}</div>
          </section>
        </div>
      </section>
    );
  }

  function BankView({ active }) {
    return (
      <section id="bankView" className={`app-view ${active ? "active" : ""}`} data-title="Your Bank">
        <section className="panel">
          <div className="panel-header"><div><h2>Your Bank</h2><div className="panel-subtitle">Store settlement account, UPI, and reconciliation details.</div></div></div>
          <form id="bankForm" className="workspace-form" onSubmit={submitBank}>
            <div className="module-grid">
              <label>Account Holder<input name="account_holder" type="text" placeholder="Store or owner name" defaultValue={bankAccount?.accountHolder || ""} required /></label>
              <label>Bank Name<input name="bank_name" type="text" placeholder="Bank name" defaultValue={bankAccount?.bankName || ""} required /></label>
              <label>Account Type<select name="account_type" defaultValue={bankAccount?.accountType || "Current"}><option>Current</option><option>Savings</option><option>Cash Credit</option><option>Overdraft</option></select></label>
              <label>Account Number<input name="account_number" type="password" inputMode="numeric" placeholder="Account number" defaultValue={bankAccount?.accountNumber || ""} required /></label>
              <label>Confirm Account<input name="confirm_account_number" type="password" inputMode="numeric" placeholder="Re-enter account number" defaultValue={bankAccount?.accountNumber || ""} required /></label>
              <label>IFSC<input name="ifsc" type="text" placeholder="ABCD0123456" defaultValue={bankAccount?.ifsc || ""} maxLength="11" required /></label>
              <label>UPI ID<input name="upi_id" type="text" placeholder="store@bank" defaultValue={bankAccount?.upiId || ""} /></label>
              <label>Branch<input name="branch" type="text" placeholder="Optional" defaultValue={bankAccount?.branch || ""} /></label>
              <label>Settlement Mode<select name="settlement_mode" defaultValue={bankAccount?.settlementMode || "Manual reconciliation"}><option>Manual reconciliation</option><option>UPI settlement</option><option>Card settlement</option><option>Bank transfer settlement</option></select></label>
              <label>Reconcile<select name="reconciliation_frequency" defaultValue={bankAccount?.reconciliationFrequency || "Daily"}><option>Daily</option><option>Weekly</option><option>Monthly</option></select></label>
              <label>UPI QR / Bank Proof<input name="qr_file" type="file" accept="image/*,.pdf" /></label>
              <label className="module-span-2">Notes<input name="notes" type="text" placeholder="Optional bank or settlement note" defaultValue={bankAccount?.notes || ""} /></label>
            </div>
            <p className="settings-help">CinchPOS stores only merchant settlement details on this device. It does not store card data, login credentials, OTPs, or perform bank transfers.</p>
            <div className="modal-actions"><button type="submit" className="button button-primary">Save Bank Details</button></div>
          </form>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Linked Account</h2><div className="panel-subtitle">Settlement account details for this store.</div></div></div>
          <div id="bankAccountCard" className="record-list">{bankAccount ? <article className="record-card bank-card"><div className="record-top"><div><h3>{bankAccount.bankName || "Linked Bank"}</h3><p className="record-meta">{bankAccount.accountHolder || "Account holder not added"} | {bankAccount.accountType || "Account type not added"}</p></div><strong className="record-amount">{maskAccountNumber(bankAccount.accountNumber)}</strong></div><div className="record-meta-grid"><span>IFSC {bankAccount.ifsc || "Not added"}</span><span>UPI {bankAccount.upiId || "Not added"}</span><span>Branch {bankAccount.branch || "Not added"}</span><span>{bankAccount.settlementMode || "Manual reconciliation"}</span><span>{bankAccount.reconciliationFrequency || "Daily"} check</span></div>{bankAccount.notes ? <p className="record-meta">{bankAccount.notes}</p> : null}{bankAccount.qrFileData ? <div className="record-actions"><FileAction record={{ fileData: bankAccount.qrFileData, fileName: bankAccount.qrFileName }} label="Download QR / Proof" /></div> : null}</article> : <Empty>No bank account linked yet. Add the store account used for settlements.</Empty>}</div>
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
        {DataTransferPanel()}
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
      ["Sell Online", workspaceStats.sellOnline],
      ["Purchases", workspaceStats.purchases],
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

    function getDraftBusinesses(currentDraft = draft) {
      const activeId = cleanText(currentDraft.activeBusinessId, "primary");
      const primary = {
        id: "primary",
        name: cleanText(currentDraft.businessName, defaultSettings.businessName),
        ownerName: cleanText(currentDraft.ownerName, defaultSettings.ownerName),
        phone: cleanText(currentDraft.businessPhone),
        email: cleanText(currentDraft.businessEmail),
        address: cleanText(currentDraft.businessAddress),
        gstin: cleanText(currentDraft.gstin).toUpperCase(),
        logo: currentDraft.storeLogo || currentDraft.storeLogoUrl || "",
        status: "Active"
      };
      const list = Array.isArray(currentDraft.businesses) && currentDraft.businesses.length
        ? currentDraft.businesses
        : [primary];
      const normalized = list.map((business, index) => ({
        ...primary,
        ...business,
        id: cleanText(business.id, index === 0 ? "primary" : `business-${index + 1}`),
        name: cleanText(business.name, index === 0 ? primary.name : `Business ${index + 1}`)
      }));
      if (!normalized.some((business) => business.id === activeId)) {
        normalized.unshift({ ...primary, id: activeId || "primary" });
      }
      return normalized.map((business) => (
        business.id === activeId
          ? {
              ...business,
              name: primary.name,
              ownerName: primary.ownerName,
              phone: primary.phone,
              email: primary.email,
              address: primary.address,
              gstin: primary.gstin,
              logo: primary.logo
            }
          : business
      ));
    }

    function getDraftWarehouses(currentDraft = draft) {
      const activeBusiness = cleanText(currentDraft.activeBusinessId, "primary");
      const fallback = {
        id: "main",
        name: "Main Warehouse",
        businessId: activeBusiness,
        location: cleanText(currentDraft.businessAddress),
        status: "Active"
      };
      const list = Array.isArray(currentDraft.warehouses) && currentDraft.warehouses.length
        ? currentDraft.warehouses
        : [fallback];
      return list.map((warehouse, index) => ({
        ...fallback,
        ...warehouse,
        id: cleanText(warehouse.id, index === 0 ? "main" : `warehouse-${index + 1}`),
        name: cleanText(warehouse.name, index === 0 ? "Main Warehouse" : `Warehouse ${index + 1}`),
        businessId: cleanText(warehouse.businessId || warehouse.business_id, activeBusiness),
        status: cleanText(warehouse.status, "Active")
      }));
    }

    function switchDraftBusiness(businessId) {
      setDraft((current) => {
        const businesses = getDraftBusinesses(current);
        const selectedBusiness = businesses.find((business) => business.id === businessId) || businesses[0];
        return {
          ...current,
          businesses,
          activeBusinessId: selectedBusiness.id,
          businessName: selectedBusiness.name,
          ownerName: selectedBusiness.ownerName,
          businessPhone: selectedBusiness.phone,
          businessEmail: selectedBusiness.email,
          businessAddress: selectedBusiness.address,
          gstin: selectedBusiness.gstin,
          storeLogo: selectedBusiness.logo || "",
          storeLogoUrl: "",
          logoName: selectedBusiness.logo ? `${selectedBusiness.name} logo` : current.logoName
        };
      });
    }

    function createDraftBusiness() {
      const id = `business-${Date.now()}`;
      const nextBusiness = {
        id,
        name: `New Business ${getDraftBusinesses().length + 1}`,
        ownerName: "Billing Workspace",
        phone: "",
        email: "",
        address: "",
        gstin: "",
        logo: "",
        status: "Active"
      };
      setDraft((current) => ({
        ...current,
        businesses: [...getDraftBusinesses(current), nextBusiness],
        activeBusinessId: id,
        businessName: nextBusiness.name,
        ownerName: nextBusiness.ownerName,
        businessPhone: "",
        businessEmail: "",
        businessAddress: "",
        gstin: "",
        storeLogo: "",
        storeLogoUrl: "",
        logoName: ""
      }));
    }

    function updateDraftBusiness(businessId, patch) {
      setDraft((current) => {
        const nextBusinesses = getDraftBusinesses(current).map((business) => (
          business.id === businessId ? { ...business, ...patch } : business
        ));
        const selectedBusiness = nextBusinesses.find((business) => business.id === (current.activeBusinessId || "primary"));
        return {
          ...current,
          businesses: nextBusinesses,
          ...(selectedBusiness ? {
            businessName: selectedBusiness.name,
            ownerName: selectedBusiness.ownerName,
            businessPhone: selectedBusiness.phone,
            businessEmail: selectedBusiness.email,
            businessAddress: selectedBusiness.address,
            gstin: selectedBusiness.gstin,
            storeLogo: selectedBusiness.logo || current.storeLogo
          } : {})
        };
      });
    }

    function deleteDraftBusiness(businessId) {
      const businesses = getDraftBusinesses();
      if (businesses.length <= 1) {
        showMessage("Keep at least one business in the workspace.");
        return;
      }
      const business = businesses.find((entry) => entry.id === businessId);
      if (!window.confirm(`Delete ${business?.name || "this business"} from this workspace? Inventory records stay saved, but this business profile will be removed.`)) {
        return;
      }
      setDraft((current) => {
        const nextBusinesses = getDraftBusinesses(current).filter((entry) => entry.id !== businessId);
        const nextActive = nextBusinesses[0];
        return {
          ...current,
          businesses: nextBusinesses,
          warehouses: getDraftWarehouses(current).filter((warehouse) => warehouse.businessId !== businessId),
          activeBusinessId: nextActive.id,
          businessName: nextActive.name,
          ownerName: nextActive.ownerName,
          businessPhone: nextActive.phone,
          businessEmail: nextActive.email,
          businessAddress: nextActive.address,
          gstin: nextActive.gstin,
          storeLogo: nextActive.logo || "",
          storeLogoUrl: ""
        };
      });
    }

    function createDraftWarehouse() {
      const id = `warehouse-${Date.now()}`;
      setDraft((current) => ({
        ...current,
        warehouses: [
          ...getDraftWarehouses(current),
          {
            id,
            name: `Warehouse ${getDraftWarehouses(current).length + 1}`,
            businessId: cleanText(current.activeBusinessId, "primary"),
            location: "",
            status: "Active"
          }
        ],
        activeWarehouseId: id
      }));
    }

    function updateDraftWarehouse(warehouseId, patch) {
      setDraft((current) => ({
        ...current,
        warehouses: getDraftWarehouses(current).map((warehouse) => (
          warehouse.id === warehouseId ? { ...warehouse, ...patch } : warehouse
        ))
      }));
    }

    function setDraftPrintProfile(paperSize, layout) {
      setDraft((current) => ({
        ...current,
        printPaperSize: paperSize,
        printLayout: layout
      }));
    }

    function updateDraftPrintCalibration(field, value) {
      setDraft((current) => {
        const key = getPrintProfileKey(current.printPaperSize, current.printLayout);
        const currentCalibration = normalizePrintCalibration(current.printCalibrationProfiles?.[key]);
        return {
          ...current,
          printCalibrationProfiles: {
            ...(current.printCalibrationProfiles || {}),
            [key]: normalizePrintCalibration({
              ...currentCalibration,
              [field]: value
            })
          }
        };
      });
    }

    function resetDraftPrintCalibration() {
      setDraft((current) => {
        const key = getPrintProfileKey(current.printPaperSize, current.printLayout);
        return {
          ...current,
          printCalibrationProfiles: {
            ...(current.printCalibrationProfiles || {}),
            [key]: { ...DEFAULT_PRINT_CALIBRATION }
          }
        };
      });
    }

    function saveSettings(event) {
      event?.preventDefault();
      const sanitizedStartupView = navigationViews.some((view) => view.id === draft.startupView)
        ? draft.startupView
        : defaultSettings.startupView;
      const sanitizedBusinesses = getDraftBusinesses();
      const sanitizedWarehouses = getDraftWarehouses();
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
        printLayout: cleanText(draft.printLayout, defaultSettings.printLayout),
        printMargin: cleanText(draft.printMargin, defaultSettings.printMargin),
        printCalibrationProfiles: draft.printCalibrationProfiles && typeof draft.printCalibrationProfiles === "object" ? draft.printCalibrationProfiles : {},
        printFooter: cleanText(draft.printFooter),
        printShopLogoOnBill: Boolean(draft.printShopLogoOnBill),
        printReceiptTemplate: cleanText(draft.printReceiptTemplate, defaultSettings.printReceiptTemplate),
        printShowGSTNumber: draft.printShowGSTNumber !== false,
        printShowCustomerDetails: draft.printShowCustomerDetails !== false,
        printShowTaxBreakdown: draft.printShowTaxBreakdown !== false,
        printShowHSN: Boolean(draft.printShowHSN),
        printShowSavings: draft.printShowSavings !== false,
        printShowPaymentDetails: draft.printShowPaymentDetails !== false,
        printShowQRCode: Boolean(draft.printShowQRCode),
        printShowFooterMessage: draft.printShowFooterMessage !== false,
        printShowTerms: draft.printShowTerms !== false,
        printShowCashierName: draft.printShowCashierName !== false,
        printShowCounterName: draft.printShowCounterName !== false,
        printFssai: cleanText(draft.printFssai),
        printWebsite: cleanText(draft.printWebsite),
        printCashierName: cleanText(draft.printCashierName, defaultSettings.printCashierName),
        printCounterName: cleanText(draft.printCounterName, defaultSettings.printCounterName),
        printOrderType: cleanText(draft.printOrderType, defaultSettings.printOrderType),
        printTermsAndConditions: cleanText(draft.printTermsAndConditions || draft.printFooterTerms),
        printFooterTerms: cleanText(draft.printFooterTerms),
        printRefundPolicy: cleanText(draft.printRefundPolicy),
        printReturnPolicy: cleanText(draft.printReturnPolicy),
        printExchangePolicy: cleanText(draft.printExchangePolicy),
        printWarrantyInfo: cleanText(draft.printWarrantyInfo),
        printVisitAgainMessage: cleanText(draft.printVisitAgainMessage),
        printSocialMedia: cleanText(draft.printSocialMedia),
        printLoyaltyMessage: cleanText(draft.printLoyaltyMessage),
        autoPrintAfterBilling: Boolean(draft.autoPrintAfterBilling),
        showPreviewWatermark: draft.showPreviewWatermark !== false,
        businesses: sanitizedBusinesses,
        activeBusinessId: cleanText(draft.activeBusinessId, "primary"),
        warehouses: sanitizedWarehouses,
        activeWarehouseId: cleanText(draft.activeWarehouseId, "main"),
        supportEmail: cleanText(draft.supportEmail, SUPPORT_EMAIL),
        supportPhone: cleanText(draft.supportPhone, SUPPORT_PHONE)
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
          storeDocuments,
          employees,
          sellOnlineCatalog,
          invoiceDetails,
          supportRequests,
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
        setPurchaseRecords(mergePurchaseCollections(snapshot.purchaseRecords, snapshot.purchaseBills));
        setExpenseRecords(Array.isArray(snapshot.expenseRecords) ? snapshot.expenseRecords : []);
        setStoreDocuments(Array.isArray(snapshot.storeDocuments) ? snapshot.storeDocuments : []);
        setEmployees(Array.isArray(snapshot.employees) ? snapshot.employees : []);
        setSellOnlineCatalog(snapshot.sellOnlineCatalog && typeof snapshot.sellOnlineCatalog === "object" ? snapshot.sellOnlineCatalog : {});
        setInvoiceDetails(snapshot.invoiceDetails && typeof snapshot.invoiceDetails === "object" ? snapshot.invoiceDetails : {});
        setSupportRequests(Array.isArray(snapshot.supportRequests) ? snapshot.supportRequests : []);
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
      if (!window.confirm("Clear local inventory, Sell Online selections, purchases, expenses, employees, documents, and open POS bills on this device? API customers and invoices will stay untouched.")) {
        return;
      }
      setInventoryItems([]);
      setSellOnlineCatalog({});
      setBankAccount(null);
      setPurchaseRecords([]);
      setExpenseRecords([]);
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
                  <span>{account.loggedIn ? (account.contact || authState.email || authState.phone || authState.customerId || `${authState.role} access`) : "Login with your email id or phone number to sync this workspace."}</span>
                </div>
              </div>
              <div className="account-actions">
                <button className="button button-primary" type="button" hidden={account.loggedIn} onClick={() => openModal("login")}>Login or Create Account</button>
                <button className="button button-secondary" type="button" hidden={!account.loggedIn} disabled={cloudSyncBusy} onClick={pullCloudWorkspace}>Pull Cloud Data</button>
                <button className="button button-secondary" type="button" hidden={!account.loggedIn} disabled={cloudSyncBusy} onClick={recoverPreviousLocalBilling}>Recover Previous Bills</button>
                <button className="button button-secondary" type="button" hidden={!account.loggedIn} onClick={signOutOfAuth}>Logout</button>
              </div>
            </div>
            <div className="settings-metric-grid">
              <article className="settings-metric"><strong>{authState.role}</strong><span>Role</span></article>
              <article className="settings-metric"><strong>{authState.email || authState.phone || "Not linked"}</strong><span>Login Detail</span></article>
              <article className="settings-metric"><strong>{authState.customerId || "Auto generated"}</strong><span>Customer ID</span></article>
              <article className="settings-metric"><strong>{authState.warehouseId}</strong><span>Warehouse</span></article>
              <article className="settings-metric"><strong>{authState.offline ? "Offline" : "Cloud"}</strong><span>Session Mode</span></article>
            </div>
            <div className="settings-metric-grid">
              {apiModuleSummary.map(([label, value]) => (
                <article className="settings-metric" key={label}>
                  <strong>{Number(value || 0)}</strong>
                  <span>{label}</span>
                </article>
              ))}
            </div>
            <p className="settings-help">CinchPOS account passwords are validated on the backend, stored only as salted password hashes, and never saved in this app. Log out to hide all workspace data on this device.</p>
          </section>
        );
      }

      if (activeSettingsSection === "business") {
        const businessStatus = draft.gstin ? "GST Ready" : "Basic Setup";
        const draftBusinesses = getDraftBusinesses();
        const draftWarehouses = getDraftWarehouses();
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
            <div className="management-dashboard">
              <article className="record-card management-card">
                <div className="record-top">
                  <div>
                    <h3>Businesses</h3>
                    <p className="record-meta">Create, edit, delete, and switch business profiles. Each business can keep its own logo once selected.</p>
                  </div>
                  <button type="button" className="button button-primary" onClick={createDraftBusiness}>Create New Business</button>
                </div>
                <div className="management-list">
                  {draftBusinesses.map((business) => (
                    <article className={`management-row ${business.id === (draft.activeBusinessId || "primary") ? "active" : ""}`} key={business.id}>
                      <div className="management-grid">
                        <label>Business Name<input type="text" value={business.name} onChange={(event) => updateDraftBusiness(business.id, { name: event.target.value })} /></label>
                        <label>Phone<input type="tel" value={business.phone || ""} onChange={(event) => updateDraftBusiness(business.id, { phone: event.target.value })} /></label>
                        <label>Email<input type="email" value={business.email || ""} onChange={(event) => updateDraftBusiness(business.id, { email: event.target.value })} /></label>
                        <label>GSTIN<input type="text" value={business.gstin || ""} onChange={(event) => updateDraftBusiness(business.id, { gstin: event.target.value.toUpperCase() })} /></label>
                      </div>
                      <label>Address<textarea rows="2" value={business.address || ""} onChange={(event) => updateDraftBusiness(business.id, { address: event.target.value })}></textarea></label>
                      <div className="management-actions">
                        <span className="record-chip">{business.id === (draft.activeBusinessId || "primary") ? "Current business" : "Available"}</span>
                        <button type="button" className="button button-secondary" onClick={() => switchDraftBusiness(business.id)}>Switch</button>
                        <button type="button" className="button button-secondary" onClick={() => deleteDraftBusiness(business.id)} disabled={draftBusinesses.length <= 1}>Delete</button>
                      </div>
                    </article>
                  ))}
                </div>
              </article>
              <article className="record-card management-card">
                <div className="record-top">
                  <div>
                    <h3>Warehouses</h3>
                    <p className="record-meta">Create warehouse locations and assign inventory to the active warehouse from Inventory.</p>
                  </div>
                  <button type="button" className="button button-primary" onClick={createDraftWarehouse}>Create Warehouse</button>
                </div>
                <div className="management-list">
                  {draftWarehouses.map((warehouse) => (
                    <article className={`management-row ${warehouse.id === (draft.activeWarehouseId || "main") ? "active" : ""}`} key={warehouse.id}>
                      <div className="management-grid">
                        <label>Warehouse Name<input type="text" value={warehouse.name} onChange={(event) => updateDraftWarehouse(warehouse.id, { name: event.target.value })} /></label>
                        <label>Business<select value={warehouse.businessId} onChange={(event) => updateDraftWarehouse(warehouse.id, { businessId: event.target.value })}>{draftBusinesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}</select></label>
                        <label>Status<select value={warehouse.status} onChange={(event) => updateDraftWarehouse(warehouse.id, { status: event.target.value })}><option>Active</option><option>Inactive</option></select></label>
                        <label>Location<input type="text" value={warehouse.location || ""} onChange={(event) => updateDraftWarehouse(warehouse.id, { location: event.target.value })} /></label>
                      </div>
                      <div className="management-actions">
                        <span className="record-chip">{warehouse.status}</span>
                        <button type="button" className="button button-secondary" onClick={() => setDraft((current) => ({ ...current, activeWarehouseId: warehouse.id }))}>Switch</button>
                        <button type="button" className="button button-secondary" onClick={() => updateDraftWarehouse(warehouse.id, { status: "Inactive" })}>Deactivate</button>
                      </div>
                    </article>
                  ))}
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
        const activePrintProfile = getPrintProfile(draft.printPaperSize, draft.printLayout);
        const activePrintCalibration = getCalibrationForSettings(draft);
        const previewPayload = buildSamplePrintPayload(draft, cleanText(draft.businessName, businessName), cleanText(draft.ownerName, ownerName), storeLogoSource);
        const printLayoutValue = draft.printLayout || getPrintProfile(draft.printPaperSize).layout;
        const receiptToggleOptions = [
          ["printShowGSTNumber", "GST number", "Show GSTIN/FSSAI in the header.", true],
          ["printShowCustomerDetails", "Customer details", "Show customer name, mobile, and GST when available.", true],
          ["printShowTaxBreakdown", "Tax summary", "Show rate-wise GST totals after item rows.", true],
          ["printShowSavings", "Savings line", "Show total savings when discounts are applied.", true],
          ["printShowFooterMessage", "Footer message", "Show the saved thank-you footer.", true],
          ["printShowTerms", "Notes and terms", "Show invoice notes and Terms & Conditions below the totals.", true]
        ];
        const receiptTextFields = [];
        const receiptPolicyFields = [
          ["printTermsAndConditions", "Terms & Conditions", "Goods once sold cannot be returned.", "printFooterTerms"]
        ];
        return (
          <section className="settings-section">
            <h4>Printing</h4>
            <div className="print-preview-section">
              <div className="panel-header">
                <div>
                  <h3>Print Preview & Calibration</h3>
                  <p className="record-meta">{activePrintProfile.layout === "thermal" ? "Thermal receipt preview uses real 58mm/80mm proportions." : "Standard bill preview uses full invoice columns."} Margin and scale changes update instantly.</p>
                </div>
                <div className="segmented-control print-preview-switch">
                  <button type="button" className={activePrintProfile.layout === "thermal" ? "active" : ""} onClick={() => setDraftPrintProfile("80mm", "thermal")}>Thermal Printing</button>
                  <button type="button" className={activePrintProfile.layout === "invoice" ? "active" : ""} onClick={() => setDraftPrintProfile("A4", "invoice")}>Standard Printing</button>
                </div>
              </div>
              <div className="print-settings-card">
                <div className="settings-inline-heading">
                  <h5>Printer Profile</h5>
                  <span>{activePrintProfile.label}</span>
                </div>
                <div className="print-profile-grid">
                  <label>Paper Size<select name="printPaperSize" value={draft.printPaperSize || "80mm"} onChange={(event) => {
                    const nextPaperSize = event.target.value;
                    const profile = getPrintProfile(nextPaperSize);
                    setDraft((current) => ({ ...current, printPaperSize: nextPaperSize, printLayout: profile.layout }));
                  }}><option value="58mm">58mm Thermal Bill</option><option value="76mm">76mm Thermal Bill</option><option value="80mm">80mm Thermal Bill</option><option value="A5">A5 Standard Bill</option><option value="A4">A4 Standard Bill</option><option value="Letter">Letter Standard Bill</option></select></label>
                  <label>Print Layout<select name="printLayout" value={printLayoutValue} onChange={(event) => setDraft((current) => ({ ...current, printLayout: event.target.value }))}><option value="thermal">Thermal Receipt</option><option value="invoice">Standard Invoice</option></select></label>
                  <label>Receipt Format<input type="text" value={printLayoutValue === "invoice" ? "Standard Invoice" : "Thermal Tax Invoice"} readOnly /></label>
                  <label>Print Margin<select name="printMargin" value={draft.printMargin || "default"} onChange={(event) => setDraft((current) => ({ ...current, printMargin: event.target.value }))}><option value="default">Recommended Margin</option><option value="none">No App Margin</option></select></label>
                </div>
              </div>
              <div className="print-settings-card">
                <div className="settings-inline-heading">
                  <h5>Calibration</h5>
                  <span>Saved separately for each printer profile</span>
                </div>
                <div className="print-calibration-grid">
                  {[
                    ["top", "Top"],
                    ["bottom", "Bottom"],
                    ["left", "Left"],
                    ["right", "Right"]
                  ].map(([field, label]) => (
                    <label key={field}>{label}<input type="number" min="-20" max="40" step="1" value={activePrintCalibration[field]} onChange={(event) => updateDraftPrintCalibration(field, event.target.value)} /></label>
                  ))}
                  <label>Scale<input type="number" min="70" max="130" step="1" value={activePrintCalibration.scale} onChange={(event) => updateDraftPrintCalibration("scale", event.target.value)} /></label>
                  <button type="button" className="button button-secondary" onClick={resetDraftPrintCalibration}>Reset</button>
                </div>
              </div>
              <div className="print-settings-card print-checklist-card">
                <div className="settings-inline-heading">
                  <h5>Shop Printer Checklist</h5>
                  <span>Use this when receipts print too small or narrow</span>
                </div>
                <div className="record-meta-grid">
                  <span>Select 80mm for most 3-inch thermal printers.</span>
                  <span>Select 58mm only for small 2-inch rolls.</span>
                  <span>In the system print dialog, turn off Fit to Page or Shrink to Fit.</span>
                  <span>Keep printer margins at None or Minimum.</span>
                </div>
              </div>
              <div className="print-settings-card">
                <div className="settings-inline-heading">
                  <h5>Receipt Content</h5>
                  <span>Controls thermal and standard bill data</span>
                </div>
                <div className="receipt-text-grid">
                  {receiptTextFields.map(([key, label, placeholder]) => (
                    <label key={key}>{label}<input name={key} type="text" value={draft[key] || ""} placeholder={placeholder} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} /></label>
                  ))}
                  <label className="settings-span-2">Footer Message<input name="printFooter" type="text" value={draft.printFooter || ""} placeholder="Thank you for shopping with us." onChange={(event) => setDraft((current) => ({ ...current, printFooter: event.target.value }))} /></label>
                </div>
                <div className="receipt-toggle-grid">
                  {receiptToggleOptions.map(([key, title, description, defaultOn]) => (
                    <label className="settings-check receipt-toggle" key={key}>
                      <input
                        name={key}
                        type="checkbox"
                        checked={defaultOn ? draft[key] !== false : Boolean(draft[key])}
                        onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.checked }))}
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="print-settings-card">
                <div className="settings-inline-heading">
                  <h5>Notes & Terms</h5>
                  <span>Printed only when Notes and policies is enabled</span>
                </div>
                <div className="receipt-policy-grid">
                  {receiptPolicyFields.map(([key, label, placeholder, fallbackKey]) => (
                    <label key={key}>{label}<textarea name={key} rows="3" value={draft[key] || (fallbackKey ? draft[fallbackKey] : "") || ""} placeholder={placeholder} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value, ...(fallbackKey ? { [fallbackKey]: event.target.value } : {}) }))}></textarea></label>
                  ))}
                </div>
              </div>
              <PrintPreviewDocument payload={previewPayload} />
              <p className="settings-help">Calibration is saved per printer profile, for example 80mm Thermal Bill and A4 Standard Bill keep separate margin and scale values.</p>
            </div>
            <div className="printing-option-grid">
              <label className="settings-check">
                <input
                  name="printShopLogoOnBill"
                  type="checkbox"
                  checked={Boolean(draft.printShopLogoOnBill)}
                  onChange={(event) => setDraft((current) => ({ ...current, printShopLogoOnBill: event.target.checked }))}
                />
                <span>
                  <strong>Print shop logo on bill</strong>
                  <small>Uses the current business logo at the top of thermal receipts and invoice pages.</small>
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
            </div>
            <div className="settings-metric-grid">
              <article className="settings-metric"><strong>{getPrintProfile(draft.printPaperSize).label}</strong><span>Paper profile</span></article>
              <article className="settings-metric"><strong>{(draft.printLayout || getPrintProfile(draft.printPaperSize).layout) === "invoice" ? "Invoice" : "Thermal"}</strong><span>Layout mode</span></article>
              <article className="settings-metric"><strong>{draft.autoPrintAfterBilling ? "On" : "Off"}</strong><span>Auto print</span></article>
              <article className="settings-metric"><strong>{draft.showPreviewWatermark === false ? "Hidden" : "Visible"}</strong><span>Preview watermark</span></article>
            </div>
            <p className="settings-help">Thermal mode keeps receipts narrow and simple. Invoice mode keeps full table columns for A4, A5, and Letter printers. The final printer/paper tray is still chosen in the system print dialog.</p>
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
                  <span>Clears Inventory, Sell Online, Purchase, Expense, Employee, Document, and open POS data from this device workspace.</span>
                  <span>Does not delete API customers or API invoices.</span>
                </div>
                <div className="record-actions settings-data-actions">
                  <button className="button button-secondary" type="button" onClick={resetLocalModules}>Reset Local Modules</button>
                </div>
              </article>
              <article className="record-card smart-inventory-card">
                <div className="record-top">
                  <div>
                    <h3>Smart Inventory Review</h3>
                    <p className="record-meta">Keeps reviewing the saved inventory and flags overlapping products, barcode conflicts, and items that may not be needed anymore.</p>
                  </div>
                  <span className="record-chip">Smart Inventory</span>
                </div>
                <div className="settings-metric-grid">
                  <article className="settings-metric"><strong>{smartInventoryReview.overlapCount}</strong><span>Overlap checks</span></article>
                  <article className="settings-metric"><strong>{smartInventoryReview.cleanupCount}</strong><span>Cleanup candidates</span></article>
                  <article className="settings-metric"><strong>{smartInventoryReview.suggestionCount}</strong><span>Total suggestions</span></article>
                </div>
                {smartInventoryReview.suggestions.length ? (
                  <div className="smart-inventory-list">
                    {smartInventoryReview.suggestions.map((suggestion, index) => (
                      <article className={`smart-inventory-item ${suggestion.type}`} key={`${suggestion.title}-${index}`}>
                        <strong>{suggestion.title}</strong>
                        <span>{suggestion.detail}</span>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="settings-inline-copy">No overlap or cleanup warnings right now. Smart Inventory will keep scanning this workspace as the list changes.</p>
                )}
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
            <div className="support-center-grid">
              <form className="support-request-form" onSubmit={submitSupportRequest}>
                <div className="panel-header">
                  <div>
                    <h3>Contact Us</h3>
                    <p className="record-meta">Send support requests, bug reports, and feature requests from this workspace.</p>
                  </div>
                </div>
                <div className="form-grid settings-form-grid">
                  <label>Request Type<select value={supportDraft.type} onChange={(event) => updateSupportDraft("type", event.target.value)}>
                    <option>Support Request</option>
                    <option>Bug Report</option>
                    <option>Feature Request</option>
                    <option>Data Migration Help</option>
                  </select></label>
                  <label>Name<input type="text" value={supportDraft.name} onChange={(event) => updateSupportDraft("name", event.target.value)} placeholder="Your name" required /></label>
                  <label>Email<input type="email" value={supportDraft.email} onChange={(event) => updateSupportDraft("email", event.target.value)} placeholder="Optional if phone is added" /></label>
                  <label>Phone<input type="tel" value={supportDraft.phone} onChange={(event) => updateSupportDraft("phone", event.target.value)} placeholder="Optional if email is added" /></label>
                  <label className="settings-span-2">Subject<input type="text" value={supportDraft.subject} onChange={(event) => updateSupportDraft("subject", event.target.value)} placeholder="Short title" required /></label>
                  <label className="settings-span-2">Message<textarea rows="4" value={supportDraft.message} onChange={(event) => updateSupportDraft("message", event.target.value)} placeholder="Explain what happened or what you need." required></textarea></label>
                </div>
                <div className="modal-actions">
                  <button className="button button-primary" type="submit">Submit Request</button>
                </div>
              </form>
              <aside className="support-side-panel">
                <article className="record-card">
                  <h3>Support Contacts</h3>
                  <div className="record-meta-grid">
                    <span>Phone {cleanText(draft.supportPhone, SUPPORT_PHONE)}</span>
                    <span>Email {cleanText(draft.supportEmail, SUPPORT_EMAIL)}</span>
                  </div>
                </article>
                <article className="record-card">
                  <h3>Support Configuration</h3>
                  <div className="form-grid settings-form-grid">
                    <label>Email<input type="email" value={draft.supportEmail || ""} onChange={(event) => setDraft((current) => ({ ...current, supportEmail: event.target.value }))} /></label>
                    <label>Phone<input type="tel" value={draft.supportPhone || ""} onChange={(event) => setDraft((current) => ({ ...current, supportPhone: event.target.value }))} /></label>
                  </div>
                </article>
                <article className="record-card">
                  <h3>FAQ</h3>
                  <details open><summary>How do I get help for importing old data?</summary><p className="record-meta">Open Retrieve Data, choose the old software, upload the export file, review the detected rows, then import only ready records.</p></details>
                  <details><summary>What should I send for a print issue?</summary><p className="record-meta">Send printer model, paper size, a photo of the bill, and the calibration values from Print Settings.</p></details>
                  <details><summary>Where is customer and invoice data kept?</summary><p className="record-meta">Customers and invoices are API-backed. Device modules like inventory, support requests, employees, documents, and settings stay in the local workspace backup.</p></details>
                </article>
              </aside>
            </div>
            <div className="record-list settings-card-stack">
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Request History</h3>
                    <p className="record-meta">Local record of support, bug, and feature requests submitted from this device.</p>
                  </div>
                  <span className="record-chip">{supportRequests.length} saved</span>
                </div>
                {supportRequests.length ? (
                  <div className="support-request-list">
                    {supportRequests.slice(0, 8).map((request) => (
                      <article className="support-request-row" key={request.id}>
                        <div>
                          <strong>{request.subject}</strong>
                          <span>{request.type} | {request.name} | {request.email || request.phone}</span>
                          <p>{request.message}</p>
                        </div>
                        <span className="record-chip">{request.status}</span>
                      </article>
                    ))}
                  </div>
                ) : <Empty>No support requests saved yet.</Empty>}
              </article>
              <article className="record-card">
                <h3>Company Information</h3>
                <p className="record-meta">{APP_NAME} by {APP_COMPANY}</p>
                <div className="record-meta-grid"><span>Billing Support</span><span>Data Migration</span><span>Printer Calibration</span><span>Feature Requests</span></div>
              </article>
            </div>
          </section>
        );
      }

      if (activeSettingsSection === "app") {
        const updateStatus = desktopUpdateState.status || "idle";
        const latestVersion = desktopUpdateState.updateInfo?.version || "";
        const updateProgress = Math.round(Number(desktopUpdateState.progress?.percent || 0));
        const updateBusy = updateStatus === "checking" || updateStatus === "downloading";
        const canDownloadUpdate = updateStatus === "available";
        const canInstallUpdate = Boolean(desktopUpdateState.canInstall || updateStatus === "downloaded");
        const updateApplyLabel = desktopUpdateState.source === "manifest" ? "Open Manual Update" : "Restart & Update";
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
                  <div className="record-chip-row">
                    <span className="record-chip">Desktop Ready</span>
                    <span className="record-chip">Version {desktopUpdateState.currentVersion || "development"}</span>
                  </div>
                </div>
                <div className="record-meta-grid"><span>Next.js Frontend</span><span>Flask Billing API</span><span>Local Workspace Storage</span><span>{appPlatform}</span></div>
              </article>
              <article className="record-card">
                <div className="record-top">
                  <div>
                    <h3>Software Update</h3>
                    <p className="record-meta">{desktopUpdateState.message || "Check for the latest CinchPOS desktop release."}</p>
                  </div>
                  <span className={`record-chip ${updateStatus === "available" || updateStatus === "downloaded" ? "warning" : ""}`}>
                    {updateStatus === "no-update" ? "Up to date" : updateStatus.replace(/-/g, " ")}
                  </span>
                </div>
                <div className="record-meta-grid">
                  <span>Current {desktopUpdateState.currentVersion || "development"}</span>
                  <span>Latest {latestVersion || "Not checked"}</span>
                  <span>{desktopUpdateState.packaged ? "Packaged desktop app" : "Development mode"}</span>
                  <span>Source {desktopUpdateState.source || "desktop"}</span>
                </div>
                {updateStatus === "downloading" ? (
                  <div className="settings-progress-row">
                    <progress value={updateProgress} max="100">{updateProgress}%</progress>
                    <span>{updateProgress}%</span>
                  </div>
                ) : null}
                {Array.isArray(desktopUpdateState.updateInfo?.notes) && desktopUpdateState.updateInfo.notes.length ? (
                  <ul className="settings-compact-list">
                    {desktopUpdateState.updateInfo.notes.slice(0, 4).map((note) => <li key={note}>{note}</li>)}
                  </ul>
                ) : null}
                <div className="settings-action-row">
                  <button type="button" className="button button-secondary" disabled={updateBusy} onClick={() => runDesktopUpdateAction("check")}>Check for Updates</button>
                  {canDownloadUpdate ? <button type="button" className="button button-primary" onClick={() => runDesktopUpdateAction("download")}>Download Update</button> : null}
                  {canInstallUpdate ? <button type="button" className="button button-primary" onClick={() => runDesktopUpdateAction("install")}>{updateApplyLabel}</button> : null}
                  {updateStatus === "downloading" ? <button type="button" className="button button-secondary" onClick={() => runDesktopUpdateAction("cancelDownload")}>Cancel</button> : null}
                </div>
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
                  <article className="settings-metric"><strong>{workspaceStats.sellOnline}</strong><span>Online Products</span></article>
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
          <p className="settings-help">End the current CinchPOS session for this counter and hide workspace data until the owner logs in again.</p>
          <div className="record-list">
            <article className="record-card">
              <div className="record-top">
                <div>
                  <h3>{account.loggedIn ? cleanText(account.name, "Operator") : "No active operator"}</h3>
                  <p className="record-meta">{account.loggedIn ? (account.contact || `${authState.role} on ${authState.businessId}`) : "Login is currently inactive for this counter."}</p>
                </div>
                <span className="record-chip">{account.loggedIn ? (authState.offline ? "Offline Cache" : "Active") : "Signed Out"}</span>
              </div>
              <div className="record-actions settings-data-actions">
                <button className="button button-secondary" type="button" disabled={!account.loggedIn || authBusy} onClick={signOutOfAuth}>Logout</button>
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

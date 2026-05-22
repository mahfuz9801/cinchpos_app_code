import { cleanText, normalizeKey } from "../format.js";
import {
  calculateDiscountPercent,
  getInventoryGSTBreakup,
  getInventoryItemBarcode,
  getInventoryItemBarcodes,
  getInventoryItemName
} from "../inventory.js";
import { defaultPOSCustomer } from "./constants.js";

export function makeBill(formId, number) {
  return {
    id: `${formId}-bill-${number}`,
    label: `Bill ${number}`,
    items: [],
    customer: { ...defaultPOSCustomer }
  };
}

export function makePOSInstance(formId) {
  return {
    bills: [makeBill(formId, 1)],
    activeBillId: `${formId}-bill-1`,
    counter: 1,
    itemQuery: "",
    matches: [],
    matchMode: "",
    matchMessage: ""
  };
}

export function makeInitialPOSState() {
  return {
    posForm: makePOSInstance("posForm"),
    workspacePosForm: makePOSInstance("workspacePosForm")
  };
}

export function getPOSBillSummary(items) {
  return (items || []).reduce((summary, item) => {
    const quantity = Number(item.quantity || 1);
    summary.quantity += quantity;
    summary.subtotal += Number(item.taxableValue || 0) * quantity;
    summary.cgst += Number(item.cgst || 0) * quantity;
    summary.sgst += Number(item.sgst || 0) * quantity;
    summary.gst += Number(item.gstAmount || 0) * quantity;
    summary.total += Number(item.inclusivePrice || 0) * quantity;
    return summary;
  }, { quantity: 0, subtotal: 0, cgst: 0, sgst: 0, gst: 0, total: 0 });
}

export function buildPOSLineItem(item) {
  const itemName = getInventoryItemName(item) || "Inventory item";
  const barcode = getInventoryItemBarcode(item);
  const inclusivePrice = Number(item.inclusivePrice || item.inclusive_price || item.price || 0);
  const mrp = Number(item.mrp || inclusivePrice || 0);
  const gstRate = Number(item.gstRate || item.gst_rate || item.gst || 0);
  const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
  const savedDiscount = Number(item.discountPercent || item.discount_percent || item.discount || 0);
  const sourceId = item.id || `${normalizeKey(itemName)}-${normalizeKey(barcode)}`;

  return {
    id: `${sourceId}-${Date.now()}`,
    key: String(sourceId),
    itemName,
    barcode,
    quantity: 1,
    mrp,
    inclusivePrice,
    discountPercent: savedDiscount || calculateDiscountPercent(mrp, inclusivePrice),
    gstRate,
    taxableValue: Number(breakup.taxableValue.toFixed(2)),
    cgst: Number(breakup.cgst.toFixed(2)),
    sgst: Number(breakup.sgst.toFixed(2)),
    gstAmount: Number(breakup.gstAmount.toFixed(2))
  };
}

export function findInventoryItemsByBarcode(items, query) {
  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  if (!search) {
    return [];
  }
  return items.filter((item) => getInventoryItemBarcodes(item).some((barcode) => {
    const savedBarcode = barcode.toLowerCase();
    return savedBarcode === search || normalizeKey(savedBarcode) === normalizedSearch;
  }));
}

export function isBarcodeLikeQuery(query) {
  const cleaned = cleanText(query);
  const normalized = normalizeKey(cleaned);
  return normalized.length >= 5 && /\d/.test(normalized) && !/\s/.test(cleaned);
}

export function findInventoryItemsByBarcodeCandidate(items, query) {
  const exactMatches = findInventoryItemsByBarcode(items, query);
  if (exactMatches.length) {
    return exactMatches;
  }
  if (!isBarcodeLikeQuery(query)) {
    return [];
  }
  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  return items.filter((item) => getInventoryItemBarcodes(item).some((barcode) => {
    const savedBarcode = barcode.toLowerCase();
    const normalizedBarcode = normalizeKey(savedBarcode);
    return savedBarcode.includes(search) || normalizedBarcode.includes(normalizedSearch);
  }));
}

export function findInventoryMatches(items, query) {
  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  if (!search) {
    return [];
  }
  return items.filter((item) => {
    const itemName = getInventoryItemName(item).toLowerCase();
    const barcodes = getInventoryItemBarcodes(item).map((barcode) => barcode.toLowerCase());
    return itemName.includes(search)
      || normalizeKey(itemName).includes(normalizedSearch)
      || barcodes.some((barcode) => barcode.includes(search) || normalizeKey(barcode).includes(normalizedSearch));
  });
}

export function findInventoryItemForPOS(items, query) {
  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  if (!search) {
    return null;
  }
  const barcodeMatches = findInventoryItemsByBarcode(items, query);
  if (barcodeMatches.length === 1) {
    return barcodeMatches[0];
  }
  const nameMatches = items.filter((item) => {
    const itemName = getInventoryItemName(item).toLowerCase();
    return itemName === search || normalizeKey(itemName) === normalizedSearch;
  });
  return nameMatches.length === 1 ? nameMatches[0] : null;
}

export function buildPOSSearchPatch(items, value) {
  const query = cleanText(value);
  if (!query) {
    return {
      itemQuery: "",
      matches: [],
      matchMode: "",
      matchMessage: ""
    };
  }

  const barcodeMatches = findInventoryItemsByBarcode(items, query);
  if (barcodeMatches.length > 1) {
    return {
      itemQuery: value,
      matches: barcodeMatches,
      matchMode: "barcode",
      matchMessage: `${barcodeMatches.length} products use barcode ${query}. Choose the correct item.`
    };
  }

  const barcodeCandidates = findInventoryItemsByBarcodeCandidate(items, query);
  if (barcodeCandidates.length > 1) {
    return {
      itemQuery: value,
      matches: barcodeCandidates,
      matchMode: "barcode",
      matchMessage: `${barcodeCandidates.length} products match barcode ${query}. Choose the correct item.`
    };
  }

  const matches = findInventoryMatches(items, value).slice(0, 8);
  return {
    itemQuery: value,
    matches,
    matchMode: matches.length ? "search" : "",
    matchMessage: matches.length ? "Matching products" : ""
  };
}

export function addInventoryItemToPOSInstance(instance, item) {
  const lineItem = buildPOSLineItem(item);
  return {
    ...instance,
    itemQuery: "",
    matches: [],
    matchMode: "",
    matchMessage: "",
    bills: (instance.bills || []).map((bill) => {
      if (bill.id !== instance.activeBillId) {
        return bill;
      }
      const items = [...(bill.items || [])];
      const existing = items.find((billItem) => billItem.key === lineItem.key);
      const nextItems = existing
        ? items.map((billItem) => (
          billItem.key === lineItem.key
            ? { ...billItem, quantity: Number(billItem.quantity || 1) + 1 }
            : billItem
        ))
        : [...items, lineItem];
      return { ...bill, items: nextItems };
    })
  };
}

export function createNextPOSBillInstance(instance, formId) {
  const nextCounter = Number(instance.counter || instance.bills?.length || 0) + 1;
  const bill = makeBill(formId, nextCounter);
  return {
    ...instance,
    counter: nextCounter,
    activeBillId: bill.id,
    itemQuery: "",
    matches: [],
    matchMode: "",
    matchMessage: "",
    bills: [...(instance.bills || []), bill]
  };
}

export function deletePOSBillFromInstance(instance, billId) {
  const currentBills = instance.bills || [];
  if (currentBills.length <= 1) {
    return { didDelete: false, deletedBill: null, nextInstance: instance };
  }

  const billToDelete = currentBills.find((openBill) => openBill.id === billId) || null;
  const deleteIndex = currentBills.findIndex((openBill) => openBill.id === billId);
  const remainingBills = currentBills.filter((openBill) => openBill.id !== billId);
  const fallbackBill = remainingBills[Math.max(0, deleteIndex - 1)] || remainingBills[0];
  const deletedActiveBill = instance.activeBillId === billId;

  return {
    didDelete: true,
    deletedBill: billToDelete,
    nextInstance: {
      ...instance,
      bills: remainingBills,
      activeBillId: deletedActiveBill ? fallbackBill.id : instance.activeBillId,
      itemQuery: deletedActiveBill ? "" : instance.itemQuery,
      matches: deletedActiveBill ? [] : instance.matches,
      matchMode: deletedActiveBill ? "" : instance.matchMode,
      matchMessage: deletedActiveBill ? "" : instance.matchMessage
    }
  };
}

export function updatePOSLineItemsQuantity(items, itemId, value) {
  const quantity = Math.max(1, Number(value || 1));
  return (items || []).map((item) => item.id === itemId ? { ...item, quantity } : item);
}

export function updatePOSLineItemsPrice(items, itemId, field, value) {
  const amount = Math.max(0, Number(value || 0));
  return (items || []).map((item) => {
    if (item.id !== itemId) {
      return item;
    }
    const next = { ...item, [field]: Number.isFinite(amount) ? amount : 0 };
    const breakup = getInventoryGSTBreakup(next.inclusivePrice, next.gstRate);
    return {
      ...next,
      discountPercent: calculateDiscountPercent(next.mrp, next.inclusivePrice),
      taxableValue: Number(breakup.taxableValue.toFixed(2)),
      cgst: Number(breakup.cgst.toFixed(2)),
      sgst: Number(breakup.sgst.toFixed(2)),
      gstAmount: Number(breakup.gstAmount.toFixed(2))
    };
  });
}

export function removePOSLineItem(items, itemId) {
  return (items || []).filter((item) => item.id !== itemId);
}

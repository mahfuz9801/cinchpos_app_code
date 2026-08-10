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

function inferPOSFormId(instance, fallback = "posForm") {
  const source = instance?.activeBillId || instance?.bills?.[0]?.id || fallback;
  const match = String(source).match(/^(.*)-bill-\d+$/);
  return match?.[1] || fallback;
}

export function normalizePOSInstance(instance, formId = inferPOSFormId(instance)) {
  const fallback = makePOSInstance(formId);
  const sourceBills = Array.isArray(instance?.bills) && instance.bills.length ? instance.bills : fallback.bills;
  const activeIndex = Math.max(0, sourceBills.findIndex((bill) => bill.id === instance?.activeBillId));
  const bills = sourceBills.map((bill, index) => {
    const number = index + 1;
    return {
      ...bill,
      id: `${formId}-bill-${number}`,
      label: `Bill ${number}`,
      items: Array.isArray(bill.items) ? bill.items : [],
      customer: { ...defaultPOSCustomer, ...(bill.customer || {}) }
    };
  });

  return {
    ...fallback,
    ...(instance || {}),
    bills,
    activeBillId: bills[activeIndex]?.id || bills[0].id,
    counter: bills.length,
    itemQuery: instance?.itemQuery || "",
    matches: Array.isArray(instance?.matches) ? instance.matches : [],
    matchMode: instance?.matchMode || "",
    matchMessage: instance?.matchMessage || ""
  };
}

export function normalizePOSState(posState = {}) {
  return {
    posForm: normalizePOSInstance(posState.posForm, "posForm"),
    workspacePosForm: normalizePOSInstance(posState.workspacePosForm, "workspacePosForm")
  };
}

export function makeInitialPOSState() {
  return normalizePOSState({
    posForm: makePOSInstance("posForm"),
    workspacePosForm: makePOSInstance("workspacePosForm")
  });
}

export function getPOSBillSummary(items) {
  return (items || []).reduce((summary, item) => {
    const quantity = Number(item.quantity || 1);
    const mrp = Number(item.mrp || item.inclusivePrice || 0);
    const sale = Number(item.inclusivePrice || 0);
    summary.quantity += quantity;
    summary.mrpTotal += mrp * quantity;
    summary.discountTotal += Math.max(0, (mrp - sale) * quantity);
    summary.subtotal += Number(item.taxableValue || 0) * quantity;
    summary.cgst += Number(item.cgst || 0) * quantity;
    summary.sgst += Number(item.sgst || 0) * quantity;
    summary.gst += Number(item.gstAmount || 0) * quantity;
    summary.total += sale * quantity;
    return summary;
  }, { quantity: 0, mrpTotal: 0, discountTotal: 0, subtotal: 0, cgst: 0, sgst: 0, gst: 0, total: 0 });
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
    hsn: cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac),
    description: cleanText(item.description || item.itemDescription || item.desc || item.shortDescription),
    batch: cleanText(item.batch || item.batchNo || item.batchNumber || item.batch_no || item.lot || item.lotNumber),
    unit: cleanText(item.unit || item.uom || item.unitName, "Pcs"),
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

function getInventorySearchName(item) {
  return cleanText(item?.itemName || item?.item_name || item?.name);
}

function scoreInventoryName(item, search, normalizedSearch) {
  const itemName = getInventorySearchName(item).toLowerCase();
  if (!itemName || !search) {
    return Number.POSITIVE_INFINITY;
  }

  const normalizedName = normalizeKey(itemName);
  const words = itemName.split(/\s+/).filter(Boolean);
  const normalizedWords = normalizedName.split("-").filter(Boolean);

  if (itemName === search || normalizedName === normalizedSearch) {
    return 0;
  }
  if (itemName.startsWith(search) || normalizedName.startsWith(normalizedSearch)) {
    return 10;
  }
  if (words.some((word) => word.startsWith(search)) || normalizedWords.some((word) => word.startsWith(normalizedSearch))) {
    return 20;
  }
  if (itemName.includes(search) || normalizedName.includes(normalizedSearch)) {
    return 40;
  }
  return Number.POSITIVE_INFINITY;
}

function scoreInventoryBarcode(item, query) {
  if (!isBarcodeLikeQuery(query)) {
    return Number.POSITIVE_INFINITY;
  }

  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  const barcodes = getInventoryItemBarcodes(item).map((barcode) => barcode.toLowerCase());
  let bestScore = Number.POSITIVE_INFINITY;

  barcodes.forEach((barcode) => {
    const normalizedBarcode = normalizeKey(barcode);
    if (barcode === search || normalizedBarcode === normalizedSearch) {
      bestScore = Math.min(bestScore, 1);
      return;
    }
    if (barcode.startsWith(search) || normalizedBarcode.startsWith(normalizedSearch)) {
      bestScore = Math.min(bestScore, 12);
      return;
    }
    if (barcode.includes(search) || normalizedBarcode.includes(normalizedSearch)) {
      bestScore = Math.min(bestScore, 45);
    }
  });

  return bestScore;
}

export function findInventoryMatches(items, query) {
  const search = cleanText(query).toLowerCase();
  const normalizedSearch = normalizeKey(query);
  if (!search) {
    return [];
  }

  return items
    .map((item, index) => {
      const nameScore = scoreInventoryName(item, search, normalizedSearch);
      const barcodeScore = scoreInventoryBarcode(item, query);
      return {
        item,
        index,
        score: Math.min(nameScore, barcodeScore),
        name: getInventorySearchName(item).toLowerCase()
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((first, second) => {
      if (first.score !== second.score) {
        return first.score - second.score;
      }
      const nameSort = first.name.localeCompare(second.name);
      return nameSort || first.index - second.index;
    })
    .map((entry) => entry.item);
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
  const currentInstance = normalizePOSInstance(instance, formId);
  const nextCounter = currentInstance.bills.length + 1;
  const bill = makeBill(formId, nextCounter);
  return {
    ...currentInstance,
    counter: nextCounter,
    activeBillId: bill.id,
    itemQuery: "",
    matches: [],
    matchMode: "",
    matchMessage: "",
    bills: [...currentInstance.bills, bill]
  };
}

export function deletePOSBillFromInstance(instance, billId) {
  const formId = inferPOSFormId(instance);
  const currentInstance = normalizePOSInstance(instance, formId);
  const currentBills = currentInstance.bills || [];
  if (currentBills.length <= 1) {
    return { didDelete: false, deletedBill: null, nextInstance: currentInstance };
  }

  const billToDelete = currentBills.find((openBill) => openBill.id === billId) || null;
  const deleteIndex = currentBills.findIndex((openBill) => openBill.id === billId);
  const remainingBills = currentBills.filter((openBill) => openBill.id !== billId);
  const fallbackBill = remainingBills[Math.max(0, deleteIndex - 1)] || remainingBills[0];
  const deletedActiveBill = currentInstance.activeBillId === billId;
  const nextActiveSourceId = deletedActiveBill ? fallbackBill.id : currentInstance.activeBillId;
  const nextActiveIndex = Math.max(0, remainingBills.findIndex((openBill) => openBill.id === nextActiveSourceId));
  const renumberedBills = remainingBills.map((openBill, index) => {
    const number = index + 1;
    return {
      ...openBill,
      id: `${formId}-bill-${number}`,
      label: `Bill ${number}`
    };
  });

  return {
    didDelete: true,
    deletedBill: billToDelete,
    nextInstance: {
      ...currentInstance,
      bills: renumberedBills,
      activeBillId: renumberedBills[nextActiveIndex]?.id || renumberedBills[0].id,
      counter: renumberedBills.length,
      itemQuery: deletedActiveBill ? "" : currentInstance.itemQuery,
      matches: deletedActiveBill ? [] : currentInstance.matches,
      matchMode: deletedActiveBill ? "" : currentInstance.matchMode,
      matchMessage: deletedActiveBill ? "" : currentInstance.matchMessage
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

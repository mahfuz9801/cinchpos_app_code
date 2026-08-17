import { cleanText, normalizeKey } from "./format.js";

export const INVENTORY_STORAGE_KEY = "cinchPOSInventory";

export function getInventoryGSTBreakup(priceInclusive, gstRate) {
  const total = Math.max(0, Number(priceInclusive || 0));
  const rate = Math.max(0, Number(gstRate || 0));
  const taxableValue = rate ? total / (1 + rate / 100) : total;
  const gstAmount = total - taxableValue;

  return {
    taxableValue,
    gstAmount,
    cgst: gstAmount / 2,
    sgst: gstAmount / 2
  };
}

export function calculateDiscountPercent(mrp, sellingPrice) {
  const maximumRetailPrice = Number(mrp || 0);
  const inclusiveSellingPrice = Number(sellingPrice || 0);
  if (!maximumRetailPrice || inclusiveSellingPrice >= maximumRetailPrice) {
    return 0;
  }
  return ((maximumRetailPrice - inclusiveSellingPrice) / maximumRetailPrice) * 100;
}

export function normalizeInventoryBarcodes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/\s+/);
  return [...new Set(values.map((item) => cleanText(item)).filter(Boolean))];
}

export function getInventoryItemName(item) {
  return cleanText(item?.itemName || item?.item_name || item?.name, "Inventory item");
}

export function getInventoryItemBarcodes(item) {
  const savedBarcodes = Array.isArray(item?.barcodes) ? item.barcodes : [];
  return normalizeInventoryBarcodes([item?.barcode, ...savedBarcodes].filter(Boolean));
}

export function getInventoryItemBarcode(item) {
  return getInventoryItemBarcodes(item)[0] || cleanText(item?.barcode);
}

export function getInventoryBarcodeLabel(item) {
  const barcodes = getInventoryItemBarcodes(item);
  return barcodes.length ? barcodes.join(" ") : "No barcode";
}

export function getInventoryItemKey(item, index = 0) {
  return cleanText(item?.id) || `${normalizeKey(getInventoryItemName(item))}-${normalizeKey(getInventoryItemBarcode(item))}-${index}`;
}

function getInventoryMatchTokens(item, index = 0) {
  return [
    item?.inventoryItemId,
    item?.itemId,
    item?.sourceItemId,
    item?.key,
    item?.id,
    getInventoryItemKey(item, index)
  ]
    .map((value) => cleanText(value))
    .filter(Boolean);
}

function findInventorySaleMatchIndex(inventoryItems, soldItem) {
  const soldTokens = new Set(getInventoryMatchTokens(soldItem).flatMap((token) => [token, normalizeKey(token)]));
  if (soldTokens.size) {
    const tokenMatchIndex = inventoryItems.findIndex((item, index) => (
      getInventoryMatchTokens(item, index).some((token) => soldTokens.has(token) || soldTokens.has(normalizeKey(token)))
    ));
    if (tokenMatchIndex >= 0) {
      return tokenMatchIndex;
    }
  }

  const soldBarcodes = getInventoryItemBarcodes(soldItem).map(normalizeKey).filter(Boolean);
  if (soldBarcodes.length) {
    const barcodeMatches = inventoryItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => getInventoryItemBarcodes(item).some((barcode) => soldBarcodes.includes(normalizeKey(barcode))));
    if (barcodeMatches.length === 1) {
      return barcodeMatches[0].index;
    }
  }

  const soldName = normalizeKey(getInventoryItemName(soldItem));
  const soldPrice = Number(soldItem?.inclusivePrice || soldItem?.inclusive_price || soldItem?.price || 0);
  if (soldName) {
    const nameMatches = inventoryItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const sameName = normalizeKey(getInventoryItemName(item)) === soldName;
        const itemPrice = Number(item?.inclusivePrice || item?.inclusive_price || item?.price || 0);
        return sameName && (!soldPrice || !itemPrice || Math.abs(itemPrice - soldPrice) < 0.001);
      });
    if (nameMatches.length === 1) {
      return nameMatches[0].index;
    }
  }

  return -1;
}

export function applyInventorySaleDeductions(inventoryItems = [], soldItems = []) {
  const deductionsByIndex = new Map();
  const unmatchedItems = [];

  (soldItems || []).forEach((soldItem) => {
    const quantity = Math.max(0, Number(soldItem?.quantity || 0));
    if (!quantity) {
      return;
    }
    const matchIndex = findInventorySaleMatchIndex(inventoryItems, soldItem);
    if (matchIndex < 0) {
      unmatchedItems.push(soldItem);
      return;
    }
    deductionsByIndex.set(matchIndex, Number(deductionsByIndex.get(matchIndex) || 0) + quantity);
  });

  if (!deductionsByIndex.size) {
    return {
      items: inventoryItems,
      deductions: [],
      unmatchedItems
    };
  }

  const deductions = [];
  const items = inventoryItems.map((item, index) => {
    const quantity = Number(deductionsByIndex.get(index) || 0);
    if (!quantity) {
      return item;
    }
    const previousStock = Number(item?.stock || 0);
    const nextStock = Number((previousStock - quantity).toFixed(3));
    deductions.push({
      item,
      itemName: getInventoryItemName(item),
      quantity,
      previousStock,
      nextStock
    });
    return {
      ...item,
      stock: nextStock,
      updatedAt: new Date().toISOString()
    };
  });

  return {
    items,
    deductions,
    unmatchedItems
  };
}

export function readInventoryItems() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    return JSON.parse(window.localStorage.getItem(INVENTORY_STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

export function writeInventoryItems(items) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(items));
  }
}

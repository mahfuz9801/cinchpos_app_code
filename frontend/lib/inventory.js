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

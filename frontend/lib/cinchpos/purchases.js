import { cleanText } from "../format.js";

function purchaseMatchKey(record = {}) {
  return [
    cleanText(record.supplier).toLowerCase(),
    cleanText(record.billNumber || record.bill_number).toLowerCase(),
    cleanText(record.purchaseDate || record.billDate || record.purchase_date || record.bill_date),
    Number(record.amount || 0).toFixed(2)
  ].join("|");
}

export function normalizeLegacyPurchaseBill(bill = {}, index = 0) {
  return {
    id: cleanText(bill.id, `legacy-purchase-bill-${index + 1}`),
    supplier: cleanText(bill.supplier, "Supplier not added"),
    item: cleanText(bill.item, "Supplier bill"),
    billNumber: cleanText(bill.billNumber || bill.bill_number),
    purchaseDate: cleanText(bill.purchaseDate || bill.billDate || bill.purchase_date || bill.bill_date),
    amount: Number(bill.amount || 0),
    gstAmount: Number(bill.gstAmount || bill.gst_amount || 0),
    paymentStatus: cleanText(bill.paymentStatus || bill.payment_status, "Not recorded"),
    notes: cleanText(bill.notes),
    fileName: cleanText(bill.fileName || bill.file_name),
    fileData: cleanText(bill.fileData || bill.file_data),
    createdAt: cleanText(bill.createdAt || bill.created_at, new Date(0).toISOString())
  };
}

export function mergePurchaseCollections(purchaseRecords = [], legacyPurchaseBills = []) {
  const merged = (Array.isArray(purchaseRecords) ? purchaseRecords : []).map((record) => ({ ...record }));
  const recordIndexByKey = new Map();

  merged.forEach((record, index) => {
    const key = purchaseMatchKey(record);
    if (key !== "|||0.00") {
      recordIndexByKey.set(key, index);
    }
  });

  (Array.isArray(legacyPurchaseBills) ? legacyPurchaseBills : []).forEach((bill, index) => {
    const normalizedBill = normalizeLegacyPurchaseBill(bill, index);
    const key = purchaseMatchKey(normalizedBill);
    const matchingIndex = recordIndexByKey.get(key);

    if (matchingIndex === undefined) {
      recordIndexByKey.set(key, merged.length);
      merged.push(normalizedBill);
      return;
    }

    const existing = merged[matchingIndex];
    merged[matchingIndex] = {
      ...existing,
      gstAmount: Number(existing.gstAmount || normalizedBill.gstAmount || 0),
      fileName: cleanText(existing.fileName || normalizedBill.fileName),
      fileData: cleanText(existing.fileData || normalizedBill.fileData)
    };
  });

  return merged.sort((first, second) => (
    cleanText(second.createdAt).localeCompare(cleanText(first.createdAt))
  ));
}

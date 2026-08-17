import test from "node:test";
import assert from "node:assert/strict";

import { mergePurchaseCollections } from "../lib/cinchpos/purchases.js";

test("mergePurchaseCollections preserves bill-only records in the unified purchase list", () => {
  const merged = mergePurchaseCollections([], [{
    id: "bill-1",
    supplier: "Supply House",
    billNumber: "PB-101",
    billDate: "2026-08-17",
    amount: 1200,
    gstAmount: 180,
    fileName: "bill.pdf",
    fileData: "data:application/pdf;base64,AA=="
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].item, "Supplier bill");
  assert.equal(merged[0].purchaseDate, "2026-08-17");
  assert.equal(merged[0].gstAmount, 180);
  assert.equal(merged[0].fileName, "bill.pdf");
});

test("mergePurchaseCollections enriches a matching purchase instead of duplicating it", () => {
  const merged = mergePurchaseCollections([{
    id: "purchase-1",
    supplier: "Supply House",
    item: "Packing material",
    billNumber: "PB-101",
    purchaseDate: "2026-08-17",
    amount: 1200,
    paymentStatus: "Paid"
  }], [{
    id: "bill-1",
    supplier: "Supply House",
    billNumber: "PB-101",
    billDate: "2026-08-17",
    amount: 1200,
    gstAmount: 180,
    fileName: "bill.pdf",
    fileData: "data:application/pdf;base64,AA=="
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "purchase-1");
  assert.equal(merged[0].item, "Packing material");
  assert.equal(merged[0].gstAmount, 180);
  assert.equal(merged[0].fileName, "bill.pdf");
});

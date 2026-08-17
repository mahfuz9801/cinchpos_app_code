import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInventorySaleDeductions,
  getInventoryItemBarcodes
} from "../lib/inventory.js";

test("applyInventorySaleDeductions reduces stock for sold POS line items", () => {
  const inventory = [
    { id: "product-a", itemName: "Product A", barcodes: ["111"], stock: 10, inclusivePrice: 50 },
    { id: "product-b", itemName: "Product B", barcodes: ["222"], stock: 6, inclusivePrice: 20 }
  ];
  const result = applyInventorySaleDeductions(inventory, [
    { inventoryItemId: "product-a", quantity: 4, itemName: "Product A", inclusivePrice: 50 }
  ]);

  assert.equal(result.deductions.length, 1);
  assert.equal(result.items[0].stock, 6);
  assert.equal(result.items[1].stock, 6);
});

test("applyInventorySaleDeductions matches barcode-less invoice lines by item id", () => {
  const inventory = [
    { id: "loose-rice", itemName: "Loose Rice", barcodes: [], stock: 25, inclusivePrice: 70 }
  ];
  const result = applyInventorySaleDeductions(inventory, [
    { itemId: "loose-rice", itemName: "Loose Rice", quantity: 3, inclusivePrice: 70 }
  ]);

  assert.equal(result.unmatchedItems.length, 0);
  assert.equal(result.items[0].stock, 22);
});

test("applyInventorySaleDeductions safely matches barcode-less items by unique name and price", () => {
  const inventory = [
    { id: "manual-1", itemName: "Handwritten Product", stock: 8, inclusivePrice: 35 },
    { id: "manual-2", itemName: "Other Product", stock: 5, inclusivePrice: 35 }
  ];
  const result = applyInventorySaleDeductions(inventory, [
    { itemName: "Handwritten Product", quantity: 2, inclusivePrice: 35 }
  ]);

  assert.equal(result.items[0].stock, 6);
  assert.equal(result.items[1].stock, 5);
});

test("getInventoryItemBarcodes keeps barcode optional", () => {
  assert.deepEqual(getInventoryItemBarcodes({ itemName: "No Barcode Product" }), []);
});

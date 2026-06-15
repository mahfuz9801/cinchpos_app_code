import test from "node:test";
import assert from "node:assert/strict";

import {
  addInventoryItemToPOSInstance,
  buildPOSSearchPatch,
  createNextPOSBillInstance,
  deletePOSBillFromInstance,
  findInventoryMatches,
  findInventoryItemsByBarcode,
  getPOSBillSummary,
  makePOSInstance
} from "../lib/cinchpos/pos.js";

const inventoryItems = [
  {
    id: "item-1",
    itemName: "Green Tea",
    barcodes: ["12345", "00012345"],
    mrp: 40,
    inclusivePrice: 36,
    gstRate: 18
  },
  {
    id: "item-2",
    itemName: "Milk",
    barcodes: ["778899"],
    mrp: 60,
    inclusivePrice: 54,
    gstRate: 5
  },
  {
    id: "item-3",
    itemName: "Milk Large",
    barcodes: ["778899"],
    mrp: 70,
    inclusivePrice: 64,
    gstRate: 5
  }
];

test("findInventoryItemsByBarcode matches direct and normalized barcode values", () => {
  const matches = findInventoryItemsByBarcode(inventoryItems, "00012345");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].itemName, "Green Tea");
});

test("buildPOSSearchPatch surfaces a clear chooser when one barcode maps to multiple items", () => {
  const patch = buildPOSSearchPatch(inventoryItems, "778899");
  assert.equal(patch.matchMode, "barcode");
  assert.equal(patch.matches.length, 2);
  assert.match(patch.matchMessage, /Choose the correct item/i);
});

test("findInventoryMatches ranks typed product names before unrelated inventory", () => {
  const matches = findInventoryMatches([
    { id: "item-vaseline", itemName: "Vaseline deep moisture 90ml", barcodes: ["8901030978449"] },
    { id: "item-amul-milk", itemName: "Amul Milk 500ml", barcodes: ["11111"] },
    { id: "item-amul-butter", itemName: "Amul Butter", barcodes: ["22222"] },
    { id: "item-parle", itemName: "Parle-G Biscuit", barcodes: ["33333"] }
  ], "Am");

  assert.deepEqual(matches.map((item) => item.itemName), ["Amul Butter", "Amul Milk 500ml"]);
});

test("findInventoryMatches still supports barcode prefix lookup for scanners", () => {
  const matches = findInventoryMatches(inventoryItems, "00012");

  assert.equal(matches.length, 1);
  assert.equal(matches[0].itemName, "Green Tea");
});

test("addInventoryItemToPOSInstance increments quantity instead of duplicating the line item", () => {
  let instance = makePOSInstance("posForm");
  instance = addInventoryItemToPOSInstance(instance, inventoryItems[0]);
  instance = addInventoryItemToPOSInstance(instance, inventoryItems[0]);
  const bill = instance.bills[0];

  assert.equal(bill.items.length, 1);
  assert.equal(bill.items[0].quantity, 2);
});

test("deletePOSBillFromInstance switches focus to a remaining bill", () => {
  let instance = makePOSInstance("posForm");
  instance = createNextPOSBillInstance(instance, "posForm");
  instance = createNextPOSBillInstance(instance, "posForm");

  const activeBillId = instance.bills[1].id;
  instance = { ...instance, activeBillId };

  const result = deletePOSBillFromInstance(instance, activeBillId);

  assert.equal(result.didDelete, true);
  assert.equal(result.nextInstance.bills.length, 2);
  assert.notEqual(result.nextInstance.activeBillId, activeBillId);
});

test("getPOSBillSummary totals quantity, taxable value, GST, and grand total", () => {
  let instance = makePOSInstance("posForm");
  instance = addInventoryItemToPOSInstance(instance, inventoryItems[0]);
  instance = addInventoryItemToPOSInstance(instance, inventoryItems[1]);

  const summary = getPOSBillSummary(instance.bills[0].items);

  assert.equal(summary.quantity, 2);
  assert.ok(summary.subtotal > 0);
  assert.ok(summary.gst > 0);
  assert.equal(Number(summary.total.toFixed(2)), 90);
});

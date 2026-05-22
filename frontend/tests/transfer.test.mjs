import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  collectImportBarcodes,
  getTransferGuideSteps,
  getTransferSourceProfile,
  normalizeInventoryImport,
  normalizeInvoiceImport,
  packageRows,
  parseCSV,
  parseTransferRows,
  workbookToTransferPayload
} from "../lib/cinchpos/transfer.js";

test("parseCSV detects semicolon-delimited exports", () => {
  const rows = parseCSV("Item Name;Barcode;Stock\nTea;111;5\nCoffee;222;7");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]["Item Name"], "Tea");
  assert.equal(rows[1].Stock, "7");
});

test("collectImportBarcodes combines barcode aliases into a unique set", () => {
  const barcodes = collectImportBarcodes({
    Barcode: "111",
    "Barcode 2": "222",
    SKU: "111",
    productCode: "333"
  });

  assert.deepEqual(new Set(barcodes), new Set(["111", "222", "333"]));
});

test("packageRows accepts invoice alias keys from imported JSON payloads", () => {
  const packaged = packageRows({ sales: [{ invoiceNumber: "INV-1" }] }, "invoices");
  assert.equal(packaged.invoices.length, 1);
  assert.equal(packaged.invoices[0].invoiceNumber, "INV-1");
});

test("packageRows accepts normalized section names from imported JSON payloads", () => {
  const packaged = packageRows({ "Customer Data": [{ Name: "Acme Stores" }] }, "customers");
  assert.equal(packaged.customers.length, 1);
  assert.equal(packaged.customers[0].Name, "Acme Stores");
});

test("normalizeInventoryImport preserves stock, price, and multiple barcodes", () => {
  const item = normalizeInventoryImport({
    "Item Name": "Masala Oats",
    Barcode: "111",
    "Barcode 2": "222",
    Stock: "9",
    MRP: "65",
    "Selling Price": "58",
    GST: "12"
  });

  assert.equal(item.itemName, "Masala Oats");
  assert.deepEqual(item.barcodes, ["111", "222"]);
  assert.equal(item.stock, 9);
  assert.equal(item.inclusivePrice, 58);
});

test("normalizeInventoryImport reads myBillBook item exports without treating item id as the item name", () => {
  const item = normalizeInventoryImport({
    "Item ID": "66822d5b-eda4-4805-8844-c297bcda9444",
    "Item Name*\n(mandatory field)": "5 star",
    "Item code": "7622202818400",
    "HSN Code": "18063100",
    "GST Tax Rate(%)": "5.00",
    "Sales Price": "10",
    MRP: "10",
    "Current stock": "17"
  });

  assert.equal(item.itemName, "5 star");
  assert.equal(item.sourceItemId, "66822d5b-eda4-4805-8844-c297bcda9444");
  assert.equal(item.sourceItemCode, "7622202818400");
  assert.deepEqual(item.barcodes, ["7622202818400"]);
  assert.equal(item.stock, 17);
  assert.equal(item.mrp, 10);
  assert.equal(item.inclusivePrice, 10);
});

test("normalizeInventoryImport keeps stock-only exports usable for inventory updates", () => {
  const item = normalizeInventoryImport({
    "Item Name": "Soap Bar",
    Stock: "0"
  });

  assert.equal(item.itemName, "Soap Bar");
  assert.equal(item.stock, 0);
  assert.equal(item.hasStockValue, true);
});

test("normalizeInvoiceImport cleans imported dates and payment values", () => {
  const invoice = normalizeInvoiceImport({
    "Invoice Number": "OLD-9",
    "Customer Name": "Northwind",
    Amount: "1499.50",
    Paid: "499.50",
    "Invoice Date": "30/04/2026",
    "Due Date": "05/05/2026"
  });

  assert.equal(invoice.invoiceNumber, "OLD-9");
  assert.equal(invoice.amount, 1499.5);
  assert.equal(invoice.totalPaid, 499.5);
  assert.equal(invoice.issuedOn, "2026-04-30");
  assert.equal(invoice.dueOn, "2026-05-05");
});

test("parseTransferRows reads Tally-style XML exports for customers, inventory, and invoices", () => {
  const payload = parseTransferRows(`
    <ENVELOPE>
      <BODY>
        <LEDGER NAME="Acme Stores">
          <PARENT>Sundry Debtors</PARENT>
          <PHONE>9876543210</PHONE>
          <EMAIL>acme@example.com</EMAIL>
        </LEDGER>
        <STOCKITEM NAME="Premium Tea">
          <BARCODE>111</BARCODE>
          <BARCODE2>222</BARCODE2>
          <OPENINGBALANCE>5</OPENINGBALANCE>
          <MRP>48</MRP>
          <SALESPRICE>42</SALESPRICE>
          <GST>5</GST>
        </STOCKITEM>
        <VOUCHER VCHTYPE="Sales">
          <VOUCHERNUMBER>INV-1</VOUCHERNUMBER>
          <PARTYLEDGERNAME>Acme Stores</PARTYLEDGERNAME>
          <AMOUNT>-1250</AMOUNT>
          <DATE>20260503</DATE>
        </VOUCHER>
      </BODY>
    </ENVELOPE>
  `, "all", "mybillbook-export.xml");

  assert.equal(payload.customers.length, 1);
  assert.equal(payload.inventory.length, 1);
  assert.equal(payload.invoices.length, 1);
  assert.equal(payload.customers[0]["Customer Name"], "Acme Stores");
  assert.equal(payload.inventory[0]["Item Name"], "Premium Tea");
  assert.equal(payload.invoices[0]["Invoice Number"], "INV-1");
});

test("workbookToTransferPayload converts spreadsheet sheets into importable row sets", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { "Customer Name": "Acme Stores", Phone: "9876543210" }
  ]), "Customer Data");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { "Item Name": "Premium Tea", Stock: "5" }
  ]), "Inventory Data");

  const payload = workbookToTransferPayload(workbook);

  assert.equal(payload["Customer Data"].length, 1);
  assert.equal(payload["Inventory Data"].length, 1);
  assert.equal(payload["Customer Data"][0]["Customer Name"], "Acme Stores");
});

test("workbookToTransferPayload skips myBillBook notice rows and finds the real header row", () => {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([
    ["", "", "", ""],
    ["You Can Edit Only 4000 Items At Once. For Editing More Than 4000 Items, Please Contact Our Support Team At 7400417400. [Batched Items Cannot Be Edited]"],
    ["Item Name", "Barcode", "MRP", "Selling Price", "Stock"],
    ["Premium Tea", "111", "48", "42", "5"],
    ["", "", "", "", ""]
  ]);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Inventory Data");

  const payload = workbookToTransferPayload(workbook);

  assert.equal(payload.length, 1);
  assert.deepEqual(payload[0], {
    "Item Name": "Premium Tea",
    Barcode: "111",
    MRP: "48",
    "Selling Price": "42",
    Stock: "5"
  });
});

test("getTransferSourceProfile detects myBillBook from preset and name", () => {
  assert.equal(getTransferSourceProfile("", "mybillbook").id, "mybillbook");
  assert.equal(getTransferSourceProfile("myBillBook Desktop").id, "mybillbook");
});

test("getTransferGuideSteps returns myBillBook-specific migration guidance", () => {
  const steps = getTransferGuideSteps("inventory", "myBillBook", "mybillbook");
  assert.ok(steps.some((step) => step.detail.includes("Data Export to Tally")));
  assert.ok(steps.some((step) => step.detail.includes("stock summary") || step.detail.includes("item price report")));
});

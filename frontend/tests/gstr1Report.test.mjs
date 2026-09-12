import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGstr1Workbook,
  makeGstr1ReportFileName,
  writeGstr1Workbook
} from "../lib/cinchpos/gstr1Report.js";

const report = {
  businessName: "Ardh Sainik Canteen",
  businessPhone: "9477119300",
  businessGstin: "19ABCDE1234F1Z5",
  businessAddress: "Kolkata, West Bengal",
  startDate: "2026-05-01",
  endDate: "2026-05-31",
  records: [
    {
      invoice: {
        invoice_number: "38750",
        issued_on: "2026-05-01",
        amount: 328,
        customer_name: "Walk-in Customer"
      },
      detail: {
        customer: { name: "Walk-in Customer" },
        items: [
          {
            itemName: "Five percent item",
            hsn: "190590",
            unit: "Pcs",
            quantity: 2,
            inclusivePrice: 105,
            taxableValue: 100,
            gstRate: 5,
            gstAmount: 5,
            lineTotal: 210
          },
          {
            itemName: "Eighteen percent item",
            hsn: "34025000",
            unit: "Bottle",
            quantity: 1,
            inclusivePrice: 118,
            taxableValue: 100,
            gstRate: 18,
            gstAmount: 18,
            lineTotal: 118
          }
        ]
      }
    },
    {
      invoice: {
        invoice_number: "38751",
        issued_on: "2026-05-02",
        amount: 105,
        customer_name: "Registered Buyer"
      },
      detail: {
        customer: {
          name: "Registered Buyer",
          gstin: "19AAAAA0000A1Z5"
        },
        items: [{
          itemName: "Registered item",
          hsn: "210690",
          unit: "Pcs",
          quantity: 1,
          inclusivePrice: 105,
          taxableValue: 100,
          gstRate: 5,
          gstAmount: 5,
          lineTotal: 105
        }]
      }
    }
  ]
};

test("GSTR-1 workbook follows the reference ten-sheet structure", () => {
  const workbook = buildGstr1Workbook(report);

  assert.deepEqual(workbook.SheetNames, [
    "gstr1", "b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exemp", "hsn(b2b)", "hsn(b2c)", "docs"
  ]);
  assert.equal(workbook.Sheets.gstr1.A1.v, "Ardh Sainik Canteen");
  assert.equal(workbook.Sheets.gstr1.A5.v, "GSTR-1");
  assert.equal(workbook.Sheets.gstr1.A6.v, "Dated: 01/05/2026-31/05/2026");
  assert.equal(workbook.Sheets.gstr1["!ref"], "A1:O38");
  assert.equal(workbook.Sheets.b2b["!ref"], "A1:M1000");
  assert.equal(workbook.Sheets["hsn(b2c)"]["!ref"], "A1:K1000");
  assert.equal(workbook.Sheets.docs["!ref"], "A1:E1000");
});

test("GSTR-1 sheet keeps sales rows, totals, and return sections in the reference layout", () => {
  const worksheet = buildGstr1Workbook(report).Sheets.gstr1;

  assert.equal(worksheet.A13.v, "Sales");
  assert.equal(worksheet.A14.v, "GSTIN");
  assert.equal(worksheet.C15.v, "State Code");
  assert.equal(worksheet.E16.v, "38750");
  assert.equal(worksheet.G16.v, 328);
  assert.equal(worksheet.H16.v, 5);
  assert.equal(worksheet.I16.v, 200);
  assert.equal(worksheet.J16.v, 5);
  assert.equal(worksheet.K16.v, 5);
  assert.equal(worksheet.E17.v, "");
  assert.equal(worksheet.H17.v, 18);
  assert.equal(worksheet.I17.v, 100);
  assert.equal(worksheet.J17.v, 9);
  assert.equal(worksheet.K17.v, 9);
  assert.equal(worksheet.L17.v, 0);
  assert.equal(worksheet.M17.v, 0);
  assert.equal(worksheet.N17.v, 18);
  assert.equal(worksheet.A20.v, "Total");
  assert.equal(worksheet.G20.v, 433);
  assert.equal(worksheet.I20.v, 400);
  assert.equal(worksheet.J20.v, 16.5);
  assert.equal(worksheet.K20.v, 16.5);
  assert.equal(worksheet.L20.v, 0);
  assert.equal(worksheet.M20.v, 0);
  assert.equal(worksheet.N20.v, 33);
  assert.equal(worksheet.A25.v, "Sales Return");
  assert.equal(worksheet.K27.v, "Central Tax Amount");
  assert.equal(worksheet.L27.v, "State/UT Tax Amount");
  assert.equal(worksheet.M27.v, "Integrated Tax Amount");
  assert.equal(worksheet.N27.v, "Cess Amt.");
  assert.equal(worksheet.O27.v, "Total Tax Amt.");
  assert.equal(worksheet.H27.v, "Invoice Type");
  assert.equal(worksheet.A29.v, "Total");
  assert.equal(worksheet.K29.v, 0);
  assert.equal(worksheet.L29.v, 0);
  assert.equal(worksheet.M29.v, 0);
  assert.equal(worksheet.N29.v, 0);
  assert.equal(worksheet.O29.v, 0);
  assert.equal(worksheet.A34.v, "Purchase Return");
  assert.equal(worksheet.K36.v, "Central Tax Amount");
  assert.equal(worksheet.L36.v, "State/UT Tax Amount");
  assert.equal(worksheet.M36.v, "Integrated Tax Amount");
  assert.equal(worksheet.N36.v, "Cess Amt.");
  assert.equal(worksheet.O36.v, "Total Tax Amt.");
  assert.equal(worksheet.A38.v, "Total");
  assert.equal(worksheet.K38.v, 0);
  assert.equal(worksheet.L38.v, 0);
  assert.equal(worksheet.M38.v, 0);
  assert.equal(worksheet.N38.v, 0);
  assert.equal(worksheet.O38.v, 0);
  assert.deepEqual(
    worksheet["!cols"].map((column) => column.wch),
    [29.5, 12, 12, 9.75, 13, 13, 11, 12, 11, 14.25, 16.5, 16.5, 16.5, 9.75, 9.75]
  );
});

test("GST filing sheets keep the uploaded report template headers and widths", () => {
  const workbook = buildGstr1Workbook(report);

  assert.deepEqual(
    workbook.Sheets.b2b["!cols"].map((column) => column.wch),
    [18.5, 12, 13, 9.75, 14.25, 13, 13, 17.5, 12, 15.25, 4.25, 9.75, 11]
  );
  assert.deepEqual(
    workbook.Sheets.b2cl["!cols"].map((column) => column.wch),
    [15, 10.62, 15, 13.85, 18.38, 5.15, 13.85, 11.77, 16.15]
  );
  assert.equal(workbook.Sheets.b2b.A4.v, "GSTIN/UIN of Recipient");
  assert.equal(workbook.Sheets.b2cl.I4.v, "E-Commerce GSTIN");
  assert.equal(workbook.Sheets.b2cl.I2, undefined);
  assert.equal(workbook.Sheets.b2cs.G2, undefined);
  assert.equal(workbook.Sheets.cdnr.M2, undefined);
  assert.equal(workbook.Sheets.docs.A4.v, "Nature of Document");
});

test("GSTR-1 classifies B2B, B2CS, HSN, and document summaries", () => {
  const workbook = buildGstr1Workbook(report);

  assert.equal(workbook.Sheets.b2b.A3.v, 1);
  assert.equal(workbook.Sheets.b2b.C3.v, 1);
  assert.equal(workbook.Sheets.b2b.A5.v, "19AAAAA0000A1Z5");
  assert.equal(workbook.Sheets.b2cs.D5.v, 5);
  assert.equal(workbook.Sheets.b2cs.E5.v, 200);
  assert.equal(workbook.Sheets.b2cs.D6.v, 18);
  assert.equal(workbook.Sheets.b2cs.E6.v, 100);
  assert.equal(workbook.Sheets["hsn(b2c)"].A3.v, 2);
  assert.equal(workbook.Sheets["hsn(b2c)"].B5.v, "");
  assert.equal(workbook.Sheets.docs.D3.v, 2);
  assert.equal(workbook.Sheets.docs.B5.v, "38750");
  assert.equal(workbook.Sheets.docs.C5.v, "38751");
});

test("GSTR-1 workbook serializes as a valid XLSX payload and uses a readable file name", () => {
  const workbook = buildGstr1Workbook(report);
  const output = writeGstr1Workbook(workbook);

  assert.ok(output.byteLength > 1000);
  assert.equal(
    makeGstr1ReportFileName(report),
    "[Ardh Sainik Canteen] GSTR-1 from 01-05-2026 to 31-05-2026.xlsx"
  );
});

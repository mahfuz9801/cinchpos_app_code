import * as XLSX from "xlsx";

const GST_STATES = [
  ["01", "Jammu and Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
  ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
  ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"],
  ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
  ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"],
  ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"],
  ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
  ["26", "Dadra and Nagar Haveli and Daman and Diu"], ["27", "Maharashtra"],
  ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"],
  ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"],
  ["35", "Andaman and Nicobar Islands"], ["36", "Telangana"],
  ["37", "Andhra Pradesh"], ["38", "Ladakh"], ["97", "Other Territory"]
];

const GST_STATE_BY_CODE = new Map(GST_STATES);
const GST_STATE_BY_NAME = new Map(GST_STATES.map(([code, name]) => [normalizeKey(name), { code, name }]));
const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
const B2CL_LIMIT = 100000;
const GST_TEMPLATE_ROWS = 1000;
const GSTR1_SALES_START_ROW = 16;
const GSTR1_SECTION_GAP_ROWS = 4;

const REFERENCE_WIDTHS = {
  gstr1: [29.5, 12, 12, 9.75, 13, 13, 11, 12, 11, 14.25, 16.5, 16.5, 16.5, 9.75, 9.75],
  b2b: [18.5, 12, 13, 9.75, 14.25, 13, 13, 17.5, 12, 15.25, 4.25, 9.75, 11],
  b2cl: [15, 10.62, 15, 13.85, 18.38, 5.15, 13.85, 11.77, 16.15],
  b2cs: [16, 13.8, 18.3, 6.1, 21.5, 11.6, 16],
  cdnr: [18.5, 12, 12, 8.75, 11, 13, 13, 17.5, 9.75, 17.5, 13, 9.75, 11],
  cdnur: [17.18, 18.27, 9.45, 11.64, 13.82, 13.82, 18.27, 5.09, 13.82, 11.64],
  exemp: [50.18, 18.27, 35.82, 19.27],
  hsnB2b: [17.18, 8.27, 6.18, 10.55, 9.45, 5.09, 13.82, 17.18, 14.91, 17.18, 11.64],
  hsnB2c: [17.18, 8.27, 12.82, 10.55, 10.55, 6.18, 13.82, 17.18, 14.91, 17.18, 11.64],
  docs: [40.5, 9.75, 9.75, 11, 11]
};

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
  return Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;
}

function nearestGstRate(value) {
  const rate = Math.max(0, numberValue(value));
  return GST_RATES.reduce((nearest, candidate) => (
    Math.abs(candidate - rate) < Math.abs(nearest - rate) ? candidate : nearest
  ), GST_RATES[0]);
}

function isoDate(value) {
  const text = cleanText(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  const match = cleanText(value).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) {
    return "";
  }
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function displayDate(value) {
  const normalized = isoDate(value);
  if (!normalized) {
    return cleanText(value);
  }
  const [year, month, day] = normalized.split("-");
  return `${day}/${month}/${year}`;
}

function invoiceNumber(invoice, detail) {
  return cleanText(
    invoice?.invoice_number || invoice?.invoiceNumber || detail?.invoiceNumber || detail?.invoice_number
  );
}

function invoiceDate(invoice, detail) {
  return isoDate(invoice?.issued_on || invoice?.issuedOn || invoice?.date || detail?.issuedOn || detail?.issued_on);
}

function customerFromRecord(invoice, detail) {
  const customer = detail?.customer && typeof detail.customer === "object" ? detail.customer : {};
  return {
    name: cleanText(customer.name || invoice?.customer_name || invoice?.customerName, "Cash Sale"),
    gstin: cleanText(customer.gstin || customer.gstIn || customer.gst_number || invoice?.customer_gstin).toUpperCase(),
    address: cleanText(customer.address || invoice?.customer_address || invoice?.customerAddress),
    state: cleanText(customer.state || invoice?.customer_state || invoice?.customerState),
    stateCode: cleanText(customer.stateCode || customer.state_code || invoice?.customer_state_code).padStart(2, "0")
  };
}

function stateFromAddress(address) {
  const key = normalizeKey(address);
  if (!key) {
    return null;
  }
  return GST_STATES
    .map(([code, name]) => ({ code, name, key: normalizeKey(name) }))
    .sort((a, b) => b.key.length - a.key.length)
    .find((state) => key.includes(state.key)) || null;
}

function resolveState({ gstin, stateCode, state, address } = {}, fallback = null) {
  const gstinCode = cleanText(gstin).slice(0, 2);
  if (GST_STATE_BY_CODE.has(gstinCode)) {
    return { code: gstinCode, name: GST_STATE_BY_CODE.get(gstinCode) };
  }
  const normalizedCode = cleanText(stateCode).padStart(2, "0");
  if (GST_STATE_BY_CODE.has(normalizedCode)) {
    return { code: normalizedCode, name: GST_STATE_BY_CODE.get(normalizedCode) };
  }
  const namedState = GST_STATE_BY_NAME.get(normalizeKey(state));
  if (namedState) {
    return namedState;
  }
  return stateFromAddress(address) || fallback || { code: "00", name: "Not Specified" };
}

function inferRate(detail, invoiceAmount) {
  const taxable = numberValue(detail?.summary?.taxable || detail?.summary?.subtotal);
  const gst = numberValue(detail?.summary?.gst || detail?.summary?.gstTotal);
  if (taxable > 0 && gst > 0) {
    return nearestGstRate((gst / taxable) * 100);
  }
  const total = numberValue(detail?.summary?.total, invoiceAmount);
  if (total > 0 && taxable > 0) {
    return nearestGstRate(((total - taxable) / taxable) * 100);
  }
  return 0;
}

function normalizeLineItems(invoice, detail) {
  const invoiceAmount = money(invoice?.amount || detail?.summary?.total);
  const sourceItems = Array.isArray(detail?.items) ? detail.items : [];
  const items = sourceItems.map((item, index) => {
    const quantity = Math.max(0, numberValue(item.quantity || item.qty, 1));
    const inclusivePrice = money(item.inclusivePrice ?? item.sellingPrice ?? item.salePrice ?? item.price);
    const lineTotal = money(numberValue(item.lineTotal, inclusivePrice * quantity));
    const gstRate = nearestGstRate(item.gstRate ?? item.gst_rate ?? item.taxRate);
    const unitTaxable = numberValue(item.taxableValue ?? item.taxable_value, NaN);
    const unitGst = numberValue(item.gstAmount ?? item.gst_amount, NaN);
    const taxableValue = money(Number.isFinite(unitTaxable)
      ? unitTaxable * quantity
      : (gstRate ? lineTotal / (1 + (gstRate / 100)) : lineTotal));
    const gstAmount = money(Number.isFinite(unitGst)
      ? unitGst * quantity
      : Math.max(0, lineTotal - taxableValue));
    return {
      name: cleanText(item.itemName || item.name, `Item ${index + 1}`),
      hsn: cleanText(item.hsn || item.hsnSac || item.hsn_sac || item.sac),
      unit: cleanText(item.unit || item.uom || item.unitName, "Pcs"),
      quantity,
      gstRate,
      taxableValue,
      gstAmount,
      totalValue: lineTotal
    };
  }).filter((item) => item.quantity > 0 && item.totalValue >= 0);

  if (items.length) {
    return items;
  }

  const gstRate = inferRate(detail, invoiceAmount);
  const taxableValue = money(gstRate ? invoiceAmount / (1 + (gstRate / 100)) : invoiceAmount);
  return [{
    name: "Invoice Amount",
    hsn: "",
    unit: "Pcs",
    quantity: 1,
    gstRate,
    taxableValue,
    gstAmount: money(invoiceAmount - taxableValue),
    totalValue: invoiceAmount
  }];
}

function uqcForUnit(unit) {
  const key = normalizeKey(unit);
  const mapping = [
    [/^(pcs?|pieces?)$/, "PCS-PIECES"], [/^(kg|kgs|kilograms?)$/, "KGS-KILOGRAMS"],
    [/^(g|gm|gms|grams?)$/, "GMS-GRAMS"], [/^(l|ltr|litres?|liters?)$/, "LTR-LITRES"],
    [/^(ml|mlt|millilitres?|milliliters?)$/, "MLT-MILLILITRES"], [/^(box|boxes)$/, "BOX-BOX"],
    [/^(pack|packs|packet|packets)$/, "PAC-PACKS"], [/^(btl|bottle|bottles)$/, "BTL-BOTTLES"],
    [/^(doz|dozen|dozens)$/, "DOZ-DOZENS"], [/^(m|mtr|meter|meters|metre|metres)$/, "MTR-METERS"]
  ];
  return mapping.find(([pattern]) => pattern.test(key))?.[1] || "OTH-OTHERS";
}

function groupByRate(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = String(item.gstRate);
    const current = groups.get(key) || { rate: item.gstRate, taxableValue: 0, gstAmount: 0, totalValue: 0 };
    current.taxableValue = money(current.taxableValue + item.taxableValue);
    current.gstAmount = money(current.gstAmount + item.gstAmount);
    current.totalValue = money(current.totalValue + item.totalValue);
    groups.set(key, current);
  });
  return [...groups.values()].sort((a, b) => a.rate - b.rate);
}

function taxSplit(group, interstate) {
  if (interstate) {
    return { central: 0, state: 0, integrated: money(group.gstAmount) };
  }
  const central = money(group.gstAmount / 2);
  return { central, state: money(group.gstAmount - central), integrated: 0 };
}

function normalizeRecords(records, businessState) {
  return (records || []).map(({ invoice = {}, detail = null }) => {
    const customer = customerFromRecord(invoice, detail);
    const customerState = resolveState(customer, businessState);
    const items = normalizeLineItems(invoice, detail);
    return {
      invoice,
      detail,
      number: invoiceNumber(invoice, detail),
      date: invoiceDate(invoice, detail),
      value: money(invoice.amount || detail?.summary?.total || items.reduce((sum, item) => sum + item.totalValue, 0)),
      customer,
      customerState,
      items,
      rateGroups: groupByRate(items),
      registered: /^[0-9]{2}[A-Z0-9]{13}$/.test(customer.gstin),
      interstate: customerState.code !== "00" && businessState.code !== "00" && customerState.code !== businessState.code
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number, undefined, { numeric: true }));
}

function makeSheet(rows, widths, { minRows = GST_TEMPLATE_ROWS, minCols = widths.length } = {}) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = widths.map((width) => ({ wch: width }));
  const endRow = Math.max(minRows, rows.length) - 1;
  const endCol = Math.max(minCols, widths.length, ...rows.map((row) => row.length)) - 1;
  worksheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: endRow, c: endCol } });
  return worksheet;
}

function sum(rows, field) {
  return money(rows.reduce((total, row) => total + numberValue(row[field]), 0));
}

function makeGstr1Sheet({ businessName, businessPhone, startDate, endDate, records, businessState }) {
  const rows = Array.from({ length: GSTR1_SALES_START_ROW - 1 }, () => []);
  const setRow = (rowNumber, values) => {
    while (rows.length < rowNumber) {
      rows.push([]);
    }
    rows[rowNumber - 1] = values;
  };
  setRow(1, [businessName]);
  setRow(2, [`Phone No: ${businessPhone || "Not added"}`]);
  setRow(5, ["GSTR-1"]);
  setRow(6, [`Dated: ${displayDate(startDate)}-${displayDate(endDate)}`]);
  setRow(13, ["Sales"]);
  setRow(14, ["GSTIN", "Customer Name", "Place of supply", "", "Invoice Details", "", "", "Total Tax%", "Taxable Value", "Amount of Tax", "", "", "", "", null]);
  setRow(15, [" ", " ", "State Code", "State Name", "Invoice Number", "Invoice Date", "Invoice value", "", "", "Central Tax Amount", "State/UT Tax Amount", "Integrated Tax Amount", "Cess Amt.", "Total Tax Amt.", null]);
  const totals = { value: 0, taxableValue: 0, central: 0, state: 0, integrated: 0, cess: 0, tax: 0 };
  let nextSalesRow = GSTR1_SALES_START_ROW;
  records.forEach((record) => {
    record.rateGroups.forEach((group, index) => {
      const split = taxSplit(group, record.interstate);
      const taxAmount = money(split.central + split.state + split.integrated);
      if (!index) {
        totals.value = money(totals.value + record.value);
      }
      totals.taxableValue = money(totals.taxableValue + group.taxableValue);
      totals.central = money(totals.central + split.central);
      totals.state = money(totals.state + split.state);
      totals.integrated = money(totals.integrated + split.integrated);
      totals.tax = money(totals.tax + taxAmount);
      setRow(nextSalesRow, [
        index ? "" : record.customer.gstin || null,
        index ? "" : (record.registered ? record.customer.name : "Cash Sale"),
        index ? "" : numberValue(record.customerState.code),
        index ? "" : record.customerState.name,
        index ? "" : record.number,
        index ? "" : displayDate(record.date),
        index ? "" : record.value,
        group.rate || null,
        group.taxableValue,
        split.central,
        split.state,
        split.integrated,
        0,
        taxAmount,
        ""
      ]);
      nextSalesRow += 1;
    });
  });
  const salesTotalRow = nextSalesRow + 1;
  const salesReturnTitleRow = salesTotalRow + GSTR1_SECTION_GAP_ROWS + 1;
  const purchaseReturnTitleRow = salesReturnTitleRow + GSTR1_SECTION_GAP_ROWS + 5;
  setRow(salesTotalRow, ["Total", "", "", "", "", "", totals.value, "", totals.taxableValue, totals.central, totals.state, totals.integrated, totals.cess, totals.tax, null]);
  setRow(salesReturnTitleRow, ["Sales Return"]);
  setRow(salesReturnTitleRow + 1, ["GSTIN", "Customer Name", "Place of supply", "", "Invoice Details", "", "", "", "Total Tax%", "Taxable Value", "Amount of Tax", "", "", "", ""]);
  setRow(salesReturnTitleRow + 2, [" ", " ", "State Code", "State Name", "Invoice Number", "Invoice Date", "Invoice value", "Invoice Type", "", "", "Central Tax Amount", "State/UT Tax Amount", "Integrated Tax Amount", "Cess Amt.", "Total Tax Amt."]);
  setRow(salesReturnTitleRow + 4, ["Total", "", "", "", "", "", 0, "", "", 0, 0, 0, 0, 0, 0]);
  setRow(purchaseReturnTitleRow, ["Purchase Return"]);
  setRow(purchaseReturnTitleRow + 1, ["GSTIN", "Customer Name", "Place of supply", "", "Invoice Details", "", "", "", "Total Tax%", "Taxable Value", "Amount of Tax", "", "", "", ""]);
  setRow(purchaseReturnTitleRow + 2, [" ", " ", "State Code", "State Name", "Invoice Number", "Invoice Date", "Invoice value", "Invoice Type", "", "", "Central Tax Amount", "State/UT Tax Amount", "Integrated Tax Amount", "Cess Amt.", "Total Tax Amt."]);
  setRow(purchaseReturnTitleRow + 4, ["Total", "", "", "", "", "", 0, "", "", 0, 0, 0, 0, 0, 0]);
  return makeSheet(rows, REFERENCE_WIDTHS.gstr1, {
    minRows: rows.length,
    minCols: 15
  });
}

function makeB2bSheet(records) {
  const registered = records.filter((record) => record.registered);
  const recipients = new Set(registered.map((record) => record.customer.gstin)).size;
  const detailRows = registered.flatMap((record) => record.rateGroups.map((group) => [
    record.customer.gstin, record.customer.name, record.number, displayDate(record.date), record.value,
    `${record.customerState.code}-${record.customerState.name}`, "N", "", "Regular B2B", "",
    group.rate, group.taxableValue, 0
  ]));
  return makeSheet([
    ["Summary For B2B"],
    ["No. of Recipients", "", "No. of Invoices", "", "Total Invoice Value", "", "", "", "", "", "", "Total Taxable", "Total Cess"],
    [recipients, "", registered.length, "", sum(registered, "value"), "", "", "", "", "", "", sum(detailRows.map((row) => ({ value: row[11] })), "value"), 0],
    ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
    ...detailRows
  ], REFERENCE_WIDTHS.b2b);
}

function makeB2clSheet(records) {
  const invoices = records.filter((record) => !record.registered && record.interstate && record.value > B2CL_LIMIT);
  const detailRows = invoices.flatMap((record) => record.rateGroups.map((group) => [
    record.number, displayDate(record.date), record.value, `${record.customerState.code}-${record.customerState.name}`,
    "", group.rate, group.taxableValue, 0, ""
  ]));
  return makeSheet([
    ["Summary For B2CL"],
    ["No. of Invoices", "", "Total Invoice Value", "", "", "", "Total Taxable Value", "Total Cess", null],
    [invoices.length, "", sum(invoices, "value"), "", "", "", sum(detailRows.map((row) => ({ value: row[6] })), "value"), 0, null],
    ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
    ...detailRows
  ], REFERENCE_WIDTHS.b2cl);
}

function makeB2csSheet(records) {
  const groups = new Map();
  records.filter((record) => !record.registered && !(record.interstate && record.value > B2CL_LIMIT)).forEach((record) => {
    record.rateGroups.filter((group) => group.rate > 0).forEach((group) => {
      const key = `${record.customerState.code}|${group.rate}`;
      const current = groups.get(key) || {
        place: `${record.customerState.code}-${record.customerState.name}`,
        rate: group.rate,
        taxableValue: 0
      };
      current.taxableValue = money(current.taxableValue + group.taxableValue);
      groups.set(key, current);
    });
  });
  const detailRows = [...groups.values()].sort((a, b) => a.place.localeCompare(b.place) || a.rate - b.rate).map((group) => [
    "OE", group.place, "", group.rate, group.taxableValue, 0, ""
  ]);
  return makeSheet([
    ["Summary For B2CS"],
    ["", "", "", "", "Total Taxable Value", "Total Cess", null],
    ["", "", "", "", sum(detailRows.map((row) => ({ value: row[4] })), "value"), 0, null],
    ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
    ...detailRows
  ], REFERENCE_WIDTHS.b2cs);
}

function makeCdnrSheet() {
  return makeSheet([
    ["Summary For CDNR"],
    ["No. of Recipients", "No. of Notes", "", "", "", "", "", "Total Note Value", "", "", "Total Taxable Value", "Total Cess", null],
    [0, 0, "", "", "", "", "", 0, "", "", 0, 0, null],
    ["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"]
  ], REFERENCE_WIDTHS.cdnr);
}

function makeCdnurSheet() {
  return makeSheet([
    ["Summary For CDNUR"],
    ["", "No. of Notes/Vouchers", "", "", "", "Total Note Value", "", "", "Total Taxable Value", "Total Cess"],
    ["", 0, "", "", "", 0, "", "", 0, 0],
    ["UR Type", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"]
  ], REFERENCE_WIDTHS.cdnur);
}

function makeExemptSheet(records, businessState) {
  const totals = {
    interRegistered: 0, intraRegistered: 0, interUnregistered: 0, intraUnregistered: 0
  };
  records.forEach((record) => {
    const zeroRated = record.rateGroups.filter((group) => group.rate === 0).reduce((total, group) => total + group.taxableValue, 0);
    if (!zeroRated) {
      return;
    }
    const key = `${record.interstate ? "inter" : "intra"}${record.registered ? "Registered" : "Unregistered"}`;
    totals[key] = money(totals[key] + zeroRated);
  });
  const rows = [
    ["Inter-State supplies to registered persons", totals.interRegistered, 0, 0],
    ["Intra-State supplies to registered persons", totals.intraRegistered, 0, 0],
    ["Inter-State supplies to unregistered persons", totals.interUnregistered, 0, 0],
    ["Intra-State supplies to unregistered persons", totals.intraUnregistered, 0, 0]
  ];
  return makeSheet([
    ["Summary For Nil rated, exempted and non GST outward supplies (8)"],
    ["", "Total Nil Rated Supplies", "Total Exempted Supplies", "Total Non-GST Supplies"],
    ["", sum(rows.map((row) => ({ value: row[1] })), "value"), 0, 0],
    ["Description", "Nil Rated Supplies", "Exempted(other than nil rated/non GST supply)", "Non-GST Supplies"],
    ...rows
  ], REFERENCE_WIDTHS.exemp);
}

function makeHsnSheet(records, registered) {
  const groups = new Map();
  records.filter((record) => record.registered === registered).forEach((record) => {
    record.items.forEach((item) => {
      const split = taxSplit(item, record.interstate);
      const uqc = uqcForUnit(item.unit);
      const hsnKey = item.hsn || `no-hsn-${normalizeKey(item.name)}`;
      const key = `${hsnKey}|${uqc}|${item.gstRate}`;
      const current = groups.get(key) || {
        hsn: item.hsn,
        description: item.name,
        uqc,
        quantity: 0,
        totalValue: 0,
        rate: item.gstRate,
        taxableValue: 0,
        integrated: 0,
        central: 0,
        state: 0
      };
      current.description = "";
      current.quantity = money(current.quantity + item.quantity);
      current.totalValue = money(current.totalValue + item.totalValue);
      current.taxableValue = money(current.taxableValue + item.taxableValue);
      current.integrated = money(current.integrated + split.integrated);
      current.central = money(current.central + split.central);
      current.state = money(current.state + split.state);
      groups.set(key, current);
    });
  });
  const detailRows = [...groups.values()].sort((a, b) => a.hsn.localeCompare(b.hsn, undefined, { numeric: true }) || a.description.localeCompare(b.description)).map((group) => [
    group.hsn, group.description, group.uqc, group.quantity, group.totalValue, group.rate,
    group.taxableValue, group.integrated, group.central, group.state, 0
  ]);
  return makeSheet([
    ["Summary For HSN(12)"],
    ["No. of HSN", "", "", "", "Total Value", "", "Total Taxable Value", "Total Integrated Tax", "Total Central Tax", "Total State/UT Tax", "Total Cess"],
    [detailRows.length, "", "", "", sum(detailRows.map((row) => ({ value: row[4] })), "value"), "", sum(detailRows.map((row) => ({ value: row[6] })), "value"), sum(detailRows.map((row) => ({ value: row[7] })), "value"), sum(detailRows.map((row) => ({ value: row[8] })), "value"), sum(detailRows.map((row) => ({ value: row[9] })), "value"), 0],
    ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
    ...detailRows
  ], registered ? REFERENCE_WIDTHS.hsnB2b : REFERENCE_WIDTHS.hsnB2c);
}

function makeDocsSheet(records) {
  const numbers = records.map((record) => record.number).filter(Boolean);
  return makeSheet([
    ["Summary of documents issued during the tax period (13)"],
    ["", "", "", "Total Number", "Total Cancelled"],
    ["", "", "", numbers.length, 0],
    ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
    ["Invoices for outward supply", numbers[0] || "", numbers.at(-1) || "", numbers.length, 0]
  ], REFERENCE_WIDTHS.docs);
}

export function buildGstr1Workbook({
  businessName = "CinchPOS Business",
  businessPhone = "",
  businessGstin = "",
  businessAddress = "",
  businessStateCode = "",
  businessStateName = "",
  startDate = "",
  endDate = "",
  records = []
} = {}) {
  const normalizedStartDate = isoDate(startDate) || records.map(({ invoice, detail }) => invoiceDate(invoice, detail)).filter(Boolean).sort()[0] || "";
  const normalizedEndDate = isoDate(endDate) || records.map(({ invoice, detail }) => invoiceDate(invoice, detail)).filter(Boolean).sort().at(-1) || normalizedStartDate;
  const businessState = resolveState({
    gstin: businessGstin,
    stateCode: businessStateCode,
    state: businessStateName,
    address: businessAddress
  });
  const normalizedRecords = normalizeRecords(records, businessState);
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: `${cleanText(businessName, "CinchPOS Business")} GSTR-1`,
    Subject: `GSTR-1 from ${displayDate(normalizedStartDate)} to ${displayDate(normalizedEndDate)}`,
    Author: "CinchPOS",
    Company: "CinchLive Technologies Pvt. Ltd."
  };
  XLSX.utils.book_append_sheet(workbook, makeGstr1Sheet({
    businessName: cleanText(businessName, "CinchPOS Business"),
    businessPhone: cleanText(businessPhone),
    startDate: normalizedStartDate,
    endDate: normalizedEndDate,
    records: normalizedRecords,
    businessState
  }), "gstr1");
  XLSX.utils.book_append_sheet(workbook, makeB2bSheet(normalizedRecords), "b2b");
  XLSX.utils.book_append_sheet(workbook, makeB2clSheet(normalizedRecords), "b2cl");
  XLSX.utils.book_append_sheet(workbook, makeB2csSheet(normalizedRecords), "b2cs");
  XLSX.utils.book_append_sheet(workbook, makeCdnrSheet(), "cdnr");
  XLSX.utils.book_append_sheet(workbook, makeCdnurSheet(), "cdnur");
  XLSX.utils.book_append_sheet(workbook, makeExemptSheet(normalizedRecords, businessState), "exemp");
  XLSX.utils.book_append_sheet(workbook, makeHsnSheet(normalizedRecords, true), "hsn(b2b)");
  XLSX.utils.book_append_sheet(workbook, makeHsnSheet(normalizedRecords, false), "hsn(b2c)");
  XLSX.utils.book_append_sheet(workbook, makeDocsSheet(normalizedRecords), "docs");
  return workbook;
}

export function writeGstr1Workbook(workbook) {
  return XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
}

export function makeGstr1ReportFileName({ businessName, startDate, endDate } = {}) {
  const safeBusiness = cleanText(businessName, "CinchPOS Business").replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim();
  const from = displayDate(startDate).replaceAll("/", "-") || "all";
  const to = displayDate(endDate).replaceAll("/", "-") || from;
  return `[${safeBusiness}] GSTR-1 from ${from} to ${to}.xlsx`;
}

import { cleanText, currency, normalizeKey, todayISO } from "../format.js";
import * as XLSX from "xlsx";
import {
  calculateDiscountPercent,
  getInventoryGSTBreakup,
  normalizeInventoryBarcodes
} from "../inventory.js";

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file) {
  if (!file) {
    return Promise.resolve("");
  }

  if (isSpreadsheetFile(file.name)) {
    return readSpreadsheetFile(file);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected import file."));
    reader.readAsText(file);
  });
}

function isSpreadsheetFile(fileName = "") {
  return /\.xlsx?$/.test(String(fileName || "").toLowerCase());
}

const spreadsheetHeaderAliases = [
  "customer name",
  "customer",
  "party name",
  "phone",
  "mobile",
  "email",
  "item name",
  "item",
  "product name",
  "barcode",
  "barcode 2",
  "sku",
  "stock",
  "qty",
  "quantity",
  "mrp",
  "selling price",
  "sale price",
  "gst",
  "hsn",
  "invoice number",
  "bill number",
  "amount",
  "paid",
  "invoice date",
  "due date"
].map(normalizeKey);

function isPlaceholderSpreadsheetHeader(value = "") {
  const normalized = normalizeKey(value);
  return (
    !normalized
    || /^_*(empty|blank|column)?_*\d*$/.test(normalized)
  );
}

function isSpreadsheetNoticeRow(row = []) {
  const joined = row.map((cell) => cleanText(cell).toLowerCase()).filter(Boolean).join(" ");
  if (!joined) {
    return false;
  }
  return (
    joined.includes("you can edit only 4000 items at once")
    || joined.includes("editing more than 4000 items")
    || joined.includes("contact our support team")
    || joined.includes("batched items cannot be edited")
  );
}

function scoreSpreadsheetHeaderRow(row = []) {
  const nonEmptyCells = row.map((cell) => cleanText(cell)).filter(Boolean);
  if (!nonEmptyCells.length || isSpreadsheetNoticeRow(row)) {
    return -1;
  }

  return nonEmptyCells.reduce((score, cell) => {
    const normalizedCell = normalizeKey(cell);
    const matches = spreadsheetHeaderAliases.some((alias) => (
      normalizedCell === alias
      || normalizedCell.includes(alias)
      || alias.includes(normalizedCell)
    ));
    return score + (matches ? 1 : 0);
  }, 0);
}

function findSpreadsheetHeaderRow(rows = []) {
  let bestIndex = -1;
  let bestScore = -1;

  rows.slice(0, 30).forEach((row, index) => {
    const score = scoreSpreadsheetHeaderRow(row);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= 2 ? bestIndex : 0;
}

function makeSpreadsheetHeaderKey(value, index, usedHeaders) {
  const baseHeader = isPlaceholderSpreadsheetHeader(value)
    ? `Column ${index + 1}`
    : cleanText(value, `Column ${index + 1}`);
  let candidate = baseHeader;
  let counter = 2;
  while (usedHeaders.has(normalizeKey(candidate))) {
    candidate = `${baseHeader} ${counter}`;
    counter += 1;
  }
  usedHeaders.add(normalizeKey(candidate));
  return candidate;
}

function rowHasSpreadsheetValues(row = {}) {
  return Object.values(row || {}).some((value) => cleanText(value));
}

function buildSheetRows(worksheet) {
  const grid = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: "",
    raw: false
  });

  if (!grid.length) {
    return [];
  }

  const headerRowIndex = findSpreadsheetHeaderRow(grid);
  const headerCells = grid[headerRowIndex] || [];
  const usedHeaders = new Set();
  const headers = headerCells.map((header, index) => makeSpreadsheetHeaderKey(header, index, usedHeaders));

  return grid
    .slice(headerRowIndex + 1)
    .filter((row) => Array.isArray(row) && row.some((cell) => cleanText(cell)))
    .filter((row) => !isSpreadsheetNoticeRow(row))
    .map((row) => headers.reduce((record, header, index) => {
      record[header] = cleanText(row[index]);
      return record;
    }, {}))
    .filter(rowHasSpreadsheetValues);
}

export function workbookToTransferPayload(workbook) {
  const sheetNames = workbook?.SheetNames || [];
  if (!sheetNames.length) {
    return [];
  }

  const sheetPayload = sheetNames.reduce((payload, sheetName) => {
    const worksheet = workbook.Sheets?.[sheetName];
    if (!worksheet) {
      return payload;
    }
    const rows = buildSheetRows(worksheet);
    if (rows.length) {
      payload[sheetName] = rows;
    }
    return payload;
  }, {});

  const payloadSheetNames = Object.keys(sheetPayload);
  if (!payloadSheetNames.length) {
    return [];
  }
  if (payloadSheetNames.length === 1) {
    return sheetPayload[payloadSheetNames[0]];
  }
  return sheetPayload;
}

async function readSpreadsheetFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    return JSON.stringify(workbookToTransferPayload(workbook));
  } catch {
    throw new Error("Could not read the selected spreadsheet file.");
  }
}

export function parseDelimitedRows(content, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const nextCharacter = content[index + 1];
    if (character === "\"" && quoted && nextCharacter === "\"") {
      cell += "\"";
      index += 1;
    } else if (character === "\"") {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) {
    rows.push(row);
  }
  return rows;
}

export function detectTransferDelimiter(content) {
  const delimiters = [",", ";", "\t", "|"];
  let bestDelimiter = ",";
  let bestScore = -1;

  delimiters.forEach((delimiter) => {
    const rows = parseDelimitedRows(content, delimiter).slice(0, 6);
    if (rows.length < 2) {
      return;
    }
    const counts = rows.map((row) => row.filter((value) => cleanText(value) !== "").length).filter(Boolean);
    if (!counts.length) {
      return;
    }
    const averageColumns = counts.reduce((total, value) => total + value, 0) / counts.length;
    const consistencyBonus = new Set(counts).size <= 2 ? 0.5 : 0;
    const score = averageColumns + consistencyBonus;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  });

  return bestDelimiter;
}

export function parseCSV(content) {
  const rows = parseDelimitedRows(content, detectTransferDelimiter(content));
  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => headers.reduce((record, header, index) => {
    record[header] = values[index] || "";
    return record;
  }, {}));
}

export function valueFrom(row, aliases, fallback = "") {
  const entries = Object.entries(row || {});
  const normalizedRow = entries.reduce((fields, [key, value]) => {
    fields[normalizeKey(key)] = value;
    return fields;
  }, {});
  const normalizedAliases = aliases.map(normalizeKey);
  const exact = normalizedAliases.find((key) => normalizedRow[key] !== undefined && normalizedRow[key] !== "");
  if (exact) {
    return normalizedRow[exact];
  }
  const fuzzy = entries.find(([key, value]) => {
    const normalizedField = normalizeKey(key);
    return value !== undefined
      && value !== ""
      && normalizedAliases.some((alias) => normalizedField.includes(alias) || alias.includes(normalizedField));
  });
  return fuzzy ? fuzzy[1] : fallback;
}

export function hasValueFrom(row, aliases) {
  const marker = "__CINCHPOS_TRANSFER_EMPTY__";
  return valueFrom(row, aliases, marker) !== marker;
}

export function numberFrom(row, aliases, fallback = 0) {
  const rawValue = valueFrom(row, aliases, fallback);
  const value = typeof rawValue === "number"
    ? rawValue
    : Number(String(rawValue || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeImportDate(value, fallback = todayISO()) {
  const raw = cleanText(value);
  if (!raw) {
    return fallback;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  const compactIsoDate = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactIsoDate) {
    const [, year, month, day] = compactIsoDate;
    return `${year}-${month}-${day}`;
  }
  const compactDate = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (compactDate) {
    let [, first, second, year] = compactDate;
    const day = Number(first);
    const month = Number(second);
    const resolvedYear = year.length === 2 ? `20${year}` : year;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return `${resolvedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return fallback;
}

export function formatTransferFieldLabel(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function collectDetectedColumns(rows) {
  const fields = new Set();
  (rows || []).slice(0, 6).forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      if (cleanText(key) && !isPlaceholderSpreadsheetHeader(key)) {
        fields.add(String(key));
      }
    });
  });
  return Array.from(fields).slice(0, 14);
}

export function collectImportBarcodes(row) {
  const barcodeFields = [
    "barcode",
    "bar_code",
    "barcode1",
    "barcode2",
    "barcode3",
    "sku",
    "itemCode",
    "item_code",
    "productCode",
    "alternateBarcode",
    "secondaryBarcode"
  ];
  const directValues = barcodeFields.map((field) => valueFrom(row, [field])).filter(Boolean);
  const scannedColumns = Object.entries(row || {})
    .filter(([key]) => {
      const normalized = normalizeKey(key);
      return normalized.includes("barcode") || ["sku", "itemcode", "productcode"].some((alias) => normalized.includes(alias));
    })
    .map(([, value]) => value);
  return normalizeInventoryBarcodes([...directValues, ...scannedColumns].join(" "));
}

export const transferSourceProfiles = [
  {
    id: "generic",
    label: "Generic Export",
    aliases: ["generic", "csv", "json", "excel export"],
    supportedFormats: ["CSV", "XLSX", "JSON", "XML"],
    exportAction: "Open the matching list in the old software and export it with the first row kept as column headers.",
    followUpNotes: {
      customers: "If the old app splits contacts across multiple reports, import the main customer list first and then run a second import for any remaining contact details.",
      inventory: "If stock, price, and GST are spread across separate exports, import the item master first and then re-import stock or price reports to update the same items.",
      invoices: "If payments are exported separately, import invoices first and then reconcile outstanding balances using the invoice register."
    }
  },
  {
    id: "mybillbook",
    label: "myBillBook",
    aliases: ["mybillbook", "my billbook", "mybill"],
    supportedFormats: ["Tally XML", "CSV", "XLSX", "JSON"],
    exportAction: "In myBillBook, go to More > Business & GST Settings > Data Export to Tally, choose the date range, and export the XML file.",
    followUpNotes: {
      customers: "myBillBook can export parties through the Tally export. If phone or email is missing for some parties, bring a party report in a second pass.",
      inventory: "myBillBook's Tally export may not carry every stock, MRP, batch, image, or custom-field detail. Keep a stock summary or item list ready for a second inventory update pass.",
      invoices: "myBillBook exports sales well for migration, but linked collections or bank details may need a follow-up reconciliation after invoice import."
    }
  },
  {
    id: "tally",
    label: "Tally / TallyPrime",
    aliases: ["tally", "tallyprime", "tally erp", "tallyerp"],
    supportedFormats: ["XML", "Excel CSV", "XLSX", "JSON"],
    exportAction: "In Tally/TallyPrime, open the party, stock item, or sales voucher report and use Export to save it as XML or Excel CSV.",
    followUpNotes: {
      customers: "If Tally uses both debtors and creditors, review the customer preview so only the right parties come into Customer Info.",
      inventory: "Stock items usually migrate well from Tally XML. If sale price and MRP are configured in separate reports, import the price report again after the stock items.",
      invoices: "Voucher imports work best when invoice number, party name, amount, and date are present. Payment linkage may still need a quick review."
    }
  },
  {
    id: "vyapar",
    label: "Vyapar",
    aliases: ["vyapar"],
    supportedFormats: ["CSV", "Excel CSV", "XLSX", "JSON"],
    exportAction: "In Vyapar, open Parties, Items, or Sales Reports and use Export/Share to save the report as Excel CSV.",
    followUpNotes: {
      customers: "If GST or address details are important, keep a backup party export even though CinchPOS currently imports name, phone, and email only.",
      inventory: "If multiple barcodes are split across columns, keep each barcode column in the export and CinchPOS will combine them.",
      invoices: "Use the sales-register export with invoice number, customer name, total amount, paid amount, and invoice date."
    }
  },
  {
    id: "busy",
    label: "BUSY",
    aliases: ["busy", "busy accounting"],
    supportedFormats: ["CSV", "Excel CSV", "XLSX", "XML"],
    exportAction: "In BUSY, open Masters or Sales Register and use Export to save the file as CSV or XML.",
    followUpNotes: {
      customers: "BUSY party exports usually map well, but keep phone and email columns visible for better duplicate matching.",
      inventory: "Bring stock item name, barcode, unit, stock, and rate columns together if possible for the easiest import.",
      invoices: "Invoice or voucher exports should include invoice number, party name, amount, and dates."
    }
  },
  {
    id: "custom",
    label: "Other / Custom Software",
    aliases: ["other", "custom"],
    supportedFormats: ["CSV", "XLSX", "JSON", "XML"],
    exportAction: "Open the customer list, item list, or sales register in the old software and export it with headers kept in the first row.",
    followUpNotes: {
      customers: "Start with the cleanest customer list first. You can always run another customer import to fill missing contacts.",
      inventory: "Run the item master first, then re-import separate stock or pricing exports if the old software splits them.",
      invoices: "Import invoice history in date order if the old software only allows limited exports."
    }
  }
];

function getTransferSourceProfileById(sourceProfileId = "") {
  const normalizedId = cleanText(sourceProfileId).toLowerCase();
  return transferSourceProfiles.find((profile) => profile.id === normalizedId) || null;
}

export function getTransferSourceProfile(sourceSoftware = "", sourceProfileId = "") {
  const directProfile = getTransferSourceProfileById(sourceProfileId);
  if (directProfile) {
    return directProfile;
  }
  const softwareKey = normalizeKey(sourceSoftware);
  if (!softwareKey) {
    return transferSourceProfiles[0];
  }
  return transferSourceProfiles.find((profile) => (
    profile.aliases || []
  ).some((alias) => softwareKey.includes(normalizeKey(alias)))) || transferSourceProfiles[0];
}

function makeGenericTransferGuideSteps(type, sourceSoftware = "") {
  const softwareName = cleanText(sourceSoftware);
  const softwareHint = softwareName
    ? `In ${softwareName}, open the matching screen and use Export or Download to save the data as CSV, JSON, or XML.`
    : "Open the previous billing app and use Export or Download in the matching customer, item, or sales screen.";

  const stepsByType = {
    customers: [
      { title: "Open the customer list in the old app", detail: softwareHint },
      { title: "Export customer records", detail: "Keep customer name, phone/mobile, and email columns if they are available." },
      { title: "Save the file without changing the headers", detail: "Do not remove the first row. CinchPOS uses those column names to place the data correctly." },
      { title: "Upload the file into Customer Data", detail: "Choose the old software, upload the file, or paste the rows here." },
      { title: "Click Review Import", detail: "CinchPOS checks duplicates first and shows which customers will be added and which ones will update Customer Info." },
      { title: "Import and confirm in Customer Info", detail: "After import, the customer list and matching customer fields are updated inside Customer Info." }
    ],
    inventory: [
      { title: "Open products or stock in the old app", detail: softwareHint },
      { title: "Export the item or stock report", detail: "Try to include item name, barcode, stock, selling price, MRP, GST, and HSN. Even stock-only exports can still update Inventory." },
      { title: "Keep barcode columns as they are", detail: "If the file has Barcode, Barcode 2, SKU, or Item Code columns, do not merge them manually. CinchPOS combines them automatically." },
      { title: "Upload the file into Inventory Data", detail: "Choose Inventory Data and upload the file or paste the rows here." },
      { title: "Click Review Import", detail: "CinchPOS shows which items will be added and which ones will update existing Inventory by barcode or item name." },
      { title: "Import and confirm in Inventory", detail: "After import, Inventory updates stock, pricing, GST, barcodes, and item details wherever the file provides them." }
    ],
    invoices: [
      { title: "Open sales or invoice history in the old app", detail: softwareHint },
      { title: "Export the invoice register", detail: "Include invoice number, customer name, phone number, invoice amount, paid amount, invoice date, and due date where possible." },
      { title: "Keep payment columns if the app has them", detail: "Full and partial payments are both recorded automatically when the file includes paid values." },
      { title: "Upload the file into Invoice Data", detail: "Choose Invoice Data and upload the export or paste the rows here." },
      { title: "Click Review Import", detail: "CinchPOS checks missing customers, duplicate invoice numbers, and the invoice rows that are ready to move." },
      { title: "Import and confirm in Invoices", detail: "After import, the Invoices screen shows the imported bills and their payment status." }
    ]
  };

  return stepsByType[type] || stepsByType.customers;
}

function makeMyBillBookGuideSteps(type) {
  const commonIntro = "In myBillBook, open More > Business & GST Settings > Data Export to Tally. Choose the date range, add the email address, and export the XML file.";
  const stepsByType = {
    customers: [
      { title: "Export from myBillBook", detail: commonIntro },
      { title: "Use the full party export", detail: "myBillBook sends parties inside the same Tally XML export. Save that XML file when it arrives." },
      { title: "Upload the XML into Customer Data", detail: "Choose myBillBook in CinchPOS and upload the XML file directly." },
      { title: "Review duplicate matches", detail: "CinchPOS checks phone number first and then exact customer name before adding or updating Customer Info." },
      { title: "Import and verify", detail: "After import, open Customer Info and confirm party names, phone numbers, and emails." }
    ],
    inventory: [
      { title: "Export from myBillBook", detail: commonIntro },
      { title: "Keep any stock or item report ready too", detail: "myBillBook's Tally XML is a good first pass. If stock, MRP, or price is missing, export a stock summary or item list for a second pass." },
      { title: "Upload the file into Inventory Data", detail: "Choose myBillBook and upload the XML file. CSV or JSON item exports also work." },
      { title: "Review stock and pricing", detail: "CinchPOS shows which items will update existing Inventory and which ones will be added as new items." },
      { title: "Import and confirm", detail: "After import, Inventory updates barcode, stock, price, GST, HSN, and date fields wherever the file provides them." }
    ],
    invoices: [
      { title: "Export from myBillBook", detail: commonIntro },
      { title: "Use the sales export", detail: "Keep invoice number, customer, amount, paid amount, and invoice date in the file whenever possible." },
      { title: "Upload the file into Invoice Data", detail: "Choose myBillBook and upload the XML or sales-register export." },
      { title: "Review invoice numbering and payments", detail: "If an invoice number already exists, CinchPOS safely renames it. Paid values are carried across whenever the file includes them." },
      { title: "Import and reconcile", detail: "After import, open Invoices and compare totals with myBillBook before going live." }
    ]
  };
  return stepsByType[type] || stepsByType.customers;
}

function makeTallyGuideSteps(type) {
  const commonIntro = "Export the relevant masters or vouchers from Tally/TallyPrime in XML when possible. CinchPOS can read the same XML file across multiple import sections.";
  const stepsByType = {
    customers: [
      { title: "Export ledgers from Tally", detail: `${commonIntro} Include debtor/customer ledgers in the export.` },
      { title: "Upload the XML or CSV here", detail: "CinchPOS reads customer name, mobile, email, and party fields from the export before creating anything." },
      { title: "Review the customer preview", detail: "Check that the preview mainly shows customer parties and not supplier-only ledgers." },
      { title: "Import and verify", detail: "After import, open Customer Info and spot-check phone numbers and names." }
    ],
    inventory: [
      { title: "Export stock items from Tally", detail: `${commonIntro} Include stock item masters with barcode, rate, GST, and HSN if available.` },
      { title: "Upload the export into Inventory Data", detail: "The XML parser reads stock items directly, and CSV/JSON exports still work with the same review screen." },
      { title: "Review price and quantity", detail: "If stock items are found but sale price or quantity looks weak, bring a second stock or rate export and import it again." },
      { title: "Import and confirm", detail: "Open Inventory and verify stock count, rate, barcode, and GST breakup." }
    ],
    invoices: [
      { title: "Export sales vouchers", detail: `${commonIntro} Include sales vouchers with voucher number, party name, amount, and date.` },
      { title: "Upload the voucher export", detail: "CinchPOS matches customers first and then prepares the invoice import plan." },
      { title: "Review invoice totals", detail: "Check the preview for invoice numbers that need renaming or rows that need a customer match." },
      { title: "Import and compare", detail: "After import, compare the invoice count and key totals with Tally before the first live day in CinchPOS." }
    ]
  };
  return stepsByType[type] || stepsByType.customers;
}

export function getTransferGuideSteps(type, sourceSoftware = "", sourceProfileId = "") {
  const profile = getTransferSourceProfile(sourceSoftware, sourceProfileId);
  if (profile.id === "mybillbook") {
    return makeMyBillBookGuideSteps(type);
  }
  if (profile.id === "tally") {
    return makeTallyGuideSteps(type);
  }
  return makeGenericTransferGuideSteps(type, sourceSoftware || profile.label);
}

export function getTransferSmartNotes(type, sourceSoftware = "", sourceProfileId = "", baseNotes = []) {
  const profile = getTransferSourceProfile(sourceSoftware, sourceProfileId);
  const softwareSpecificNotes = [
    profile.exportAction,
    profile.followUpNotes?.[type] || ""
  ].filter(Boolean);
  return Array.from(new Set([
    ...softwareSpecificNotes,
    ...baseNotes
  ]));
}

function decodeXMLText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksLikeXML(content = "", fileName = "") {
  const trimmed = String(content || "").trim();
  return fileName.toLowerCase().endsWith(".xml") || trimmed.startsWith("<");
}

function extractXMLNodes(content, tagName) {
  const matches = [];
  const regex = new RegExp(`<${escapeRegExp(tagName)}\\b([^>]*)>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "gi");
  let match = regex.exec(content);
  while (match) {
    matches.push({
      attributes: match[1] || "",
      inner: match[2] || ""
    });
    match = regex.exec(content);
  }
  return matches;
}

function parseXMLAttributes(attributeString = "") {
  const attributes = {};
  String(attributeString || "").replace(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(['"])(.*?)\2/g, (_, key, __, value) => {
    attributes[normalizeKey(key)] = decodeXMLText(value);
    return "";
  });
  return attributes;
}

function extractXMLLeafEntries(content = "") {
  const entries = [];
  const regex = /<([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^>]*)?>([^<>]*)<\/\1>/g;
  let match = regex.exec(content);
  while (match) {
    const value = decodeXMLText(match[2]);
    if (cleanText(value)) {
      entries.push({
        tag: match[1],
        normalizedTag: normalizeKey(match[1]),
        value
      });
    }
    match = regex.exec(content);
  }
  return entries;
}

function xmlEntryValue(entries, aliases = [], includeAliases = aliases) {
  const normalizedAliases = aliases.map(normalizeKey);
  const exact = entries.find((entry) => normalizedAliases.includes(entry.normalizedTag));
  if (exact) {
    return exact.value;
  }
  const fuzzyAliases = includeAliases.map(normalizeKey);
  const fuzzy = entries.find((entry) => fuzzyAliases.some((alias) => entry.normalizedTag.includes(alias) || alias.includes(entry.normalizedTag)));
  return fuzzy ? fuzzy.value : "";
}

function xmlEntryValues(entries, includeAliases = []) {
  const fuzzyAliases = includeAliases.map(normalizeKey);
  return entries
    .filter((entry) => fuzzyAliases.some((alias) => entry.normalizedTag.includes(alias) || alias.includes(entry.normalizedTag)))
    .map((entry) => entry.value);
}

function xmlEntryNumber(entries, aliases = [], includeAliases = aliases, fallback = 0) {
  const value = xmlEntryValue(entries, aliases, includeAliases);
  const parsed = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function xmlEntryMaxNumber(entries, aliases = [], includeAliases = aliases, fallback = 0) {
  const values = xmlEntryValues(entries, includeAliases.length ? includeAliases : aliases)
    .map((value) => Number(String(value || "").replace(/[^0-9.-]/g, "")))
    .filter(Number.isFinite);
  if (!values.length) {
    return fallback;
  }
  return Math.max(...values.map((value) => Math.abs(value)));
}

function normalizeXMLRecord(entries, attributes = {}) {
  const row = {};
  entries.forEach((entry) => {
    const label = formatTransferFieldLabel(entry.tag) || entry.tag;
    if (!row[label]) {
      row[label] = entry.value;
      return;
    }
    let counter = 2;
    while (row[`${label} ${counter}`]) {
      counter += 1;
    }
    row[`${label} ${counter}`] = entry.value;
  });
  Object.entries(attributes || {}).forEach(([key, value]) => {
    const label = formatTransferFieldLabel(key);
    if (!row[label] && cleanText(value)) {
      row[label] = value;
    }
  });
  return row;
}

function parseTallyCustomers(content) {
  return extractXMLNodes(content, "LEDGER")
    .map((node) => {
      const attributes = parseXMLAttributes(node.attributes);
      const entries = extractXMLLeafEntries(node.inner);
      const parent = cleanText(xmlEntryValue(entries, ["parent", "group", "primarygroup"])).toLowerCase();
      const phone = cleanText(xmlEntryValue(entries, ["mobile", "phone", "phoneno", "contact", "ledgermobile"], ["mobile", "phone", "contact"]));
      const email = cleanText(xmlEntryValue(entries, ["email", "emailid", "emailaddress"], ["email"]));
      const name = cleanText(
        attributes.name,
        xmlEntryValue(entries, ["name", "ledgername", "partyname", "mailingname"], ["mailingname", "ledgername", "partyname", "name"])
      );
      const looksLikeCustomer = ["sundrydebtors", "debtor", "customer", "receivable", "party"].some((token) => parent.includes(token));
      if (!name || (!looksLikeCustomer && !phone && !email)) {
        return null;
      }
      if (["sundrycreditors", "creditor", "vendor", "supplier"].some((token) => parent.includes(token)) && !phone && !email) {
        return null;
      }
      return {
        "Customer Name": name,
        Phone: phone,
        Email: email,
        Parent: parent
      };
    })
    .filter(Boolean);
}

function parseTallyInventory(content) {
  return extractXMLNodes(content, "STOCKITEM")
    .map((node) => {
      const attributes = parseXMLAttributes(node.attributes);
      const entries = extractXMLLeafEntries(node.inner);
      const itemName = cleanText(
        attributes.name,
        xmlEntryValue(entries, ["name", "stockitemname"], ["stockitemname", "name"])
      );
      const barcodeValues = xmlEntryValues(entries, ["barcode", "sku", "itemcode", "productcode"]);
      const stock = xmlEntryMaxNumber(entries, ["closingbalance", "closingqty", "openingbalance", "openingqty", "actualqty"], ["closingbalance", "closingqty", "openingbalance", "openingqty", "actualqty"], 0);
      const mrp = xmlEntryNumber(entries, ["mrp", "maximumretailprice"], ["mrp", "maximumretailprice"], 0);
      const sellingPrice = xmlEntryNumber(entries, ["sellingprice", "salesprice", "saleprice", "price", "rate"], ["sellingprice", "salesprice", "saleprice", "price", "rate"], 0);
      const gstRate = xmlEntryNumber(entries, ["gstrate", "taxrate", "rateofgst", "gst", "tax"], ["gstrate", "taxrate", "rateofgst", "gst"], 0);
      if (!itemName && !barcodeValues.length) {
        return null;
      }
      return {
        "Item Name": itemName,
        Barcode: barcodeValues[0] || "",
        "Barcode 2": barcodeValues[1] || "",
        "Barcode 3": barcodeValues[2] || "",
        Category: cleanText(xmlEntryValue(entries, ["category", "group", "parent"], ["category", "group", "parent"])),
        HSN: cleanText(xmlEntryValue(entries, ["hsncode", "hsn", "saccode"], ["hsn", "sac"])),
        Stock: stock ? String(stock) : "",
        Unit: cleanText(xmlEntryValue(entries, ["baseunits", "unit"], ["baseunits", "unit"])),
        MRP: mrp ? String(mrp) : "",
        "Selling Price": sellingPrice ? String(sellingPrice) : "",
        GST: gstRate ? String(gstRate) : "",
        "Manufacturing Date": cleanText(xmlEntryValue(entries, ["manufacturingdate", "mfgdate"], ["manufacturing", "mfg"])),
        "Expiry Date": cleanText(xmlEntryValue(entries, ["expirydate", "expdate"], ["expiry", "expdate"]))
      };
    })
    .filter(Boolean);
}

function parseTallyInvoices(content) {
  return extractXMLNodes(content, "VOUCHER")
    .map((node) => {
      const attributes = parseXMLAttributes(node.attributes);
      const entries = extractXMLLeafEntries(node.inner);
      const voucherType = cleanText(
        attributes.vchtype,
        xmlEntryValue(entries, ["vouchertypename", "vouchertype", "typename"], ["vouchertype", "typename"])
      ).toLowerCase();
      if (voucherType && !voucherType.includes("sale") && !voucherType.includes("invoice")) {
        return null;
      }
      const invoiceNumber = cleanText(xmlEntryValue(entries, ["vouchernumber", "billnumber", "invoicenumber", "reference"], ["vouchernumber", "billnumber", "invoicenumber", "reference"]));
      const customerName = cleanText(xmlEntryValue(entries, ["partyledgername", "partyname", "ledgername", "basicbuyername"], ["partyledgername", "partyname", "basicbuyername"]));
      const amount = xmlEntryMaxNumber(entries, ["vouchertotal", "amount", "billamount", "grandtotal", "netamount"], ["vouchertotal", "billamount", "grandtotal", "netamount", "amount"], 0);
      const totalPaid = xmlEntryMaxNumber(entries, ["paidamount", "receivedamount", "amountreceived"], ["paidamount", "receivedamount", "amountreceived"], 0);
      const issuedOn = cleanText(xmlEntryValue(entries, ["date", "effectivedate"], ["date", "effectivedate"]));
      const dueOn = cleanText(xmlEntryValue(entries, ["duedate", "dueondate"], ["duedate", "dueondate"]));
      if (!customerName && !invoiceNumber && amount <= 0) {
        return null;
      }
      return {
        "Invoice Number": invoiceNumber,
        "Customer Name": customerName,
        Amount: amount ? String(amount) : "",
        Paid: totalPaid ? String(totalPaid) : "",
        "Invoice Date": issuedOn,
        "Due Date": dueOn || issuedOn,
        Notes: cleanText(xmlEntryValue(entries, ["narration", "notes", "remark"], ["narration", "note", "remark"]))
      };
    })
    .filter(Boolean);
}

function parseGenericXMLGroup(content, tagNames = []) {
  const rows = [];
  tagNames.forEach((tagName) => {
    extractXMLNodes(content, tagName).forEach((node) => {
      const entries = extractXMLLeafEntries(node.inner);
      const attributes = parseXMLAttributes(node.attributes);
      const row = normalizeXMLRecord(entries, attributes);
      if (Object.keys(row).length) {
        rows.push(row);
      }
    });
  });
  return rows;
}

function parseXMLTransferPayload(content) {
  const payload = {
    customers: parseTallyCustomers(content),
    inventory: parseTallyInventory(content),
    invoices: parseTallyInvoices(content)
  };

  if (payload.customers.length || payload.inventory.length || payload.invoices.length) {
    return payload;
  }

  return {
    customers: parseGenericXMLGroup(content, ["CUSTOMER", "PARTY", "CLIENT"]),
    inventory: parseGenericXMLGroup(content, ["ITEM", "PRODUCT", "STOCKITEM", "INVENTORYITEM"]),
    invoices: parseGenericXMLGroup(content, ["INVOICE", "BILL", "SALE", "VOUCHER"])
  };
}

export function parseTransferRows(content, dataType, fileName = "") {
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return dataType === "all" ? {} : [];
  }
  if (fileName.toLowerCase().endsWith(".json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  if (looksLikeXML(trimmed, fileName)) {
    return parseXMLTransferPayload(trimmed);
  }
  return parseCSV(trimmed);
}

export function packageRows(payload, dataType) {
  const pickArray = (source, aliases = []) => {
    if (!source || typeof source !== "object") {
      return null;
    }
    const entries = Object.entries(source);
    const normalizedLookup = entries.reduce((lookup, [key, value]) => {
      lookup[normalizeKey(key)] = value;
      return lookup;
    }, {});
    const collapsedLookup = entries.reduce((lookup, [key, value]) => {
      lookup[normalizeKey(key).replace(/-/g, "")] = value;
      return lookup;
    }, {});
    for (const alias of aliases) {
      if (Array.isArray(source[alias])) {
        return source[alias];
      }
      const normalizedAlias = normalizeKey(alias);
      if (Array.isArray(normalizedLookup[normalizedAlias])) {
        return normalizedLookup[normalizedAlias];
      }
      const collapsedAlias = normalizedAlias.replace(/-/g, "");
      if (Array.isArray(collapsedLookup[collapsedAlias])) {
        return collapsedLookup[collapsedAlias];
      }
    }
    return null;
  };

  if (Array.isArray(payload)) {
    return { [dataType === "all" ? "inventory" : dataType]: payload };
  }
  if (dataType !== "all") {
    const aliases = {
      inventory: ["inventory", "items", "products", "inventorydata", "stock"],
      customers: ["customers", "parties", "customerdata"],
      invoices: ["invoices", "invoice", "bills", "sales", "invoicedata", "salesregister"],
      purchases: ["purchases", "purchase"],
      expenses: ["expenses", "expense"],
      purchase_bills: ["purchase_bills", "purchaseBills", "bills"],
      documents: ["documents", "storeDocuments", "papers"]
    }[dataType] || [dataType];
    const matchedRows = pickArray(payload, aliases);
    if (matchedRows) {
      return { [dataType]: matchedRows };
    }
    const looksLikeSingleRow = payload && typeof payload === "object" && Object.values(payload).some((value) => value === null || ["string", "number", "boolean"].includes(typeof value));
    return { [dataType]: looksLikeSingleRow ? [payload] : [] };
  }
  return {
    inventory: pickArray(payload, ["inventory", "items", "products", "inventorydata", "stock"]) || [],
    customers: pickArray(payload, ["customers", "parties", "customerdata"]) || [],
    invoices: pickArray(payload, ["invoices", "invoice", "bills", "sales", "invoicedata", "salesregister"]) || [],
    purchases: pickArray(payload, ["purchases", "purchase"]) || [],
    expenses: pickArray(payload, ["expenses", "expense"]) || [],
    purchase_bills: pickArray(payload, ["purchase_bills", "purchaseBills", "bills"]) || [],
    documents: pickArray(payload, ["documents", "storeDocuments", "papers"]) || []
  };
}

export function normalizeInventoryImport(row, index = 0) {
  const itemName = cleanText(valueFrom(row, ["itemName", "item_name", "productName", "product_name", "itemDescription", "description", "name"]));
  const sourceItemId = cleanText(valueFrom(row, ["itemId", "item_id", "productId", "product_id", "sourceItemId"]));
  const sourceItemCode = cleanText(valueFrom(row, ["itemCode", "item_code", "productCode", "product_code", "sku", "sourceItemCode"]));
  const barcodes = collectImportBarcodes(row);
  const hasStockValue = hasValueFrom(row, ["stock", "stockCount", "quantity", "qty", "currentStock", "openingStock", "closingStock", "availableStock", "qtyInHand"]);
  const hasMrpValue = hasValueFrom(row, ["mrp", "maximumRetailPrice", "listPrice", "mrpRate"]);
  const hasInclusivePriceValue = hasValueFrom(row, ["inclusivePrice", "inclusive_price", "sellingPrice", "selling_price", "salePrice", "salesPrice", "sales_price", "salesRate", "saleRate", "sellingRate", "price", "rate", "retailPrice"]);
  const hasGstRateValue = hasValueFrom(row, ["gstRate", "gst_rate", "gst", "taxPercent", "tax", "taxRate"]);
  const hasCategoryValue = hasValueFrom(row, ["category", "group", "department"]);
  const hasHsnValue = hasValueFrom(row, ["hsn", "hsnSac", "hsn_sac", "sac"]);
  const hasUnitValue = hasValueFrom(row, ["unit", "uom", "baseUnit"]);
  const hasManufacturingDateValue = hasValueFrom(row, ["manufacturingDate", "manufacturing_date", "mfgDate", "mfg_date"]);
  const hasExpiryDateValue = hasValueFrom(row, ["expiryDate", "expiry_date", "expDate", "exp_date"]);
  const inclusivePrice = numberFrom(row, ["inclusivePrice", "inclusive_price", "sellingPrice", "selling_price", "salePrice", "salesPrice", "sales_price", "salesRate", "saleRate", "sellingRate", "price", "rate", "retailPrice"], 0);
  const mrp = numberFrom(row, ["mrp", "maximumRetailPrice", "listPrice", "mrpRate"], inclusivePrice);
  const gstRate = numberFrom(row, ["gstRate", "gst_rate", "gst", "taxPercent", "tax", "taxRate"], 0);
  const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
  return {
    id: `import-${Date.now()}-${index}`,
    itemName,
    sourceItemId,
    sourceItemCode,
    barcode: barcodes[0] || "",
    barcodes,
    category: cleanText(valueFrom(row, ["category", "group", "department"])),
    hsn: cleanText(valueFrom(row, ["hsn", "hsnSac", "hsn_sac", "sac"])),
    manufacturingDate: normalizeImportDate(valueFrom(row, ["manufacturingDate", "manufacturing_date", "mfgDate", "mfg_date"]), ""),
    expiryDate: normalizeImportDate(valueFrom(row, ["expiryDate", "expiry_date", "expDate", "exp_date"]), ""),
    stock: numberFrom(row, ["stock", "stockCount", "quantity", "qty", "currentStock", "openingStock", "closingStock", "availableStock", "qtyInHand"], 0),
    unit: cleanText(valueFrom(row, ["unit", "uom", "baseUnit"], "pcs")),
    mrp,
    inclusivePrice,
    discountPercent: calculateDiscountPercent(mrp, inclusivePrice),
    gstRate,
    taxableValue: Number(breakup.taxableValue.toFixed(2)),
    cgst: Number(breakup.cgst.toFixed(2)),
    sgst: Number(breakup.sgst.toFixed(2)),
    gstAmount: Number(breakup.gstAmount.toFixed(2)),
    hasStockValue,
    hasMrpValue,
    hasInclusivePriceValue,
    hasGstRateValue,
    hasCategoryValue,
    hasHsnValue,
    hasUnitValue,
    hasManufacturingDateValue,
    hasExpiryDateValue,
    createdAt: todayISO()
  };
}

export function normalizeCustomerImport(row) {
  return {
    name: cleanText(valueFrom(row, ["name", "customerName", "customer_name", "partyName", "party", "customer", "ledgerName"])),
    email: cleanText(valueFrom(row, ["email", "emailAddress", "emailId", "partyEmail"])),
    address: cleanText(valueFrom(row, ["address", "customerAddress", "customer_address", "partyAddress", "billingAddress", "shippingAddress"])),
    phone: cleanText(valueFrom(row, ["phone", "mobile", "contact", "phoneNumber", "customerPhone", "customer_phone", "mobileNumber", "mobileNo", "phoneNo", "partyPhone", "partyMobile", "whatsapp"]))
  };
}

export function normalizeInvoiceImport(row) {
  return {
    customerId: cleanText(valueFrom(row, ["customerId", "customer_id"])),
    customerName: cleanText(valueFrom(row, ["customerName", "customer_name", "customer", "partyName", "party", "name", "ledgerName"])),
    customerPhone: cleanText(valueFrom(row, ["customerPhone", "customer_phone", "phone", "mobile", "contact", "phoneNo", "mobileNo", "partyMobile"])),
    customerEmail: cleanText(valueFrom(row, ["customerEmail", "customer_email", "email", "emailId"])),
    customerAddress: cleanText(valueFrom(row, ["customerAddress", "customer_address", "address", "partyAddress", "billingAddress", "shippingAddress"])),
    invoiceNumber: cleanText(valueFrom(row, ["invoiceNumber", "invoice_number", "billNumber", "bill_number", "number", "voucherNumber", "referenceNo"])),
    amount: numberFrom(row, ["amount", "total", "invoiceAmount", "invoice_amount", "billAmount", "grandTotal", "invoiceValue", "voucherAmount", "netAmount"], 0),
    totalPaid: numberFrom(row, ["totalPaid", "total_paid", "paid", "paidAmount", "paid_amount", "received", "receivedAmount"], 0),
    issuedOn: normalizeImportDate(valueFrom(row, ["issuedOn", "issued_on", "date", "invoiceDate", "billDate", "voucherDate"]), todayISO()),
    dueOn: normalizeImportDate(valueFrom(row, ["dueOn", "due_on", "dueDate", "due_date", "dueOnDate"]), todayISO()),
    notes: cleanText(valueFrom(row, ["notes", "remarks", "description"], "Imported invoice"))
  };
}

export function normalizePurchaseImport(row, index = 0) {
  return {
    id: `import-${Date.now()}-${index}`,
    supplier: cleanText(valueFrom(row, ["supplier", "supplierName", "vendor", "partyName"], "Imported Supplier")),
    item: cleanText(valueFrom(row, ["item", "itemName", "product", "material"], "Imported Item")),
    billNumber: cleanText(valueFrom(row, ["billNumber", "bill_number", "invoiceNumber", "voucherNumber"])),
    purchaseDate: normalizeImportDate(valueFrom(row, ["purchaseDate", "purchase_date", "date", "billDate"]), todayISO()),
    amount: numberFrom(row, ["amount", "total", "billAmount", "purchaseAmount"], 0),
    paymentStatus: cleanText(valueFrom(row, ["paymentStatus", "status"], "Pending")),
    notes: cleanText(valueFrom(row, ["notes", "remarks"])),
    createdAt: new Date().toISOString()
  };
}

export function normalizeExpenseImport(row, index = 0) {
  return {
    id: `import-${Date.now()}-${index}`,
    category: cleanText(valueFrom(row, ["category", "expenseCategory", "type"], "Other")),
    paidTo: cleanText(valueFrom(row, ["paidTo", "paid_to", "vendor", "partyName"])),
    expenseDate: normalizeImportDate(valueFrom(row, ["expenseDate", "expense_date", "date"]), todayISO()),
    amount: numberFrom(row, ["amount", "total", "expenseAmount"], 0),
    paymentMode: cleanText(valueFrom(row, ["paymentMode", "payment_mode", "method"], "Cash")),
    notes: cleanText(valueFrom(row, ["notes", "remarks"])),
    createdAt: new Date().toISOString()
  };
}

export function summarizeInventoryImport(item) {
  return [item.barcodes.join(", "), item.stock ? `Stock ${item.stock}` : "", item.inclusivePrice ? currency(item.inclusivePrice) : ""]
    .filter(Boolean)
    .join(" | ") || "No barcode";
}

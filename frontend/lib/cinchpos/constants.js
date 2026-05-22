export const APP_NAME = "CinchPOS";
export const APP_COMPANY = "CinchLive Technologies Pvt. Ltd.";
export const DEFAULT_STORE_NAME = "Store Name";
export const CINCHPOS_LOGO_SRC = "/brand/cinchpos-logo.png";

export const defaultSettings = {
  appearance: "system",
  density: "comfortable",
  deviceType: "desktop",
  businessName: DEFAULT_STORE_NAME,
  ownerName: "Billing Workspace",
  businessPhone: "",
  businessEmail: "",
  businessAddress: "",
  gstin: "",
  storeLogo: "",
  storeLogoUrl: "",
  logoName: "",
  invoicePrefix: "INV",
  defaultDueDays: "0",
  invoiceNotes: "",
  startupView: "dashboardView",
  printPaperSize: "80mm",
  printFooter: "Thank you for shopping with us.",
  printShopLogoOnBill: false,
  autoPrintAfterBilling: false,
  showPreviewWatermark: true
};

export const defaultAccount = {
  loggedIn: false,
  name: "",
  contact: ""
};

export const storageKeys = {
  settings: "cinchPOSSettings",
  account: "cinchPOSAccount",
  inventory: "cinchPOSInventory",
  bank: "cinchPOSBankAccount",
  purchases: "cinchPOSPurchases",
  expenses: "cinchPOSExpenses",
  purchaseBills: "cinchPOSPurchaseBills",
  documents: "cinchPOSStoreDocuments",
  employees: "cinchPOSEmployees",
  pos: "cinchPOSReactPOSState",
  trendView: "billingTrendView",
  trendStart: "billingTrendStartDate",
  trendEnd: "billingTrendEndDate"
};

export const appViews = [
  { id: "dashboardView", title: "Dashboard", icon: "dashboard" },
  { id: "cinchPOSView", title: "CinchPOS", icon: "pos", billing: true },
  { id: "invoicesView", title: "Invoices", icon: "invoice" },
  { id: "customerInfoView", title: "Customer Info", icon: "customer" },
  { id: "inventoryView", title: "Inventory", icon: "inventory" },
  { id: "purchaseView", title: "Purchase", icon: "purchase" },
  { id: "expensesView", title: "Expenses", icon: "expenses" },
  { id: "salesReportView", title: "Sales Report", icon: "report" },
  { id: "employeeView", title: "Manage Employee", icon: "employee" },
  { id: "bankView", title: "Your Bank", icon: "bank" },
  { id: "documentsView", title: "Store Documents", icon: "documents" },
  { id: "dataTransferView", title: "Retrieve Data", icon: "transfer" }
];

export const routeViewMap = {
  dashboard: "dashboardView",
  pos: "cinchPOSView",
  invoices: "invoicesView",
  customers: "customerInfoView",
  inventory: "inventoryView",
  purchase: "purchaseView",
  expenses: "expensesView",
  sales: "salesReportView",
  employee: "employeeView",
  bank: "bankView",
  documents: "documentsView",
  transfer: "dataTransferView"
};

export const defaultPOSCustomer = {
  phone: "",
  name: "",
  customerId: "",
  paymentMethod: "Cash",
  paymentType: "full",
  partialAmount: ""
};

export const dataTransferConfigs = [
  {
    type: "customers",
    title: "Customer Data",
    subtitle: "Bring names, phone numbers, and email addresses into Customer Info.",
    targetLabel: "Customer Info",
    destinationHelp: "CinchPOS adds new customer records here and updates matching customer phone or email details when the import file includes them.",
    placeholder: "Paste customer export rows here.",
    acceptedFields: ["Customer Name", "Phone", "Mobile", "Email", "Party Name", "Contact"],
    smartNotes: [
      "Duplicate customers are matched first by phone number, then by exact name.",
      "CSV, XLSX, JSON, XML, semicolon-separated, and tab-separated exports are accepted.",
      "Review Import shows what will be created and what is already present."
    ]
  },
  {
    type: "inventory",
    title: "Inventory Data",
    subtitle: "Bring products, multiple barcodes, stock, MRP, selling price, and GST into Inventory.",
    targetLabel: "Inventory",
    destinationHelp: "CinchPOS adds new items here and updates matching inventory stock, price, GST, barcode, and item details by barcode or item name.",
    placeholder: "Paste inventory export rows here.",
    acceptedFields: ["Item Name", "Barcode", "Barcode 2", "Stock", "MRP", "Selling Price", "GST", "HSN"],
    smartNotes: [
      "If an imported barcode already exists, the item is updated instead of creating a duplicate.",
      "Multiple barcode columns are combined automatically into one item.",
      "Stock, price, GST, and barcode details are preserved wherever the import file provides them, including Tally-style XML and XLSX exports."
    ]
  },
  {
    type: "invoices",
    title: "Invoice Data",
    subtitle: "Bring old invoices into Invoices. Missing customers are created only when needed.",
    targetLabel: "Invoices",
    destinationHelp: "CinchPOS creates imported invoices here, records paid or part-paid amounts from the file, and creates missing customers only when required.",
    placeholder: "Paste invoice export rows here.",
    acceptedFields: ["Invoice Number", "Customer Name", "Phone", "Amount", "Paid", "Invoice Date", "Due Date"],
    smartNotes: [
      "Paid and partial-paid invoices both record their payment during import.",
      "If an invoice number already exists, CinchPOS creates a safe imported number automatically.",
      "Customer matching happens before creating any new customer record."
    ]
  }
];

export function makeTransferDraftState() {
  return dataTransferConfigs.reduce((drafts, config) => {
    drafts[config.type] = {
      sourceProfile: "generic",
      sourceSoftware: "",
      transferText: "",
      preview: null,
      fileName: ""
    };
    return drafts;
  }, {});
}

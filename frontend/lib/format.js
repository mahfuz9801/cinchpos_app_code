export const currency = (value) => `Rs ${Number(value || 0).toFixed(2)}`;

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function statusClass(status = "") {
  const value = status.toLowerCase();
  if (value === "paid") {
    return "status-paid";
  }
  if (value === "overdue") {
    return "status-overdue";
  }
  return "status-pending";
}

export function cleanText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

export function phonesMatch(first, second) {
  const left = normalizePhone(first).slice(-10);
  const right = normalizePhone(second).slice(-10);
  return Boolean(left && right && left === right);
}

export function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function maskAccountNumber(value) {
  const accountNumber = String(value || "").replace(/\s+/g, "");
  if (!accountNumber) {
    return "Not added";
  }
  return accountNumber.length > 4 ? `**** ${accountNumber.slice(-4)}` : accountNumber;
}

export function formatIndianPhone(value) {
  const phone = normalizePhone(value).slice(-10);
  return phone ? `+91 ${phone.slice(0, 5)} ${phone.slice(5)}` : "+91";
}

export function formatDate(value) {
  return cleanText(value, "Not added");
}

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character] || character
  ));
}

export function invoicePaidAmount(invoice) {
  const explicitPaid = Number(invoice?.total_paid ?? invoice?.paid ?? invoice?.paid_amount);
  if (Number.isFinite(explicitPaid) && explicitPaid > 0) {
    return explicitPaid;
  }
  const amount = Number(invoice?.amount || 0);
  const outstanding = Number(invoice?.outstanding || 0);
  return Math.max(0, amount - outstanding);
}

export function invoiceOutstandingAmount(invoice) {
  const explicitOutstanding = Number(invoice?.outstanding);
  if (Number.isFinite(explicitOutstanding)) {
    return Math.max(0, explicitOutstanding);
  }
  return Math.max(0, Number(invoice?.amount || 0) - invoicePaidAmount(invoice));
}

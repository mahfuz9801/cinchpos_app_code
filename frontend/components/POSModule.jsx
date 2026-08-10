"use client";

import { useEffect, useMemo, useState } from "react";
import { createCustomer, createInvoice, recordPayment } from "@/lib/api";
import { cleanText, currency, normalizePhone, phonesMatch, todayISO } from "@/lib/format";
import {
  calculateDiscountPercent,
  getInventoryBarcodeLabel,
  getInventoryGSTBreakup,
  getInventoryItemBarcode,
  getInventoryItemBarcodes,
  getInventoryItemKey,
  getInventoryItemName,
  readInventoryItems
} from "@/lib/inventory";

const emptyCustomer = {
  customer_phone: "",
  customer_name: "",
  customer_id: "",
  payment_method: "Cash",
  payment_type: "full",
  partial_amount: "",
  item_name: ""
};

function makeBill(number) {
  return { id: `bill-${number}`, label: `Bill ${number}`, items: [] };
}

function getPOSBillSummary(items) {
  return items.reduce((summary, item) => {
    const quantity = Number(item.quantity || 1);
    const inclusivePrice = Number(item.inclusivePrice || 0);
    const taxableValue = Number(item.taxableValue || 0) * quantity;
    const gstAmount = Number(item.gstAmount || 0) * quantity;
    const total = inclusivePrice * quantity;
    return {
      taxableValue: summary.taxableValue + taxableValue,
      gstAmount: summary.gstAmount + gstAmount,
      total: summary.total + total,
      itemCount: summary.itemCount + quantity
    };
  }, { taxableValue: 0, gstAmount: 0, total: 0, itemCount: 0 });
}

function buildPOSLineItem(item, index) {
  const itemName = getInventoryItemName(item);
  const barcode = getInventoryItemBarcode(item);
  const inclusivePrice = Number(item.inclusivePrice || item.inclusive_price || item.price || 0);
  const mrp = Number(item.mrp || inclusivePrice || 0);
  const gstRate = Number(item.gstRate || item.gst_rate || item.gst || 0);
  const breakup = getInventoryGSTBreakup(inclusivePrice, gstRate);
  const savedDiscount = Number(item.discountPercent || item.discount_percent || item.discount || 0);

  return {
    id: getInventoryItemKey(item, index),
    itemName,
    barcode,
    quantity: 1,
    mrp,
    inclusivePrice,
    gstRate,
    taxableValue: breakup.taxableValue,
    gstAmount: breakup.gstAmount,
    discountPercent: savedDiscount || calculateDiscountPercent(mrp, inclusivePrice)
  };
}

function findInventoryMatches(items, query) {
  const search = cleanText(query).toLowerCase();
  if (!search) {
    return [];
  }

  return items.filter((item) => {
    const itemName = getInventoryItemName(item).toLowerCase();
    const barcodes = getInventoryItemBarcodes(item).map((barcode) => barcode.toLowerCase());
    return itemName.includes(search) || barcodes.some((barcode) => barcode.includes(search));
  });
}

function findExactInventoryItem(items, query) {
  const search = cleanText(query).toLowerCase();
  if (!search) {
    return null;
  }

  const barcodeMatch = items.find((item) => getInventoryItemBarcodes(item).some((barcode) => barcode.toLowerCase() === search));
  if (barcodeMatch) {
    return barcodeMatch;
  }

  return items.find((item) => getInventoryItemName(item).toLowerCase() === search) || null;
}

function POSBillTable({ items, summary, onQuantityChange, onPriceChange, onRemove }) {
  return (
    <>
      <div className="pos-preview-scroll">
        <table className="bill-preview-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Barcode</th>
              <th>Qty</th>
              <th>MRP</th>
              <th>Selling</th>
              <th>Discount</th>
              <th>GST</th>
              <th>Line Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map((item) => {
                const quantity = Number(item.quantity || 1);
                const lineTotal = Number(item.inclusivePrice || 0) * quantity;
                return (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.itemName}</strong>
                      <span>{item.gstRate}% GST</span>
                    </td>
                    <td>{item.barcode || "No barcode"}</td>
                    <td>
                      <input
                        className="line-edit-input qty-input"
                        type="number"
                        min="1"
                        step="1"
                        value={quantity}
                        onChange={(event) => onQuantityChange(item.id, event.target.value)}
                        aria-label={`Quantity for ${item.itemName}`}
                      />
                    </td>
                    <td>
                      <input
                        className="line-edit-input price-input"
                        type="number"
                        min="0"
                        step="0.01"
                        value={Number(item.mrp || 0)}
                        onChange={(event) => onPriceChange(item.id, "mrp", event.target.value)}
                        aria-label={`MRP for ${item.itemName}`}
                      />
                    </td>
                    <td>
                      <input
                        className="line-edit-input price-input"
                        type="number"
                        min="0"
                        step="0.01"
                        value={Number(item.inclusivePrice || 0)}
                        onChange={(event) => onPriceChange(item.id, "inclusivePrice", event.target.value)}
                        aria-label={`Selling price for ${item.itemName}`}
                      />
                    </td>
                    <td>{Number(item.discountPercent || 0).toFixed(2)}%</td>
                    <td>{currency(Number(item.gstAmount || 0) * quantity)}</td>
                    <td><strong>{currency(lineTotal)}</strong></td>
                    <td>
                      <button className="line-remove" type="button" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.itemName}`}>
                        &times;
                      </button>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan="9" className="bill-empty">Scan a barcode or search an inventory item to start billing.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="bill-summary-row">
        <span>Taxable <strong>{currency(summary.taxableValue)}</strong></span>
        <span>GST <strong>{currency(summary.gstAmount)}</strong></span>
        <span>Total <strong>{currency(summary.total)}</strong></span>
      </div>
    </>
  );
}

export default function POSModule({ customers = [], onRefresh, showMessage, onClose, embedded = false }) {
  const [localCustomers, setLocalCustomers] = useState(customers);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [form, setForm] = useState(emptyCustomer);
  const [bills, setBills] = useState([makeBill(1)]);
  const [activeBillId, setActiveBillId] = useState("bill-1");
  const [billCounter, setBillCounter] = useState(1);
  const [matches, setMatches] = useState([]);

  useEffect(() => {
    setLocalCustomers(customers);
  }, [customers]);

  useEffect(() => {
    setInventoryItems(readInventoryItems());
  }, []);

  const activeBill = bills.find((bill) => bill.id === activeBillId) || bills[0];
  const activeBillIndex = Math.max(0, bills.findIndex((bill) => bill.id === activeBill?.id));
  const activeBillDisplayLabel = `Bill ${activeBillIndex + 1}`;
  const items = activeBill?.items || [];
  const summary = useMemo(() => getPOSBillSummary(items), [items]);
  const paidAmount = form.payment_type === "partial"
    ? Math.min(summary.total, Math.max(0, Number(form.partial_amount || 0)))
    : summary.total;
  const unpaidAmount = Math.max(0, summary.total - paidAmount);

  function updateForm(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function handlePhoneChange(value) {
    const phone = normalizePhone(value).slice(-10);
    const matchedCustomer = localCustomers.find((customer) => phonesMatch(customer.phone, phone));
    setForm((current) => ({
      ...current,
      customer_phone: phone,
      customer_name: phone.length === 10 && matchedCustomer ? matchedCustomer.name : current.customer_name,
      customer_id: phone.length === 10 && matchedCustomer ? String(matchedCustomer.id) : ""
    }));
  }

  function customerStatus() {
    const phone = normalizePhone(form.customer_phone).slice(-10);
    if (phone.length < 10) {
      return "Enter a 10 digit Indian customer phone number.";
    }
    const matchedCustomer = localCustomers.find((customer) => phonesMatch(customer.phone, phone));
    if (matchedCustomer) {
      return `Registered customer found: ${matchedCustomer.name}.`;
    }
    return "New customer. Enter the name once and CinchPOS will save it during billing.";
  }

  function setActiveItems(updater) {
    setBills((currentBills) => currentBills.map((bill) => {
      if (bill.id !== activeBillId) {
        return bill;
      }
      const nextItems = typeof updater === "function" ? updater(bill.items) : updater;
      return { ...bill, items: nextItems };
    }));
  }

  function handleItemSearch(value) {
    updateForm("item_name", value);
    const exact = findExactInventoryItem(inventoryItems, value);
    if (exact) {
      setMatches([exact]);
      return;
    }
    setMatches(findInventoryMatches(inventoryItems, value).slice(0, 8));
  }

  function addItemToBill(item = null) {
    const matchedItem = item || findExactInventoryItem(inventoryItems, form.item_name) || matches[0];
    if (!matchedItem) {
      showMessage("Search an inventory item by name or barcode before adding it to the bill.");
      return;
    }

    const index = inventoryItems.indexOf(matchedItem);
    const lineItem = buildPOSLineItem(matchedItem, index);
    setActiveItems((currentItems) => {
      const existing = currentItems.find((current) => current.id === lineItem.id);
      if (existing) {
        return currentItems.map((current) => current.id === lineItem.id ? { ...current, quantity: Number(current.quantity || 1) + 1 } : current);
      }
      return [...currentItems, lineItem];
    });
    setForm((current) => ({ ...current, item_name: "" }));
    setMatches([]);
  }

  function updateQuantity(itemId, quantity) {
    const nextQuantity = Math.max(1, Number(quantity || 1));
    setActiveItems((currentItems) => currentItems.map((item) => item.id === itemId ? { ...item, quantity: nextQuantity } : item));
  }

  function updatePrice(itemId, field, value) {
    const amount = Math.max(0, Number(value || 0));
    setActiveItems((currentItems) => currentItems.map((item) => {
      if (item.id !== itemId) {
        return item;
      }
      const next = { ...item, [field]: amount };
      const breakup = getInventoryGSTBreakup(next.inclusivePrice, next.gstRate);
      next.taxableValue = breakup.taxableValue;
      next.gstAmount = breakup.gstAmount;
      next.discountPercent = calculateDiscountPercent(next.mrp, next.inclusivePrice);
      return next;
    }));
  }

  function removeItem(itemId) {
    setActiveItems((currentItems) => currentItems.filter((item) => item.id !== itemId));
  }

  function createNewBill() {
    const nextNumber = billCounter + 1;
    const nextBill = makeBill(nextNumber);
    setBillCounter(nextNumber);
    setBills((currentBills) => [...currentBills, nextBill]);
    setActiveBillId(nextBill.id);
    setForm(emptyCustomer);
    setMatches([]);
  }

  function resetActiveBill() {
    setActiveItems([]);
    setForm(emptyCustomer);
    setMatches([]);
  }

  async function ensurePOSCustomer() {
    const phone = normalizePhone(form.customer_phone).slice(-10);
    const name = cleanText(form.customer_name);
    const existingCustomer = localCustomers.find((customer) => phonesMatch(customer.phone, phone));
    if (existingCustomer) {
      return existingCustomer.id;
    }
    if (phone.length !== 10) {
      throw new Error("Enter a valid 10 digit Indian customer phone number.");
    }
    if (!name) {
      throw new Error("Enter the customer name before POS billing.");
    }

    const customer = await createCustomer({ name, email: "", phone });
    setLocalCustomers((current) => [...current, customer].sort((first, second) => first.name.localeCompare(second.name)));
    return customer.id;
  }

  function printPOSBill(invoice) {
    const targetWindow = window.open("", "_blank", "width=420,height=720");
    if (!targetWindow) {
      return;
    }

    const rows = items.map((item) => `
      <tr>
        <td>${item.itemName}</td>
        <td>${item.quantity}</td>
        <td>${currency(item.inclusivePrice)}</td>
        <td>${currency(Number(item.inclusivePrice || 0) * Number(item.quantity || 1))}</td>
      </tr>
    `).join("");

    targetWindow.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>${invoice.invoice_number || "CinchPOS Bill"}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
            h1 { font-size: 20px; margin: 0 0 8px; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            th, td { border-bottom: 1px solid #ddd; padding: 8px 0; text-align: left; font-size: 13px; }
            .total { margin-top: 16px; font-size: 18px; font-weight: 700; text-align: right; }
          </style>
        </head>
        <body>
          <h1>CinchPOS</h1>
          <p>Bill: ${invoice.invoice_number}</p>
          <p>Customer: ${cleanText(form.customer_name, "Walk-in Customer")} ${form.customer_phone ? `(+91 ${form.customer_phone})` : ""}</p>
          <table>
            <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="total">Grand Total ${currency(summary.total)}</div>
        </body>
      </html>
    `);
    targetWindow.document.close();
    targetWindow.focus();
    targetWindow.print();
  }

  async function submitBilling(print = false) {
    if (!items.length) {
      showMessage("Add at least one inventory item to the bill.");
      return;
    }
    if (summary.total <= 0) {
      showMessage("Bill total must be greater than zero.");
      return;
    }

    try {
      const customerId = await ensurePOSCustomer();
      const invoice = await createInvoice({
        customer_id: customerId,
        amount: summary.total,
        issued_on: todayISO(),
        due_on: todayISO(),
        notes: `POS billing: ${items.length} item(s). Paid via ${form.payment_method}.`
      });

      if (paidAmount > 0) {
        await recordPayment({
          invoice_id: invoice.id,
          amount: paidAmount,
          paid_on: todayISO(),
          method: form.payment_method,
          notes: "POS payment"
        });
      }

      if (print) {
        printPOSBill(invoice);
      }

      resetActiveBill();
      await onRefresh?.();
      onClose?.();
      showMessage(unpaidAmount > 0 ? `POS billing completed. Unpaid amount: ${currency(unpaidAmount)}.` : "POS billing completed.");
    } catch (error) {
      showMessage(error.message);
    }
  }

  const content = (
    <>
      <form className="workspace-form" onSubmit={(event) => {
        event.preventDefault();
        submitBilling(false);
      }}>
        <div className="pos-workstation">
          <div className="pos-left-rail">
            <section className="pos-section pos-customer-compact">
              <h3>Customer Info</h3>
              <div className="pos-customer-grid">
                <label>
                  Phone
                  <span className="phone-input">
                    <span className="country-code">+91</span>
                    <input name="customer_phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength="14" pattern="[0-9]{10}" placeholder="10 digit number" required value={form.customer_phone} onChange={(event) => handlePhoneChange(event.target.value)} />
                  </span>
                </label>
                <label>
                  Name
                  <input name="customer_name" type="text" autoComplete="name" placeholder="Required for new customer" required value={form.customer_name} onChange={(event) => updateForm("customer_name", event.target.value)} />
                </label>
                <label>
                  Payment Mode
                  <select name="payment_method" value={form.payment_method} onChange={(event) => updateForm("payment_method", event.target.value)}>
                    <option>Cash</option>
                    <option>UPI</option>
                    <option>Card</option>
                    <option>Bank Transfer</option>
                  </select>
                </label>
                <label>
                  Payment Type
                  <select name="payment_type" value={form.payment_type} onChange={(event) => updateForm("payment_type", event.target.value)}>
                    <option value="full">Full Payment</option>
                    <option value="partial">Partial Payment</option>
                  </select>
                </label>
                {form.payment_type === "partial" ? (
                  <label className="partial-payment-field">
                    Amount Paid
                    <input name="partial_amount" type="number" min="0" step="0.01" placeholder="0.00" value={form.partial_amount} onChange={(event) => updateForm("partial_amount", event.target.value)} />
                  </label>
                ) : null}
              </div>
              <div className="pos-payment-summary">Unpaid: {currency(unpaidAmount)}</div>
              <p className={`pos-helper ${form.customer_id ? "found" : ""}`}>{customerStatus()}</p>
            </section>
            <div className="virtual-keyboard" aria-label="Virtual keyboard">
              {["123", "456", "789", "0"].map((row) => (
                <div className="keyboard-row" key={row}>
                  {row.split("").map((key) => (
                    <button type="button" key={key} onClick={() => handlePhoneChange(`${form.customer_phone}${key}`)}>{key}</button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="pos-billing-main">
            <section className="pos-section pos-billing-section">
              <div className="pos-section-head">
                <h3>Start Billing</h3>
                <div className="pos-bill-actions">
                  <button type="button" className="button button-secondary" onClick={createNewBill}>Create New Bill</button>
                  {!embedded ? <button type="submit" className="button button-primary">Complete Billing</button> : null}
                  {!embedded ? <button type="button" className="button button-primary" onClick={() => submitBilling(true)}>Save & Print Bill</button> : null}
                </div>
              </div>
              <div className="pos-item-entry">
                <label>
                  Search Item
                  <input name="item_name" type="text" list="posInventorySuggestions" autoComplete="off" placeholder="Scan barcode or search item name" value={form.item_name} onChange={(event) => handleItemSearch(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addItemToBill();
                    }
                  }} />
                </label>
                <button type="button" className="button button-secondary" onClick={() => addItemToBill()}>Add Item</button>
              </div>
              <div className="pos-match-list" hidden={!matches.length}>
                <div className="pos-match-title">Choose the product to add</div>
                <div className="pos-match-grid">
                  {matches.map((item, index) => (
                    <button key={getInventoryItemKey(item, index)} type="button" className="pos-match-card" onClick={() => addItemToBill(item)}>
                      <span>{getInventoryItemName(item)}</span>
                      <small>{currency(item.inclusivePrice || item.inclusive_price || item.price)}</small>
                      <em>{getInventoryBarcodeLabel(item)}</em>
                    </button>
                  ))}
                </div>
              </div>
              <div className="pos-bill-tabs" aria-label="Open bills">
                {bills.map((bill, billIndex) => {
                  const billSummary = getPOSBillSummary(bill.items);
                  const billDisplayLabel = `Bill ${billIndex + 1}`;
                  return (
                    <button key={bill.id} type="button" className={`bill-tab ${bill.id === activeBillId ? "active" : ""}`} onClick={() => setActiveBillId(bill.id)}>
                      {billDisplayLabel} <span>{currency(billSummary.total)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="pos-preview-panel" aria-label="Bill preview">
              <div className="pos-preview-head">
                <div>
                  <h3>Bill Preview</h3>
                  <p className="pos-helper">{activeBillDisplayLabel} is ready.</p>
                </div>
                <div className="pos-total">
                  <span>Grand Total</span>
                  <strong>{currency(summary.total)}</strong>
                </div>
              </div>
              <POSBillTable
                items={items}
                summary={summary}
                onQuantityChange={updateQuantity}
                onPriceChange={updatePrice}
                onRemove={removeItem}
              />
            </section>
          </div>
        </div>
        {embedded ? (
          <div className="modal-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="button button-primary">Complete Billing</button>
            <button type="button" className="button button-primary" onClick={() => submitBilling(true)}>Save & Print Bill</button>
          </div>
        ) : null}
      </form>
      <datalist id="posInventorySuggestions">
        {inventoryItems.flatMap((item, index) => {
          const name = getInventoryItemName(item);
          const barcodes = getInventoryItemBarcodes(item);
          return [
            <option key={`${index}-name`} value={name}>{currency(item.inclusivePrice || item.inclusive_price || item.price)}</option>,
            ...barcodes.map((barcode) => <option key={`${index}-${barcode}`} value={barcode}>{name}</option>)
          ];
        })}
      </datalist>
    </>
  );

  if (embedded) {
    return content;
  }

  return (
    <section id="cinchPOSView" className="app-view active" data-title="CinchPOS">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>CinchPOS</h2>
          </div>
        </div>
        {content}
      </section>
    </section>
  );
}

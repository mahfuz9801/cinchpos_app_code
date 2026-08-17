"use client";

import { useEffect, useMemo, useState } from "react";
import { currency, formatDate } from "@/lib/format";
import {
  calculateDiscountPercent,
  getInventoryBarcodeLabel,
  getInventoryGSTBreakup,
  getInventoryItemName,
  readInventoryItems,
  normalizeInventoryBarcodes,
  writeInventoryItems
} from "@/lib/inventory";

const emptyForm = {
  item_name: "",
  barcode: "",
  category: "",
  hsn: "",
  manufacturing_date: "",
  expiry_date: "",
  stock: "1",
  stock_adjustment: "1",
  unit: "pcs",
  mrp: "",
  inclusive_price: "",
  discount_percent: "",
  gst_rate: "18"
};

export default function InventoryModule({ showMessage }) {
  const [form, setForm] = useState(emptyForm);
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [stockAdjustments, setStockAdjustments] = useState({});

  useEffect(() => {
    setItems(readInventoryItems());
  }, []);

  const discountPercent = calculateDiscountPercent(form.mrp, form.inclusive_price);
  const gst = getInventoryGSTBreakup(form.inclusive_price, form.gst_rate);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return items;
    }
    return items.filter((item) => {
      const name = getInventoryItemName(item).toLowerCase();
      const barcode = getInventoryBarcodeLabel(item).toLowerCase();
      return name.includes(query) || barcode.includes(query);
    });
  }, [items, search]);

  function updateField(name, value) {
    setForm((current) => {
      const next = { ...current, [name]: value };
      if (name === "mrp" || name === "inclusive_price") {
        next.discount_percent = calculateDiscountPercent(next.mrp, next.inclusive_price).toFixed(2);
      }
      return next;
    });
  }

  function changeDraftStock(delta) {
    const adjustment = Math.max(1, Math.round(Number(form.stock_adjustment || 0) || 0));
    updateField("stock", String(Math.max(0, Number(form.stock || 0) + (delta * adjustment))));
  }

  function changeItemStock(item, delta) {
    const targetId = String(item.id || "");
    const nextItems = items.map((entry) => (
      String(entry.id || "") === targetId
        ? { ...entry, stock: Math.max(0, Number(entry.stock || 0) + delta) }
        : entry
    ));
    setItems(nextItems);
    writeInventoryItems(nextItems);
  }

  function handleSubmit(event) {
    event.preventDefault();
    const itemName = form.item_name.trim();
    const nextMrp = Number(form.mrp || 0);
    const nextInclusivePrice = Number(form.inclusive_price || 0);
    const barcodes = normalizeInventoryBarcodes(form.barcode);
    if (!itemName || nextMrp <= 0 || nextInclusivePrice <= 0) {
      showMessage("Add item name, MRP, and selling price greater than zero. Barcode is optional.");
      return;
    }
    if (nextInclusivePrice > nextMrp) {
      showMessage("Selling price should not be higher than MRP.");
      return;
    }

    const nextItem = {
      id: `${Date.now()}`,
      itemName,
      barcode: barcodes[0] || "",
      barcodes,
      category: form.category.trim(),
      hsn: form.hsn.trim(),
      manufacturingDate: form.manufacturing_date || "",
      expiryDate: form.expiry_date || "",
      stock: Number(form.stock || 0),
      unit: form.unit,
      mrp: nextMrp,
      inclusivePrice: nextInclusivePrice,
      gstRate: Number(form.gst_rate || 0),
      discountPercent,
      taxableValue: gst.taxableValue,
      gstAmount: gst.gstAmount,
      createdAt: new Date().toISOString()
    };

    const nextItems = [nextItem, ...items];
    setItems(nextItems);
    writeInventoryItems(nextItems);
    setForm(emptyForm);
    showMessage("Inventory item added.");
  }

  return (
    <section id="inventoryView" className="app-view active" data-title="Inventory">
      <div className="inventory-workspace">
        <section className="panel inventory-editor-panel">
          <div className="panel-header">
            <div>
              <h2>Inventory</h2>
              <div className="panel-subtitle">Prices are inclusive of GST. CGST and SGST split equally for intra-state sales.</div>
            </div>
          </div>
          <form className="inventory-form" onSubmit={handleSubmit}>
            <section className="inventory-form-section">
              <h3>Item Description</h3>
              <div className="inventory-grid">
                <label>
                  Item Name
                  <input name="item_name" type="text" placeholder="Product name" required value={form.item_name} onChange={(event) => updateField("item_name", event.target.value)} />
                </label>
                <label>
                  Category
                  <input name="category" type="text" placeholder="Grocery, dairy, medicine" value={form.category} onChange={(event) => updateField("category", event.target.value)} />
                </label>
                <label>
                  HSN/SAC
                  <input name="hsn" type="text" placeholder="Optional" value={form.hsn} onChange={(event) => updateField("hsn", event.target.value)} />
                </label>
                <label>
                  Manufacturing Date
                  <input name="manufacturing_date" type="date" value={form.manufacturing_date} onChange={(event) => updateField("manufacturing_date", event.target.value)} />
                </label>
                <label>
                  Expiry Date
                  <input name="expiry_date" type="date" value={form.expiry_date} onChange={(event) => updateField("expiry_date", event.target.value)} />
                </label>
              </div>
              <div className="barcode-entry-list barcode-entry-list-single">
                <div className="barcode-entry barcode-entry-single">
                  <label>
                    Barcodes
                    <input name="barcode" type="text" inputMode="numeric" placeholder="Optional. Separate multiple barcodes with space" value={form.barcode} onChange={(event) => updateField("barcode", event.target.value)} />
                  </label>
                </div>
              </div>
            </section>

            <section className="inventory-form-section">
              <h3>Stock Count</h3>
              <div className="inventory-stock-grid">
                <label className="stock-count-field">
                  Stock Count
                  <input name="stock" type="number" min="0" step="1" required value={form.stock} onChange={(event) => updateField("stock", event.target.value)} />
                </label>
                <div className="stock-current-display" aria-live="polite">
                  <span>Current stock</span>
                  <strong>{Number(form.stock || 0)} {form.unit || "pcs"}</strong>
                </div>
                <label>
                  Unit
                  <select name="unit" value={form.unit} onChange={(event) => updateField("unit", event.target.value)}>
                    <option value="pcs">Pieces</option>
                    <option value="kg">Kilogram</option>
                    <option value="g">Gram</option>
                    <option value="l">Litre</option>
                    <option value="ml">Millilitre</option>
                    <option value="box">Box</option>
                    <option value="pack">Pack</option>
                  </select>
                </label>
                <label className="stock-adjustment-field">
                  Adjust By
                  <input name="stock_adjustment" type="number" min="1" step="1" value={form.stock_adjustment} onChange={(event) => updateField("stock_adjustment", event.target.value)} />
                </label>
                <div className="stock-adjustment-actions">
                  <button type="button" className="button button-secondary" onClick={() => changeDraftStock(-1)}>Subtract Stock</button>
                  <button type="button" className="button button-secondary" onClick={() => changeDraftStock(1)}>Add Stock</button>
                </div>
              </div>
            </section>

            <section className="inventory-form-section">
              <h3>Pricing Details</h3>
              <div className="inventory-pricing-grid">
                <label>
                  MRP
                  <input name="mrp" type="number" min="0.01" step="0.01" placeholder="0.00" required value={form.mrp} onChange={(event) => updateField("mrp", event.target.value)} />
                </label>
                <label>
                  Selling Price (Incl. GST)
                  <input name="inclusive_price" type="number" min="0.01" step="0.01" placeholder="0.00" required value={form.inclusive_price} onChange={(event) => updateField("inclusive_price", event.target.value)} />
                </label>
                <label>
                  Discount (%)
                  <input name="discount_percent" type="number" min="0" max="100" step="0.01" placeholder="Auto" readOnly value={discountPercent.toFixed(2)} />
                </label>
                <label>
                  GST Rate
                  <select name="gst_rate" value={form.gst_rate} onChange={(event) => updateField("gst_rate", event.target.value)}>
                    <option value="0">0% GST</option>
                    <option value="0.25">0.25% GST (0.125% CGST + 0.125% SGST)</option>
                    <option value="1.5">1.5% GST (0.75% CGST + 0.75% SGST)</option>
                    <option value="3">3% GST (1.5% CGST + 1.5% SGST)</option>
                    <option value="5">5% GST (2.5% CGST + 2.5% SGST)</option>
                    <option value="12">12% GST (6% CGST + 6% SGST)</option>
                    <option value="18">18% GST (9% CGST + 9% SGST)</option>
                    <option value="28">28% GST (14% CGST + 14% SGST)</option>
                  </select>
                </label>
              </div>
              <div className="gst-preview" aria-live="polite">
                <span>MRP <strong>{currency(form.mrp)}</strong></span>
                <span>Selling price <strong>{currency(form.inclusive_price)}</strong></span>
                <span>Discount <strong>{discountPercent.toFixed(2)}%</strong></span>
                <span>Taxable value <strong>{currency(gst.taxableValue)}</strong></span>
                <span>CGST <strong>{currency(gst.cgst)}</strong></span>
                <span>SGST <strong>{currency(gst.sgst)}</strong></span>
                <span>Total GST <strong>{currency(gst.gstAmount)}</strong></span>
              </div>
              <p className="settings-help">Select the GST rate applicable to the item/HSN or SAC. The app splits inclusive GST into CGST and SGST for intra-state billing.</p>
            </section>
            <div className="modal-actions">
              <button type="submit" className="button button-primary">Add Item</button>
            </div>
          </form>
        </section>

        <section className="panel inventory-list-panel">
          <div className="panel-header">
            <div>
              <h2>Inventory Items</h2>
              <div className="panel-subtitle">Saved locally in this app workspace.</div>
            </div>
          </div>
          <label className="inventory-search">
            Search Products
            <input type="search" placeholder="Search by item name or barcode" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="inventory-list">
            {filteredItems.length ? filteredItems.map((item, index) => {
              const itemGst = getInventoryGSTBreakup(item.inclusivePrice || item.inclusive_price, item.gstRate || item.gst_rate);
              const itemKey = item.id || `${item.itemName}-${index}`;
              const stockAdjustment = Math.max(1, Math.round(Number(stockAdjustments[itemKey] || 1) || 0));
              return (
                <article key={itemKey} className="inventory-item">
                  <div className="inventory-top">
                    <div>
                      <h3>{getInventoryItemName(item)}</h3>
                      <p className="inventory-meta">{item.category || "Uncategorized"} | HSN/SAC {item.hsn || "Not added"} | Mfg {item.manufacturingDate ? formatDate(item.manufacturingDate) : "Not added"} | Exp {item.expiryDate ? formatDate(item.expiryDate) : "Not added"}</p>
                      <div className="inventory-stock-control">
                        <div className="inventory-stock-summary">
                          <span>Current Stock</span>
                          <strong>{item.stock || 0} {item.unit || "pcs"}</strong>
                        </div>
                        <label className="inventory-stock-adjuster">
                          Adjust By
                          <input type="number" min="1" step="1" value={stockAdjustments[itemKey] || "1"} onChange={(event) => setStockAdjustments((current) => ({ ...current, [itemKey]: event.target.value }))} />
                        </label>
                        <div className="inventory-stock-control-buttons">
                          <button type="button" className="button button-secondary" onClick={() => changeItemStock(item, -stockAdjustment)}>Subtract</button>
                          <button type="button" className="button button-secondary" onClick={() => changeItemStock(item, stockAdjustment)}>Add</button>
                        </div>
                      </div>
                    </div>
                    <strong>{currency(item.inclusivePrice || item.inclusive_price)}</strong>
                  </div>
                  <div className="barcode-box">
                    <span className="barcode-lines" aria-hidden="true"></span>
                    <small>{getInventoryBarcodeLabel(item)}</small>
                  </div>
                  <div className="inventory-price-grid">
                    <span>MRP <strong>{currency(item.mrp)}</strong></span>
                    <span>Discount <strong>{Number(item.discountPercent || item.discount_percent || 0).toFixed(2)}%</strong></span>
                  </div>
                  <div className="gst-breakup">
                    <span>Taxable {currency(itemGst.taxableValue)}</span>
                    <span>CGST {currency(itemGst.cgst)}</span>
                    <span>SGST {currency(itemGst.sgst)}</span>
                  </div>
                </article>
              );
            }) : (
              <div className="module-empty">No inventory items saved yet.</div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

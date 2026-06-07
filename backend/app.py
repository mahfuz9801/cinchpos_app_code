import os
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, date, datetime, timedelta

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

VENDOR_PATH = os.path.join(os.path.dirname(__file__), "vendor")
if os.path.isdir(VENDOR_PATH) and VENDOR_PATH not in sys.path:
    sys.path.insert(0, VENDOR_PATH)

app = Flask(__name__)

DATABASE = os.getenv(
    "DATABASE_PATH",
    os.path.join(os.path.dirname(__file__), "database.db"),
)
SCHEMA_VERSION = "3"
DB_INDEX_STATEMENTS = (
    "CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_issued_on ON invoices(issued_on)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_due_on ON invoices(due_on)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)",
    "CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on)",
)


@app.before_request
def handle_cors_preflight():
    if request.method == "OPTIONS":
        return jsonify({}), 204


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = os.getenv("CORS_ORIGIN", "*")
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS, HEAD"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.errorhandler(HTTPException)
def handle_http_exception(error):
    return jsonify({"error": error.description}), error.code


@app.errorhandler(Exception)
def handle_unexpected_exception(error):
    if app.debug:
        raise error
    return jsonify({"error": "Unexpected server error."}), 500


def get_connection():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA temp_store = MEMORY")
    return connection


def ensure_column(table_name, column_name, definition):
    with closing(get_connection()) as conn:
        columns = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        if column_name not in {column["name"] for column in columns}:
            conn.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {column_name} {definition}"
            )
            conn.commit()


def set_app_meta(conn, key, value):
    updated = conn.execute(
        """
        UPDATE app_meta
        SET meta_value = ?, updated_at = CURRENT_TIMESTAMP
        WHERE meta_key = ?
        """,
        (str(value), key),
    )
    if updated.rowcount == 0:
        conn.execute(
            """
            INSERT INTO app_meta (meta_key, meta_value)
            VALUES (?, ?)
            """,
            (key, str(value)),
        )


def init_db():
    with closing(get_connection()) as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_meta (
                meta_key TEXT PRIMARY KEY,
                meta_value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT DEFAULT '',
                address TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS invoices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                invoice_number TEXT NOT NULL UNIQUE,
                amount REAL NOT NULL,
                total_paid REAL DEFAULT 0,
                status TEXT DEFAULT 'Pending',
                issued_on TEXT NOT NULL,
                due_on TEXT NOT NULL,
                notes TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES customers (id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                invoice_id INTEGER NOT NULL,
                customer_id INTEGER NOT NULL,
                amount REAL NOT NULL,
                method TEXT DEFAULT 'Bank Transfer',
                paid_on TEXT NOT NULL,
                notes TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (invoice_id) REFERENCES invoices (id),
                FOREIGN KEY (customer_id) REFERENCES customers (id)
            )
            """
        )
        for statement in DB_INDEX_STATEMENTS:
            conn.execute(statement)
        conn.commit()

    ensure_column("customers", "email", "TEXT DEFAULT ''")
    ensure_column("customers", "address", "TEXT DEFAULT ''")
    ensure_column("customers", "phone", "TEXT DEFAULT ''")
    ensure_column("invoices", "total_paid", "REAL DEFAULT 0")
    ensure_column("invoices", "status", "TEXT DEFAULT 'Pending'")
    ensure_column("invoices", "notes", "TEXT DEFAULT ''")
    ensure_column("payments", "method", "TEXT DEFAULT 'Bank Transfer'")
    ensure_column("payments", "notes", "TEXT DEFAULT ''")

    with closing(get_connection()) as conn:
        set_app_meta(conn, "schema_version", SCHEMA_VERSION)
        set_app_meta(conn, "schema_last_initialized_at", datetime.now(UTC).isoformat())
        conn.commit()


def parse_date(value, field_name):
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must use YYYY-MM-DD format.") from exc


def today_value():
    return date.today()


def format_money(value):
    return round(float(value or 0), 2)


def compute_invoice_status(amount, total_paid, due_on):
    outstanding = round(float(amount or 0) - float(total_paid or 0), 2)
    if outstanding <= 0:
        return "Paid"
    if parse_date(due_on, "due_on") < today_value():
        return "Overdue"
    return "Pending"


def serialize_customer(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"] or "",
        "address": row["address"] or "",
        "phone": row["phone"] or "",
        "created_at": row["created_at"],
    }


def serialize_invoice(row):
    amount = format_money(row["amount"])
    total_paid = format_money(row["total_paid"])
    outstanding = format_money(amount - total_paid)
    status = compute_invoice_status(amount, total_paid, row["due_on"])
    return {
        "id": row["id"],
        "invoice_number": row["invoice_number"],
        "customer_id": row["customer_id"],
        "customer_name": row["customer_name"],
        "amount": amount,
        "total_paid": total_paid,
        "outstanding": outstanding,
        "status": status,
        "issued_on": row["issued_on"],
        "due_on": row["due_on"],
        "notes": row["notes"] or "",
    }


def serialize_payment(row):
    return {
        "id": row["id"],
        "invoice_id": row["invoice_id"],
        "invoice_number": row["invoice_number"],
        "customer_id": row["customer_id"],
        "customer_name": row["customer_name"],
        "amount": format_money(row["amount"]),
        "method": row["method"] or "Bank Transfer",
        "paid_on": row["paid_on"],
        "notes": row["notes"] or "",
        "created_at": row["created_at"],
    }


def refresh_invoice_status(conn, invoice_id):
    row = conn.execute(
        "SELECT amount, total_paid, due_on FROM invoices WHERE id = ?",
        (invoice_id,),
    ).fetchone()
    if not row:
        return
    status = compute_invoice_status(row["amount"], row["total_paid"], row["due_on"])
    conn.execute("UPDATE invoices SET status = ? WHERE id = ?", (status, invoice_id))


def generate_invoice_number(conn, issued_on):
    issued_date = parse_date(issued_on, "issued_on")
    prefix = issued_date.strftime("INV-%Y%m%d")
    suffix = 1
    while True:
        candidate = f"{prefix}-{suffix:03d}"
        existing = conn.execute(
            "SELECT 1 FROM invoices WHERE invoice_number = ?",
            (candidate,),
        ).fetchone()
        if not existing:
            return candidate
        suffix += 1


def get_summary_data():
    today = today_value()
    month_start = today.replace(day=1).isoformat()
    today_iso = today.isoformat()

    with closing(get_connection()) as conn:
        totals = conn.execute(
            """
            SELECT
                COUNT(*) AS invoice_count,
                COALESCE(SUM(amount - total_paid), 0) AS outstanding_total
            FROM invoices
            """
        ).fetchone()
        revenue = conn.execute(
            """
            SELECT COALESCE(SUM(amount), 0) AS revenue
            FROM payments
            WHERE paid_on BETWEEN ? AND ?
            """,
            (month_start, today_iso),
        ).fetchone()

    monthly_revenue = format_money(revenue["revenue"])
    expenses = format_money(totals["outstanding_total"])
    net_balance = format_money(monthly_revenue - expenses)
    return {
        "monthly_revenue": monthly_revenue,
        "outstanding_payments": expenses,
        "invoice_count": int(totals["invoice_count"] or 0),
        "expenses_total": expenses,
        "net_balance": net_balance,
        "net_balance_direction": "positive" if net_balance >= 0 else "negative",
    }


def get_recent_invoices(limit=5):
    with closing(get_connection()) as conn:
        invoices = conn.execute(
            """
            SELECT
                invoices.id,
                invoices.invoice_number,
                invoices.customer_id,
                customers.name AS customer_name,
                invoices.amount,
                invoices.total_paid,
                invoices.status,
                invoices.issued_on,
                invoices.due_on,
                invoices.notes
            FROM invoices
            JOIN customers ON customers.id = invoices.customer_id
            ORDER BY invoices.issued_on DESC, invoices.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [serialize_invoice(invoice) for invoice in invoices]


def get_alerts(limit=6):
    today_iso = today_value().isoformat()
    with closing(get_connection()) as conn:
        overdue = conn.execute(
            """
            SELECT
                invoices.invoice_number,
                customers.name AS customer_name,
                invoices.due_on,
                invoices.amount,
                invoices.total_paid
            FROM invoices
            JOIN customers ON customers.id = invoices.customer_id
            WHERE invoices.total_paid < invoices.amount
              AND invoices.due_on < ?
            ORDER BY invoices.due_on ASC
            LIMIT ?
            """,
            (today_iso, limit),
        ).fetchall()
        due_today = conn.execute(
            """
            SELECT
                invoices.invoice_number,
                customers.name AS customer_name,
                invoices.due_on,
                invoices.amount,
                invoices.total_paid
            FROM invoices
            JOIN customers ON customers.id = invoices.customer_id
            WHERE invoices.total_paid < invoices.amount
              AND invoices.due_on = ?
            ORDER BY invoices.id DESC
            LIMIT ?
            """,
            (today_iso, limit),
        ).fetchall()

    alerts = []
    for row in overdue:
        alerts.append(
            {
                "type": "overdue",
                "title": f"{row['invoice_number']} is overdue",
                "detail": (
                    f"{row['customer_name']} still owes "
                    f"{format_money(row['amount'] - row['total_paid'])}."
                ),
                "date": row["due_on"],
            }
        )
    for row in due_today:
        alerts.append(
            {
                "type": "due_today",
                "title": f"{row['invoice_number']} is due today",
                "detail": (
                    f"Reminder for {row['customer_name']} with "
                    f"{format_money(row['amount'] - row['total_paid'])} outstanding."
                ),
                "date": row["due_on"],
            }
        )
    return alerts[:limit]


def get_trend_data(view, start_date=None, end_date=None):
    today = today_value()
    with closing(get_connection()) as conn:
        rows = conn.execute(
            "SELECT paid_on, amount FROM payments ORDER BY paid_on ASC, id ASC"
        ).fetchall()

    points = []
    if view == "monthly":
        first_of_month = today.replace(day=1)
        month_starts = []
        cursor = first_of_month
        for _ in range(5, -1, -1):
            month_starts.append(cursor)
            cursor = (cursor.replace(day=1) - timedelta(days=1)).replace(day=1)
        month_starts.sort()
        totals = {month.strftime("%Y-%m"): 0.0 for month in month_starts}
        for row in rows:
            paid_on = parse_date(row["paid_on"], "paid_on")
            key = paid_on.strftime("%Y-%m")
            if key in totals:
                totals[key] += float(row["amount"] or 0)
        for month in month_starts:
            key = month.strftime("%Y-%m")
            points.append(
                {
                    "label": month.strftime("%b"),
                    "value": format_money(totals[key]),
                }
            )
    elif view == "weekly":
        week_starts = [today - timedelta(days=today.weekday()) - timedelta(weeks=offset) for offset in range(7, -1, -1)]
        week_starts.sort()
        totals = {day.isoformat(): 0.0 for day in week_starts}
        for row in rows:
            paid_on = parse_date(row["paid_on"], "paid_on")
            week_start = paid_on - timedelta(days=paid_on.weekday())
            key = week_start.isoformat()
            if key in totals:
                totals[key] += float(row["amount"] or 0)
        for day in week_starts:
            points.append(
                {
                    "label": day.strftime("%d %b"),
                    "value": format_money(totals[day.isoformat()]),
                }
            )
    elif view == "custom":
        if not start_date or not end_date:
            raise ValueError("Custom range requires start_date and end_date.")
        start = parse_date(start_date, "start_date")
        end = parse_date(end_date, "end_date")
        if start > end:
            raise ValueError("start_date must be on or before end_date.")
        if (end - start).days > 90:
            raise ValueError("Custom range must be 90 days or less.")
        dates = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
        totals = {day.isoformat(): 0.0 for day in dates}
        for row in rows:
            paid_on = parse_date(row["paid_on"], "paid_on").isoformat()
            if paid_on in totals:
                totals[paid_on] += float(row["amount"] or 0)
        for day in dates:
            points.append(
                {
                    "label": day.strftime("%d %b"),
                    "value": format_money(totals[day.isoformat()]),
                }
            )
    else:
        dates = [today - timedelta(days=offset) for offset in range(6, -1, -1)]
        totals = {day.isoformat(): 0.0 for day in dates}
        for row in rows:
            paid_on = parse_date(row["paid_on"], "paid_on").isoformat()
            if paid_on in totals:
                totals[paid_on] += float(row["amount"] or 0)
        for day in dates:
            points.append(
                {
                    "label": day.strftime("%a"),
                    "value": format_money(totals[day.isoformat()]),
                }
            )

    return {
        "view": view,
        "points": points,
        "start_date": start_date,
        "end_date": end_date,
    }


init_db()


@app.route("/")
def home():
    return jsonify(
        {
            "name": "CinchPOS API",
            "status": "ok",
            "endpoints": [
                "/api/health",
                "/api/dashboard",
                "/api/dashboard/trend",
                "/api/customers",
                "/api/invoices",
                "/api/payments",
            ],
        }
    )


@app.route("/api/health")
def health():
    with closing(get_connection()) as conn:
        conn.execute("SELECT 1").fetchone()
    return jsonify(
        {
            "status": "ok",
            "schema_version": SCHEMA_VERSION,
            "database": os.path.basename(DATABASE),
        }
    )


@app.route("/api/dashboard")
def dashboard():
    return jsonify(
        {
            "summary": get_summary_data(),
            "recent_invoices": get_recent_invoices(),
            "alerts": get_alerts(),
        }
    )


@app.route("/api/dashboard/trend")
def dashboard_trend():
    view = (request.args.get("view") or "weekly").strip().lower()
    if view not in {"daily", "weekly", "monthly", "custom"}:
        return jsonify({"error": "view must be daily, weekly, monthly, or custom."}), 400
    start_date = (request.args.get("start_date") or "").strip() or None
    end_date = (request.args.get("end_date") or "").strip() or None
    try:
        return jsonify(get_trend_data(view, start_date=start_date, end_date=end_date))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/customers", methods=["GET"])
def list_customers():
    with closing(get_connection()) as conn:
        rows = conn.execute(
            "SELECT id, name, email, address, phone, created_at FROM customers ORDER BY name ASC"
        ).fetchall()
    return jsonify([serialize_customer(row) for row in rows])


@app.route("/api/customers", methods=["POST"])
def add_customer():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    address = (data.get("address") or "").strip()
    phone = (data.get("phone") or "").strip()

    if not name:
        return jsonify({"error": "Customer name is required."}), 400

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            "INSERT INTO customers (name, email, address, phone) VALUES (?, ?, ?, ?)",
            (name, email, address, phone),
        )
        conn.commit()
        customer = conn.execute(
            "SELECT id, name, email, address, phone, created_at FROM customers WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return jsonify(serialize_customer(customer)), 201


@app.route("/api/customers/<int:customer_id>", methods=["PUT"])
def update_customer(customer_id):
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    address = (data.get("address") or "").strip()
    phone = (data.get("phone") or "").strip()

    if not name:
        return jsonify({"error": "Customer name is required."}), 400

    with closing(get_connection()) as conn:
        existing = conn.execute(
            "SELECT id FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Customer not found."}), 404

        conn.execute(
            "UPDATE customers SET name = ?, email = ?, address = ?, phone = ? WHERE id = ?",
            (name, email, address, phone, customer_id),
        )
        conn.commit()
        customer = conn.execute(
            "SELECT id, name, email, address, phone, created_at FROM customers WHERE id = ?",
            (customer_id,),
        ).fetchone()
    return jsonify(serialize_customer(customer))


@app.route("/api/invoices", methods=["GET"])
def list_invoices():
    limit = request.args.get("limit")
    query = """
        SELECT
            invoices.id,
            invoices.invoice_number,
            invoices.customer_id,
            customers.name AS customer_name,
            invoices.amount,
            invoices.total_paid,
            invoices.status,
            invoices.issued_on,
            invoices.due_on,
            invoices.notes
        FROM invoices
        JOIN customers ON customers.id = invoices.customer_id
        ORDER BY invoices.issued_on DESC, invoices.id DESC
    """

    with closing(get_connection()) as conn:
        if limit:
            try:
                rows = conn.execute(f"{query} LIMIT ?", (int(limit),)).fetchall()
            except ValueError:
                return jsonify({"error": "limit must be numeric."}), 400
        else:
            rows = conn.execute(query).fetchall()
    return jsonify([serialize_invoice(row) for row in rows])


@app.route("/api/invoices", methods=["POST"])
def create_invoice():
    data = request.get_json() or {}

    try:
        customer_id = int(data.get("customer_id") or 0)
        amount = float(data.get("amount") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "Customer and amount must be valid numbers."}), 400

    issued_on = (data.get("issued_on") or today_value().isoformat()).strip()
    due_on = (data.get("due_on") or "").strip()
    notes = (data.get("notes") or "").strip()

    if customer_id <= 0:
        return jsonify({"error": "Select a customer."}), 400
    if amount <= 0:
        return jsonify({"error": "Amount must be greater than zero."}), 400
    if not due_on:
        return jsonify({"error": "Due date is required."}), 400

    try:
        parse_date(issued_on, "issued_on")
        parse_date(due_on, "due_on")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with closing(get_connection()) as conn:
        customer = conn.execute(
            "SELECT id FROM customers WHERE id = ?", (customer_id,)
        ).fetchone()
        if not customer:
            return jsonify({"error": "Customer not found."}), 404

        invoice_number = (data.get("invoice_number") or "").strip()
        if not invoice_number:
            invoice_number = generate_invoice_number(conn, issued_on)

        status = compute_invoice_status(amount, 0, due_on)
        try:
            cursor = conn.execute(
                """
                INSERT INTO invoices (
                    customer_id, invoice_number, amount, total_paid, status,
                    issued_on, due_on, notes
                )
                VALUES (?, ?, ?, 0, ?, ?, ?, ?)
                """,
                (customer_id, invoice_number, amount, status, issued_on, due_on, notes),
            )
        except sqlite3.IntegrityError as exc:
            if "invoice_number" in str(exc).lower():
                return jsonify({"error": "Invoice number already exists."}), 409
            raise
        conn.commit()
        row = conn.execute(
            """
            SELECT
                invoices.id,
                invoices.invoice_number,
                invoices.customer_id,
                customers.name AS customer_name,
                invoices.amount,
                invoices.total_paid,
                invoices.status,
                invoices.issued_on,
                invoices.due_on,
                invoices.notes
            FROM invoices
            JOIN customers ON customers.id = invoices.customer_id
            WHERE invoices.id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()

    return jsonify(serialize_invoice(row)), 201


@app.route("/api/payments", methods=["GET"])
def list_payments():
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT
                payments.id,
                payments.invoice_id,
                invoices.invoice_number,
                payments.customer_id,
                customers.name AS customer_name,
                payments.amount,
                payments.method,
                payments.paid_on,
                payments.notes,
                payments.created_at
            FROM payments
            JOIN invoices ON invoices.id = payments.invoice_id
            JOIN customers ON customers.id = payments.customer_id
            ORDER BY payments.paid_on DESC, payments.id DESC
            """
        ).fetchall()
    return jsonify([serialize_payment(row) for row in rows])


@app.route("/api/payments", methods=["POST"])
def record_payment():
    data = request.get_json() or {}

    try:
        invoice_id = int(data.get("invoice_id") or 0)
        amount = float(data.get("amount") or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "Invoice and amount must be valid numbers."}), 400

    paid_on = (data.get("paid_on") or today_value().isoformat()).strip()
    method = (data.get("method") or "Bank Transfer").strip()
    notes = (data.get("notes") or "").strip()

    if invoice_id <= 0:
        return jsonify({"error": "Select an invoice."}), 400
    if amount <= 0:
        return jsonify({"error": "Payment amount must be greater than zero."}), 400

    try:
        parse_date(paid_on, "paid_on")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    with closing(get_connection()) as conn:
        invoice = conn.execute(
            """
            SELECT id, customer_id, amount, total_paid
            FROM invoices
            WHERE id = ?
            """,
            (invoice_id,),
        ).fetchone()
        if not invoice:
            return jsonify({"error": "Invoice not found."}), 404

        outstanding = float(invoice["amount"] or 0) - float(invoice["total_paid"] or 0)
        if amount - outstanding > 0.009:
            return jsonify({"error": "Payment exceeds outstanding amount."}), 400

        conn.execute(
            """
            INSERT INTO payments (invoice_id, customer_id, amount, method, paid_on, notes)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (invoice_id, invoice["customer_id"], amount, method, paid_on, notes),
        )
        conn.execute(
            "UPDATE invoices SET total_paid = total_paid + ? WHERE id = ?",
            (amount, invoice_id),
        )
        refresh_invoice_status(conn, invoice_id)
        conn.commit()

    return jsonify({"message": "Payment recorded successfully."}), 201


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
    app.run(host=host, port=port, debug=debug, use_reloader=debug)

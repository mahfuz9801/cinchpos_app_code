import os
import sqlite3
import sys
import hashlib
import hmac
import smtplib
import ssl
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from email.message import EmailMessage
from functools import wraps
import json
import re
import secrets
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import HTTPException

VENDOR_PATH = os.path.join(os.path.dirname(__file__), "vendor")
if os.path.isdir(VENDOR_PATH) and VENDOR_PATH not in sys.path:
    sys.path.insert(0, VENDOR_PATH)

try:
    import jwt
    from jwt import PyJWKClient
except ImportError:  # pragma: no cover - exercised only when auth is enabled without deps
    jwt = None
    PyJWKClient = None

try:
    import certifi
except ImportError:  # pragma: no cover - fallback for minimal local runtimes
    certifi = None

def load_env_file(env_path):
    if not env_path or not os.path.isfile(env_path):
        return
    try:
        with open(env_path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        return


load_env_file(os.path.join(os.path.dirname(__file__), ".env"))
load_env_file(os.getenv("CINCHPOS_ENV_FILE", "").strip())

app = Flask(__name__)

DATABASE = os.getenv(
    "DATABASE_PATH",
    os.path.join(os.path.dirname(__file__), "database.db"),
)
SCHEMA_VERSION = "6"
AUTH_REQUIRED = os.getenv("CINCHPOS_AUTH_REQUIRED", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
CLERK_ISSUER = os.getenv("CLERK_ISSUER", "").strip().rstrip("/")
CLERK_JWKS_URL = os.getenv(
    "CLERK_JWKS_URL",
    f"{CLERK_ISSUER}/.well-known/jwks.json" if CLERK_ISSUER else "",
).strip()
CLERK_AUDIENCE = os.getenv("CLERK_AUDIENCE", "").strip() or None
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY", "").strip()
DEFAULT_BUSINESS_ID = "primary"
DEFAULT_WAREHOUSE_ID = "main"
DEFAULT_BUSINESS_NAME = "Store Name"
AUTH_TOKEN_LEEWAY_SECONDS = int(os.getenv("CINCHPOS_AUTH_TOKEN_LEEWAY", "60"))
OFFLINE_SESSION_HOURS = int(os.getenv("CINCHPOS_OFFLINE_SESSION_HOURS", "24"))
CINCHPOS_SESSION_HOURS = int(os.getenv("CINCHPOS_ACCOUNT_SESSION_HOURS", "168"))
PASSWORD_HASH_ITERATIONS = int(os.getenv("CINCHPOS_PASSWORD_HASH_ITERATIONS", "310000"))
LOGIN_LOCK_THRESHOLD = int(os.getenv("CINCHPOS_LOGIN_LOCK_THRESHOLD", "5"))
LOGIN_LOCK_MINUTES = int(os.getenv("CINCHPOS_LOGIN_LOCK_MINUTES", "15"))
OTP_LENGTH = int(os.getenv("CINCHPOS_OTP_LENGTH", "6"))
OTP_EXPIRY_MINUTES = int(os.getenv("CINCHPOS_OTP_EXPIRY_MINUTES", "10"))
OTP_RESEND_SECONDS = int(os.getenv("CINCHPOS_OTP_RESEND_SECONDS", "60"))
OTP_MAX_ATTEMPTS = int(os.getenv("CINCHPOS_OTP_MAX_ATTEMPTS", "5"))
EMAIL_OTP_FROM = os.getenv("CINCHPOS_EMAIL_FROM", "support@cinchpos.in").strip()
SMTP_HOST = os.getenv("CINCHPOS_SMTP_HOST", "smtpout.secureserver.net").strip()
SMTP_PORT = int(os.getenv("CINCHPOS_SMTP_PORT", "465"))
SMTP_USERNAME = os.getenv("CINCHPOS_SMTP_USERNAME", EMAIL_OTP_FROM).strip()
SMTP_PASSWORD = os.getenv("CINCHPOS_SMTP_PASSWORD", "").strip()
SMTP_SECURITY = os.getenv("CINCHPOS_SMTP_SECURITY", "ssl").strip().lower()
SMS_WEBHOOK_URL = os.getenv("CINCHPOS_SMS_WEBHOOK_URL", "").strip()
PUBLIC_STORE_BASE_URL = os.getenv("CINCHPOS_PUBLIC_STORE_BASE_URL", "https://cinchpos.in").strip().rstrip("/")
PUBLIC_STORE_SYNC_URL = os.getenv("CINCHPOS_PUBLIC_STORE_SYNC_URL", f"{PUBLIC_STORE_BASE_URL}/api/online-store/sync").strip()
EXPOSE_DEV_OTP = os.getenv("CINCHPOS_EXPOSE_DEV_OTP", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
CUSTOMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{3,31}$")
CUSTOMER_ACCOUNT_ID_PREFIX = os.getenv("CINCHPOS_CUSTOMER_ID_PREFIX", "CP").strip().upper() or "CP"
CUSTOMER_ACCOUNT_ID_DIGITS = max(4, int(os.getenv("CINCHPOS_CUSTOMER_ID_DIGITS", "6")))
PASSWORD_RULES = {
    "min_length": 8,
    "uppercase": True,
    "lowercase": True,
    "number": True,
    "special": True,
    "spaces": False,
}
DB_INDEX_STATEMENTS = (
    "CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)",
    "CREATE INDEX IF NOT EXISTS idx_customers_business_id ON customers(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_business_id ON invoices(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_issued_on ON invoices(issued_on)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_due_on ON invoices(due_on)",
    "CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)",
    "CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_customer_id ON payments(customer_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_business_id ON payments(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on)",
    "CREATE INDEX IF NOT EXISTS idx_auth_audit_business_id ON auth_audit_logs(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_auth_audit_user_id ON auth_audit_logs(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_memberships_user_business ON business_memberships(clerk_user_id, business_id)",
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_customer_id ON customer_accounts(customer_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_username_unique ON customer_accounts(username) WHERE username <> ''",
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_email ON customer_accounts(email)",
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_phone ON customer_accounts(phone)",
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_business_id ON customer_accounts(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_account_sessions_token_hash ON account_sessions(token_hash)",
    "CREATE INDEX IF NOT EXISTS idx_account_sessions_account_id ON account_sessions(account_id)",
    "CREATE INDEX IF NOT EXISTS idx_account_otp_codes_account_id ON account_otp_codes(account_id)",
    "CREATE INDEX IF NOT EXISTS idx_account_otp_codes_destination ON account_otp_codes(destination)",
    "CREATE INDEX IF NOT EXISTS idx_online_stores_business_id ON online_stores(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_online_stores_slug ON online_stores(slug)",
    "CREATE INDEX IF NOT EXISTS idx_online_products_business_id ON online_products(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_online_products_store_id ON online_products(store_id)",
    "CREATE INDEX IF NOT EXISTS idx_online_orders_business_id ON online_orders(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_online_orders_store_id ON online_orders(store_id)",
)

PERMISSIONS = {
    "billing:read": "View POS billing",
    "billing:write": "Create and complete bills",
    "invoices:read": "View invoices",
    "invoices:write": "Create and update invoices",
    "payments:write": "Record payments",
    "inventory:read": "View inventory",
    "inventory:write": "Update inventory",
    "purchases:read": "View purchase records",
    "purchases:write": "Manage purchase records",
    "sales:read": "View sales reports",
    "reports:read": "View dashboard and reports",
    "employees:read": "View employees",
    "employees:write": "Manage employees",
    "customers:read": "View customers",
    "customers:write": "Manage customers",
    "suppliers:read": "View suppliers",
    "suppliers:write": "Manage suppliers",
    "business:read": "View business settings",
    "business:write": "Manage businesses",
    "warehouses:read": "View warehouses",
    "warehouses:write": "Manage warehouses",
    "roles:manage": "Manage roles and permissions",
    "ai:use": "Use AI features",
    "support:use": "Use support features",
    "audit:read": "View authentication audit logs",
}
ALL_PERMISSIONS = tuple(PERMISSIONS.keys())
ROLE_PERMISSION_MATRIX = {
    "owner": ALL_PERMISSIONS,
    "admin": ALL_PERMISSIONS,
    "manager": (
        "billing:read",
        "billing:write",
        "invoices:read",
        "invoices:write",
        "payments:write",
        "inventory:read",
        "inventory:write",
        "purchases:read",
        "purchases:write",
        "sales:read",
        "reports:read",
        "employees:read",
        "customers:read",
        "customers:write",
        "suppliers:read",
        "suppliers:write",
        "warehouses:read",
        "support:use",
    ),
    "store_manager": (
        "billing:read",
        "billing:write",
        "invoices:read",
        "invoices:write",
        "payments:write",
        "inventory:read",
        "inventory:write",
        "purchases:read",
        "purchases:write",
        "sales:read",
        "reports:read",
        "employees:read",
        "employees:write",
        "customers:read",
        "customers:write",
        "suppliers:read",
        "suppliers:write",
        "warehouses:read",
        "support:use",
    ),
    "salesman": (
        "billing:read",
        "billing:write",
        "invoices:read",
        "payments:write",
        "customers:read",
        "customers:write",
        "inventory:read",
        "support:use",
    ),
    "stock_manager": (
        "inventory:read",
        "inventory:write",
        "purchases:read",
        "purchases:write",
        "warehouses:read",
        "warehouses:write",
        "suppliers:read",
        "suppliers:write",
        "reports:read",
        "support:use",
    ),
    "cashier": (
        "billing:read",
        "billing:write",
        "invoices:read",
        "payments:write",
        "customers:read",
        "customers:write",
        "inventory:read",
        "support:use",
    ),
    "warehouse_manager": (
        "inventory:read",
        "inventory:write",
        "purchases:read",
        "purchases:write",
        "warehouses:read",
        "warehouses:write",
        "reports:read",
        "support:use",
    ),
    "warehouse_staff": (
        "inventory:read",
        "inventory:write",
        "warehouses:read",
        "support:use",
    ),
    "accountant": (
        "invoices:read",
        "invoices:write",
        "payments:write",
        "purchases:read",
        "purchases:write",
        "sales:read",
        "reports:read",
        "customers:read",
        "support:use",
    ),
    "employee": (
        "billing:read",
        "customers:read",
        "inventory:read",
        "support:use",
    ),
}
ROLE_LABELS = {
    "owner": "Owner",
    "admin": "Admin",
    "manager": "Manager",
    "store_manager": "Store Manager",
    "salesman": "Salesman",
    "stock_manager": "Stock Manager",
    "cashier": "Cashier",
    "warehouse_manager": "Warehouse Manager",
    "warehouse_staff": "Warehouse Staff",
    "accountant": "Accountant",
    "employee": "Employee",
}
JWKS_CLIENT = None


@app.before_request
def handle_cors_preflight():
    if request.method == "OPTIONS":
        return jsonify({}), 204


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = os.getenv("CORS_ORIGIN", "*")
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, Authorization, "
        "X-CinchPOS-Business-Id, X-CinchPOS-Warehouse-Id"
    )
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS, HEAD"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
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


def json_dumps(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True)


def json_loads(value, fallback):
    if not value:
        return fallback
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def normalize_role_key(value):
    normalized = str(value or "employee").strip().lower().replace(" ", "_").replace("-", "_")
    if normalized.startswith("org:"):
        normalized = normalized.split(":", 1)[1]
    return normalized or "employee"


def normalize_permissions(values):
    if not values:
        return []
    if isinstance(values, str):
        values = [entry.strip() for entry in values.split(",")]
    return sorted({value for value in values if value in PERMISSIONS})


def permissions_for_role(role_key):
    return list(ROLE_PERMISSION_MATRIX.get(normalize_role_key(role_key), ROLE_PERMISSION_MATRIX["employee"]))


def normalize_customer_id(value):
    return str(value or "").strip().lower()


def normalize_username(value):
    return str(value or "").strip().lower()


def account_username_from_payload(data):
    return data.get("username") or data.get("user_name") or data.get("customer_id") or data.get("user_id")


def normalize_account_email(value):
    return str(value or "").strip().lower()


def normalize_account_phone(value):
    digits = re.sub(r"\D+", "", str(value or ""))
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    return digits[-10:] if len(digits) >= 10 else digits


def account_identifier_from_payload(data):
    return (
        data.get("identifier")
        or data.get("login")
        or data.get("contact")
        or data.get("username")
        or data.get("email")
        or data.get("phone")
        or data.get("customer_id")
        or data.get("user_id")
    )


def validate_username(value):
    username = normalize_username(value)
    if not CUSTOMER_ID_PATTERN.match(username):
        raise ValueError("Username must be 4-32 characters and use letters, numbers, dot, dash, or underscore.")
    return username


def validate_customer_id(value):
    return validate_username(value)


def password_validation_errors(password):
    value = str(password or "")
    errors = []
    if len(value) < PASSWORD_RULES["min_length"]:
        errors.append(f"Password must be at least {PASSWORD_RULES['min_length']} characters.")
    if PASSWORD_RULES["uppercase"] and not re.search(r"[A-Z]", value):
        errors.append("Password must include an uppercase letter.")
    if PASSWORD_RULES["lowercase"] and not re.search(r"[a-z]", value):
        errors.append("Password must include a lowercase letter.")
    if PASSWORD_RULES["number"] and not re.search(r"\d", value):
        errors.append("Password must include a number.")
    if PASSWORD_RULES["special"] and not re.search(r"[^A-Za-z0-9\s]", value):
        errors.append("Password must include a special character.")
    if not PASSWORD_RULES["spaces"] and re.search(r"\s", value):
        errors.append("Password must not contain spaces.")
    return errors


def hash_password(password, salt=None):
    salt_bytes = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        str(password or "").encode("utf-8"),
        salt_bytes,
        PASSWORD_HASH_ITERATIONS,
    )
    return (
        f"pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}$"
        f"{salt_bytes.hex()}${digest.hex()}"
    )


def verify_password(password, stored_hash):
    try:
        algorithm, iteration_text, salt_hex, digest_hex = str(stored_hash or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt_bytes = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            str(password or "").encode("utf-8"),
            salt_bytes,
            int(iteration_text),
        )
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False


def hash_session_token(token):
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def safe_identifier(value, prefix):
    body = re.sub(r"[^a-z0-9_-]+", "_", normalize_customer_id(value)).strip("_")
    return f"{prefix}_{body or secrets.token_hex(4)}"


def row_get(row, key, default=""):
    if not row:
        return default
    try:
        return row[key]
    except (IndexError, KeyError):
        return default


def generate_customer_account_id(conn):
    prefix = re.sub(r"[^A-Z0-9]+", "", CUSTOMER_ACCOUNT_ID_PREFIX.upper())[:8] or "CP"
    digits = CUSTOMER_ACCOUNT_ID_DIGITS
    rows = conn.execute(
        "SELECT customer_id FROM customer_accounts WHERE customer_id LIKE ?",
        (f"{prefix}%",),
    ).fetchall()
    highest = 0
    for row in rows:
        value = str(row_get(row, "customer_id", "") or "").upper()
        suffix = value[len(prefix):] if value.startswith(prefix) else ""
        if suffix.isdigit():
            highest = max(highest, int(suffix))
    for number in range(highest + 1, highest + 10000):
        candidate = f"{prefix}{number:0{digits}d}"
        exists = conn.execute(
            "SELECT 1 FROM customer_accounts WHERE customer_id = ?",
            (candidate,),
        ).fetchone()
        if not exists:
            return candidate
    raise RuntimeError("Could not generate a unique customer id.")


def username_seed_from_value(value):
    seed = re.sub(r"[^a-z0-9._-]+", "-", normalize_username(value)).strip("._-")
    seed = re.sub(r"[-._]{2,}", "-", seed)
    if not seed:
        seed = f"shop-{secrets.randbelow(10000):04d}"
    if not re.match(r"^[a-z0-9]", seed):
        seed = f"shop-{seed}"
    seed = seed[:24].strip("._-") or "shop"
    if len(seed) < 4:
        seed = f"{seed}-{secrets.randbelow(10000):04d}"[:24].strip("._-")
    return seed if CUSTOMER_ID_PATTERN.match(seed) else f"shop-{secrets.randbelow(10000):04d}"


def generate_account_username(conn, business_name="", email="", phone=""):
    base = username_seed_from_value(
        business_name
        or (str(email).split("@", 1)[0] if email else "")
        or phone
        or "shop"
    )
    candidate = base
    suffix = 2
    while conn.execute(
        "SELECT 1 FROM customer_accounts WHERE username = ?",
        (candidate,),
    ).fetchone():
        suffix_text = str(suffix)
        candidate = f"{base[: max(4, 32 - len(suffix_text) - 1)]}-{suffix_text}".strip("._-")
        suffix += 1
    return candidate


def migrate_customer_account_usernames(conn):
    rows = conn.execute(
        "SELECT id, customer_id, username FROM customer_accounts"
    ).fetchall()
    for row in rows:
        if row_get(row, "username"):
            continue
        base_username = normalize_username(row_get(row, "customer_id"))
        if not base_username or not CUSTOMER_ID_PATTERN.match(base_username):
            base_username = f"user_{str(row_get(row, 'id', '')).replace('acct_', '')[:8] or secrets.token_hex(4)}"
        username = base_username
        suffix = 2
        while conn.execute(
            "SELECT 1 FROM customer_accounts WHERE username = ? AND id <> ?",
            (username, row["id"]),
        ).fetchone():
            username = f"{base_username}_{suffix}"
            suffix += 1
        conn.execute(
            """
            UPDATE customer_accounts
            SET username = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (username, row["id"]),
        )


def current_auth_context():
    context = getattr(g, "auth_context", None)
    if context:
        return context
    return {
        "authenticated": False,
        "source": "local-dev",
        "user_id": "local-owner",
        "email": "",
        "name": "Local Owner",
        "business_id": DEFAULT_BUSINESS_ID,
        "warehouse_id": DEFAULT_WAREHOUSE_ID,
        "role": "owner",
        "permissions": list(ALL_PERMISSIONS),
        "mfa_required": False,
        "mfa_verified": True,
    }


def is_owner_context(context):
    return normalize_role_key(context.get("role")) == "owner" or context.get("user_id") == "local-owner"


def current_business_id():
    return current_auth_context().get("business_id") or DEFAULT_BUSINESS_ID


def current_warehouse_id():
    return current_auth_context().get("warehouse_id") or DEFAULT_WAREHOUSE_ID


def get_jwks_client():
    global JWKS_CLIENT
    if not CLERK_JWKS_URL:
        raise ValueError("CLERK_JWKS_URL or CLERK_ISSUER must be configured.")
    if PyJWKClient is None or jwt is None:
        raise ValueError("PyJWT[crypto] must be installed to verify Clerk tokens.")
    if JWKS_CLIENT is None:
        JWKS_CLIENT = PyJWKClient(CLERK_JWKS_URL)
    return JWKS_CLIENT


def verify_clerk_token(token):
    signing_key = get_jwks_client().get_signing_key_from_jwt(token)
    options = {
        "require": ["exp", "iat", "sub"],
        "verify_aud": bool(CLERK_AUDIENCE),
    }
    decode_kwargs = {
        "algorithms": ["RS256"],
        "options": options,
        "leeway": AUTH_TOKEN_LEEWAY_SECONDS,
    }
    if CLERK_ISSUER:
        decode_kwargs["issuer"] = CLERK_ISSUER
    if CLERK_AUDIENCE:
        decode_kwargs["audience"] = CLERK_AUDIENCE
    return jwt.decode(token, signing_key.key, **decode_kwargs)


def extract_claim_email(claims):
    return (
        claims.get("email")
        or claims.get("primary_email_address")
        or claims.get("email_address")
        or ""
    )


def extract_claim_name(claims):
    full_name = claims.get("name") or claims.get("full_name")
    if full_name:
        return full_name
    first = claims.get("given_name") or claims.get("first_name") or ""
    last = claims.get("family_name") or claims.get("last_name") or ""
    return f"{first} {last}".strip() or extract_claim_email(claims)


def extract_claim_business_id(claims):
    org_claim = claims.get("o") if isinstance(claims.get("o"), dict) else {}
    return (
        request.headers.get("X-CinchPOS-Business-Id")
        or org_claim.get("id")
        or claims.get("org_id")
        or claims.get("business_id")
        or DEFAULT_BUSINESS_ID
    )


def extract_claim_role(claims):
    org_claim = claims.get("o") if isinstance(claims.get("o"), dict) else {}
    return normalize_role_key(
        request.headers.get("X-CinchPOS-Role")
        or org_claim.get("rol")
        or claims.get("org_role")
        or claims.get("role")
        or "employee"
    )


def get_membership_for_user(conn, user_id, business_id):
    return conn.execute(
        """
        SELECT clerk_user_id, business_id, warehouse_id, role_key, permissions_json,
               status, email, name, mfa_required
        FROM business_memberships
        WHERE clerk_user_id = ? AND business_id = ?
        """,
        (user_id, business_id),
    ).fetchone()


def ensure_default_auth_records(conn):
    conn.execute(
        """
        INSERT OR IGNORE INTO businesses (id, name, owner_user_id, status)
        VALUES (?, ?, ?, 'Active')
        """,
        (DEFAULT_BUSINESS_ID, DEFAULT_BUSINESS_NAME, "local-owner"),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO warehouses (id, business_id, name, status)
        VALUES (?, ?, 'Main Warehouse', 'Active')
        """,
        (DEFAULT_WAREHOUSE_ID, DEFAULT_BUSINESS_ID),
    )
    for role_key, permissions in ROLE_PERMISSION_MATRIX.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO roles (
                business_id, role_key, name, is_custom, permissions_json
            )
            VALUES (?, ?, ?, 0, ?)
            """,
            (
                DEFAULT_BUSINESS_ID,
                role_key,
                ROLE_LABELS.get(role_key, role_key.replace("_", " ").title()),
                json_dumps(list(permissions)),
            ),
        )
    conn.execute(
        """
        INSERT OR IGNORE INTO business_memberships (
            clerk_user_id, business_id, warehouse_id, role_key,
            permissions_json, status, email, name, mfa_required
        )
        VALUES (?, ?, ?, 'owner', ?, 'Active', '', 'Local Owner', 1)
        """,
        ("local-owner", DEFAULT_BUSINESS_ID, DEFAULT_WAREHOUSE_ID, json_dumps(list(ALL_PERMISSIONS))),
    )


def build_local_auth_context():
    return {
        "authenticated": False,
        "source": "local-dev",
        "user_id": "local-owner",
        "email": "",
        "name": "Local Owner",
        "business_id": request.headers.get("X-CinchPOS-Business-Id") or DEFAULT_BUSINESS_ID,
        "warehouse_id": request.headers.get("X-CinchPOS-Warehouse-Id") or DEFAULT_WAREHOUSE_ID,
        "role": "owner",
        "permissions": list(ALL_PERMISSIONS),
        "mfa_required": False,
        "mfa_verified": True,
    }


def build_clerk_auth_context(claims):
    user_id = claims.get("sub") or ""
    business_id = str(extract_claim_business_id(claims))
    role_key = extract_claim_role(claims)
    with closing(get_connection()) as conn:
        ensure_default_auth_records(conn)
        membership = get_membership_for_user(conn, user_id, business_id)
        if not membership and role_key in {"owner", "admin"}:
            conn.execute(
                """
                INSERT OR IGNORE INTO businesses (id, name, owner_user_id, status)
                VALUES (?, ?, ?, 'Active')
                """,
                (business_id, DEFAULT_BUSINESS_NAME, user_id),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO warehouses (id, business_id, name, status)
                VALUES (?, ?, 'Main Warehouse', 'Active')
                """,
                (DEFAULT_WAREHOUSE_ID, business_id),
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO business_memberships (
                    clerk_user_id, business_id, warehouse_id, role_key,
                    permissions_json, status, email, name, mfa_required
                )
                VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)
                """,
                (
                    user_id,
                    business_id,
                    DEFAULT_WAREHOUSE_ID,
                    role_key,
                    json_dumps(permissions_for_role(role_key)),
                    extract_claim_email(claims),
                    extract_claim_name(claims),
                    1 if role_key in {"owner", "admin"} else 0,
                ),
            )
            conn.commit()
            membership = get_membership_for_user(conn, user_id, business_id)

    if not membership or membership["status"] != "Active":
        raise PermissionError("User is not assigned to this business.")

    permissions = normalize_permissions(json_loads(membership["permissions_json"], []))
    if not permissions:
        permissions = permissions_for_role(membership["role_key"])
    mfa_required = bool(membership["mfa_required"])
    mfa_verified = bool(claims.get("fva")) or not mfa_required
    return {
        "authenticated": True,
        "source": "clerk",
        "user_id": user_id,
        "email": membership["email"] or extract_claim_email(claims),
        "name": membership["name"] or extract_claim_name(claims),
        "business_id": membership["business_id"],
        "warehouse_id": membership["warehouse_id"] or DEFAULT_WAREHOUSE_ID,
        "role": normalize_role_key(membership["role_key"]),
        "permissions": permissions,
        "mfa_required": mfa_required,
        "mfa_verified": mfa_verified,
        "session_id": claims.get("sid") or "",
    }


def serialize_customer_account(row):
    if not row:
        return {}
    username = row_get(row, "username") or row_get(row, "customer_id")
    customer_id = row_get(row, "customer_id") or username
    return {
        "id": row["id"],
        "username": username,
        "customer_id": customer_id,
        "name": row["name"] or username,
        "email": row["email"] or "",
        "phone": row["phone"] or "",
        "business_id": row["business_id"] or DEFAULT_BUSINESS_ID,
        "warehouse_id": row["warehouse_id"] or DEFAULT_WAREHOUSE_ID,
        "role": normalize_role_key(row["role_key"] or "owner"),
        "status": row["status"] or "Active",
    }


def ensure_roles_for_business(conn, business_id):
    for role_key, permissions in ROLE_PERMISSION_MATRIX.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO roles (
                business_id, role_key, name, is_custom, permissions_json
            )
            VALUES (?, ?, ?, 0, ?)
            """,
            (
                business_id,
                role_key,
                ROLE_LABELS.get(role_key, role_key.replace("_", " ").title()),
                json_dumps(list(permissions)),
            ),
        )


def build_account_auth_context(account_row, session_id=""):
    membership = None
    business_id = account_row["business_id"] or DEFAULT_BUSINESS_ID
    username = row_get(account_row, "username") or row_get(account_row, "customer_id")
    customer_id = row_get(account_row, "customer_id") or username
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        membership = get_membership_for_user(conn, account_row["id"], business_id)

    role_key = normalize_role_key(
        (membership["role_key"] if membership else account_row["role_key"]) or "owner"
    )
    permissions = normalize_permissions(json_loads(membership["permissions_json"], [])) if membership else []
    if not permissions:
        permissions = permissions_for_role(role_key)
    if "*" not in permissions and role_key in {"owner", "admin"}:
        permissions = list(ALL_PERMISSIONS)

    return {
        "authenticated": True,
        "source": "cinchpos-account",
        "user_id": account_row["id"],
        "username": username,
        "customer_id": customer_id,
        "email": account_row["email"] or "",
        "phone": account_row["phone"] or "",
        "name": account_row["name"] or username,
        "business_id": business_id,
        "warehouse_id": account_row["warehouse_id"] or DEFAULT_WAREHOUSE_ID,
        "role": role_key,
        "permissions": permissions,
        "mfa_required": False,
        "mfa_verified": True,
        "session_id": session_id,
    }


def create_account_session(conn, account_row):
    session_id = f"sess_{secrets.token_hex(16)}"
    token = f"cinch_{secrets.token_urlsafe(32)}"
    expires_at = datetime.now(UTC) + timedelta(hours=CINCHPOS_SESSION_HOURS)
    conn.execute(
        """
        INSERT INTO account_sessions (
            id, account_id, token_hash, business_id, warehouse_id, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            account_row["id"],
            hash_session_token(token),
            account_row["business_id"] or DEFAULT_BUSINESS_ID,
            account_row["warehouse_id"] or DEFAULT_WAREHOUSE_ID,
            expires_at.isoformat(),
        ),
    )
    return token, session_id, expires_at


def parse_db_datetime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00").replace(" ", "T"))
    except ValueError:
        return None


def make_otp_code():
    max_value = 10 ** max(4, OTP_LENGTH)
    return f"{secrets.randbelow(max_value):0{max(4, OTP_LENGTH)}d}"


def find_account_for_login_identifier(conn, identifier):
    value = str(identifier or "").strip()
    email = normalize_account_email(value)
    phone = normalize_account_phone(value)
    username = normalize_username(value)
    if "@" in value:
        return conn.execute(
            "SELECT * FROM customer_accounts WHERE lower(email) = ?",
            (email,),
        ).fetchone()
    if phone and len(phone) == 10 and re.fullmatch(r"\d{10}", phone):
        return conn.execute(
            "SELECT * FROM customer_accounts WHERE phone = ?",
            (phone,),
        ).fetchone()
    return conn.execute(
        """
        SELECT * FROM customer_accounts
        WHERE username = ? OR (username = '' AND customer_id = ?)
        """,
        (username, username),
    ).fetchone()


def send_email_otp(destination, code):
    if not SMTP_HOST or not SMTP_PASSWORD:
        return {"sent": False, "reason": "smtp_not_configured"}

    message = EmailMessage()
    message["Subject"] = "Your CinchPOS login OTP"
    message["From"] = EMAIL_OTP_FROM
    message["To"] = destination
    message.set_content(
        "\n".join(
            [
                "Your CinchPOS login OTP is:",
                "",
                code,
                "",
                f"This OTP expires in {OTP_EXPIRY_MINUTES} minutes.",
                "If you did not request this, you can ignore this email.",
            ]
        )
    )

    if SMTP_SECURITY in {"ssl", "smtps"}:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=15) as smtp:
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as smtp:
            if SMTP_SECURITY in {"starttls", "tls"}:
                smtp.starttls(context=ssl.create_default_context())
            smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(message)
    return {"sent": True, "reason": ""}


def send_sms_otp(destination, code):
    if not SMS_WEBHOOK_URL:
        return {"sent": False, "reason": "sms_not_configured"}
    payload = json_dumps(
        {
            "to": destination,
            "message": f"Your CinchPOS OTP is {code}. It expires in {OTP_EXPIRY_MINUTES} minutes.",
            "otp": code,
            "purpose": "cinchpos-login",
        }
    ).encode("utf-8")
    request_obj = urlrequest.Request(
        SMS_WEBHOOK_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlrequest.urlopen(request_obj, timeout=15) as response:
        if response.status >= 400:
            return {"sent": False, "reason": "sms_provider_failed"}
    return {"sent": True, "reason": ""}


def deliver_otp(channel, destination, code):
    try:
        if channel == "email":
            return send_email_otp(destination, code)
        if channel == "phone":
            return send_sms_otp(destination, code)
    except Exception as exc:
        return {"sent": False, "reason": str(exc)}
    return {"sent": False, "reason": "unsupported_channel"}


def mask_contact(destination, channel):
    value = str(destination or "")
    if channel == "email" and "@" in value:
        local, domain = value.split("@", 1)
        visible = local[:2] if len(local) > 2 else local[:1]
        return f"{visible}{'*' * max(2, len(local) - len(visible))}@{domain}"
    if channel == "phone":
        digits = normalize_account_phone(value)
        return f"******{digits[-4:]}" if len(digits) >= 4 else "phone number"
    return "registered contact"


def create_otp_challenge(conn, account_row, channel, destination):
    latest = conn.execute(
        """
        SELECT created_at
        FROM account_otp_codes
        WHERE account_id = ? AND consumed_at = ''
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (account_row["id"],),
    ).fetchone()
    latest_created_at = parse_db_datetime(latest["created_at"]) if latest else None
    if latest_created_at:
        seconds_since = (datetime.now(UTC).replace(tzinfo=None) - latest_created_at.replace(tzinfo=None)).total_seconds()
        if seconds_since < OTP_RESEND_SECONDS:
            wait_seconds = max(1, int(OTP_RESEND_SECONDS - seconds_since))
            return None, {"error": f"Please wait {wait_seconds} seconds before requesting another OTP.", "status": 429}

    code = make_otp_code()
    otp_id = f"otp_{secrets.token_hex(12)}"
    expires_at = datetime.now(UTC) + timedelta(minutes=OTP_EXPIRY_MINUTES)
    conn.execute(
        """
        UPDATE account_otp_codes
        SET consumed_at = ?
        WHERE account_id = ? AND consumed_at = ''
        """,
        (datetime.now(UTC).isoformat(), account_row["id"]),
    )
    conn.execute(
        """
        INSERT INTO account_otp_codes (
            id, account_id, channel, destination, code_hash, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (otp_id, account_row["id"], channel, destination, hash_password(code), expires_at.isoformat()),
    )
    return {"id": otp_id, "code": code, "expires_at": expires_at}, None


def get_account_context_from_token(token):
    token_hash = hash_session_token(token)
    now_iso = datetime.now(UTC).isoformat()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        row = conn.execute(
            """
            SELECT account_sessions.id AS session_id,
                   account_sessions.expires_at,
                   account_sessions.revoked_at,
                   customer_accounts.id,
                   customer_accounts.customer_id,
                   customer_accounts.email,
                   customer_accounts.phone,
                   customer_accounts.name,
                   customer_accounts.business_id,
                   customer_accounts.warehouse_id,
                   customer_accounts.role_key,
                   customer_accounts.status
            FROM account_sessions
            JOIN customer_accounts ON customer_accounts.id = account_sessions.account_id
            WHERE account_sessions.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if not row or row["revoked_at"]:
            raise PermissionError("Session expired. Please login again.")
        if row["status"] != "Active":
            raise PermissionError("This CinchPOS account is not active.")
        if row["expires_at"] <= now_iso:
            raise PermissionError("Session expired. Please login again.")
        conn.execute(
            "UPDATE account_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
            (row["session_id"],),
        )
        conn.commit()
    return build_account_auth_context(row, row["session_id"])


def get_request_auth_context(required=False):
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        try:
            if token.startswith("cinch_") or "." not in token:
                return get_account_context_from_token(token)
            return build_clerk_auth_context(verify_clerk_token(token))
        except PermissionError:
            raise
        except Exception as exc:
            raise PermissionError(f"Invalid authentication token. {exc}") from exc

    if AUTH_REQUIRED or required:
        raise PermissionError("Authentication is required.")

    return build_local_auth_context()


def has_permission(context, permission):
    permissions = context.get("permissions", [])
    return not permission or "*" in permissions or permission in permissions


def log_auth_event(event_type, context=None, detail=None):
    context = context or current_auth_context()
    device = request.headers.get("User-Agent", "")
    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO auth_audit_logs (
                event_type, user_id, business_id, device_info, detail_json
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                event_type,
                context.get("user_id", ""),
                context.get("business_id", DEFAULT_BUSINESS_ID),
                device,
                json_dumps(detail or {}),
            ),
        )
        conn.commit()


def require_permission(permission=None):
    def decorator(handler):
        @wraps(handler)
        def wrapper(*args, **kwargs):
            try:
                context = get_request_auth_context()
                if not has_permission(context, permission):
                    return jsonify({"error": "You do not have permission to perform this action."}), 403
                if context.get("mfa_required") and not context.get("mfa_verified"):
                    return jsonify({"error": "Multi-factor verification is required for this role."}), 403
                g.auth_context = context
            except PermissionError as exc:
                return jsonify({"error": str(exc)}), 401
            return handler(*args, **kwargs)
        return wrapper
    return decorator


def create_clerk_invitation(email, role_key, business_id):
    if not CLERK_SECRET_KEY:
        return {"status": "not_configured", "id": ""}
    payload = {
        "email_address": email,
        "public_metadata": {
            "business_id": business_id,
            "role": role_key,
        },
    }
    data = json_dumps(payload).encode("utf-8")
    request_obj = urlrequest.Request(
        "https://api.clerk.com/v1/invitations",
        data=data,
        headers={
            "Authorization": f"Bearer {CLERK_SECRET_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlrequest.urlopen(request_obj, timeout=10) as response:
            body = response.read().decode("utf-8")
            payload = json_loads(body, {})
            return {
                "status": payload.get("status") or "created",
                "id": payload.get("id") or "",
            }
    except URLError as exc:
        return {"status": "failed", "id": "", "error": str(exc)}


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


def ensure_auth_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS businesses (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_user_id TEXT DEFAULT '',
            status TEXT DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS warehouses (
            id TEXT PRIMARY KEY,
            business_id TEXT NOT NULL,
            name TEXT NOT NULL,
            location TEXT DEFAULT '',
            status TEXT DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS roles (
            business_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            name TEXT NOT NULL,
            is_custom INTEGER DEFAULT 0,
            permissions_json TEXT NOT NULL DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (business_id, role_key),
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS business_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clerk_user_id TEXT NOT NULL,
            business_id TEXT NOT NULL,
            warehouse_id TEXT DEFAULT 'main',
            role_key TEXT NOT NULL DEFAULT 'employee',
            permissions_json TEXT NOT NULL DEFAULT '[]',
            status TEXT DEFAULT 'Active',
            email TEXT DEFAULT '',
            name TEXT DEFAULT '',
            mfa_required INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (clerk_user_id, business_id),
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS employee_invitations (
            id TEXT PRIMARY KEY,
            business_id TEXT NOT NULL,
            email TEXT NOT NULL,
            name TEXT DEFAULT '',
            role_key TEXT NOT NULL,
            permissions_json TEXT NOT NULL DEFAULT '[]',
            status TEXT DEFAULT 'Pending',
            clerk_invitation_id TEXT DEFAULT '',
            invited_by TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS auth_audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            user_id TEXT DEFAULT '',
            business_id TEXT DEFAULT 'primary',
            device_info TEXT DEFAULT '',
            detail_json TEXT NOT NULL DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS offline_session_grants (
            id TEXT PRIMARY KEY,
            clerk_user_id TEXT NOT NULL,
            business_id TEXT NOT NULL,
            warehouse_id TEXT DEFAULT 'main',
            role_key TEXT NOT NULL,
            permissions_json TEXT NOT NULL DEFAULT '[]',
            expires_at TEXT NOT NULL,
            revoked_at TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_accounts (
            id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            business_id TEXT NOT NULL,
            warehouse_id TEXT DEFAULT 'main',
            role_key TEXT NOT NULL DEFAULT 'owner',
            status TEXT DEFAULT 'Active',
            email TEXT DEFAULT '',
            phone TEXT DEFAULT '',
            name TEXT DEFAULT '',
            failed_login_count INTEGER DEFAULT 0,
            locked_until TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login_at TEXT DEFAULT '',
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_otp_codes (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            destination TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            attempts INTEGER DEFAULT 0,
            expires_at TEXT NOT NULL,
            consumed_at TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES customer_accounts (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS account_sessions (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            business_id TEXT NOT NULL,
            warehouse_id TEXT DEFAULT 'main',
            expires_at TEXT NOT NULL,
            revoked_at TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (account_id) REFERENCES customer_accounts (id),
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS workspace_snapshots (
            business_id TEXT PRIMARY KEY,
            payload_json TEXT NOT NULL DEFAULT '{}',
            updated_by TEXT DEFAULT '',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS online_stores (
            id TEXT PRIMARY KEY,
            business_id TEXT NOT NULL UNIQUE,
            public_code TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL UNIQUE,
            store_name TEXT NOT NULL,
            contact_phone TEXT DEFAULT '',
            contact_email TEXT DEFAULT '',
            address TEXT DEFAULT '',
            logo_url TEXT DEFAULT '',
            sync_token TEXT DEFAULT '',
            status TEXT DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS online_products (
            id TEXT PRIMARY KEY,
            store_id TEXT NOT NULL,
            business_id TEXT NOT NULL,
            product_key TEXT NOT NULL,
            name TEXT NOT NULL,
            barcode TEXT DEFAULT '',
            barcodes_json TEXT NOT NULL DEFAULT '[]',
            category TEXT DEFAULT '',
            hsn TEXT DEFAULT '',
            unit TEXT DEFAULT 'Pcs',
            stock REAL DEFAULT 0,
            offline_price REAL DEFAULT 0,
            online_price REAL DEFAULT 0,
            mrp REAL DEFAULT 0,
            gst_rate REAL DEFAULT 0,
            image_url TEXT DEFAULT '',
            status TEXT DEFAULT 'Active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (business_id, product_key),
            FOREIGN KEY (store_id) REFERENCES online_stores (id),
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS online_orders (
            id TEXT PRIMARY KEY,
            store_id TEXT NOT NULL,
            business_id TEXT NOT NULL,
            invoice_number TEXT NOT NULL UNIQUE,
            customer_name TEXT NOT NULL,
            customer_phone TEXT DEFAULT '',
            customer_email TEXT DEFAULT '',
            customer_address TEXT DEFAULT '',
            items_json TEXT NOT NULL DEFAULT '[]',
            subtotal REAL DEFAULT 0,
            gst_total REAL DEFAULT 0,
            discount_total REAL DEFAULT 0,
            total REAL DEFAULT 0,
            status TEXT DEFAULT 'Placed',
            payment_status TEXT DEFAULT 'Unpaid',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (store_id) REFERENCES online_stores (id),
            FOREIGN KEY (business_id) REFERENCES businesses (id)
        )
        """
    )
    ensure_default_auth_records(conn)


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
        ensure_auth_schema(conn)
        conn.commit()

    ensure_column("customers", "email", "TEXT DEFAULT ''")
    ensure_column("customers", "address", "TEXT DEFAULT ''")
    ensure_column("customers", "phone", "TEXT DEFAULT ''")
    ensure_column("customers", "business_name", "TEXT DEFAULT ''")
    ensure_column("customers", "business_id", f"TEXT DEFAULT '{DEFAULT_BUSINESS_ID}'")
    ensure_column("invoices", "total_paid", "REAL DEFAULT 0")
    ensure_column("invoices", "status", "TEXT DEFAULT 'Pending'")
    ensure_column("invoices", "notes", "TEXT DEFAULT ''")
    ensure_column("invoices", "business_id", f"TEXT DEFAULT '{DEFAULT_BUSINESS_ID}'")
    ensure_column("invoices", "warehouse_id", f"TEXT DEFAULT '{DEFAULT_WAREHOUSE_ID}'")
    ensure_column("payments", "method", "TEXT DEFAULT 'Bank Transfer'")
    ensure_column("payments", "notes", "TEXT DEFAULT ''")
    ensure_column("payments", "business_id", f"TEXT DEFAULT '{DEFAULT_BUSINESS_ID}'")
    ensure_column("customer_accounts", "failed_login_count", "INTEGER DEFAULT 0")
    ensure_column("customer_accounts", "locked_until", "TEXT DEFAULT ''")
    ensure_column("customer_accounts", "phone", "TEXT DEFAULT ''")
    ensure_column("customer_accounts", "username", "TEXT DEFAULT ''")
    ensure_column("online_stores", "sync_token", "TEXT DEFAULT ''")

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        migrate_customer_account_usernames(conn)
        for statement in DB_INDEX_STATEMENTS:
            conn.execute(statement)
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
        "businessName": row["business_name"] or "",
        "business_name": row["business_name"] or "",
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


def count_billing_records_for_business(conn, business_id):
    return {
        "customers": conn.execute(
            "SELECT COUNT(*) AS total FROM customers WHERE business_id = ?",
            (business_id,),
        ).fetchone()["total"],
        "invoices": conn.execute(
            "SELECT COUNT(*) AS total FROM invoices WHERE business_id = ?",
            (business_id,),
        ).fetchone()["total"],
        "payments": conn.execute(
            "SELECT COUNT(*) AS total FROM payments WHERE business_id = ?",
            (business_id,),
        ).fetchone()["total"],
    }


def create_database_backup(reason="recovery"):
    database_path = os.path.abspath(DATABASE)
    backup_dir = os.path.join(os.path.dirname(database_path), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    safe_reason = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(reason or "backup")).strip("-") or "backup"
    backup_path = os.path.join(backup_dir, f"database-before-{safe_reason}-{timestamp}.db")
    with closing(sqlite3.connect(database_path)) as source_conn, closing(sqlite3.connect(backup_path)) as backup_conn:
        source_conn.backup(backup_conn)
    return backup_path


def slugify_store_name(value):
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug[:48].strip("-") or "store"


def generate_online_public_code(conn):
    for _ in range(300):
        candidate = f"{secrets.randbelow(10000):04d}"
        existing = conn.execute(
            "SELECT 1 FROM online_stores WHERE public_code = ?",
            (candidate,),
        ).fetchone()
        if not existing:
            return candidate
    raise RuntimeError("Could not generate a unique online store code.")


def normalize_online_public_code(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "")).upper()[:16]


def online_public_code_is_available(conn, public_code, store_id=""):
    if not public_code:
        return False
    existing = conn.execute(
        "SELECT id FROM online_stores WHERE public_code = ?",
        (public_code,),
    ).fetchone()
    return not existing or existing["id"] == store_id


def build_online_store_slug(store_name, public_code):
    return f"{slugify_store_name(store_name)}-{slugify_store_name(public_code)}"


def generate_online_invoice_number(conn):
    prefix = datetime.now(UTC).strftime("WEB-%Y%m%d")
    suffix = 1
    while True:
        candidate = f"{prefix}-{suffix:04d}"
        existing = conn.execute(
            "SELECT 1 FROM online_orders WHERE invoice_number = ?",
            (candidate,),
        ).fetchone()
        if not existing:
            return candidate
        suffix += 1


def serialize_online_store(row):
    if not row:
        return None
    public_url = f"{PUBLIC_STORE_BASE_URL}/{row['slug']}/online-store"
    return {
        "id": row["id"],
        "business_id": row["business_id"],
        "public_code": row["public_code"],
        "slug": row["slug"],
        "store_name": row["store_name"],
        "contact_phone": row["contact_phone"] or "",
        "contact_email": row["contact_email"] or "",
        "address": row["address"] or "",
        "logo_url": row["logo_url"] or "",
        "status": row["status"] or "Active",
        "public_url": public_url,
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def serialize_online_product(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "product_key": row["product_key"],
        "name": row["name"],
        "barcode": row["barcode"] or "",
        "barcodes": json_loads(row["barcodes_json"], []),
        "category": row["category"] or "",
        "hsn": row["hsn"] or "",
        "unit": row["unit"] or "Pcs",
        "stock": format_money(row["stock"]),
        "offline_price": format_money(row["offline_price"]),
        "online_price": format_money(row["online_price"]),
        "mrp": format_money(row["mrp"]),
        "gst_rate": format_money(row["gst_rate"]),
        "image_url": row["image_url"] or "",
        "status": row["status"] or "Active",
        "updated_at": row["updated_at"],
    }


def open_public_sync_request(request_obj, timeout=12):
    if certifi:
        context = ssl.create_default_context(cafile=certifi.where())
        return urlrequest.urlopen(request_obj, timeout=timeout, context=context)
    return urlrequest.urlopen(request_obj, timeout=timeout)


def sync_online_store_public_catalog(store_row, products):
    if app.config.get("TESTING"):
        return {"status": "skipped", "reason": "testing"}
    if not PUBLIC_STORE_SYNC_URL:
        return {"status": "skipped", "reason": "sync_url_not_configured"}
    sync_token = row_get(store_row, "sync_token")
    if not sync_token:
        return {"status": "skipped", "reason": "sync_token_missing"}

    payload = {
        "store": serialize_online_store(store_row),
        "products": products,
        "sync_token": sync_token,
    }
    request_obj = urlrequest.Request(
        PUBLIC_STORE_SYNC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "CinchPOS-Desktop/1.0",
        },
        method="POST",
    )
    try:
        with open_public_sync_request(request_obj, timeout=12) as response:
            body = response.read().decode("utf-8")
            response_payload = json_loads(body, {})
            return {
                "status": response_payload.get("status") or "synced",
                "store_url": response_payload.get("store", {}).get("public_url") or payload["store"].get("public_url"),
                "synced_count": response_payload.get("published_count", len(products)),
            }
    except HTTPError as exc:
        try:
            body = exc.read().decode("utf-8")
        except Exception:
            body = ""
        response_payload = json_loads(body, {})
        return {"status": "failed", "error": response_payload.get("error") or str(exc)}
    except URLError as exc:
        return {"status": "failed", "error": str(exc)}


def get_online_store_by_business(conn, business_id):
    return conn.execute(
        "SELECT * FROM online_stores WHERE business_id = ?",
        (business_id,),
    ).fetchone()


def get_online_store_by_slug(conn, slug):
    return conn.execute(
        "SELECT * FROM online_stores WHERE slug = ? AND status = 'Active'",
        (slug,),
    ).fetchone()


def normalize_online_product(product):
    product_key = str(product.get("id") or product.get("product_key") or product.get("productKey") or "").strip()
    name = str(product.get("name") or product.get("itemName") or "").strip()
    barcodes = product.get("barcodes")
    if not isinstance(barcodes, list):
        barcodes = []
    barcode = str(product.get("barcode") or (barcodes[0] if barcodes else "") or "").strip()
    if barcode and barcode not in barcodes:
        barcodes = [barcode, *barcodes]
    offline_price = format_money(product.get("offline_price") or product.get("offlinePrice") or product.get("price") or 0)
    online_price = format_money(product.get("online_price") or product.get("onlinePrice") or offline_price)
    return {
        "id": product_key,
        "product_key": product_key,
        "name": name,
        "barcode": barcode,
        "barcodes": [str(value).strip() for value in barcodes if str(value).strip()],
        "category": str(product.get("category") or "").strip(),
        "hsn": str(product.get("hsn") or product.get("hsnSac") or "").strip(),
        "unit": str(product.get("unit") or "Pcs").strip() or "Pcs",
        "stock": format_money(product.get("stock")),
        "offline_price": offline_price,
        "online_price": online_price,
        "mrp": format_money(product.get("mrp") or offline_price),
        "gst_rate": format_money(product.get("gst_rate") or product.get("gstRate") or 0),
        "image_url": str(product.get("image_url") or product.get("imageUrl") or "").strip(),
        "status": "Active" if str(product.get("status") or "Active").lower() != "inactive" else "Inactive",
    }


def get_online_store_products(conn, store_id, public_only=False):
    sql = """
        SELECT *
        FROM online_products
        WHERE store_id = ?
    """
    params = [store_id]
    if public_only:
        sql += " AND status = 'Active' AND stock > 0"
    sql += " ORDER BY name COLLATE NOCASE ASC"
    return [serialize_online_product(row) for row in conn.execute(sql, params).fetchall()]


def serialize_online_order(row):
    return {
        "id": row["id"],
        "invoice_number": row["invoice_number"],
        "customer_name": row["customer_name"],
        "customer_phone": row["customer_phone"] or "",
        "customer_email": row["customer_email"] or "",
        "customer_address": row["customer_address"] or "",
        "items": json_loads(row["items_json"], []),
        "subtotal": format_money(row["subtotal"]),
        "gst_total": format_money(row["gst_total"]),
        "discount_total": format_money(row["discount_total"]),
        "total": format_money(row["total"]),
        "status": row["status"] or "Placed",
        "payment_status": row["payment_status"] or "Unpaid",
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
    rows = conn.execute(
        """
        SELECT invoice_number
        FROM invoices
        WHERE invoice_number LIKE ?
        ORDER BY invoice_number DESC
        """,
        (f"{prefix}-%",),
    ).fetchall()
    max_suffix = 0
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
    for row in rows:
        match = pattern.match(row["invoice_number"] or "")
        if match:
            max_suffix = max(max_suffix, int(match.group(1)))
    suffix = max_suffix + 1
    while True:
        candidate = f"{prefix}-{suffix:03d}"
        existing = conn.execute(
            "SELECT 1 FROM invoices WHERE invoice_number = ?",
            (candidate,),
        ).fetchone()
        if not existing:
            return candidate
        suffix += 1


def get_sales_events(business_id=None):
    business_id = business_id or current_business_id()
    with closing(get_connection()) as conn:
        payment_rows = conn.execute(
            """
            SELECT paid_on AS sale_date, amount
            FROM payments
            WHERE business_id = ?
            ORDER BY paid_on ASC, id ASC
            """,
            (business_id,),
        ).fetchall()
        invoice_rows = conn.execute(
            """
            SELECT
                invoices.issued_on AS sale_date,
                CASE
                    WHEN invoices.total_paid - COALESCE(SUM(payments.amount), 0) > 0
                    THEN invoices.total_paid - COALESCE(SUM(payments.amount), 0)
                    ELSE 0
                END AS amount
            FROM invoices
            LEFT JOIN payments ON payments.invoice_id = invoices.id
            WHERE invoices.business_id = ?
              AND invoices.total_paid > 0
            GROUP BY invoices.id
            ORDER BY invoices.issued_on ASC, invoices.id ASC
            """,
            (business_id,),
        ).fetchall()

    events = []
    for row in [*payment_rows, *invoice_rows]:
        amount = float(row["amount"] or 0)
        if amount > 0:
            events.append({"sale_date": row["sale_date"], "amount": amount})
    return events


def get_summary_data(business_id=None):
    business_id = business_id or current_business_id()
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
            WHERE business_id = ?
            """
            ,
            (business_id,),
        ).fetchone()
    monthly_revenue = format_money(
        sum(
            event["amount"]
            for event in get_sales_events(business_id)
            if month_start <= event["sale_date"] <= today_iso
        )
    )
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


def get_recent_invoices(limit=5, business_id=None):
    business_id = business_id or current_business_id()
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
            WHERE invoices.business_id = ?
            ORDER BY invoices.issued_on DESC, invoices.id DESC
            LIMIT ?
            """,
            (business_id, limit),
        ).fetchall()
    return [serialize_invoice(invoice) for invoice in invoices]


def get_alerts(limit=6, business_id=None):
    business_id = business_id or current_business_id()
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
              AND invoices.business_id = ?
              AND invoices.due_on < ?
            ORDER BY invoices.due_on ASC
            LIMIT ?
            """,
            (business_id, today_iso, limit),
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
              AND invoices.business_id = ?
              AND invoices.due_on = ?
            ORDER BY invoices.id DESC
            LIMIT ?
            """,
            (business_id, today_iso, limit),
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


def get_trend_data(view, start_date=None, end_date=None, business_id=None):
    business_id = business_id or current_business_id()
    today = today_value()
    events = get_sales_events(business_id)

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
        for event in events:
            sale_date = parse_date(event["sale_date"], "sale_date")
            key = sale_date.strftime("%Y-%m")
            if key in totals:
                totals[key] += float(event["amount"] or 0)
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
        for event in events:
            sale_date = parse_date(event["sale_date"], "sale_date")
            week_start = sale_date - timedelta(days=sale_date.weekday())
            key = week_start.isoformat()
            if key in totals:
                totals[key] += float(event["amount"] or 0)
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
        for event in events:
            sale_date = parse_date(event["sale_date"], "sale_date").isoformat()
            if sale_date in totals:
                totals[sale_date] += float(event["amount"] or 0)
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
        for event in events:
            sale_date = parse_date(event["sale_date"], "sale_date").isoformat()
            if sale_date in totals:
                totals[sale_date] += float(event["amount"] or 0)
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
                "/api/auth/context",
                "/api/auth/businesses",
                "/api/auth/roles",
                "/api/auth/invitations",
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


@app.route("/api/auth/context", methods=["GET"])
@require_permission()
def auth_context_endpoint():
    context = current_auth_context()
    return jsonify(
        {
            "auth_required": AUTH_REQUIRED,
            "configured": True,
            "cinchpos_accounts": True,
            "password_rules": PASSWORD_RULES,
            "context": context,
            "permissions": PERMISSIONS,
            "role_permissions": {key: list(value) for key, value in ROLE_PERMISSION_MATRIX.items()},
        }
    )


@app.route("/api/auth/password-rules", methods=["GET"])
def auth_password_rules():
    return jsonify({"rules": PASSWORD_RULES})


@app.route("/api/auth/register", methods=["POST"])
def register_customer_account():
    data = request.get_json() or {}
    password = str(data.get("password") or "")
    confirm_password = str(data.get("confirm_password") or data.get("confirmPassword") or password)
    if password != confirm_password:
        return jsonify({"error": "Password and confirmation do not match."}), 400
    errors = password_validation_errors(password)
    if errors:
        return jsonify({"error": " ".join(errors), "password_errors": errors}), 400

    business_name = (data.get("business_name") or data.get("businessName") or "").strip()
    contact = str(data.get("contact") or data.get("identifier") or "").strip()
    email = normalize_account_email(data.get("email") or (contact if "@" in contact else ""))
    phone = normalize_account_phone(data.get("phone") or (contact if "@" not in contact else ""))
    if not business_name:
        return jsonify({"error": "Business name is required."}), 400
    if email and "@" not in email:
        return jsonify({"error": "Enter a valid email id."}), 400
    if phone and len(phone) != 10:
        return jsonify({"error": "Enter a valid 10 digit phone number."}), 400
    if not email and not phone:
        return jsonify({"error": "Email id or phone number is required."}), 400
    display_name = business_name
    account_id = f"acct_{secrets.token_hex(12)}"

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        migrate_customer_account_usernames(conn)
        requested_username = account_username_from_payload(data)
        try:
            username = validate_username(requested_username) if requested_username else generate_account_username(
                conn,
                business_name,
                email,
                phone,
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        if requested_username and conn.execute(
            "SELECT 1 FROM customer_accounts WHERE username = ?",
            (username,),
        ).fetchone():
            return jsonify({"error": "This username is already registered."}), 409
        if email and conn.execute(
            "SELECT 1 FROM customer_accounts WHERE lower(email) = ?",
            (email,),
        ).fetchone():
            return jsonify({"error": "This email id is already registered."}), 409
        if phone and conn.execute(
            "SELECT 1 FROM customer_accounts WHERE phone = ?",
            (phone,),
        ).fetchone():
            return jsonify({"error": "This phone number is already registered."}), 409

        customer_id = generate_customer_account_id(conn)
        business_id = safe_identifier(username, "biz")
        warehouse_id = f"{business_id}_main"
        conn.execute(
            """
            INSERT INTO businesses (id, name, owner_user_id, status)
            VALUES (?, ?, ?, 'Active')
            """,
            (business_id, business_name, account_id),
        )
        conn.execute(
            """
            INSERT INTO warehouses (id, business_id, name, status)
            VALUES (?, ?, 'Main Warehouse', 'Active')
            """,
            (warehouse_id, business_id),
        )
        ensure_roles_for_business(conn, business_id)
        conn.execute(
            """
            INSERT INTO customer_accounts (
                id, customer_id, username, password_hash, business_id, warehouse_id,
                role_key, status, email, phone, name, last_login_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'owner', 'Active', ?, ?, ?, ?)
            """,
            (
                account_id,
                customer_id,
                username,
                hash_password(password),
                business_id,
                warehouse_id,
                email,
                phone,
                display_name,
                datetime.now(UTC).isoformat(),
            ),
        )
        conn.execute(
            """
            INSERT INTO business_memberships (
                clerk_user_id, business_id, warehouse_id, role_key,
                permissions_json, status, email, name, mfa_required
            )
            VALUES (?, ?, ?, 'owner', ?, 'Active', ?, ?, 0)
            """,
            (
                account_id,
                business_id,
                warehouse_id,
                json_dumps(list(ALL_PERMISSIONS)),
                email,
                display_name,
            ),
        )
        account_row = conn.execute(
            "SELECT * FROM customer_accounts WHERE id = ?",
            (account_id,),
        ).fetchone()
        token, session_id, expires_at = create_account_session(conn, account_row)
        conn.commit()

    context = build_account_auth_context(account_row, session_id)
    g.auth_context = context
    log_auth_event("customer_account.registered", context, {"username": username, "customer_id": customer_id})
    return jsonify(
        {
            "token": token,
            "expires_at": expires_at.isoformat(),
            "account": serialize_customer_account(account_row),
            "context": context,
            "auth_required": AUTH_REQUIRED,
            "configured": True,
        }
    ), 201


@app.route("/api/auth/login", methods=["POST"])
def login_customer_account():
    data = request.get_json() or {}
    identifier = str(account_identifier_from_payload(data) or "").strip()
    password = str(data.get("password") or "")
    if not identifier or not password:
        return jsonify({"error": "Email id or phone number and password are required."}), 400

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        migrate_customer_account_usernames(conn)
        account_row = find_account_for_login_identifier(conn, identifier)
        now_iso = datetime.now(UTC).isoformat()
        if not account_row or account_row["status"] != "Active":
            return jsonify({"error": "Invalid login detail or password."}), 401
        if account_row["locked_until"] and account_row["locked_until"] > now_iso:
            return jsonify({"error": "Account is temporarily locked. Please try again later."}), 423
        if not verify_password(password, account_row["password_hash"]):
            next_failed_count = int(account_row["failed_login_count"] or 0) + 1
            locked_until = ""
            if next_failed_count >= LOGIN_LOCK_THRESHOLD:
                locked_until = (datetime.now(UTC) + timedelta(minutes=LOGIN_LOCK_MINUTES)).isoformat()
                next_failed_count = 0
            conn.execute(
                """
                UPDATE customer_accounts
                SET failed_login_count = ?,
                    locked_until = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (next_failed_count, locked_until, account_row["id"]),
            )
            conn.commit()
            return jsonify({"error": "Invalid login detail or password."}), 401
        conn.execute(
            """
            UPDATE customer_accounts
            SET last_login_at = ?,
                failed_login_count = 0,
                locked_until = '',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (now_iso, account_row["id"]),
        )
        token, session_id, expires_at = create_account_session(conn, account_row)
        conn.commit()

    context = build_account_auth_context(account_row, session_id)
    g.auth_context = context
    log_auth_event("customer_account.login", context, {"identifier": identifier, "customer_id": context.get("customer_id")})
    return jsonify(
        {
            "token": token,
            "expires_at": expires_at.isoformat(),
            "account": serialize_customer_account(account_row),
            "context": context,
            "auth_required": AUTH_REQUIRED,
            "configured": True,
        }
    )


@app.route("/api/auth/otp/request", methods=["POST"])
def request_account_otp():
    data = request.get_json() or {}
    identifier = account_identifier_from_payload(data)
    if not identifier:
        return jsonify({"error": "Enter your email id or phone number."}), 400

    identifier_value = str(identifier or "").strip()
    requested_channel = str(data.get("channel") or "").strip().lower()
    channel = requested_channel if requested_channel in {"email", "phone"} else ""
    if not channel:
        channel = "email" if "@" in identifier_value else "phone"

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        account_row = find_account_for_login_identifier(conn, identifier_value)
        if not account_row or account_row["status"] != "Active":
            return jsonify(
                {
                    "ok": True,
                    "message": "If an active CinchPOS account matches this detail, an OTP will be sent.",
                    "expires_in_minutes": OTP_EXPIRY_MINUTES,
                }
            )

        destination = normalize_account_email(account_row["email"]) if channel == "email" else normalize_account_phone(account_row["phone"])
        if not destination:
            return jsonify({"error": f"No {channel} is linked with this CinchPOS account."}), 400

        challenge, blocked = create_otp_challenge(conn, account_row, channel, destination)
        if blocked:
            status = int(blocked.pop("status", 429))
            return jsonify(blocked), status

        delivery = deliver_otp(channel, destination, challenge["code"])
        if not delivery["sent"] and not EXPOSE_DEV_OTP and AUTH_REQUIRED:
            conn.rollback()
            if channel == "phone" and delivery["reason"] == "sms_not_configured":
                return jsonify({"error": "Phone OTP is not configured yet. Add an SMS provider before using phone OTP."}), 503
            return jsonify({"error": "OTP delivery is not configured. Add SMTP settings for support@cinchpos.in."}), 503

        conn.commit()

    response = {
        "ok": True,
        "channel": channel,
        "masked_destination": mask_contact(destination, channel),
        "expires_in_minutes": OTP_EXPIRY_MINUTES,
        "message": f"OTP sent to {mask_contact(destination, channel)}.",
    }
    if EXPOSE_DEV_OTP or not AUTH_REQUIRED:
        response["dev_otp"] = challenge["code"]
        if not delivery["sent"]:
            response["delivery_warning"] = delivery["reason"]
    return jsonify(response)


@app.route("/api/auth/otp/verify", methods=["POST"])
def verify_account_otp():
    data = request.get_json() or {}
    identifier = account_identifier_from_payload(data)
    code = re.sub(r"\D+", "", str(data.get("otp") or data.get("code") or ""))
    if not identifier or not code:
        return jsonify({"error": "Enter your email id or phone number and OTP."}), 400

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        account_row = find_account_for_login_identifier(conn, identifier)
        now_iso = datetime.now(UTC).isoformat()
        if not account_row or account_row["status"] != "Active":
            return jsonify({"error": "Invalid or expired OTP."}), 401
        otp_row = conn.execute(
            """
            SELECT *
            FROM account_otp_codes
            WHERE account_id = ? AND consumed_at = '' AND expires_at > ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (account_row["id"], now_iso),
        ).fetchone()
        if not otp_row:
            return jsonify({"error": "Invalid or expired OTP."}), 401
        if int(otp_row["attempts"] or 0) >= OTP_MAX_ATTEMPTS:
            return jsonify({"error": "Too many OTP attempts. Request a fresh OTP."}), 429
        if not verify_password(code, otp_row["code_hash"]):
            conn.execute(
                """
                UPDATE account_otp_codes
                SET attempts = attempts + 1
                WHERE id = ?
                """,
                (otp_row["id"],),
            )
            conn.commit()
            return jsonify({"error": "Invalid or expired OTP."}), 401

        consumed_at = datetime.now(UTC).isoformat()
        conn.execute(
            """
            UPDATE account_otp_codes
            SET consumed_at = ?
            WHERE id = ?
            """,
            (consumed_at, otp_row["id"]),
        )
        conn.execute(
            """
            UPDATE customer_accounts
            SET last_login_at = ?,
                failed_login_count = 0,
                locked_until = '',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (consumed_at, account_row["id"]),
        )
        token, session_id, expires_at = create_account_session(conn, account_row)
        conn.commit()

    context = build_account_auth_context(account_row, session_id)
    g.auth_context = context
    log_auth_event("customer_account.otp_login", context, {"channel": otp_row["channel"]})
    return jsonify(
        {
            "token": token,
            "expires_at": expires_at.isoformat(),
            "account": serialize_customer_account(account_row),
            "context": context,
            "auth_required": AUTH_REQUIRED,
            "configured": True,
        }
    )


@app.route("/api/auth/logout", methods=["POST"])
def logout_customer_account():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        if token.startswith("cinch_") or "." not in token:
            with closing(get_connection()) as conn:
                ensure_auth_schema(conn)
                conn.execute(
                    """
                    UPDATE account_sessions
                    SET revoked_at = ?
                    WHERE token_hash = ? AND revoked_at = ''
                    """,
                    (datetime.now(UTC).isoformat(), hash_session_token(token)),
                )
                conn.commit()
    return jsonify({"ok": True})


@app.route("/api/auth/businesses", methods=["GET"])
@require_permission("business:read")
def list_businesses():
    context = current_auth_context()
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT businesses.id, businesses.name, businesses.owner_user_id,
                   businesses.status, businesses.created_at, businesses.updated_at,
                   business_memberships.role_key
            FROM businesses
            JOIN business_memberships ON business_memberships.business_id = businesses.id
            WHERE business_memberships.clerk_user_id = ?
               OR ? = 'local-owner'
            ORDER BY businesses.name ASC
            """,
            (context["user_id"], context["user_id"]),
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/auth/businesses", methods=["POST"])
@require_permission("business:write")
def create_business():
    context = current_auth_context()
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Business name is required."}), 400
    business_id = (data.get("id") or f"business_{secrets.token_hex(6)}").strip()
    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO businesses (id, name, owner_user_id, status)
            VALUES (?, ?, ?, 'Active')
            """,
            (business_id, name, context["user_id"]),
        )
        conn.execute(
            """
            INSERT INTO warehouses (id, business_id, name, status)
            VALUES (?, ?, 'Main Warehouse', 'Active')
            """,
            (f"{business_id}_main", business_id),
        )
        conn.execute(
            """
            INSERT INTO business_memberships (
                clerk_user_id, business_id, warehouse_id, role_key,
                permissions_json, status, email, name, mfa_required
            )
            VALUES (?, ?, ?, 'owner', ?, 'Active', ?, ?, 1)
            """,
            (
                context["user_id"],
                business_id,
                f"{business_id}_main",
                json_dumps(list(ALL_PERMISSIONS)),
                context.get("email", ""),
                context.get("name", ""),
            ),
        )
        for role_key, permissions in ROLE_PERMISSION_MATRIX.items():
            conn.execute(
                """
                INSERT OR IGNORE INTO roles (
                    business_id, role_key, name, is_custom, permissions_json
                )
                VALUES (?, ?, ?, 0, ?)
                """,
                (
                    business_id,
                    role_key,
                    ROLE_LABELS.get(role_key, role_key.title()),
                    json_dumps(list(permissions)),
                ),
            )
        conn.commit()
    log_auth_event("business.created", context, {"business_id": business_id, "name": name})
    return jsonify({"id": business_id, "name": name, "status": "Active"}), 201


@app.route("/api/auth/warehouses", methods=["GET"])
@require_permission("warehouses:read")
def list_warehouses():
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT id, business_id, name, location, status, created_at, updated_at
            FROM warehouses
            WHERE business_id = ?
            ORDER BY name ASC
            """,
            (current_business_id(),),
        ).fetchall()
    return jsonify([dict(row) for row in rows])


@app.route("/api/auth/roles", methods=["GET"])
@require_permission("employees:read")
def list_roles():
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        ensure_roles_for_business(conn, DEFAULT_BUSINESS_ID)
        ensure_roles_for_business(conn, current_business_id())
        conn.commit()
        rows = conn.execute(
            """
            SELECT business_id, role_key, name, is_custom, permissions_json
            FROM roles
            WHERE business_id IN (?, ?)
            ORDER BY is_custom ASC, name ASC
            """,
            (DEFAULT_BUSINESS_ID, current_business_id()),
        ).fetchall()
    roles = []
    seen = set()
    for row in rows:
        key = row["role_key"]
        if key in seen:
            continue
        seen.add(key)
        roles.append(
            {
                "business_id": row["business_id"],
                "role_key": key,
                "name": row["name"],
                "is_custom": bool(row["is_custom"]),
                "permissions": normalize_permissions(json_loads(row["permissions_json"], [])),
            }
        )
    return jsonify({"roles": roles, "permissions": PERMISSIONS})


@app.route("/api/auth/roles", methods=["POST"])
@require_permission("roles:manage")
def create_role():
    data = request.get_json() or {}
    role_key = normalize_role_key(data.get("role_key") or data.get("name"))
    name = (data.get("name") or role_key.replace("_", " ").title()).strip()
    permissions = normalize_permissions(data.get("permissions") or [])
    if not permissions:
        return jsonify({"error": "At least one permission is required."}), 400
    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO roles (business_id, role_key, name, is_custom, permissions_json)
            VALUES (?, ?, ?, 1, ?)
            ON CONFLICT(business_id, role_key)
            DO UPDATE SET name = excluded.name,
                          permissions_json = excluded.permissions_json,
                          updated_at = CURRENT_TIMESTAMP
            """,
            (current_business_id(), role_key, name, json_dumps(permissions)),
        )
        conn.commit()
    log_auth_event("role.changed", detail={"role_key": role_key, "permissions": permissions})
    return jsonify({"role_key": role_key, "name": name, "permissions": permissions}), 201


@app.route("/api/auth/invitations", methods=["POST"])
@require_permission("employees:write")
def invite_employee():
    context = current_auth_context()
    data = request.get_json() or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    role_key = normalize_role_key(data.get("role") or data.get("role_key") or "employee")
    default_permissions = normalize_permissions(permissions_for_role(role_key))
    requested_permissions = normalize_permissions(data.get("permissions") or default_permissions)
    if set(requested_permissions) != set(default_permissions) and not has_permission(context, "roles:manage"):
        return jsonify({"error": "Only the owner or a role manager can customize employee access."}), 403
    permissions = requested_permissions
    if not email or "@" not in email:
        return jsonify({"error": "A valid employee email is required."}), 400
    clerk_result = create_clerk_invitation(email, role_key, context["business_id"])
    invitation_id = f"invite_{secrets.token_hex(8)}"
    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO employee_invitations (
                id, business_id, email, name, role_key, permissions_json,
                status, clerk_invitation_id, invited_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                invitation_id,
                context["business_id"],
                email,
                name,
                role_key,
                json_dumps(permissions),
                clerk_result.get("status") or "Pending",
                clerk_result.get("id") or "",
                context["user_id"],
            ),
        )
        conn.commit()
    log_auth_event(
        "employee.invited",
        context,
        {"email": email, "role": role_key, "status": clerk_result.get("status")},
    )
    return jsonify(
        {
            "id": invitation_id,
            "email": email,
            "role": role_key,
            "permissions": permissions,
            "status": clerk_result.get("status") or "Pending",
            "clerk_invitation_id": clerk_result.get("id") or "",
            "error": clerk_result.get("error", ""),
        }
    ), 201


@app.route("/api/auth/offline-session", methods=["POST"])
@require_permission("billing:read")
def create_offline_session():
    context = current_auth_context()
    if not context.get("authenticated"):
        return jsonify({"error": "Online authentication is required before creating an offline session."}), 401
    expires_at = datetime.now(UTC) + timedelta(hours=OFFLINE_SESSION_HOURS)
    grant_id = f"offline_{secrets.token_hex(16)}"
    with closing(get_connection()) as conn:
        conn.execute(
            """
            INSERT INTO offline_session_grants (
                id, clerk_user_id, business_id, warehouse_id, role_key,
                permissions_json, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                grant_id,
                context["user_id"],
                context["business_id"],
                context["warehouse_id"],
                context["role"],
                json_dumps(context["permissions"]),
                expires_at.isoformat(),
            ),
        )
        conn.commit()
    log_auth_event("offline_session.created", context, {"expires_at": expires_at.isoformat()})
    return jsonify({"id": grant_id, "context": context, "expires_at": expires_at.isoformat()}), 201


@app.route("/api/auth/audit", methods=["GET"])
@require_permission("audit:read")
def list_auth_audit_logs():
    limit = min(200, max(1, int(request.args.get("limit") or 50)))
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT id, event_type, user_id, business_id, device_info, detail_json, created_at
            FROM auth_audit_logs
            WHERE business_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (current_business_id(), limit),
        ).fetchall()
    return jsonify([
        {
            **dict(row),
            "detail": json_loads(row["detail_json"], {}),
        }
        for row in rows
    ])


@app.route("/api/workspace/snapshot", methods=["GET"])
@require_permission("business:read")
def get_workspace_snapshot():
    business_id = current_business_id()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        row = conn.execute(
            """
            SELECT payload_json, updated_by, updated_at
            FROM workspace_snapshots
            WHERE business_id = ?
            """,
            (business_id,),
        ).fetchone()
    payload = json_loads(row["payload_json"], {}) if row else {}
    return jsonify(
        {
            "business_id": business_id,
            "payload": payload,
            "updated_by": row["updated_by"] if row else "",
            "updated_at": row["updated_at"] if row else "",
        }
    )


@app.route("/api/workspace/snapshot", methods=["PUT"])
@require_permission("business:write")
def save_workspace_snapshot():
    data = request.get_json() or {}
    payload = data.get("payload")
    if not isinstance(payload, dict):
        return jsonify({"error": "Workspace payload must be an object."}), 400
    context = current_auth_context()
    business_id = current_business_id()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        conn.execute(
            """
            INSERT INTO workspace_snapshots (
                business_id, payload_json, updated_by, updated_at
            )
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(business_id)
            DO UPDATE SET payload_json = excluded.payload_json,
                          updated_by = excluded.updated_by,
                          updated_at = CURRENT_TIMESTAMP
            """,
            (business_id, json_dumps(payload), context["user_id"]),
        )
        conn.commit()
    log_auth_event("workspace_snapshot.saved", context, {"keys": sorted(payload.keys())[:30]})
    return jsonify({"business_id": business_id, "updated_by": context["user_id"], "ok": True})


@app.route("/api/workspace/recover-local-billing", methods=["GET"])
@require_permission("business:read")
def get_recoverable_local_billing_data():
    business_id = current_business_id()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        local_counts = count_billing_records_for_business(conn, DEFAULT_BUSINESS_ID)
        current_counts = count_billing_records_for_business(conn, business_id)
    return jsonify(
        {
            "source_business_id": DEFAULT_BUSINESS_ID,
            "target_business_id": business_id,
            "recoverable": business_id != DEFAULT_BUSINESS_ID and any(local_counts.values()),
            "local_counts": local_counts,
            "current_counts": current_counts,
        }
    )


@app.route("/api/workspace/recover-local-billing", methods=["POST"])
@require_permission("business:write")
def recover_local_billing_data():
    context = current_auth_context()
    target_business_id = current_business_id()
    if not is_owner_context(context):
        return jsonify({"error": "Only the owner can recover previous local billing data."}), 403
    if target_business_id == DEFAULT_BUSINESS_ID:
        return jsonify({"error": "You are already viewing the previous local workspace."}), 400

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        source_counts = count_billing_records_for_business(conn, DEFAULT_BUSINESS_ID)
        if not any(source_counts.values()):
            return jsonify(
                {
                    "message": "No previous local billing data was found.",
                    "source_business_id": DEFAULT_BUSINESS_ID,
                    "target_business_id": target_business_id,
                    "recovered": source_counts,
                    "backup_path": "",
                }
            )

        conn.commit()
        backup_path = create_database_backup("local-billing-recovery")
        conn.execute(
            "UPDATE customers SET business_id = ? WHERE business_id = ?",
            (target_business_id, DEFAULT_BUSINESS_ID),
        )
        conn.execute(
            "UPDATE invoices SET business_id = ? WHERE business_id = ?",
            (target_business_id, DEFAULT_BUSINESS_ID),
        )
        conn.execute(
            "UPDATE payments SET business_id = ? WHERE business_id = ?",
            (target_business_id, DEFAULT_BUSINESS_ID),
        )
        conn.commit()
        target_counts = count_billing_records_for_business(conn, target_business_id)

    log_auth_event(
        "workspace.local_billing_recovered",
        context,
        {
            "source_business_id": DEFAULT_BUSINESS_ID,
            "target_business_id": target_business_id,
            "recovered": source_counts,
            "backup_path": backup_path,
        },
    )
    return jsonify(
        {
            "message": "Previous local billing data recovered.",
            "source_business_id": DEFAULT_BUSINESS_ID,
            "target_business_id": target_business_id,
            "recovered": source_counts,
            "current_counts": target_counts,
            "backup_path": backup_path,
        }
    )


@app.route("/api/online-store/profile", methods=["GET"])
@require_permission("sales:read")
def get_online_store_profile():
    business_id = current_business_id()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        store_row = get_online_store_by_business(conn, business_id)
        products = get_online_store_products(conn, store_row["id"]) if store_row else []
    return jsonify({"store": serialize_online_store(store_row), "products": products})


@app.route("/api/online-store/publish", methods=["PUT"])
@require_permission("sales:read")
def publish_online_store():
    data = request.get_json() or {}
    store_payload = data.get("store") if isinstance(data.get("store"), dict) else {}
    product_payloads = data.get("products") if isinstance(data.get("products"), list) else []
    store_name = str(store_payload.get("store_name") or store_payload.get("storeName") or "").strip()
    if not store_name:
        return jsonify({"error": "Store name is required before publishing online."}), 400
    normalized_products = [normalize_online_product(product) for product in product_payloads]
    normalized_products = [
        product for product in normalized_products
        if product["product_key"] and product["name"] and product["online_price"] > 0
    ]
    if not normalized_products:
        return jsonify({"error": "Select at least one product with a name and online price."}), 400

    business_id = current_business_id()
    context = current_auth_context()
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        store_row = get_online_store_by_business(conn, business_id)
        preferred_public_code = ""
        if context.get("source") == "cinchpos-account":
            preferred_public_code = normalize_online_public_code(context.get("customer_id"))
        if store_row:
            store_id = store_row["id"]
            public_code = store_row["public_code"]
            sync_token = row_get(store_row, "sync_token") or secrets.token_urlsafe(32)
            if (
                preferred_public_code
                and preferred_public_code != public_code
                and online_public_code_is_available(conn, preferred_public_code, store_id)
            ):
                public_code = preferred_public_code
        else:
            store_id = f"store_{secrets.token_hex(12)}"
            sync_token = secrets.token_urlsafe(32)
            if preferred_public_code and online_public_code_is_available(conn, preferred_public_code):
                public_code = preferred_public_code
            else:
                public_code = generate_online_public_code(conn)
        next_slug = build_online_store_slug(store_name, public_code)
        if store_row:
            conn.execute(
                """
                UPDATE online_stores
                SET public_code = ?,
                    slug = ?,
                    store_name = ?,
                    contact_phone = ?,
                    contact_email = ?,
                    address = ?,
                    logo_url = ?,
                    sync_token = ?,
                    status = 'Active',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    public_code,
                    next_slug,
                    store_name,
                    str(store_payload.get("contact_phone") or store_payload.get("contactPhone") or "").strip(),
                    str(store_payload.get("contact_email") or store_payload.get("contactEmail") or "").strip(),
                    str(store_payload.get("address") or "").strip(),
                    str(store_payload.get("logo_url") or store_payload.get("logoUrl") or "").strip(),
                    sync_token,
                    store_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO online_stores (
                    id, business_id, public_code, slug, store_name,
                    contact_phone, contact_email, address, logo_url, sync_token, status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')
                """,
                (
                    store_id,
                    business_id,
                    public_code,
                    next_slug,
                    store_name,
                    str(store_payload.get("contact_phone") or store_payload.get("contactPhone") or "").strip(),
                    str(store_payload.get("contact_email") or store_payload.get("contactEmail") or "").strip(),
                    str(store_payload.get("address") or "").strip(),
                    str(store_payload.get("logo_url") or store_payload.get("logoUrl") or "").strip(),
                    sync_token,
                ),
            )

        active_keys = {product["product_key"] for product in normalized_products}
        if active_keys:
            placeholders = ",".join("?" for _ in active_keys)
            conn.execute(
                f"""
                UPDATE online_products
                SET status = 'Inactive', updated_at = CURRENT_TIMESTAMP
                WHERE business_id = ? AND product_key NOT IN ({placeholders})
                """,
                [business_id, *active_keys],
            )
        for product in normalized_products:
            product_id = f"online_{business_id}_{product['product_key']}"
            conn.execute(
                """
                INSERT INTO online_products (
                    id, store_id, business_id, product_key, name, barcode,
                    barcodes_json, category, hsn, unit, stock, offline_price,
                    online_price, mrp, gst_rate, image_url, status, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', CURRENT_TIMESTAMP)
                ON CONFLICT(business_id, product_key)
                DO UPDATE SET store_id = excluded.store_id,
                              name = excluded.name,
                              barcode = excluded.barcode,
                              barcodes_json = excluded.barcodes_json,
                              category = excluded.category,
                              hsn = excluded.hsn,
                              unit = excluded.unit,
                              stock = excluded.stock,
                              offline_price = excluded.offline_price,
                              online_price = excluded.online_price,
                              mrp = excluded.mrp,
                              gst_rate = excluded.gst_rate,
                              image_url = excluded.image_url,
                              status = 'Active',
                              updated_at = CURRENT_TIMESTAMP
                """,
                (
                    product_id,
                    store_id,
                    business_id,
                    product["product_key"],
                    product["name"],
                    product["barcode"],
                    json_dumps(product["barcodes"]),
                    product["category"],
                    product["hsn"],
                    product["unit"],
                    product["stock"],
                    product["offline_price"],
                    product["online_price"],
                    product["mrp"],
                    product["gst_rate"],
                    product["image_url"],
                ),
            )
        conn.commit()
        store_row = get_online_store_by_business(conn, business_id)
        products = get_online_store_products(conn, store_row["id"])

    log_auth_event("online_store.published", context, {"products": len(normalized_products), "slug": next_slug})
    sync_result = sync_online_store_public_catalog(store_row, products)
    return jsonify({
        "store": serialize_online_store(store_row),
        "products": products,
        "published_count": len(normalized_products),
        "sync": sync_result,
    })


@app.route("/api/public/stores/<store_slug>", methods=["GET"])
def public_online_store(store_slug):
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        store_row = get_online_store_by_slug(conn, store_slug)
        if not store_row:
            return jsonify({"error": "Online store not found."}), 404
        products = get_online_store_products(conn, store_row["id"], public_only=True)
    return jsonify({"store": serialize_online_store(store_row), "products": products})


@app.route("/api/public/stores/<store_slug>/checkout", methods=["POST"])
def checkout_online_store(store_slug):
    data = request.get_json() or {}
    customer = data.get("customer") if isinstance(data.get("customer"), dict) else {}
    cart_items = data.get("items") if isinstance(data.get("items"), list) else []
    customer_name = str(customer.get("name") or "").strip()
    customer_phone = normalize_account_phone(customer.get("phone"))
    customer_email = normalize_account_email(customer.get("email"))
    customer_address = str(customer.get("address") or "").strip()
    if not customer_name:
        return jsonify({"error": "Customer name is required."}), 400
    if len(customer_phone) != 10:
        return jsonify({"error": "A valid 10 digit phone number is required."}), 400
    if not cart_items:
        return jsonify({"error": "Cart is empty."}), 400

    requested_quantities = {}
    for item in cart_items:
        product_id = str(item.get("id") or item.get("product_key") or item.get("productKey") or "").strip()
        quantity = int(float(item.get("quantity") or 0))
        if product_id and quantity > 0:
            requested_quantities[product_id] = requested_quantities.get(product_id, 0) + min(quantity, 999)
    if not requested_quantities:
        return jsonify({"error": "Cart is empty."}), 400

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        store_row = get_online_store_by_slug(conn, store_slug)
        if not store_row:
            return jsonify({"error": "Online store not found."}), 404
        product_rows = []
        for product_key, quantity in requested_quantities.items():
            row = conn.execute(
                """
                SELECT *
                FROM online_products
                WHERE store_id = ? AND product_key = ? AND status = 'Active'
                """,
                (store_row["id"], product_key),
            ).fetchone()
            if not row:
                return jsonify({"error": "One or more cart items are no longer available."}), 409
            if float(row["stock"] or 0) < quantity:
                return jsonify({"error": f"{row['name']} has only {format_money(row['stock'])} in stock."}), 409
            product_rows.append((row, quantity))

        order_items = []
        subtotal = 0.0
        gst_total = 0.0
        discount_total = 0.0
        total = 0.0
        for row, quantity in product_rows:
            online_price = format_money(row["online_price"])
            mrp = format_money(row["mrp"] or online_price)
            gst_rate = format_money(row["gst_rate"])
            line_total = format_money(online_price * quantity)
            taxable = format_money(line_total / (1 + (gst_rate / 100))) if gst_rate else line_total
            gst_amount = format_money(line_total - taxable)
            discount_amount = format_money(max(0, mrp - online_price) * quantity)
            subtotal += taxable
            gst_total += gst_amount
            discount_total += discount_amount
            total += line_total
            order_items.append(
                {
                    "id": row["product_key"],
                    "name": row["name"],
                    "barcode": row["barcode"] or "",
                    "quantity": quantity,
                    "unit": row["unit"] or "Pcs",
                    "mrp": mrp,
                    "price": online_price,
                    "gst_rate": gst_rate,
                    "taxable": taxable,
                    "gst_amount": gst_amount,
                    "total": line_total,
                }
            )

        order_id = f"order_{secrets.token_hex(12)}"
        invoice_number = generate_online_invoice_number(conn)
        conn.execute(
            """
            INSERT INTO online_orders (
                id, store_id, business_id, invoice_number, customer_name,
                customer_phone, customer_email, customer_address, items_json,
                subtotal, gst_total, discount_total, total, status, payment_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Placed', 'Unpaid')
            """,
            (
                order_id,
                store_row["id"],
                store_row["business_id"],
                invoice_number,
                customer_name,
                customer_phone,
                customer_email,
                customer_address,
                json_dumps(order_items),
                format_money(subtotal),
                format_money(gst_total),
                format_money(discount_total),
                format_money(total),
            ),
        )
        for row, quantity in product_rows:
            conn.execute(
                """
                UPDATE online_products
                SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (quantity, row["id"]),
            )
        conn.commit()
        order_row = conn.execute(
            "SELECT * FROM online_orders WHERE id = ?",
            (order_id,),
        ).fetchone()

    return jsonify(
        {
            "order": serialize_online_order(order_row),
            "store": serialize_online_store(store_row),
            "invoice_download_name": f"{invoice_number}.html",
        }
    ), 201


@app.route("/api/public/orders/<order_id>/invoice", methods=["GET"])
def public_online_order_invoice(order_id):
    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        row = conn.execute(
            """
            SELECT online_orders.*, online_stores.store_name, online_stores.contact_phone,
                   online_stores.contact_email, online_stores.address, online_stores.logo_url,
                   online_stores.slug
            FROM online_orders
            JOIN online_stores ON online_stores.id = online_orders.store_id
            WHERE online_orders.id = ?
            """,
            (order_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "Invoice not found."}), 404
    return jsonify(
        {
            "store": {
                "store_name": row["store_name"],
                "contact_phone": row["contact_phone"] or "",
                "contact_email": row["contact_email"] or "",
                "address": row["address"] or "",
                "logo_url": row["logo_url"] or "",
                "slug": row["slug"],
            },
            "order": serialize_online_order(row),
        }
    )


@app.route("/api/dashboard")
@require_permission("reports:read")
def dashboard():
    business_id = current_business_id()
    return jsonify(
        {
            "summary": get_summary_data(business_id),
            "recent_invoices": get_recent_invoices(business_id=business_id),
            "alerts": get_alerts(business_id=business_id),
        }
    )


@app.route("/api/dashboard/trend")
@require_permission("reports:read")
def dashboard_trend():
    view = (request.args.get("view") or "weekly").strip().lower()
    if view not in {"daily", "weekly", "monthly", "custom"}:
        return jsonify({"error": "view must be daily, weekly, monthly, or custom."}), 400
    start_date = (request.args.get("start_date") or "").strip() or None
    end_date = (request.args.get("end_date") or "").strip() or None
    try:
        return jsonify(get_trend_data(view, start_date=start_date, end_date=end_date, business_id=current_business_id()))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/customers", methods=["GET"])
@require_permission("customers:read")
def list_customers():
    with closing(get_connection()) as conn:
        rows = conn.execute(
            """
            SELECT id, name, email, address, phone, business_name, created_at
            FROM customers
            WHERE business_id = ?
            ORDER BY name ASC
            """,
            (current_business_id(),),
        ).fetchall()
    return jsonify([serialize_customer(row) for row in rows])


@app.route("/api/customers", methods=["POST"])
@require_permission("customers:write")
def add_customer():
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    address = (data.get("address") or "").strip()
    phone = (data.get("phone") or "").strip()
    business_name = (data.get("businessName") or data.get("business_name") or "").strip()

    if not name:
        return jsonify({"error": "Customer name is required."}), 400

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            INSERT INTO customers (name, email, address, phone, business_name, business_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (name, email, address, phone, business_name, current_business_id()),
        )
        conn.commit()
        customer = conn.execute(
            "SELECT id, name, email, address, phone, business_name, created_at FROM customers WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    return jsonify(serialize_customer(customer)), 201


@app.route("/api/customers/<int:customer_id>", methods=["PUT"])
@require_permission("customers:write")
def update_customer(customer_id):
    data = request.get_json() or {}
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    address = (data.get("address") or "").strip()
    phone = (data.get("phone") or "").strip()
    business_name = (data.get("businessName") or data.get("business_name") or "").strip()

    if not name:
        return jsonify({"error": "Customer name is required."}), 400

    with closing(get_connection()) as conn:
        existing = conn.execute(
            "SELECT id FROM customers WHERE id = ? AND business_id = ?",
            (customer_id, current_business_id()),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Customer not found."}), 404

        conn.execute(
            """
            UPDATE customers
            SET name = ?, email = ?, address = ?, phone = ?, business_name = ?
            WHERE id = ? AND business_id = ?
            """,
            (name, email, address, phone, business_name, customer_id, current_business_id()),
        )
        conn.commit()
        customer = conn.execute(
            """
            SELECT id, name, email, address, phone, business_name, created_at
            FROM customers
            WHERE id = ? AND business_id = ?
            """,
            (customer_id, current_business_id()),
        ).fetchone()
    return jsonify(serialize_customer(customer))


@app.route("/api/invoices", methods=["GET"])
@require_permission("invoices:read")
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
        WHERE invoices.business_id = ?
        ORDER BY invoices.issued_on DESC, invoices.id DESC
    """
    params = [current_business_id()]

    with closing(get_connection()) as conn:
        if limit:
            try:
                params.append(int(limit))
                rows = conn.execute(f"{query} LIMIT ?", params).fetchall()
            except ValueError:
                return jsonify({"error": "limit must be numeric."}), 400
        else:
            rows = conn.execute(query, params).fetchall()
    return jsonify([serialize_invoice(row) for row in rows])


@app.route("/api/invoices", methods=["POST"])
@require_permission("invoices:write")
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
            "SELECT id FROM customers WHERE id = ? AND business_id = ?",
            (customer_id, current_business_id()),
        ).fetchone()
        if not customer:
            return jsonify({"error": "Customer not found."}), 404

        requested_invoice_number = (data.get("invoice_number") or "").strip()
        auto_invoice_number = not requested_invoice_number or bool(data.get("auto_invoice_number"))

        status = compute_invoice_status(amount, 0, due_on)
        cursor = None
        invoice_number = requested_invoice_number
        for _attempt in range(50):
            invoice_number = generate_invoice_number(conn, issued_on) if auto_invoice_number else requested_invoice_number
            try:
                cursor = conn.execute(
                    """
                    INSERT INTO invoices (
                        customer_id, invoice_number, amount, total_paid, status,
                        issued_on, due_on, notes, business_id, warehouse_id
                    )
                    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        customer_id,
                        invoice_number,
                        amount,
                        status,
                        issued_on,
                        due_on,
                        notes,
                        current_business_id(),
                        current_warehouse_id(),
                    ),
                )
                break
            except sqlite3.IntegrityError as exc:
                if "invoice_number" not in str(exc).lower():
                    raise
                if not auto_invoice_number:
                    return jsonify({"error": "Invoice number already exists. Leave it blank to auto-generate the next bill number."}), 409
                continue
        if cursor is None:
            return jsonify({"error": "Could not generate a unique invoice number. Please try again."}), 409
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
            WHERE invoices.id = ? AND invoices.business_id = ?
            """,
            (cursor.lastrowid, current_business_id()),
        ).fetchone()

    return jsonify(serialize_invoice(row)), 201


@app.route("/api/invoices/<int:invoice_id>", methods=["DELETE"])
@require_permission("invoices:write")
def delete_invoice(invoice_id):
    context = current_auth_context()
    if not is_owner_context(context):
        return jsonify({"error": "Only the owner can delete invoices."}), 403

    with closing(get_connection()) as conn:
        invoice = conn.execute(
            """
            SELECT id, invoice_number
            FROM invoices
            WHERE id = ? AND business_id = ?
            """,
            (invoice_id, current_business_id()),
        ).fetchone()
        if not invoice:
            return jsonify({"error": "Invoice not found."}), 404

        conn.execute(
            "DELETE FROM payments WHERE invoice_id = ? AND business_id = ?",
            (invoice_id, current_business_id()),
        )
        conn.execute(
            "DELETE FROM invoices WHERE id = ? AND business_id = ?",
            (invoice_id, current_business_id()),
        )
        conn.commit()

    log_auth_event(
        "invoice.deleted",
        context=context,
        detail={"invoice_id": invoice_id, "invoice_number": invoice["invoice_number"]},
    )
    return jsonify({"message": "Invoice deleted."})


@app.route("/api/payments", methods=["GET"])
@require_permission("invoices:read")
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
            WHERE payments.business_id = ?
            ORDER BY payments.paid_on DESC, payments.id DESC
            """,
            (current_business_id(),),
        ).fetchall()
    return jsonify([serialize_payment(row) for row in rows])


@app.route("/api/payments", methods=["POST"])
@require_permission("payments:write")
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
            WHERE id = ? AND business_id = ?
            """,
            (invoice_id, current_business_id()),
        ).fetchone()
        if not invoice:
            return jsonify({"error": "Invoice not found."}), 404

        outstanding = float(invoice["amount"] or 0) - float(invoice["total_paid"] or 0)
        if amount - outstanding > 0.009:
            return jsonify({"error": "Payment exceeds outstanding amount."}), 400

        conn.execute(
            """
            INSERT INTO payments (invoice_id, customer_id, amount, method, paid_on, notes, business_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (invoice_id, invoice["customer_id"], amount, method, paid_on, notes, current_business_id()),
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

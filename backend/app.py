import os
import sqlite3
import sys
import hashlib
import hmac
from contextlib import closing
from datetime import UTC, date, datetime, timedelta
from functools import wraps
import json
import re
import secrets
from urllib import request as urlrequest
from urllib.error import URLError

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

app = Flask(__name__)

DATABASE = os.getenv(
    "DATABASE_PATH",
    os.path.join(os.path.dirname(__file__), "database.db"),
)
SCHEMA_VERSION = "4"
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
CUSTOMER_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{3,31}$")
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
    "CREATE INDEX IF NOT EXISTS idx_customer_accounts_business_id ON customer_accounts(business_id)",
    "CREATE INDEX IF NOT EXISTS idx_account_sessions_token_hash ON account_sessions(token_hash)",
    "CREATE INDEX IF NOT EXISTS idx_account_sessions_account_id ON account_sessions(account_id)",
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
    response.headers["Referrer-Policy"] = "no-referrer"
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


def validate_customer_id(value):
    customer_id = normalize_customer_id(value)
    if not CUSTOMER_ID_PATTERN.match(customer_id):
        raise ValueError("Customer ID must be 4-32 characters and use letters, numbers, dot, dash, or underscore.")
    return customer_id


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
    return {
        "id": row["id"],
        "customer_id": row["customer_id"],
        "name": row["name"] or row["customer_id"],
        "email": row["email"] or "",
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
        "customer_id": account_row["customer_id"],
        "email": account_row["email"] or "",
        "name": account_row["name"] or account_row["customer_id"],
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
    return not permission or permission in context.get("permissions", [])


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
            password_hash TEXT NOT NULL,
            business_id TEXT NOT NULL,
            warehouse_id TEXT DEFAULT 'main',
            role_key TEXT NOT NULL DEFAULT 'owner',
            status TEXT DEFAULT 'Active',
            email TEXT DEFAULT '',
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

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
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
    try:
        customer_id = validate_customer_id(data.get("customer_id") or data.get("user_id"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    password = str(data.get("password") or "")
    errors = password_validation_errors(password)
    if errors:
        return jsonify({"error": " ".join(errors), "password_errors": errors}), 400

    display_name = (data.get("name") or customer_id).strip()
    email = (data.get("email") or "").strip().lower()
    business_name = (data.get("business_name") or f"{display_name} Store").strip()
    account_id = f"acct_{secrets.token_hex(12)}"
    business_id = safe_identifier(customer_id, "biz")
    warehouse_id = f"{business_id}_main"

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        if conn.execute(
            "SELECT 1 FROM customer_accounts WHERE customer_id = ?",
            (customer_id,),
        ).fetchone():
            return jsonify({"error": "This customer ID is already registered."}), 409

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
                id, customer_id, password_hash, business_id, warehouse_id,
                role_key, status, email, name, last_login_at
            )
            VALUES (?, ?, ?, ?, ?, 'owner', 'Active', ?, ?, ?)
            """,
            (
                account_id,
                customer_id,
                hash_password(password),
                business_id,
                warehouse_id,
                email,
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
    log_auth_event("customer_account.registered", context, {"customer_id": customer_id})
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
    customer_id = normalize_customer_id(data.get("customer_id") or data.get("user_id"))
    password = str(data.get("password") or "")
    if not customer_id or not password:
        return jsonify({"error": "Customer ID and password are required."}), 400

    with closing(get_connection()) as conn:
        ensure_auth_schema(conn)
        account_row = conn.execute(
            "SELECT * FROM customer_accounts WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        now_iso = datetime.now(UTC).isoformat()
        if not account_row or account_row["status"] != "Active":
            return jsonify({"error": "Invalid customer ID or password."}), 401
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
            return jsonify({"error": "Invalid customer ID or password."}), 401
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
    log_auth_event("customer_account.login", context, {"customer_id": customer_id})
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
    permissions = normalize_permissions(data.get("permissions") or permissions_for_role(role_key))
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
            SELECT id, name, email, address, phone, created_at
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

    if not name:
        return jsonify({"error": "Customer name is required."}), 400

    with closing(get_connection()) as conn:
        cursor = conn.execute(
            """
            INSERT INTO customers (name, email, address, phone, business_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            (name, email, address, phone, current_business_id()),
        )
        conn.commit()
        customer = conn.execute(
            "SELECT id, name, email, address, phone, created_at FROM customers WHERE id = ?",
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
            SET name = ?, email = ?, address = ?, phone = ?
            WHERE id = ? AND business_id = ?
            """,
            (name, email, address, phone, customer_id, current_business_id()),
        )
        conn.commit()
        customer = conn.execute(
            """
            SELECT id, name, email, address, phone, created_at
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

        invoice_number = (data.get("invoice_number") or "").strip()
        if not invoice_number:
            invoice_number = generate_invoice_number(conn, issued_on)

        status = compute_invoice_status(amount, 0, due_on)
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

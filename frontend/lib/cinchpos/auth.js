export const CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "";
export const CINCHPOS_AUTH_REQUIRED = ["1", "true", "yes", "on"].includes(
  String(process.env.NEXT_PUBLIC_CINCHPOS_AUTH_REQUIRED || "1").toLowerCase()
);

const OFFLINE_AUTH_KEY = "offline-auth-session";
const ACCOUNT_AUTH_KEY = "account-auth-session";
let clerkClientPromise = null;

async function getDesktopDeviceBootId() {
  if (typeof window === "undefined" || !window.cinchposDesktop?.getRuntimeConfig) {
    return "";
  }
  try {
    const config = await window.cinchposDesktop.getRuntimeConfig();
    return config?.deviceBootId || "";
  } catch {
    return "";
  }
}

export const rolePermissionMatrix = {
  owner: ["*"],
  admin: ["*"],
  manager: [
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
    "customers:read",
    "customers:write",
    "suppliers:read",
    "suppliers:write",
    "warehouses:read",
    "support:use"
  ],
  store_manager: [
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
    "support:use"
  ],
  salesman: [
    "billing:read",
    "billing:write",
    "invoices:read",
    "payments:write",
    "customers:read",
    "customers:write",
    "inventory:read",
    "support:use"
  ],
  stock_manager: [
    "inventory:read",
    "inventory:write",
    "warehouses:read",
    "warehouses:write",
    "purchases:read",
    "purchases:write",
    "suppliers:read",
    "suppliers:write",
    "reports:read",
    "support:use"
  ],
  cashier: [
    "billing:read",
    "billing:write",
    "invoices:read",
    "payments:write",
    "customers:read",
    "customers:write",
    "inventory:read",
    "support:use"
  ],
  warehouse_manager: [
    "inventory:read",
    "inventory:write",
    "warehouses:read",
    "warehouses:write",
    "purchases:read",
    "purchases:write",
    "suppliers:read",
    "suppliers:write",
    "reports:read",
    "support:use"
  ],
  warehouse_staff: ["inventory:read", "inventory:write", "warehouses:read", "support:use"],
  accountant: ["invoices:read", "invoices:write", "payments:write", "purchases:read", "purchases:write", "sales:read", "reports:read", "customers:read", "support:use"],
  employee: ["billing:read", "inventory:read", "customers:read", "support:use"]
};

export const viewPermissionMap = {
  dashboardView: "reports:read",
  cinchPOSView: "billing:read",
  invoicesView: "invoices:read",
  customerInfoView: "customers:read",
  inventoryView: "inventory:read",
  sellOnlineView: "sales:read",
  purchaseView: "purchases:read",
  expensesView: "purchases:read",
  salesReportView: "reports:read",
  employeeView: "employees:read",
  bankView: "business:read",
  documentsView: "business:read",
  dataTransferView: "business:read"
};

export function normalizeRole(role) {
  return String(role || "employee").trim().toLowerCase().replace(/\s+/g, "_");
}

export function permissionsForRole(role, overrides = []) {
  const normalizedRole = normalizeRole(role);
  const defaults = rolePermissionMatrix[normalizedRole] || rolePermissionMatrix.employee;
  return Array.from(new Set([...(defaults || []), ...(Array.isArray(overrides) ? overrides : [])]));
}

export function hasPermission(authState, permission) {
  if (!permission) {
    return true;
  }
  const permissions = Array.isArray(authState?.permissions) ? authState.permissions : [];
  return permissions.includes("*") || permissions.includes(permission);
}

export function makeSignedOutAuthState(overrides = {}) {
  return {
    configured: Boolean(CLERK_PUBLISHABLE_KEY),
    required: CINCHPOS_AUTH_REQUIRED,
    authenticated: false,
    source: "",
    token: "",
    username: "",
    customerId: "",
    offline: false,
    userId: "",
    name: "",
    email: "",
    phone: "",
    emailVerified: false,
    role: "employee",
    businessId: "primary",
    warehouseId: "main",
    permissions: [],
    mfaRequired: false,
    mfaVerified: false,
    sessionId: "",
    ...overrides
  };
}

export function makeLocalOwnerAuthState(overrides = {}) {
  return {
    ...makeSignedOutAuthState(),
    configured: Boolean(CLERK_PUBLISHABLE_KEY),
    required: CINCHPOS_AUTH_REQUIRED,
    authenticated: true,
    source: "local-dev",
    token: "",
    username: "",
    customerId: "",
    offline: true,
    userId: "local-owner",
    name: "Local Owner",
    email: "",
    phone: "",
    emailVerified: false,
    role: "owner",
    businessId: "primary",
    warehouseId: "main",
    permissions: ["*"],
    mfaRequired: false,
    mfaVerified: false,
    sessionId: "local-offline",
    ...overrides
  };
}

export function accountFromAuthState(authState) {
  return {
    loggedIn: Boolean(authState?.authenticated),
    name: authState?.name || authState?.email || "Operator",
    contact: authState?.email || "",
    provider: authState?.source === "cinchpos-account" ? "cinchpos" : (authState?.configured ? "clerk" : "local"),
    role: normalizeRole(authState?.role || "employee"),
    businessId: authState?.businessId || "primary",
    warehouseId: authState?.warehouseId || "main",
    permissions: Array.isArray(authState?.permissions) ? authState.permissions : [],
    emailVerified: Boolean(authState?.emailVerified),
    mfaRequired: Boolean(authState?.mfaRequired),
    mfaVerified: Boolean(authState?.mfaVerified),
    offline: Boolean(authState?.offline)
  };
}

export function normalizeBackendAuthContext(payload) {
  const context = payload?.context || {};
  const account = payload?.account || {};
  const username = context.username || account.username || "";
  const customerId = context.customer_id || account.customer_id || "";
  const permissions = Array.isArray(context.permissions) && context.permissions.length
    ? context.permissions
    : permissionsForRole(context.role || "employee");
  return {
    configured: Boolean(payload?.configured || CLERK_PUBLISHABLE_KEY),
    required: Boolean(payload?.auth_required ?? CINCHPOS_AUTH_REQUIRED),
    authenticated: Boolean(context.authenticated),
    source: context.source || "",
    token: payload?.token || "",
    username: username || customerId,
    customerId: customerId || username,
    offline: false,
    userId: context.user_id || "",
    name: context.name || "",
    email: context.email || "",
    phone: context.phone || payload?.account?.phone || "",
    emailVerified: Boolean(context.email_verified),
    role: normalizeRole(context.role),
    businessId: context.business_id || "primary",
    warehouseId: context.warehouse_id || "main",
    permissions,
    mfaRequired: Boolean(context.mfa_required),
    mfaVerified: Boolean(context.mfa_verified),
    sessionId: context.session_id || ""
  };
}

export function normalizeCinchAccountAuth(payload) {
  const account = payload?.account || {};
  const context = payload?.context || {};
  const username = account.username || context.username || "";
  const customerId = account.customer_id || context.customer_id || "";
  return {
    ...normalizeBackendAuthContext(payload),
    configured: true,
    source: "cinchpos-account",
    token: payload?.token || "",
    username: username || customerId,
    customerId: customerId || username,
    authenticated: Boolean(payload?.token && payload?.context?.authenticated)
  };
}

export async function loadClerkClient() {
  if (typeof window === "undefined" || !CLERK_PUBLISHABLE_KEY) {
    return null;
  }
  if (window.Clerk?.loaded) {
    return window.Clerk;
  }
  if (!clerkClientPromise) {
    clerkClientPromise = import("@clerk/clerk-js")
      .then(async ({ Clerk }) => {
        const clerk = new Clerk(CLERK_PUBLISHABLE_KEY);
        window.Clerk = clerk;
        await clerk.load({
          signInUrl: window.location.href,
          signUpUrl: window.location.href,
          afterSignInUrl: window.location.href,
          afterSignUpUrl: window.location.href
        });
        return clerk;
      })
      .catch((error) => ({ error }));
  }
  const clerk = await clerkClientPromise;
  return clerk?.error ? null : clerk;
}

export async function getClerkSessionToken(clerk) {
  if (!clerk?.session) {
    return "";
  }
  try {
    return await clerk.session.getToken();
  } catch {
    return "";
  }
}

export async function writeOfflineAuthSession(authState, grant = {}) {
  if (typeof window === "undefined" || !authState?.authenticated) {
    return;
  }
  const deviceBootId = await getDesktopDeviceBootId();
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    deviceBootId,
    devicePolicy: "logout-on-device-restart",
    grant,
    authState: {
      ...authState,
      offline: true,
      permissions: Array.isArray(authState.permissions) ? authState.permissions : []
    }
  });
  if (window.cinchposSecureStorage?.set) {
    await window.cinchposSecureStorage.set(OFFLINE_AUTH_KEY, payload);
    return;
  }
  window.localStorage.setItem(`cinchPOS:${OFFLINE_AUTH_KEY}`, payload);
}

export async function readOfflineAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const payload = window.cinchposSecureStorage?.get
      ? await window.cinchposSecureStorage.get(OFFLINE_AUTH_KEY)
      : window.localStorage.getItem(`cinchPOS:${OFFLINE_AUTH_KEY}`);
    if (!payload) {
      return null;
    }
    const parsed = JSON.parse(payload);
    const currentDeviceBootId = await getDesktopDeviceBootId();
    if (parsed.deviceBootId && currentDeviceBootId && parsed.deviceBootId !== currentDeviceBootId) {
      await clearOfflineAuthSession();
      return null;
    }
    return parsed?.authState ? parsed : null;
  } catch {
    return null;
  }
}

export async function clearOfflineAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  if (window.cinchposSecureStorage?.remove) {
    await window.cinchposSecureStorage.remove(OFFLINE_AUTH_KEY);
  }
  window.localStorage.removeItem(`cinchPOS:${OFFLINE_AUTH_KEY}`);
}

export async function writeAccountAuthSession(authState, expiresAt = "") {
  if (typeof window === "undefined" || !authState?.authenticated || !authState?.token) {
    return;
  }
  const deviceBootId = await getDesktopDeviceBootId();
  const payload = JSON.stringify({
    savedAt: new Date().toISOString(),
    expiresAt,
    deviceBootId,
    devicePolicy: "logout-on-device-restart",
    authState: {
      ...authState,
      offline: false,
      permissions: Array.isArray(authState.permissions) ? authState.permissions : []
    }
  });
  if (window.cinchposSecureStorage?.set) {
    await window.cinchposSecureStorage.set(ACCOUNT_AUTH_KEY, payload);
    return;
  }
  window.localStorage.setItem(`cinchPOS:${ACCOUNT_AUTH_KEY}`, payload);
}

export async function readAccountAuthSession() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const payload = window.cinchposSecureStorage?.get
      ? await window.cinchposSecureStorage.get(ACCOUNT_AUTH_KEY)
      : window.localStorage.getItem(`cinchPOS:${ACCOUNT_AUTH_KEY}`);
    if (!payload) {
      return null;
    }
    const parsed = JSON.parse(payload);
    if (!parsed?.authState?.token) {
      return null;
    }
    const currentDeviceBootId = await getDesktopDeviceBootId();
    if (parsed.deviceBootId && currentDeviceBootId && parsed.deviceBootId !== currentDeviceBootId) {
      await clearAccountAuthSession();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearAccountAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  if (window.cinchposSecureStorage?.remove) {
    await window.cinchposSecureStorage.remove(ACCOUNT_AUTH_KEY);
  }
  window.sessionStorage.removeItem(`cinchPOS:${ACCOUNT_AUTH_KEY}`);
  window.localStorage.removeItem(`cinchPOS:${ACCOUNT_AUTH_KEY}`);
}

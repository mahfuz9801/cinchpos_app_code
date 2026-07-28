const DEFAULT_API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
const RUNTIME_CONFIG_PATH = "/__cinchpos_runtime.json";
let runtimeApiBaseUrlPromise = null;
let authTokenProvider = null;
let authContextProvider = null;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isReadRequest(method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return normalizedMethod === "GET" || normalizedMethod === "HEAD";
}

function isFetchNetworkError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return error instanceof TypeError || /failed to fetch|network|load failed/i.test(message);
}

function makeServiceUnavailableError(error) {
  const serviceError = new Error("Billing service is starting. CinchPOS will reconnect automatically.");
  serviceError.name = "CinchPOSServiceUnavailableError";
  serviceError.isNetworkError = true;
  serviceError.cause = error;
  return serviceError;
}

export function isApiNetworkError(error) {
  return Boolean(error?.isNetworkError) || isFetchNetworkError(error);
}

async function parseJSON(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function resolveApiBaseUrl() {
  if (typeof window === "undefined") {
    return DEFAULT_API_BASE_URL;
  }

  if (window.__CINCHPOS_API_BASE_URL) {
    return window.__CINCHPOS_API_BASE_URL;
  }

  if (!runtimeApiBaseUrlPromise) {
    runtimeApiBaseUrlPromise = Promise.resolve()
      .then(async () => {
        const desktopRuntimeConfig = window.cinchposDesktop?.getRuntimeConfig;
        if (typeof desktopRuntimeConfig !== "function") {
          return null;
        }
        const payload = await desktopRuntimeConfig();
        return typeof payload?.apiBaseUrl === "string" && payload.apiBaseUrl
          ? payload
          : null;
      })
      .catch(() => null)
      .then((desktopPayload) => {
        if (desktopPayload?.apiBaseUrl) {
          return desktopPayload;
        }
        return fetch(RUNTIME_CONFIG_PATH, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        return parseJSON(response);
          });
      })
      .then((payload) => {
        const apiBaseUrl = typeof payload?.apiBaseUrl === "string" && payload.apiBaseUrl
          ? payload.apiBaseUrl
          : DEFAULT_API_BASE_URL;
        window.__CINCHPOS_API_BASE_URL = apiBaseUrl;
        return apiBaseUrl;
      })
      .catch(() => DEFAULT_API_BASE_URL);
  }

  return runtimeApiBaseUrlPromise;
}

export function setAuthTokenProvider(provider) {
  authTokenProvider = typeof provider === "function" ? provider : null;
}

export function setAuthContextProvider(provider) {
  authContextProvider = typeof provider === "function" ? provider : null;
}

export async function fetchJSON(path, options = {}) {
  const apiBaseUrl = await resolveApiBaseUrl();
  const requestUrl = `${apiBaseUrl}${path}`;
  const token = authTokenProvider ? await authTokenProvider() : "";
  const authContext = authContextProvider ? authContextProvider() : {};
  const requestOptions = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(authContext?.businessId ? { "X-CinchPOS-Business-Id": authContext.businessId } : {}),
      ...(authContext?.warehouseId ? { "X-CinchPOS-Warehouse-Id": authContext.warehouseId } : {}),
      ...(options.headers || {})
    },
    cache: "no-store"
  };
  const maxAttempts = isReadRequest(requestOptions.method) ? 18 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(requestUrl, requestOptions);
      const payload = await parseJSON(response);

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxAttempts && isReadRequest(requestOptions.method)) {
          await wait(Math.min(1800, 180 + attempt * 140));
          continue;
        }
        throw new Error(payload.error || "Request failed.");
      }

      return payload;
    } catch (error) {
      if (!isReadRequest(requestOptions.method) || attempt >= maxAttempts) {
        if (isFetchNetworkError(error)) {
          throw makeServiceUnavailableError(error);
        }
        throw error instanceof Error ? error : new Error("Request failed.");
      }
      await wait(Math.min(1800, 180 + attempt * 140));
    }
  }

  throw new Error("Request failed.");
}

export function getDashboard() {
  return fetchJSON("/api/dashboard");
}

export function getTrend({ view = "weekly", startDate, endDate } = {}) {
  const params = new URLSearchParams({ view });
  if (startDate) {
    params.set("start_date", startDate);
  }
  if (endDate) {
    params.set("end_date", endDate);
  }
  return fetchJSON(`/api/dashboard/trend?${params.toString()}`);
}

export function getAuthContext() {
  return fetchJSON("/api/auth/context");
}

export function getPasswordRules() {
  return fetchJSON("/api/auth/password-rules");
}

export function registerCinchAccount(payload) {
  return fetchJSON("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function loginCinchAccount(payload) {
  return fetchJSON("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function requestCinchAccountOtp(payload) {
  return fetchJSON("/api/auth/otp/request", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function verifyCinchAccountOtp(payload) {
  return fetchJSON("/api/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function logoutCinchAccount() {
  return fetchJSON("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getAuthBusinesses() {
  return fetchJSON("/api/auth/businesses");
}

export function createAuthBusiness(payload) {
  return fetchJSON("/api/auth/businesses", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getAuthWarehouses() {
  return fetchJSON("/api/auth/warehouses");
}

export function getAuthRoles() {
  return fetchJSON("/api/auth/roles");
}

export function createAuthRole(payload) {
  return fetchJSON("/api/auth/roles", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function inviteEmployeeAccount(payload) {
  return fetchJSON("/api/auth/invitations", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function createOfflineSession(payload = {}) {
  return fetchJSON("/api/auth/offline-session", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getAuthAuditLogs({ limit = 50 } = {}) {
  return fetchJSON(`/api/auth/audit?limit=${encodeURIComponent(limit)}`);
}

export function getWorkspaceSnapshot() {
  return fetchJSON("/api/workspace/snapshot");
}

export function saveWorkspaceSnapshot(payload) {
  return fetchJSON("/api/workspace/snapshot", {
    method: "PUT",
    body: JSON.stringify({ payload })
  });
}

export function getRecoverableLocalBillingData() {
  return fetchJSON("/api/workspace/recover-local-billing");
}

export function recoverLocalBillingData() {
  return fetchJSON("/api/workspace/recover-local-billing", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function getOnlineStoreProfile() {
  return fetchJSON("/api/online-store/profile");
}

export function publishOnlineStore(payload) {
  return fetchJSON("/api/online-store/publish", {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function getPublicOnlineStore(storeSlug) {
  return fetchJSON(`/api/public/stores/${encodeURIComponent(storeSlug)}`);
}

export function checkoutPublicOnlineStore(storeSlug, payload) {
  return fetchJSON(`/api/public/stores/${encodeURIComponent(storeSlug)}/checkout`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getPublicOnlineInvoice(orderId) {
  return fetchJSON(`/api/public/orders/${encodeURIComponent(orderId)}/invoice`);
}

export function getCustomers() {
  return fetchJSON("/api/customers");
}

export function createCustomer(payload) {
  return fetchJSON("/api/customers", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateCustomer(customerId, payload) {
  return fetchJSON(`/api/customers/${customerId}`, {
    method: "PUT",
    body: JSON.stringify(payload)
  });
}

export function getInvoices() {
  return fetchJSON("/api/invoices");
}

export function createInvoice(payload) {
  return fetchJSON("/api/invoices", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function deleteInvoice(invoiceId) {
  return fetchJSON(`/api/invoices/${encodeURIComponent(invoiceId)}`, {
    method: "DELETE"
  });
}

export function recordPayment(payload) {
  return fetchJSON("/api/payments", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

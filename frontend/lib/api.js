const DEFAULT_API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000";
const RUNTIME_CONFIG_PATH = "/__cinchpos_runtime.json";
let runtimeApiBaseUrlPromise = null;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isReadRequest(method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return normalizedMethod === "GET" || normalizedMethod === "HEAD";
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
    runtimeApiBaseUrlPromise = fetch(RUNTIME_CONFIG_PATH, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        return parseJSON(response);
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

export async function fetchJSON(path, options = {}) {
  const apiBaseUrl = await resolveApiBaseUrl();
  const requestUrl = `${apiBaseUrl}${path}`;
  const requestOptions = {
    ...options,
    headers: {
      "Content-Type": "application/json",
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

export function recordPayment(payload) {
  return fetchJSON("/api/payments", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

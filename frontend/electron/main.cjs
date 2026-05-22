const { app, BrowserWindow, dialog, protocol, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { pathToFileURL } = require("url");

const APP_NAME = "CinchPOS";
const APP_ID = "com.cinchlive.cinchpos";
const DEFAULT_BACKEND_PORT = Number(process.env.CINCHPOS_BACKEND_PORT || 5001);
const FRONTEND_HOST = "127.0.0.1";
const FRONTEND_SCHEME = "cinchpos";
const FRONTEND_ORIGIN = `${FRONTEND_SCHEME}://app`;
const RUNTIME_CONFIG_PATH = "/__cinchpos_runtime.json";
const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=UTF-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=UTF-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".map": "application/json; charset=UTF-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=UTF-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const childProcesses = [];
let mainWindow = null;
let frontendReady = false;
let servicesReady = false;
let bootPromise = null;
let frontendBootPromise = null;
let backendBootPromise = null;
let windowRetryTimer = null;
let windowRetryCount = 0;
let loadingWindow = null;
let frontendProtocolRegistered = false;
const runtimeConfig = {
  backendPort: DEFAULT_BACKEND_PORT
};
const MAX_WINDOW_RETRY_COUNT = 5;
const RETRYABLE_WINDOW_ERROR_CODES = new Set([-102, -105, -106, -118, -300]);
const BACKEND_DATA_DIR_NAME = "backend-data";

app.setName(APP_NAME);
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: FRONTEND_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

function getFrontendBaseUrl() {
  return FRONTEND_ORIGIN;
}

function getAppUrl() {
  return `${getFrontendBaseUrl()}/pos/`;
}

function getApiBaseUrl() {
  return `http://${FRONTEND_HOST}:${runtimeConfig.backendPort}`;
}

function getApiHealthUrl() {
  return `${getApiBaseUrl()}/api/health`;
}

function getRuntimeConfigPayload() {
  return JSON.stringify({
    appUrl: getAppUrl(),
    apiBaseUrl: getApiBaseUrl(),
    backendPort: runtimeConfig.backendPort
  });
}

function clearWindowRetryTimer() {
  if (windowRetryTimer) {
    clearTimeout(windowRetryTimer);
    windowRetryTimer = null;
  }
}

function focusMainWindow() {
  const targetWindow = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : createMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }
  targetWindow.show();
  targetWindow.focus();
}

function getFrontendDir() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
}

function getFrontendStaticDir() {
  return path.join(getFrontendDir(), "out");
}

function getBackendDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "backend") : path.resolve(__dirname, "..", "..", "backend");
}

function ensureDirectorySync(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function getAppDataDir() {
  return app.isPackaged
    ? app.getPath("userData")
    : path.resolve(__dirname, "..", "..", ".runtime");
}

function getWritableBackendDataDir() {
  return path.join(getAppDataDir(), BACKEND_DATA_DIR_NAME);
}

function getBundledDatabasePath() {
  return path.join(getBackendDir(), "database.db");
}

function getLiveDatabasePath() {
  return app.isPackaged ? path.join(getWritableBackendDataDir(), "database.db") : getBundledDatabasePath();
}

function ensureWritableBackendData() {
  const liveDatabasePath = getLiveDatabasePath();
  if (!app.isPackaged) {
    return liveDatabasePath;
  }

  ensureDirectorySync(getWritableBackendDataDir());
  if (fs.existsSync(liveDatabasePath)) {
    return liveDatabasePath;
  }

  const bundledDatabasePath = getBundledDatabasePath();
  if (fs.existsSync(bundledDatabasePath)) {
    fs.copyFileSync(bundledDatabasePath, liveDatabasePath);
    return liveDatabasePath;
  }

  fs.closeSync(fs.openSync(liveDatabasePath, "a"));
  return liveDatabasePath;
}

function getBackendExecutable() {
  if (!app.isPackaged) {
    return null;
  }

  if (process.platform === "darwin") {
    const executablePath = path.join(getBackendDir(), "dist", "cinchpos-backend");
    return fs.existsSync(executablePath) ? executablePath : null;
  }

  if (process.platform === "win32") {
    const executablePath = path.join(getBackendDir(), "dist", "cinchpos-backend.exe");
    return fs.existsSync(executablePath) ? executablePath : null;
  }

  return null;
}

function getWindowsBundledPython() {
  if (!app.isPackaged || process.platform !== "win32") {
    return null;
  }

  const pythonPath = path.join(getBackendDir(), "runtime", "windows-python", "python.exe");
  return fs.existsSync(pythonPath) ? pythonPath : null;
}

function getAppIconPath() {
  const iconName = process.platform === "win32" ? "icon.ico" : "icon.png";
  return path.join(getFrontendDir(), "build", iconName);
}

function getDockIconPath() {
  return path.join(getFrontendDir(), "build", "icon.png");
}

function getLoadingScreenUrl() {
  const appIconUrl = pathToFileURL(getAppIconPath()).href;
  const loadingMarkup = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>CinchPOS</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #050505;
        color: #f4f7f7;
      }

      .startup-shell {
        width: min(460px, calc(100vw - 48px));
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 8px;
        background: linear-gradient(180deg, rgba(17, 24, 39, 0.96), rgba(3, 7, 18, 0.98));
        padding: 28px 28px 24px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.42);
      }

      .startup-brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }

      .startup-icon {
        width: 54px;
        height: 54px;
        border-radius: 8px;
        background: rgba(94, 234, 212, 0.12);
        border: 1px solid rgba(94, 234, 212, 0.3);
        display: grid;
        place-items: center;
        overflow: hidden;
      }

      .startup-icon img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .startup-copy {
        display: grid;
        gap: 3px;
      }

      .startup-label {
        font-size: 12px;
        color: #5eead4;
      }

      .startup-title {
        font-size: 28px;
        font-weight: 600;
        line-height: 1.1;
      }

      .startup-subtitle {
        margin-top: 16px;
        color: rgba(226, 232, 240, 0.78);
        font-size: 14px;
      }

      .startup-status {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 22px;
        color: rgba(226, 232, 240, 0.92);
        font-size: 13px;
      }

      .startup-spinner {
        width: 15px;
        height: 15px;
        border-radius: 999px;
        border: 2px solid rgba(148, 163, 184, 0.26);
        border-top-color: #5eead4;
        animation: spin 0.85s linear infinite;
      }

      .startup-bar {
        height: 4px;
        margin-top: 18px;
        background: rgba(51, 65, 85, 0.42);
        border-radius: 999px;
        overflow: hidden;
      }

      .startup-bar::after {
        content: "";
        display: block;
        width: 38%;
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #5eead4, #34d399);
        animation: slide 1.2s ease-in-out infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      @keyframes slide {
        0% { transform: translateX(-120%); }
        100% { transform: translateX(360%); }
      }
    </style>
  </head>
  <body>
    <main class="startup-shell">
      <div class="startup-brand">
        <div class="startup-icon">
          <img src="${appIconUrl}" alt="CinchPOS" />
        </div>
        <div class="startup-copy">
          <div class="startup-label">Launching Workspace</div>
          <div class="startup-title">CinchPOS</div>
        </div>
      </div>
      <p class="startup-subtitle">Preparing the billing workspace and local services.</p>
      <div class="startup-status">
        <span class="startup-spinner" aria-hidden="true"></span>
        <span>Starting frontend and backend...</span>
      </div>
      <div class="startup-bar" aria-hidden="true"></div>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=UTF-8,${encodeURIComponent(loadingMarkup)}`;
}

function reservePort(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, FRONTEND_HOST, () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(resolvedPort);
      });
    });
  });
}

async function findOpenPort(preferredPort, excludedPorts = []) {
  if (preferredPort > 0 && !excludedPorts.includes(preferredPort) && !(await canConnect(preferredPort))) {
    return preferredPort;
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidatePort = await reservePort(0);
    if (!excludedPorts.includes(candidatePort) && !(await canConnect(candidatePort))) {
      return candidatePort;
    }
  }

  throw new Error("Could not find an available local port for CinchPOS.");
}

async function prepareRuntimePorts() {
  runtimeConfig.backendPort = await findOpenPort(DEFAULT_BACKEND_PORT);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: FRONTEND_HOST, port });
    socket.setTimeout(650);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function pingUrl(url, timeoutMs = 350, isValidStatus = (statusCode) => statusCode >= 200 && statusCode < 500) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(isValidStatus(response.statusCode));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });

    request.on("error", () => resolve(false));
  });
}

function waitForUrl(url, timeoutMs = 30000, isValidStatus = (statusCode) => statusCode >= 200 && statusCode < 500) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (isValidStatus(response.statusCode)) {
          resolve();
          return;
        }
        retry();
      });

      request.setTimeout(1200, () => {
        request.destroy();
        retry();
      });

      request.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(check, 150);
    };

    check();
  });
}

function resolveStaticFile(staticDir, requestUrl) {
  const { pathname } = new URL(requestUrl, getFrontendBaseUrl());
  const safePath = decodeURIComponent(pathname);
  const normalizedPath = safePath === "/" ? "/index.html" : safePath;
  const candidates = normalizedPath.endsWith("/")
    ? [path.join(staticDir, normalizedPath, "index.html")]
    : [
        path.join(staticDir, normalizedPath),
        path.join(staticDir, `${normalizedPath}.html`),
        path.join(staticDir, normalizedPath, "index.html")
      ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(path.resolve(staticDir))) {
      continue;
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }

  const notFoundPage = path.join(staticDir, "404.html");
  if (fs.existsSync(notFoundPage)) {
    return notFoundPage;
  }
  return null;
}

function registerFrontendProtocol(staticDir) {
  if (frontendProtocolRegistered) {
    return;
  }

  protocol.handle(FRONTEND_SCHEME, async (request) => {
    try {
      const requestUrl = request.url || `${getFrontendBaseUrl()}/`;
      const requestPath = new URL(requestUrl, getFrontendBaseUrl()).pathname;

      if (requestPath === RUNTIME_CONFIG_PATH) {
        return new Response(getRuntimeConfigPayload(), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        });
      }

      const filePath = resolveStaticFile(staticDir, requestUrl);
      if (!filePath) {
        console.error(`CinchPOS protocol could not resolve ${requestUrl}`);
        return new Response("Not found", {
          status: 404,
          headers: {
            "Content-Type": "text/plain; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        });
      }

      const extension = path.extname(filePath).toLowerCase();
      const content = await fs.promises.readFile(filePath);
      return new Response(content, {
        status: 200,
        headers: {
          "Content-Type": STATIC_MIME_TYPES[extension] || "application/octet-stream",
          "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
        }
      });
    } catch (error) {
      console.error(`CinchPOS protocol error for ${request.url || "(unknown url)"}: ${error.message || error}`);
      return new Response("Could not load the requested file.", {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      });
    }
  });

  frontendProtocolRegistered = true;
}

function spawnManaged(command, args, options, label) {
  const child = spawn(command, args, {
    ...options,
    env: { ...process.env, ...options.env },
    stdio: "pipe"
  });

  childProcesses.push(child);
  child.stdout.on("data", (data) => console.log(`[${label}] ${data}`));
  child.stderr.on("data", (data) => console.error(`[${label}] ${data}`));
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}`);
    }
  });
  return child;
}

async function ensureBackend() {
  if (backendBootPromise) {
    return backendBootPromise;
  }

  backendBootPromise = (async () => {
    if (await pingUrl(getApiHealthUrl(), 350, (statusCode) => statusCode >= 200 && statusCode < 400)) {
      return;
    }

    const backendDir = getBackendDir();
    const liveDatabasePath = ensureWritableBackendData();
    const bundledWindowsPython = getWindowsBundledPython();
    const backendExecutable = getBackendExecutable();
    const command = bundledWindowsPython || backendExecutable || process.env.PYTHON || "python3";
    const args = backendExecutable ? [] : ["app.py"];

    const backendProcess = spawnManaged(command, args, {
      cwd: backendDir,
      env: {
        DATABASE_PATH: liveDatabasePath,
        HOST: FRONTEND_HOST,
        PORT: String(runtimeConfig.backendPort),
        FLASK_DEBUG: "0"
      }
    }, "flask");

    const backendErrors = [];
    backendProcess.stderr.on("data", (data) => {
      const lines = String(data || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      backendErrors.push(...lines);
      if (backendErrors.length > 12) {
        backendErrors.splice(0, backendErrors.length - 12);
      }
    });

    await Promise.race([
      waitForUrl(getApiHealthUrl(), 30000, (statusCode) => statusCode >= 200 && statusCode < 400),
      new Promise((_, reject) => {
        backendProcess.once("exit", (code, signal) => {
          const detail = backendErrors.length ? ` ${backendErrors[backendErrors.length - 1]}` : "";
          reject(new Error(`The backend exited before becoming ready (code: ${code ?? "null"}, signal: ${signal ?? "none"}).${detail}`));
        });
      })
    ]);
  })();

  try {
    await backendBootPromise;
  } finally {
    backendBootPromise = null;
  }
}

async function ensureFrontend() {
  if (frontendBootPromise) {
    return frontendBootPromise;
  }

  frontendBootPromise = (async () => {
    const staticDir = getFrontendStaticDir();
    if (!fs.existsSync(staticDir)) {
      throw new Error("The desktop frontend bundle is missing. Rebuild the app before opening it.");
    }

    registerFrontendProtocol(staticDir);
    frontendReady = true;
  })();

  try {
    await frontendBootPromise;
  } finally {
    frontendBootPromise = null;
  }
}

function scheduleAppWindowReload(reason = "retry") {
  const targetWindow = createMainWindow();
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }
  if (windowRetryCount >= MAX_WINDOW_RETRY_COUNT) {
    console.error(`CinchPOS window recovery exhausted after ${windowRetryCount} attempts (${reason}).`);
    return;
  }

  clearWindowRetryTimer();
  windowRetryCount += 1;
  targetWindow.loadURL(getLoadingScreenUrl()).catch(() => {});
  const retryDelay = Math.min(3000, 500 + windowRetryCount * 350);
  console.warn(`Retrying CinchPOS window load (${windowRetryCount}/${MAX_WINDOW_RETRY_COUNT}) after ${reason}.`);

  windowRetryTimer = setTimeout(async () => {
    windowRetryTimer = null;
    try {
      await ensureFrontend();
      await ensureBackend();
      await loadAppIntoWindow({ resetRetries: false });
    } catch (error) {
      console.error(`CinchPOS retry ${windowRetryCount} failed: ${error.message || error}`);
      scheduleAppWindowReload(error.message || "retry failed");
    }
  }, retryDelay);
}

function getWindowOptions(overrides = {}) {
  return {
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 640,
    title: "CinchPOS",
    backgroundColor: "#000000",
    icon: getAppIconPath(),
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...overrides
  };
}

async function inspectAppWindow(targetWindow, timeoutMs = 1500) {
  const inspectionPromise = targetWindow.webContents.executeJavaScript(
    `(() => ({
      title: document.title || "",
      text: ((document.body && document.body.innerText) || "").slice(0, 160),
      hasDesktopApp: Boolean(document.querySelector(".desktop-app"))
    }))()`,
    true
  );
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("inspection timeout")), timeoutMs);
  });
  return Promise.race([inspectionPromise, timeoutPromise]);
}

function attachCommonWindowHandlers(targetWindow) {
  targetWindow.on("closed", () => {
    clearWindowRetryTimer();
    if (mainWindow === targetWindow) {
      mainWindow = null;
    }
    if (loadingWindow === targetWindow) {
      loadingWindow = null;
    }
  });
  targetWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createMainWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) {
    mainWindow = loadingWindow;
    return loadingWindow;
  }

  loadingWindow = new BrowserWindow(getWindowOptions());
  attachCommonWindowHandlers(loadingWindow);
  loadingWindow.loadURL(getLoadingScreenUrl());
  mainWindow = loadingWindow;
  return loadingWindow;
}

async function loadAppIntoWindow({ resetRetries = true } = {}) {
  const targetLoadingWindow = createMainWindow();
  if (!targetLoadingWindow || targetLoadingWindow.isDestroyed()) {
    return;
  }
  if (resetRetries) {
    clearWindowRetryTimer();
    windowRetryCount = 0;
  }

  const bounds = targetLoadingWindow.getBounds();
  const appWindow = new BrowserWindow(getWindowOptions({
    ...bounds,
    show: false
  }));
  attachCommonWindowHandlers(appWindow);
  appWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`CinchPOS renderer process gone: ${JSON.stringify(details)}`);
  });
  appWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    if (!validatedURL || !validatedURL.startsWith(getFrontendBaseUrl())) {
      return;
    }
    if (!RETRYABLE_WINDOW_ERROR_CODES.has(errorCode)) {
      return;
    }
    console.error(`CinchPOS page load failed (${errorCode}) ${errorDescription} for ${validatedURL}`);
    if (!appWindow.isDestroyed()) {
      appWindow.destroy();
    }
    mainWindow = targetLoadingWindow && !targetLoadingWindow.isDestroyed() ? targetLoadingWindow : null;
    scheduleAppWindowReload(errorDescription || `error ${errorCode}`);
  });

  try {
    let loadedTitle = "";
    let loadedSuccessfully = false;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await appWindow.loadURL(getAppUrl());
      await new Promise((resolve) => setTimeout(resolve, 220));
      loadedTitle = (appWindow.webContents.getTitle() || "").trim();
      let inspection = null;
      try {
        inspection = await inspectAppWindow(appWindow);
      } catch (error) {
        inspection = { title: "", text: `[inspection failed: ${error.message || error}]`, hasDesktopApp: false };
      }
      const effectiveTitle = `${loadedTitle} ${inspection.title || ""}`.trim();
      const rendererErrorText = inspection.text || "";
      if (inspection.hasDesktopApp || /cinchpos/i.test(inspection.title || "")) {
        loadedSuccessfully = true;
        break;
      }
      console.warn(
        `CinchPOS app window validation failed on attempt ${attempt}:`
        + ` title="${effectiveTitle || "(blank)"}"`
        + ` hasDesktopApp="${inspection.hasDesktopApp ? "yes" : "no"}"`
        + ` details="${rendererErrorText || "(blank)"}"`
      );
    }

    if (!loadedSuccessfully) {
      throw new Error(`Unexpected page title after app load: ${loadedTitle || "(blank)"}`);
    }
  } catch (error) {
    if (!appWindow.isDestroyed()) {
      appWindow.destroy();
    }
    mainWindow = targetLoadingWindow && !targetLoadingWindow.isDestroyed() ? targetLoadingWindow : null;
    throw error;
  }

  mainWindow = appWindow;
  appWindow.show();
  appWindow.focus();
  windowRetryCount = 0;
  clearWindowRetryTimer();

  if (targetLoadingWindow && !targetLoadingWindow.isDestroyed()) {
    targetLoadingWindow.destroy();
  }
  loadingWindow = null;
}

async function boot() {
  try {
    const startedAt = Date.now();
    let frontendLoadedAt = 0;
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(getDockIconPath());
    }
    createMainWindow();
    await prepareRuntimePorts();
    console.log(`CinchPOS using backend port ${runtimeConfig.backendPort}`);
    const frontendBoot = ensureFrontend();
    const backendBoot = ensureBackend();
    await frontendBoot;
    frontendLoadedAt = Date.now();
    console.log(`CinchPOS shell ready in ${frontendLoadedAt - startedAt}ms`);
    await loadAppIntoWindow();
    await backendBoot;
    servicesReady = true;
    console.log(`CinchPOS ready in ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.error("CinchPOS could not start:", error?.message || error);
    dialog.showErrorBox("CinchPOS could not start", error.message || String(error));
    app.quit();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
    if (!servicesReady && !bootPromise) {
      bootPromise = boot();
    }
  });

  app.whenReady().then(() => {
    bootPromise = boot();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      focusMainWindow();
      if (servicesReady) {
        loadAppIntoWindow().catch((error) => {
          dialog.showErrorBox("CinchPOS could not restore", error.message || String(error));
        });
        return;
      }
      if (!bootPromise) {
        bootPromise = boot();
      }
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    childProcesses.forEach((child) => {
      if (!child.killed) {
        child.kill();
      }
    });
  });
}

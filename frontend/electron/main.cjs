const { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch (error) {
  console.warn(`CinchPOS updater unavailable: ${error.message || error}`);
}

const APP_NAME = "CinchPOS";
const APP_ID = "com.cinchlive.cinchpos";
const DEFAULT_BACKEND_PORT = Number(process.env.CINCHPOS_BACKEND_PORT || 5001);
const FRONTEND_HOST = "127.0.0.1";
const FRONTEND_SCHEME = "cinchpos";
const FRONTEND_ORIGIN = `${FRONTEND_SCHEME}://app`;
const RUNTIME_CONFIG_PATH = "/__cinchpos_runtime.json";
const UPDATE_FEED_URL = process.env.CINCHPOS_UPDATE_FEED_URL
  || "https://7aakdg0aolddhlmb.public.blob.vercel-storage.com/updates";
const RELEASE_MANIFEST_URL = process.env.CINCHPOS_RELEASE_MANIFEST_URL
  || `${UPDATE_FEED_URL.replace(/\/+$/, "")}/release.json`;
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
const updateState = {
  currentVersion: app.getVersion(),
  status: "idle",
  message: "CinchPOS will check for updates after startup.",
  updateInfo: null,
  progress: null,
  downloadPath: "",
  canInstall: false,
  source: "native"
};
let updateCheckInFlight = null;
let fallbackDownloadRequest = null;
let promptedUpdateVersion = "";
let promptedDownloadedVersion = "";
const MAX_WINDOW_RETRY_COUNT = 5;
const RETRYABLE_WINDOW_ERROR_CODES = new Set([-102, -105, -106, -118, -300]);
const BACKEND_DATA_DIR_NAME = "backend-data";
const SECURE_STORAGE_DIR_NAME = "secure-storage";
const PRINT_JOBS_DIR_NAME = "print-jobs";
const CSS_PX_PER_INCH = 96;
const MICRONS_PER_INCH = 25400;

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

function getDeviceBootId() {
  const bootEpochMinute = Math.floor((Date.now() - os.uptime() * 1000) / 60000);
  return `${process.platform}:${bootEpochMinute}`;
}

function getRuntimeConfigPayload() {
  return JSON.stringify({
    appUrl: getAppUrl(),
    apiBaseUrl: getApiBaseUrl(),
    backendPort: runtimeConfig.backendPort,
    deviceBootId: getDeviceBootId()
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

function getSecureStorageDir() {
  return ensureDirectorySync(path.join(getAppDataDir(), SECURE_STORAGE_DIR_NAME));
}

function getSecureStoragePath(key) {
  const safeKey = String(key || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  if (!safeKey) {
    throw new Error("Secure storage key is required.");
  }
  return path.join(getSecureStorageDir(), `${safeKey}.json`);
}

function registerSecureStorageBridge() {
  ipcMain.handle("cinchpos:secure-store:set", async (_event, key, value) => {
    const normalizedValue = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const storagePath = getSecureStoragePath(key);
    const encrypted = Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    const payload = encrypted
      ? { encrypted: true, value: safeStorage.encryptString(normalizedValue).toString("base64") }
      : { encrypted: false, value: normalizedValue };
    await fs.promises.writeFile(storagePath, JSON.stringify(payload), { mode: 0o600 });
    return { ok: true, encrypted };
  });

  ipcMain.handle("cinchpos:secure-store:get", async (_event, key) => {
    const storagePath = getSecureStoragePath(key);
    if (!fs.existsSync(storagePath)) {
      return null;
    }
    const payload = JSON.parse(await fs.promises.readFile(storagePath, "utf8"));
    if (payload.encrypted) {
      return safeStorage.decryptString(Buffer.from(payload.value || "", "base64"));
    }
    return payload.value || null;
  });

  ipcMain.handle("cinchpos:secure-store:remove", async (_event, key) => {
    const storagePath = getSecureStoragePath(key);
    if (fs.existsSync(storagePath)) {
      await fs.promises.unlink(storagePath);
    }
    return { ok: true };
  });
}

function registerRuntimeConfigBridge() {
  ipcMain.handle("cinchpos:get-runtime-config", async () => ({
    appUrl: getAppUrl(),
    apiBaseUrl: getApiBaseUrl(),
    backendPort: runtimeConfig.backendPort,
    deviceBootId: getDeviceBootId()
  }));
}

function clampPrintMicrons(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

async function getMeasuredThermalPageSize(printWindow, fallbackPageSize = {}) {
  if (!printWindow || printWindow.isDestroyed()) {
    return fallbackPageSize;
  }
  try {
    const measurement = await printWindow.webContents.executeJavaScript(`
      (() => {
        const target = document.querySelector(".thermal-receipt") || document.querySelector(".print-content") || document.body || document.documentElement;
        const body = document.body || target;
        const html = document.documentElement || target;
        const width = Math.max(target.scrollWidth || 0, body.scrollWidth || 0, html.scrollWidth || 0, target.getBoundingClientRect().width || 0);
        const height = Math.max(target.scrollHeight || 0, body.scrollHeight || 0, html.scrollHeight || 0, target.getBoundingClientRect().height || 0);
        return { width, height };
      })()
    `);
    const fallbackWidth = Number(fallbackPageSize.width || 80000);
    const widthMicrons = clampPrintMicrons(fallbackWidth, 50000, 82000);
    const measuredHeight = Number(measurement && measurement.height ? measurement.height : 0);
    const heightMicrons = clampPrintMicrons(
      (measuredHeight / CSS_PX_PER_INCH) * MICRONS_PER_INCH + 15000,
      120000,
      12000000
    );
    return { width: widthMicrons, height: heightMicrons };
  } catch (error) {
    console.warn(`CinchPOS thermal print measurement failed: ${error.message || error}`);
    return fallbackPageSize;
  }
}

function cloneUpdateState() {
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    feedUrl: UPDATE_FEED_URL,
    manifestUrl: RELEASE_MANIFEST_URL,
    packaged: app.isPackaged
  };
}

function setUpdateState(patch = {}) {
  Object.assign(updateState, patch, { currentVersion: app.getVersion() });
  const payload = cloneUpdateState();
  BrowserWindow.getAllWindows().forEach((targetWindow) => {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("cinchpos:update-status", payload);
    }
  });
  return payload;
}

function getUpdateVersion(info = {}) {
  return String(info.version || updateState.updateInfo?.version || "").trim();
}

async function promptForAvailableUpdate(info = {}) {
  const version = getUpdateVersion(info);
  if (!app.isPackaged || !mainWindow || mainWindow.isDestroyed() || !version || promptedUpdateVersion === version) {
    return;
  }
  promptedUpdateVersion = version;

  const result = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "CinchPOS update available",
    message: `CinchPOS ${version} is available.`,
    detail: "Download the update in the background. After it is ready, CinchPOS only needs a restart to apply it.",
    buttons: ["Download Update", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (result.response === 0) {
    downloadUpdate().catch((error) => {
      console.warn(`CinchPOS update download prompt failed: ${error.message || error}`);
      setUpdateState({
        status: "error",
        message: `Could not start the update download. ${error.message || error}`
      });
    });
  }
}

async function promptForDownloadedUpdate(info = {}) {
  const version = getUpdateVersion(info);
  if (!app.isPackaged || !mainWindow || mainWindow.isDestroyed() || !version || promptedDownloadedVersion === version) {
    return;
  }
  promptedDownloadedVersion = version;

  const result = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "CinchPOS update ready",
    message: `CinchPOS ${version} is ready.`,
    detail: "Restart CinchPOS when the billing counter is free. The update will be applied during restart.",
    buttons: ["Restart & Update", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });

  if (result.response === 0) {
    installUpdate().catch((error) => {
      console.warn(`CinchPOS update install prompt failed: ${error.message || error}`);
      setUpdateState({
        status: "error",
        message: `Could not restart for update. ${error.message || error}`
      });
    });
  }
}

function compareVersions(left, right) {
  const leftParts = String(left || "0.0.0").split(/[.-]/).map((part) => Number(part) || 0);
  const rightParts = String(right || "0.0.0").split(/[.-]/).map((part) => Number(part) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function requestUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const client = String(url || "").startsWith("https:") ? https : http;
    const request = client.get(url, {
      headers: {
        "User-Agent": `${APP_NAME}/${app.getVersion()}`
      }
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      if (statusCode >= 300 && statusCode < 400 && location && redirectCount < 5) {
        response.resume();
        const nextUrl = new URL(location, url).toString();
        requestUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Update server returned ${statusCode}.`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(15000, () => {
      request.destroy(new Error("Update server timed out."));
    });
    request.once("error", reject);
  });
}

async function fetchJSON(url) {
  const response = await requestUrl(url);
  return new Promise((resolve, reject) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Update manifest is not valid JSON: ${error.message || error}`));
      }
    });
    response.once("error", reject);
  });
}

function getFallbackDownload(manifest = {}) {
  const key = process.platform === "darwin" ? "mac" : "windows";
  const download = manifest.downloads && manifest.downloads[key];
  if (!download || !download.url) {
    return null;
  }
  return {
    platform: key,
    url: download.url,
    fileName: download.fileName || path.basename(new URL(download.url).pathname) || (key === "mac" ? "CinchPOS.dmg" : "CinchPOS-Setup.exe"),
    size: Number(download.size || 0),
    sha512: download.sha512 || ""
  };
}

async function checkFallbackRelease() {
  const manifest = await fetchJSON(RELEASE_MANIFEST_URL);
  const download = getFallbackDownload(manifest);
  if (!download) {
    throw new Error("No update download is configured for this operating system.");
  }
  const remoteVersion = String(manifest.version || "").trim();
  if (!remoteVersion) {
    throw new Error("Update manifest is missing a version.");
  }
  if (compareVersions(remoteVersion, app.getVersion()) <= 0) {
    return setUpdateState({
      status: "no-update",
      message: `CinchPOS is up to date. Current version ${app.getVersion()}.`,
      updateInfo: { version: remoteVersion, releaseDate: manifest.releaseDate || "", notes: manifest.notes || [] },
      progress: null,
      downloadPath: "",
      canInstall: false,
      source: "manifest"
    });
  }

  return setUpdateState({
    status: "available",
    message: `CinchPOS ${remoteVersion} is available.`,
    updateInfo: {
      version: remoteVersion,
      releaseDate: manifest.releaseDate || "",
      notes: manifest.notes || [],
      download
    },
    progress: null,
    downloadPath: "",
    canInstall: false,
    source: "manifest"
  });
}

async function downloadFallbackInstaller() {
  const info = updateState.updateInfo || {};
  const download = info.download;
  if (!download || !download.url) {
    throw new Error("No installer URL is available for this update.");
  }

  const downloadsDir = ensureDirectorySync(path.join(getAppDataDir(), "updates"));
  const filePath = path.join(downloadsDir, makeSafePrintFileName(download.fileName));
  setUpdateState({
    status: "downloading",
    message: `Downloading CinchPOS ${info.version || "update"}...`,
    progress: { percent: 0, transferred: 0, total: download.size || 0 },
    downloadPath: "",
    canInstall: false,
    source: "manifest"
  });

  const response = await requestUrl(download.url);
  const total = Number(response.headers["content-length"] || download.size || 0);
  let transferred = 0;

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(filePath);
    fallbackDownloadRequest = response;
    response.on("data", (chunk) => {
      transferred += chunk.length;
      const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
      setUpdateState({
        status: "downloading",
        message: `Downloading CinchPOS ${info.version || "update"}... ${percent || ""}%`.trim(),
        progress: { percent, transferred, total },
        source: "manifest"
      });
    });
    response.once("error", reject);
    fileStream.once("error", reject);
    fileStream.once("finish", resolve);
    response.pipe(fileStream);
  }).finally(() => {
    fallbackDownloadRequest = null;
  });

  return setUpdateState({
    status: "downloaded",
    message: "Manual update package downloaded. Restart update was not available for this package.",
    progress: { percent: 100, transferred, total },
    downloadPath: filePath,
    canInstall: true,
    source: "manifest"
  });
}

let updaterConfigured = false;

function configureAutoUpdater() {
  if (updaterConfigured || !autoUpdater) {
    return;
  }
  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: UPDATE_FEED_URL
  });

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({
      status: "checking",
      message: "Checking for CinchPOS updates...",
      progress: null,
      source: "native"
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      status: "available",
      message: `CinchPOS ${info.version || "update"} is available.`,
      updateInfo: info,
      progress: null,
      downloadPath: "",
      canInstall: false,
      source: "native"
    });
    promptForAvailableUpdate(info).catch((error) => {
      console.warn(`CinchPOS update prompt failed: ${error.message || error}`);
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({
      status: "no-update",
      message: `CinchPOS is up to date. Current version ${app.getVersion()}.`,
      updateInfo: info,
      progress: null,
      downloadPath: "",
      canInstall: false,
      source: "native"
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      status: "downloading",
      message: `Downloading CinchPOS update... ${Math.round(progress.percent || 0)}%`,
      progress,
      source: "native"
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({
      status: "downloaded",
      message: "Update downloaded. Restart CinchPOS to apply it.",
      updateInfo: info,
      progress: { percent: 100 },
      canInstall: true,
      source: "native"
    });
    promptForDownloadedUpdate(info).catch((error) => {
      console.warn(`CinchPOS downloaded update prompt failed: ${error.message || error}`);
    });
  });

  autoUpdater.on("error", (error) => {
    console.error(`CinchPOS native updater failed: ${error.message || error}`);
    setUpdateState({
      status: "error",
      message: `Native update check failed. ${error.message || error}`,
      progress: null,
      source: "native"
    });
  });
}

async function checkForUpdates({ manual = false } = {}) {
  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
    configureAutoUpdater();
    if (!app.isPackaged) {
      return setUpdateState({
        status: "idle",
        message: "Updates are checked only in the packaged desktop app.",
        progress: null,
        source: "development"
      });
    }

    try {
      if (autoUpdater) {
        await autoUpdater.checkForUpdates();
        return cloneUpdateState();
      }
    } catch (error) {
      console.warn(`CinchPOS native update check failed, trying release manifest: ${error.message || error}`);
    }

    try {
      const fallbackState = await checkFallbackRelease();
      if (!manual && fallbackState.status === "available") {
        promptForAvailableUpdate(fallbackState.updateInfo).catch((error) => {
          console.warn(`CinchPOS fallback update prompt failed: ${error.message || error}`);
        });
      }
      return fallbackState;
    } catch (error) {
      const message = manual
        ? `Could not check for updates. ${error.message || error}`
        : "Could not check for updates automatically.";
      return setUpdateState({
        status: "error",
        message,
        progress: null,
        source: "manifest"
      });
    }
  })();

  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

async function downloadUpdate() {
  configureAutoUpdater();
  if (!app.isPackaged) {
    return setUpdateState({
      status: "idle",
      message: "Download updates from packaged CinchPOS, not from development mode.",
      progress: null,
      canInstall: false
    });
  }

  if (updateState.source === "native" && autoUpdater) {
    try {
      await autoUpdater.downloadUpdate();
      return cloneUpdateState();
    } catch (error) {
      console.warn(`CinchPOS native update download failed, trying installer fallback: ${error.message || error}`);
      await checkFallbackRelease();
      return downloadFallbackInstaller();
    }
  }

  return downloadFallbackInstaller();
}

async function installUpdate() {
  configureAutoUpdater();
  if (updateState.source === "native" && autoUpdater && updateState.canInstall) {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true, mode: "native" };
  }

  if (updateState.downloadPath && fs.existsSync(updateState.downloadPath)) {
    const result = await shell.openPath(updateState.downloadPath);
    if (result) {
      throw new Error(result);
    }
    setUpdateState({
      status: "installing",
      message: "Manual update package opened. This is only used when restart update is unavailable.",
      canInstall: true,
      source: "manifest"
    });
    return { ok: true, mode: "installer" };
  }

  const download = updateState.updateInfo && updateState.updateInfo.download;
  if (download && download.url) {
    await shell.openExternal(download.url);
    return { ok: true, mode: "browser" };
  }

  throw new Error("No downloaded update is ready to install.");
}

function registerUpdateBridge() {
  configureAutoUpdater();
  ipcMain.handle("cinchpos:update:get-state", async () => cloneUpdateState());
  ipcMain.handle("cinchpos:update:check", async () => checkForUpdates({ manual: true }));
  ipcMain.handle("cinchpos:update:download", async () => downloadUpdate());
  ipcMain.handle("cinchpos:update:install", async () => installUpdate());
  ipcMain.handle("cinchpos:update:cancel-download", async () => {
    if (fallbackDownloadRequest && typeof fallbackDownloadRequest.destroy === "function") {
      fallbackDownloadRequest.destroy(new Error("Download cancelled."));
    }
    return setUpdateState({
      status: "available",
      message: "Update download cancelled.",
      progress: null,
      canInstall: false
    });
  });
}

function getPrintJobsDir() {
  return ensureDirectorySync(path.join(getAppDataDir(), PRINT_JOBS_DIR_NAME));
}

function makeSafePrintFileName(value) {
  return String(value || "cinchpos-print")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "cinchpos-print";
}

async function waitForPrintAssets(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const assetWaitScript = `
    new Promise((resolve) => {
      const images = Array.from(document.images || []);
      let pending = images.filter((image) => !image.complete).length;
      if (!pending) {
        resolve(true);
        return;
      }
      const done = () => {
        pending -= 1;
        if (pending <= 0) {
          resolve(true);
        }
      };
      images.forEach((image) => {
        if (image.complete) {
          return;
        }
        image.addEventListener("load", done, { once: true });
        image.addEventListener("error", done, { once: true });
      });
      setTimeout(() => resolve(false), 1600);
    })
  `;

  await Promise.race([
    targetWindow.webContents.executeJavaScript(assetWaitScript, true).catch(() => false),
    new Promise((resolve) => setTimeout(resolve, 1800))
  ]);
}

function registerPrintBridge() {
  ipcMain.handle("cinchpos:print-html", async (event, payload = {}) => {
    const html = typeof payload.html === "string" ? payload.html : "";
    if (!html.trim()) {
      throw new Error("Nothing was prepared for printing.");
    }

    const title = makeSafePrintFileName(payload.title || "CinchPOS Bill");
    const printFilePath = path.join(getPrintJobsDir(), `${Date.now()}-${title}.html`);
    await fs.promises.writeFile(printFilePath, html, "utf8");

    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const printWindow = new BrowserWindow({
      width: 900,
      height: 760,
      minWidth: 640,
      minHeight: 520,
      title: `Print ${payload.title || "CinchPOS Bill"}`,
      backgroundColor: "#ffffff",
      show: false,
      autoHideMenuBar: true,
      parent: ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    attachCommonWindowHandlers(printWindow);

    const cleanup = () => {
      fs.promises.unlink(printFilePath).catch(() => {});
    };
    printWindow.on("closed", cleanup);

    try {
      await printWindow.loadFile(printFilePath);
      await waitForPrintAssets(printWindow);
      if (printWindow.isDestroyed()) {
        return { ok: false, cancelled: true };
      }

      printWindow.show();
      printWindow.focus();

      const printOptions = {
        silent: false,
        printBackground: true,
        margins: { marginType: "none" },
        scaleFactor: payload.isThermal ? 100 : clampPrintMicrons(payload.scaleFactor || 100, 70, 130)
      };
      if (payload.isThermal && payload.pageSize && typeof payload.pageSize === "object") {
        printOptions.pageSize = await getMeasuredThermalPageSize(printWindow, payload.pageSize);
      } else if (payload.pageSize) {
        printOptions.pageSize = payload.pageSize;
      }

      const result = await new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };
        printWindow.once("closed", () => settle({ ok: false, cancelled: true }));
        printWindow.webContents.print(printOptions, (success, failureReason) => {
          settle({
            ok: Boolean(success),
            cancelled: !success && /cancel/i.test(String(failureReason || "")),
            failureReason: failureReason || ""
          });
        });
      });

      if (!result.ok && !result.cancelled) {
        throw new Error(result.failureReason || "The system print dialog could not open.");
      }

      setTimeout(() => {
        if (!printWindow.isDestroyed()) {
          printWindow.destroy();
        }
      }, 800);
      return result;
    } catch (error) {
      if (!printWindow.isDestroyed()) {
        printWindow.destroy();
      }
      cleanup();
      throw error;
    }
  });
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
      preload: path.join(__dirname, "preload.cjs"),
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
    await backendBoot;
    servicesReady = true;
    await loadAppIntoWindow();
    setTimeout(() => {
      checkForUpdates({ manual: false }).catch((error) => {
        console.warn(`CinchPOS background update check failed: ${error.message || error}`);
      });
    }, 3500);
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
    registerSecureStorageBridge();
    registerRuntimeConfigBridge();
    registerPrintBridge();
    registerUpdateBridge();
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

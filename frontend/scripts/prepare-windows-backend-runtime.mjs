import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const backendDir = path.resolve(projectRoot, "..", "backend");
const runtimeRoot = path.join(backendDir, "runtime");
const downloadsDir = path.join(runtimeRoot, "downloads");
const windowsPythonDir = path.join(runtimeRoot, "windows-python");

const PYTHON_VERSION = process.env.CINCHPOS_WINDOWS_PYTHON_VERSION || "3.13.7";
const PYTHON_ZIP_NAME = `python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ZIP_NAME}`;
const PYTHON_ZIP_PATH = path.join(downloadsDir, PYTHON_ZIP_NAME);
const REQUIRED_PACKAGES = [
  "flask",
  "blinker",
  "click",
  "itsdangerous",
  "jinja2",
  "werkzeug",
  "markupsafe"
];

function streamDownload(url, destination) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(destination);
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        output.close();
        streamDownload(response.headers.location, destination).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        output.close();
        reject(new Error(`Download failed for ${url}: ${response.statusCode}`));
        return;
      }

      response.pipe(output);
      output.on("finish", () => {
        output.close();
        resolve();
      });
    });

    request.on("error", (error) => {
      output.close();
      reject(error);
    });
  });
}

async function findSitePackagesDir() {
  const windowsCandidate = path.join(backendDir, ".venv", "Lib", "site-packages");
  if (existsSync(windowsCandidate)) {
    return windowsCandidate;
  }

  const libDir = path.join(backendDir, ".venv", "lib");
  const pythonVersions = await readdir(libDir, { withFileTypes: true });
  const pythonDir = pythonVersions.find((entry) => entry.isDirectory() && entry.name.startsWith("python"));

  if (!pythonDir) {
    throw new Error("Could not locate backend virtualenv site-packages.");
  }

  const unixCandidate = path.join(libDir, pythonDir.name, "site-packages");
  if (!existsSync(unixCandidate)) {
    throw new Error("Could not locate backend virtualenv site-packages.");
  }

  return unixCandidate;
}

async function ensureDownload() {
  await mkdir(downloadsDir, { recursive: true });
  if (existsSync(PYTHON_ZIP_PATH)) {
    return;
  }

  console.log(`Downloading ${PYTHON_URL}`);
  await streamDownload(PYTHON_URL, PYTHON_ZIP_PATH);
}

function extractZip() {
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${PYTHON_ZIP_PATH}' -DestinationPath '${windowsPythonDir}' -Force`
    ], { stdio: "inherit" });
    return;
  }

  execFileSync("unzip", ["-o", PYTHON_ZIP_PATH, "-d", windowsPythonDir], {
    stdio: "inherit"
  });
}

async function configurePth() {
  const files = await readdir(windowsPythonDir);
  const pthName = files.find((entry) => entry.endsWith("._pth"));
  if (!pthName) {
    throw new Error("Could not find the embedded Python ._pth file.");
  }

  const versionPrefix = pthName.replace("._pth", "");
  const contents = [
    `${versionPrefix}.zip`,
    ".",
    "Lib/site-packages",
    "import site"
  ].join("\n");

  await writeFile(path.join(windowsPythonDir, pthName), `${contents}\n`);
}

async function copyDependencies() {
  const sitePackagesDir = await findSitePackagesDir();
  const targetSitePackagesDir = path.join(windowsPythonDir, "Lib", "site-packages");

  await mkdir(targetSitePackagesDir, { recursive: true });

  for (const packageName of REQUIRED_PACKAGES) {
    const source = path.join(sitePackagesDir, packageName);
    if (!existsSync(source)) {
      throw new Error(`Missing Python package directory: ${source}`);
    }
    await rm(path.join(targetSitePackagesDir, packageName), { recursive: true, force: true });
    await cp(source, path.join(targetSitePackagesDir, packageName), { recursive: true });
  }
}

async function writeRuntimeMetadata() {
  const metadata = {
    pythonUrl: PYTHON_URL,
    pythonVersion: PYTHON_VERSION,
    generatedAt: new Date().toISOString(),
    packagedDependencies: REQUIRED_PACKAGES
  };

  await writeFile(
    path.join(windowsPythonDir, "cinchpos-runtime.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
}

async function main() {
  await ensureDownload();
  await rm(windowsPythonDir, { recursive: true, force: true });
  await mkdir(windowsPythonDir, { recursive: true });
  extractZip();
  await configurePth();
  await copyDependencies();
  await writeRuntimeMetadata();
  console.log(`Prepared Windows backend runtime at ${windowsPythonDir}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

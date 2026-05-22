import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const backendDir = path.resolve(projectRoot, "..", "backend");
const vendorDir = path.join(backendDir, "vendor");

const REQUIRED_PACKAGES = [
  "flask",
  "blinker",
  "click",
  "itsdangerous",
  "jinja2",
  "markupsafe",
  "werkzeug"
];

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

  return path.join(libDir, pythonDir.name, "site-packages");
}

async function removeCompiledArtifacts(targetDir) {
  const entries = await readdir(targetDir, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") {
        await rm(fullPath, { recursive: true, force: true });
        return;
      }
      await removeCompiledArtifacts(fullPath);
      return;
    }

    if (/\.(so|pyd|pyc)$/i.test(entry.name)) {
      await rm(fullPath, { force: true });
    }
  }));
}

async function main() {
  const sitePackagesDir = await findSitePackagesDir();

  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });

  for (const packageName of REQUIRED_PACKAGES) {
    const sourceDir = path.join(sitePackagesDir, packageName);
    if (!existsSync(sourceDir)) {
      throw new Error(`Missing Python package directory: ${sourceDir}`);
    }
    const destinationDir = path.join(vendorDir, packageName);
    await cp(sourceDir, destinationDir, { recursive: true });
    await removeCompiledArtifacts(destinationDir);
  }

  await writeFile(
    path.join(vendorDir, "README.txt"),
    "Vendored pure-Python Flask runtime dependencies for packaged Linux builds.\n"
  );

  console.log(`Prepared backend vendor directory at ${vendorDir}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

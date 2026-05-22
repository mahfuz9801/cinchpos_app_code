import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");
const testsDir = path.join(frontendDir, "tests");

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const targetPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTestFiles(targetPath);
    }
    return entry.name.endsWith(".test.mjs") ? [targetPath] : [];
  });
}

const testFiles = collectTestFiles(testsDir);

if (!testFiles.length) {
  console.error("No frontend test files were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: frontendDir,
  stdio: "inherit"
});

process.exit(result.status ?? 1);

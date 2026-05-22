import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, "..");
const backendDir = path.resolve(frontendDir, "..", "backend");

const pythonCandidates = process.platform === "win32"
  ? [
      path.join(backendDir, ".venv", "Scripts", "python.exe"),
      "python",
      "py"
    ]
  : [
      path.join(backendDir, ".venv", "bin", "python"),
      "python3",
      "python"
    ];

for (const candidate of pythonCandidates) {
  if (candidate.includes(path.sep) && !existsSync(candidate)) {
    continue;
  }

  const result = spawnSync(candidate, ["-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], {
    cwd: backendDir,
    stdio: "inherit"
  });

  if (result.error && result.error.code === "ENOENT") {
    continue;
  }

  process.exit(result.status ?? 1);
}

console.error("Could not find a Python runtime to execute backend tests.");
process.exit(1);

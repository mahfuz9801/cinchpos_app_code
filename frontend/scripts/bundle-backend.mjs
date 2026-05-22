import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..", "..", "backend");
const pythonExecutable = process.platform === "win32"
  ? path.join(backendDir, ".venv", "Scripts", "python.exe")
  : path.join(backendDir, ".venv", "bin", "python");

if (!existsSync(pythonExecutable)) {
  console.error(`Missing backend build Python at ${pythonExecutable}`);
  process.exit(1);
}

const result = spawnSync(
  pythonExecutable,
  ["-m", "PyInstaller", "--clean", "--onefile", "--name", "cinchpos-backend", "app.py"],
  {
    cwd: backendDir,
    stdio: "inherit"
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

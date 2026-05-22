import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pngToIco from "png-to-ico";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const buildDir = path.join(projectRoot, "build");
const sourcePng = path.join(buildDir, "icon.png");
const iconIco = path.join(buildDir, "icon.ico");
const iconIcns = path.join(buildDir, "icon.icns");
const iconsetDir = path.join(buildDir, "icon.iconset");
const windowsIconsetDir = path.join(buildDir, "windows.iconset");

async function ensureWindowsIcon() {
  if (process.platform !== "darwin" && existsSync(iconIco)) {
    console.log(`Reusing ${iconIco}`);
    return;
  }

  if (process.platform !== "darwin") {
    const fallbackBuffer = await pngToIco([sourcePng]);
    await writeFile(iconIco, fallbackBuffer);
    console.log(`Generated fallback ${iconIco}`);
    return;
  }

  const sizes = [
    [16, "icon_16x16.png"],
    [24, "icon_24x24.png"],
    [32, "icon_32x32.png"],
    [48, "icon_48x48.png"],
    [64, "icon_64x64.png"],
    [128, "icon_128x128.png"],
    [256, "icon_256x256.png"]
  ];

  await rm(windowsIconsetDir, { recursive: true, force: true });
  await mkdir(windowsIconsetDir, { recursive: true });

  const windowsPngs = sizes.map(([size, filename]) => {
    const outPath = path.join(windowsIconsetDir, filename);
    execFileSync("sips", ["-z", String(size), String(size), sourcePng, "--out", outPath], {
      stdio: "inherit"
    });
    return outPath;
  });

  const buffer = await pngToIco(windowsPngs);
  await writeFile(iconIco, buffer);
  console.log(`Generated ${iconIco}`);
}

async function ensureMacIcon() {
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"]
  ];

  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(iconsetDir, { recursive: true });

  sizes.forEach(([size, filename]) => {
    execFileSync("sips", ["-z", String(size), String(size), sourcePng, "--out", path.join(iconsetDir, filename)], {
      stdio: "inherit"
    });
  });

  try {
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", iconIcns], {
      stdio: "inherit"
    });
    console.log(`Generated ${iconIcns}`);
  } catch (error) {
    if (existsSync(iconIcns)) {
      console.warn(`Reusing existing ${iconIcns} because iconutil could not regenerate it.`);
      return;
    }
    throw error;
  }
}

async function main() {
  if (!existsSync(sourcePng)) {
    throw new Error(`Missing icon source: ${sourcePng}`);
  }

  await mkdir(buildDir, { recursive: true });
  await ensureWindowsIcon();

  if (process.platform === "darwin") {
    await ensureMacIcon();
  } else if (!existsSync(iconIcns)) {
    console.log("Skipping .icns generation on non-macOS host.");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

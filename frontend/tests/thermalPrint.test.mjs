import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  MAX_THERMAL_PAGE_HEIGHT_MICRONS,
  getThermalPrintGeometry
} = require("../electron/thermal-print.cjs");

test("short thermal receipts retain their measured height at 100 percent scale", () => {
  const geometry = getThermalPrintGeometry(
    { width: 302, height: 500 },
    { width: 80000, height: 180000 }
  );

  assert.equal(geometry.pageSize.width, 80000);
  assert.equal(geometry.pageSize.height, 140292);
  assert.equal(geometry.paginated, false);
  assert.equal(geometry.estimatedPageCount, 1);
});

test("large thermal receipts use fixed-height pages instead of one shrinkable custom page", () => {
  const geometry = getThermalPrintGeometry(
    { width: 302, height: 3000 },
    { width: 80000, height: 280000 }
  );

  assert.equal(geometry.pageSize.width, 80000);
  assert.equal(geometry.pageSize.height, MAX_THERMAL_PAGE_HEIGHT_MICRONS);
  assert.equal(geometry.paginated, true);
  assert.equal(geometry.estimatedPageCount, 3);
  assert.ok(geometry.contentHeightMicrons > geometry.pageSize.height);
});

test("thermal width follows the selected printer profile", () => {
  const geometry = getThermalPrintGeometry(
    { width: 219, height: 700 },
    { width: 58000, height: 220000 }
  );

  assert.equal(geometry.pageSize.width, 58000);
  assert.equal(geometry.paginated, false);
});

test("fallback print dimensions can never recreate a metre-long page", () => {
  const geometry = getThermalPrintGeometry({}, { width: 80000, height: 12000000 });

  assert.equal(geometry.pageSize.height, MAX_THERMAL_PAGE_HEIGHT_MICRONS);
  assert.equal(geometry.contentHeightMicrons, 288000);
  assert.equal(geometry.paginated, true);
});

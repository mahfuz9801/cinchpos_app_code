const CSS_PX_PER_INCH = 96;
const MICRONS_PER_INCH = 25400;
const MIN_THERMAL_WIDTH_MICRONS = 50000;
const MAX_THERMAL_WIDTH_MICRONS = 82000;
const MIN_THERMAL_PAGE_HEIGHT_MICRONS = 70000;
// A driver-safe segment keeps Chromium at 100% scale for long roll-paper receipts.
const MAX_THERMAL_PAGE_HEIGHT_MICRONS = 280000;
const RECEIPT_END_ALLOWANCE_MICRONS = 8000;

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cssPixelsToMicrons(value) {
  const pixels = Math.max(0, Number(value) || 0);
  return Math.round((pixels / CSS_PX_PER_INCH) * MICRONS_PER_INCH);
}

function getThermalPrintGeometry(measurement = {}, fallbackPageSize = {}) {
  const width = clampNumber(
    fallbackPageSize.width,
    MIN_THERMAL_WIDTH_MICRONS,
    MAX_THERMAL_WIDTH_MICRONS,
    80000
  );
  const measuredHeightMicrons = cssPixelsToMicrons(measurement.height);
  const fallbackHeightMicrons = clampNumber(
    fallbackPageSize.height,
    MIN_THERMAL_PAGE_HEIGHT_MICRONS,
    MAX_THERMAL_PAGE_HEIGHT_MICRONS,
    180000
  );
  const contentHeightMicrons = Math.max(
    MIN_THERMAL_PAGE_HEIGHT_MICRONS,
    measuredHeightMicrons || fallbackHeightMicrons
  ) + RECEIPT_END_ALLOWANCE_MICRONS;
  const height = Math.min(contentHeightMicrons, MAX_THERMAL_PAGE_HEIGHT_MICRONS);

  return {
    pageSize: { width, height },
    contentHeightMicrons,
    paginated: contentHeightMicrons > MAX_THERMAL_PAGE_HEIGHT_MICRONS,
    estimatedPageCount: Math.max(1, Math.ceil(contentHeightMicrons / MAX_THERMAL_PAGE_HEIGHT_MICRONS))
  };
}

module.exports = {
  MAX_THERMAL_PAGE_HEIGHT_MICRONS,
  getThermalPrintGeometry
};

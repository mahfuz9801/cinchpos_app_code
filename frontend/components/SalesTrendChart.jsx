import { currency } from "@/lib/format";

function buildCoordinates(points) {
  const width = 760;
  const height = 280;
  const padding = { top: 18, right: 20, bottom: 42, left: 20 };
  const maxValue = Math.max(...points.map((point) => Number(point.value || 0)), 1);
  const stepX = points.length > 1 ? (width - padding.left - padding.right) / (points.length - 1) : 0;

  return points.map((point, index) => {
    const x = padding.left + index * stepX;
    const usableHeight = height - padding.top - padding.bottom;
    const y = padding.top + usableHeight - (Number(point.value || 0) / maxValue) * usableHeight;
    return { ...point, x, y };
  });
}

function captionFor(view) {
  if (view === "daily") {
    return "Collections in the last 7 days";
  }
  if (view === "weekly") {
    return "Collections by week";
  }
  if (view === "monthly") {
    return "Collections by month";
  }
  return "Collections in the selected range";
}

export default function SalesTrendChart({ trend, view, customRange, onViewChange, onRangeChange, onApplyRange }) {
  const points = trend?.points?.length ? trend.points : [{ label: "No data", value: 0 }];
  const coordinates = buildCoordinates(points);
  const width = 760;
  const height = 280;
  const linePath = coordinates.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${coordinates[coordinates.length - 1].x} 238 L ${coordinates[0].x} 238 Z`;
  const peak = Math.max(...points.map((point) => Number(point.value || 0)), 0);

  return (
    <section className="panel" id="sales-trend">
      <div className="panel-header">
        <div>
          <h2>Sales Trend</h2>
          <div className="panel-subtitle">Daily, weekly, monthly, and custom range collections.</div>
        </div>
        <div className="trend-controls">
          <div className="segmented-control">
            {["daily", "weekly", "monthly", "custom"].map((item) => (
              <button key={item} className={view === item ? "active" : ""} type="button" onClick={() => onViewChange(item)}>
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className={`range-controls ${view === "custom" ? "visible" : ""}`}>
        <input
          className="range-input"
          type="date"
          value={customRange.startDate}
          onChange={(event) => onRangeChange({ ...customRange, startDate: event.target.value })}
        />
        <input
          className="range-input"
          type="date"
          value={customRange.endDate}
          onChange={(event) => onRangeChange({ ...customRange, endDate: event.target.value })}
        />
        <button className="button button-secondary" type="button" onClick={onApplyRange}>
          Apply Range
        </button>
      </div>
      <div className="chart-meta">
        <span>{captionFor(view)}</span>
        <span>Peak {currency(peak)}</span>
      </div>
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} aria-label="Revenue trend chart">
        {[0.25, 0.5, 0.75].map((ratio) => {
          const y = 18 + (height - 18 - 42) * ratio;
          return <line key={ratio} x1="20" x2="740" y1={y} y2={y} stroke="var(--line)" strokeDasharray="5 8" />;
        })}
        <path d={areaPath} fill="rgba(11, 122, 83, 0.12)" />
        <path d={linePath} fill="none" stroke="var(--green)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {coordinates.map((point, index) => (
          <g key={`${point.label}-${index}`}>
            <circle cx={point.x} cy={point.y} r="5" fill="var(--surface)" stroke="var(--green)" strokeWidth="3" />
            <text x={point.x} y="262" textAnchor="middle" fill="var(--muted)" fontSize="13">
              {point.label}
            </text>
          </g>
        ))}
      </svg>
    </section>
  );
}

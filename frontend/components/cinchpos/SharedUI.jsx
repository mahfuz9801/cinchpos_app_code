"use client";

import { useEffect, useState } from "react";
import { currency, statusClass } from "@/lib/format";
import { APP_NAME, CINCHPOS_LOGO_SRC, SUPPORT_EMAIL, SUPPORT_PHONE } from "@/lib/cinchpos/constants";

export function AppLogo({ className = "" }) {
  return (
    <span className={`app-logo-mark ${className}`} aria-label={`${APP_NAME} app logo`}>
      <img src={CINCHPOS_LOGO_SRC} alt={`${APP_NAME} logo`} />
    </span>
  );
}

export function StoreLogo({ source = "", fallback = "ST", alt = "Store logo", className = "" }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [source]);

  return (
    <span className={`store-logo-frame ${className}`} aria-label={alt}>
      {source && !failed ? (
        <img src={source} alt={alt} onError={() => setFailed(true)} />
      ) : (
        <span className="store-logo-initials">{fallback}</span>
      )}
    </span>
  );
}

export function HeaderTitle({ storeName, title, eyebrow }) {
  return (
    <div className="header-title">
      <div className="eyebrow">{eyebrow}</div>
      <h1><span className="store-title-name">{storeName}</span> <span id="workspaceTitle" className="store-title-app">{title}</span></h1>
    </div>
  );
}

export function HeaderSupportMenu() {
  const phoneHref = `tel:${SUPPORT_PHONE.replace(/\s+/g, "")}`;
  const mailHref = `mailto:${SUPPORT_EMAIL}`;
  return (
    <nav className="toolbar-actions header-support-menu" aria-label="Support links">
      <a className="button button-secondary" href={phoneHref} title={`${SUPPORT_PHONE} | ${SUPPORT_EMAIL}`}>Contact Us</a>
      <a className="button button-secondary" href={mailHref}>Support</a>
      <a className="button button-secondary" href="#help-center">Help Center</a>
    </nav>
  );
}

export function Modal({ open, title, subtitle, large = false, cardClass = "", children, onClose }) {
  return (
    <div className={`modal ${open ? "open" : ""}`} aria-hidden={!open} onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <div className={`modal-card ${large ? "large" : ""} ${cardClass}`}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-button" type="button" onClick={onClose}>&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function IconSprite() {
  return (
    <svg className="icon-sprite" aria-hidden="true" focusable="false">
      <symbol id="icon-dashboard" viewBox="0 0 24 24"><path d="M4 5.5h16v13H4zM4 10h16M8 15h1.5M12 15h1.5M16 15h1.5M8 6v3"></path></symbol>
      <symbol id="icon-pos" viewBox="0 0 24 24"><path d="M7 4h8l2 4v4H5V8h12M6 12h12v7H6zM8.5 15h2M13 15h3M8.5 17.5h7.5M16 4h1.5a2 2 0 0 1 2 2v13M9 6h4"></path></symbol>
      <symbol id="icon-invoice" viewBox="0 0 24 24"><path d="M7 4h10v16l-2-1-2 1-2-1-2 1-2-1zM9 8h6M9 11h6M9 15h2.5M13 15h2M10 18h4"></path></symbol>
      <symbol id="icon-customer" viewBox="0 0 24 24"><path d="M4 6h16v12H4zM8 10.25a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 10h5M12 13h4M12 16h3M5 6l2-2h10l2 2"></path></symbol>
      <symbol id="icon-inventory" viewBox="0 0 24 24"><path d="M5 5h14v14H5zM5 10h14M5 15h14M8 7.5h3M13 7.5h3M8 12.5h2.5M13 12.5h3M8 17.5h3M14 17.5h2"></path></symbol>
      <symbol id="icon-online" viewBox="0 0 24 24"><path d="M4 7h16l-1.5 12h-13zM7 7a5 5 0 0 1 10 0M8 11h8M9 15h6M12 11v4M6.5 19h11"></path></symbol>
      <symbol id="icon-purchase" viewBox="0 0 24 24"><path d="M7 4h10v16H7zM9 8h6M9 11h5M9 14h3M15.5 15.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM14.2 17.2h1.4M14.2 18.8h1.4"></path></symbol>
      <symbol id="icon-expenses" viewBox="0 0 24 24"><path d="M6 5h12v14H6zM9 9h6M9 12h4M9 15h2M15.5 14.5h4M17.5 12.5v4M8 5l1-2h6l1 2"></path></symbol>
      <symbol id="icon-report" viewBox="0 0 24 24"><path d="M5 19V5M5 19h15M8 15l3-3 3 2 4-6M9 19v-3M13 19v-4M17 19v-7"></path></symbol>
      <symbol id="icon-employee" viewBox="0 0 24 24"><path d="M6 5h12v15H6zM9 9a3 3 0 1 0 6 0 3 3 0 0 0-6 0zM8.5 17a4 4 0 0 1 7 0M10 5l1-2h2l1 2"></path></symbol>
      <symbol id="icon-bank" viewBox="0 0 24 24"><path d="M4 9h16L12 4zM6 9v8M10 9v8M14 9v8M18 9v8M4 19h16M7 12h10M7 15h10"></path></symbol>
      <symbol id="icon-documents" viewBox="0 0 24 24"><path d="M6 4h9l3 3v13H6zM14 4v4h4M8.5 10h7M8.5 13h7M8.5 16h4M16 18.5l1.2 1.2 2.3-2.7"></path></symbol>
      <symbol id="icon-transfer" viewBox="0 0 24 24"><path d="M4 7h10M10 3l4 4-4 4M20 17H10M14 13l-4 4 4 4M5 13h4M15 11h4"></path></symbol>
      <symbol id="icon-settings" viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14M9 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM15 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM10 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path></symbol>
    </svg>
  );
}

export function SummaryIcon({ type }) {
  const paths = {
    revenue: "M6 23V9M6 23h20M10 19l4-4 4 2.5 6-8.5M11 9.5h5M11 12.5h3",
    outstanding: "M8 7h12v18H8zM11 11h6M11 14h5M20 18h3M20 21h3M14 21a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    invoices: "M10 5h12v21l-2.5-1.3L17 26l-2.5-1.3L12 26l-2-1zM13 10h6M13 14h6M13 18h3M17 18h2",
    balance: "M7 8h18v15H7zM7 13h18M11 18h4M18 18h3M11 21h10M10 5h12"
  };

  return (
    <div className="summary-icon" aria-hidden="true">
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={paths[type]} />
      </svg>
    </div>
  );
}

export function TrendChart({ points }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const safePoints = points?.length ? points : [{ label: "", value: 0 }, { label: "", value: 0 }];
  const width = 760;
  const height = 280;
  const padding = { top: 18, right: 20, bottom: 42, left: 20 };
  const maxValue = Math.max(...safePoints.map((point) => Number(point.value || 0)), 1);
  const stepX = safePoints.length > 1 ? (width - padding.left - padding.right) / (safePoints.length - 1) : 0;
  const coordinates = safePoints.map((point, index) => {
    const x = padding.left + index * stepX;
    const usableHeight = height - padding.top - padding.bottom;
    const y = padding.top + usableHeight - (Number(point.value || 0) / maxValue) * usableHeight;
    return { ...point, x, y };
  });
  const linePath = coordinates.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${coordinates[coordinates.length - 1].x} ${height - padding.bottom} L ${coordinates[0].x} ${height - padding.bottom} Z`;
  const activePoint = activeIndex === null ? null : coordinates[activeIndex];
  const hoverWidth = safePoints.length > 1 ? stepX : width - padding.left - padding.right;
  const tooltipWidth = 150;
  const tooltipHeight = 44;
  const tooltipX = activePoint
    ? Math.min(width - tooltipWidth - 8, Math.max(8, activePoint.x - tooltipWidth / 2))
    : 0;
  const tooltipY = activePoint ? Math.max(8, activePoint.y - tooltipHeight - 14) : 0;
  const labelStride = Math.max(1, Math.ceil(coordinates.length / 8));
  const updateActivePoint = (event) => {
    if (!safePoints.length) {
      setActiveIndex(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const nextIndex = stepX
      ? Math.round((relativeX - padding.left) / stepX)
      : 0;
    setActiveIndex(Math.max(0, Math.min(coordinates.length - 1, nextIndex)));
  };

  return (
    <svg
      id="trendChart"
      className="chart-svg"
      viewBox={`0 0 ${width} ${height}`}
      aria-label="Revenue trend chart"
      onPointerMove={updateActivePoint}
      onPointerLeave={() => setActiveIndex(null)}
    >
      <defs>
        <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--green)" stopOpacity="0.24"></stop>
          <stop offset="100%" stopColor="var(--green)" stopOpacity="0.02"></stop>
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => {
        const y = padding.top + (height - padding.top - padding.bottom) * ratio;
        return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="var(--line)" strokeDasharray="4 10" />;
      })}
      <path d={areaPath} fill="url(#trendFill)"></path>
      <path d={linePath} fill="none" stroke="var(--green)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"></path>
      {coordinates.map((point, index) => (
        <g key={`${point.label}-${index}`}>
          <circle cx={point.x} cy={point.y} r="4.5" fill="var(--green)"></circle>
          {index % labelStride === 0 || index === coordinates.length - 1 ? (
            <text x={point.x} y={height - 14} textAnchor="middle" fill="var(--muted)" fontSize="12">{point.label}</text>
          ) : null}
        </g>
      ))}
      {coordinates.map((point, index) => {
        const x = Math.max(padding.left, point.x - hoverWidth / 2);
        const maxWidth = width - padding.left - padding.right;
        const nextWidth = Math.min(hoverWidth || maxWidth, width - padding.right - x);
        return (
          <rect
            key={`hover-${point.label}-${index}`}
            className="chart-hover-zone"
            x={x}
            y={padding.top}
            width={Math.max(18, nextWidth)}
            height={height - padding.top - padding.bottom}
            tabIndex="0"
            role="button"
            aria-label={`${point.label || "Trend"} ${currency(point.value)}`}
            onPointerEnter={() => setActiveIndex(index)}
            onFocus={() => setActiveIndex(index)}
            onBlur={() => setActiveIndex(null)}
          />
        );
      })}
      {activePoint ? (
        <g className="chart-tooltip">
          <line className="chart-hover-line" x1={activePoint.x} x2={activePoint.x} y1={padding.top} y2={height - padding.bottom} />
          <circle className="chart-active-dot" cx={activePoint.x} cy={activePoint.y} r="7" />
          <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx="8" />
          <text className="chart-tooltip-label" x={tooltipX + 10} y={tooltipY + 17}>{activePoint.label || "Trend"}</text>
          <text className="chart-tooltip-value" x={tooltipX + 10} y={tooltipY + 35}>{currency(activePoint.value)}</text>
        </g>
      ) : null}
    </svg>
  );
}

export function InvoiceRow({ invoice, includeInvoiceNumber = true }) {
  return (
    <article className="invoice-item">
      <div>
        <div className="invoice-row">
          <span className="invoice-name">{invoice.customer_name}</span>
          <span className="invoice-amount">{currency(invoice.amount)}</span>
        </div>
        <p className="invoice-meta">{includeInvoiceNumber ? `${invoice.invoice_number} | ` : ""}Date {invoice.issued_on}</p>
      </div>
      <span className={`status-badge ${statusClass(invoice.status)}`}>{invoice.status}</span>
    </article>
  );
}

export function Empty({ children }) {
  return <div className="clean-empty">{children}</div>;
}

export function FileAction({ record, label }) {
  if (!record.fileData || !String(record.fileData).startsWith("data:")) {
    return null;
  }
  return <a className="button button-secondary file-action" href={record.fileData} download={record.fileName || "cinchpos-file"}>{label}</a>;
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HeaderToolbar from "./HeaderToolbar";
import IconSprite from "./IconSprite";
import Modals from "./Modals";

const defaultSettings = {
  businessName: "CinchPOS",
  ownerName: "Billing Workspace",
  appearance: "system",
  density: "comfortable",
  deviceType: "desktop"
};

const navItems = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/pos", label: "CinchPOS", icon: "pos", billing: true },
  { href: "/invoices", label: "Invoices", icon: "invoice" },
  { href: "/customers", label: "Customer Info", icon: "customer" },
  { href: "/inventory", label: "Inventory", icon: "inventory" }
];

function loadStoredSettings() {
  if (typeof window === "undefined") {
    return defaultSettings;
  }

  try {
    return {
      ...defaultSettings,
      ...JSON.parse(window.localStorage.getItem("cinchPOSSettings") || "{}")
    };
  } catch {
    return defaultSettings;
  }
}

export default function DashboardLayout({ title, customers = [], invoices = [], onRefresh = async () => {}, children }) {
  const pathname = usePathname();
  const [activeModal, setActiveModal] = useState(null);
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState(defaultSettings);
  const messageTimer = useRef(null);

  useEffect(() => {
    setSettings(loadStoredSettings());
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.toggle("density-compact", settings.density === "compact");
    body.dataset.deviceType = settings.deviceType || "desktop";

    if (settings.appearance === "dark") {
      body.dataset.appearance = "dark";
    } else if (settings.appearance === "light") {
      delete body.dataset.appearance;
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      body.dataset.appearance = "dark";
    } else {
      delete body.dataset.appearance;
    }

    window.localStorage.setItem("cinchPOSSettings", JSON.stringify(settings));
  }, [settings]);

  const showMessage = useCallback((text) => {
    setMessage(text);
    if (messageTimer.current) {
      window.clearTimeout(messageTimer.current);
    }
    messageTimer.current = window.setTimeout(() => setMessage(""), 4200);
  }, []);

  const openModal = useCallback((name, props = {}) => setActiveModal({ name, props }), []);
  const closeModal = useCallback(() => setActiveModal(null), []);
  const actions = useMemo(() => ({ openModal, closeModal, showMessage }), [openModal, closeModal, showMessage]);
  const initials = settings.businessName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "CP";

  return (
    <>
      <IconSprite />
      <main className="desktop-app">
        <section className="app-workspace">
          <HeaderToolbar title={title} businessName={settings.businessName} ownerName={settings.ownerName} openModal={openModal} />
          <div id="appMessage" className={`message ${message ? "show" : ""}`}>
            {message}
          </div>
          <div className="app-view-stack">
            {typeof children === "function" ? children(actions) : children}
          </div>
        </section>

        <aside className="right-navigation" aria-label="Application navigation">
          <Link className="brand" href="/">
            <span className="brand-logo-wrap">
              <span id="brandFallback" className="brand-mark">{initials}</span>
            </span>
            <span>
              <span>{settings.businessName}</span>
              <small>Billing workspace</small>
            </span>
          </Link>
          <nav className="right-nav-links">
            {navItems.map((item) => {
              const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} className={`nav-item ${item.billing ? "nav-billing" : ""} ${isActive ? "active" : ""}`}>
                  <span className="nav-icon">
                    <svg><use href={`#icon-${item.icon}`}></use></svg>
                  </span>
                  {item.label}
                </Link>
              );
            })}
            <button className="nav-item" type="button" onClick={() => openModal("settings")}>
              <span className="nav-icon">
                <svg><use href="#icon-settings"></use></svg>
              </span>
              Settings
            </button>
          </nav>
        </aside>
      </main>

      <Modals
        activeModal={activeModal}
        customers={customers}
        invoices={invoices}
        settings={settings}
        onSettingsChange={setSettings}
        openModal={openModal}
        closeModal={closeModal}
        onRefresh={onRefresh}
        showMessage={showMessage}
      />
    </>
  );
}

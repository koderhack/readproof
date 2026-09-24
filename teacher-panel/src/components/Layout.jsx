import React, { useEffect, useState } from "react";
import { cn } from "../lib/utils.js";
import { Icon } from "../lib/icons.jsx";
import { useApp } from "../context.jsx";
import { Avatar, Toasts } from "./ui.jsx";

const NAV = [
  { name: "dashboard", label: "Panel nauczyciela", icon: "dashboard", group: "Pulpit" },
  { name: "tests", label: "Testy", icon: "doc", group: "Pulpit" },
  { name: "classes", label: "Klasy", icon: "classes", group: "Nauczanie" },
  { name: "students", label: "Uczniowie", icon: "users", group: "Nauczanie" },
  { name: "results", label: "Wyniki", icon: "chart", group: "Ewaluacja" },
  { name: "grading", label: "Sprawdzanie", icon: "checkCircle", group: "Ewaluacja" },
  { name: "settings", label: "Ustawienia", icon: "settings", group: "System" },
];

export function Layout({ children }) {
  const { view, navigate, getTeacherWallet } = useApp();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const wallet = getTeacherWallet();
  const isDemo = wallet === "DemoNauczyciel-panel";
  const displayName = isDemo ? "Nauczyciel (demo)" : `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;

  const current = NAV.find((n) => n.name === view.name);

  const go = (name) => {
    navigate(name);
    setMobileOpen(false);
  };

  const groups = [...new Set(NAV.map((n) => n.group))];

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <div className={cn("shell", collapsed && "shell-collapsed")}>
      <div
        className={cn("sidebar", mobileOpen && "sidebar-open", collapsed && "sidebar-collapsed")}
      >
        <div className="brand">
          <div className="brand-mark">
            <img src="/assets/icon.png" alt="" />
          </div>
          {!collapsed && (
            <div className="brand-text">
              <strong>ReadProof</strong>
              <span>Panel nauczyciela</span>
            </div>
          )}
        </div>

        <nav className="nav">
          {groups.map((g) => (
            <div key={g} className="nav-group">
              {!collapsed && <div className="nav-group-label">{g}</div>}
              {NAV.filter((n) => n.group === g).map((item) => (
                <button
                  key={item.name}
                  className={cn("nav-item", view.name === item.name && "active")}
                  onClick={() => go(item.name)}
                  title={item.label}
                >
                  <Icon name={item.icon} size={19} />
                  {!collapsed && <span>{item.label}</span>}
                  {!collapsed && item.name === "grading" && <span className="nav-dot" />}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button
            className="nav-item collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Rozwiń menu" : "Zwiń menu"}
          >
            <Icon name={collapsed ? "chevronRight" : "chevronLeft"} size={18} />
            {!collapsed && <span>Zwiń menu</span>}
          </button>
        </div>
      </div>

      {mobileOpen && <div className="scrim" onClick={() => setMobileOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="icon-btn mobile-burger" onClick={() => setMobileOpen(true)} aria-label="Menu" aria-expanded={mobileOpen}>
            <Icon name="menu" size={20} />
          </button>
          <div className="topbar-title">
            {current ? current.label : "Panel"}
          </div>
          <div className="topbar-actions">
            <a className="topbar-action" href="/verify/" title="Weryfikuj dowód blockchain"><Icon name="checkCircle" size={18} /></a>
            <button className="topbar-action search-btn" title="Szukaj testy" onClick={() => navigate("tests")}>
              <Icon name="search" size={18} />
            </button>
            <button className="topbar-action" title="Nowe wyniki" onClick={() => navigate("results")}>
              <Icon name="bell" size={18} />
            </button>
            <button className="topbar-user" onClick={() => navigate("settings")}>
              <Avatar student={{ firstName: displayName, lastName: "" }} size={32} />
              <span className="topbar-user-name">
                <strong>{displayName}</strong>
                <small>Panel nauczyciela</small>
              </span>
            </button>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>

      <Toasts />
    </div>
  );
}
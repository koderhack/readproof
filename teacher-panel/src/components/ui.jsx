import React from "react";
import { cn } from "../lib/utils.js";
import { Icon } from "../lib/icons.jsx";
import { statusMeta, typeMeta } from "../data/meta.js";
import { useApp } from "../context.jsx";

export const Badge = ({ tone = "gray", children, className }) => (
  <span className={cn("badge", `badge-${tone}`, className)}>{children}</span>
);

export const TypeBadge = ({ type, small }) => {
  const meta = typeMeta[type];
  return (
    <span className={cn("type-badge", `type-${type}`, small && "type-small")}>
      <Icon name={meta.icon} size={small ? 13 : 14} />
      {meta.label}
    </span>
  );
};

export const StatusBadge = ({ status }) => {
  const meta = statusMeta[status] || { label: status, tone: "gray" };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
};

export const Avatar = ({ student, size = 34, className }) => {
  const name = student ? `${student.firstName} ${student.lastName}` : "?";
  const initials = student
    ? `${student.firstName?.[0] ?? ""}${student.lastName?.[0] ?? ""}`.toUpperCase()
    : "?";
  const hue = student
    ? [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360
    : 0;
  return (
    <span
      className={cn("avatar", className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 42% 88%)`, color: `hsl(${hue} 45% 32%)` }}
      title={name}
    >
      {initials}
    </span>
  );
};

export const StatCard = ({ label, value, icon, hint, tone = "indigo", to, small }) => {
  const accentTones = {
    indigo: { bg: "#E8EDF7", color: "#173A8A" },
    blue: { bg: "#E8EDF7", color: "#173A8A" },
    amber: { bg: "#F8F1E0", color: "#B98A2F" },
    green: { bg: "#E7F2EB", color: "#1B5E3B" },
    rose: { bg: "#FBEAEA", color: "#B3261E" },
    violet: { bg: "#E7F2EB", color: "#1B5E3B" },
  };
  const t = accentTones[tone] || accentTones.blue;
  return (
    <div className={cn("stat-card", small && "stat-card-small")}>
      <div className="stat-icon" style={{ background: t.bg, color: t.color }}>
        <Icon name={icon} size={19} />
      </div>
      <div className="stat-body">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {hint && <div className="stat-hint">{hint}</div>}
      </div>
    </div>
  );
};

export const Modal = ({ open, onClose, title, children, footer, width = 560 }) => {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Zamknij">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
};

export const EmptyState = ({ icon = "doc", title, text, action }) => (
  <div className="empty-state">
    <div className="empty-icon"><Icon name={icon} size={26} /></div>
    <h3>{title}</h3>
    {text && <p>{text}</p>}
    {action}
  </div>
);

export const ProgressBar = ({ value, tone = "indigo", height = 6, label }) => (
  <div className="progress-wrap">
    <div className="progress-track" style={{ height }}>
      <div className={cn("progress-fill", `progress-${tone}`)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
    {label && <span className="progress-label">{label}</span>}
  </div>
);

export const Toggle = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    className={cn("toggle", checked && "toggle-on")}
    onClick={() => onChange(!checked)}
  >
    <span className="toggle-knob" />
    {label && <span className="toggle-label">{label}</span>}
  </button>
);

export const Toasts = () => {
  const { toasts } = useApp();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cn("toast", `toast-${t.tone}`)}>
          <Icon name={t.tone === "success" ? "checkCircle" : "info"} size={17} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
};

export const Segmented = ({ options, value, onChange, className }) => (
  <div className={cn("segmented", className)}>
    {options.map((o) => (
      <button
        key={o.value}
        className={cn("segmented-btn", value === o.value && "active")}
        onClick={() => onChange(o.value)}
      >
        {o.icon && <Icon name={o.icon} size={15} />}
        {o.label}
      </button>
    ))}
  </div>
);

export const PageHeader = ({ title, subtitle, actions }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
    {actions && <div className="page-head-actions">{actions}</div>}
  </div>
);

export const Btn = ({ children, variant = "primary", size = "md", icon, onClick, className, disabled, type = "button" }) => (
  <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className={cn("btn", `btn-${variant}`, `btn-${size}`, className)}
  >
    {icon && <Icon name={icon} size={size === "sm" ? 15 : 17} />}
    {children}
  </button>
);

export const Field = ({ label, hint, error, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
    {error && <span className="field-error">{error}</span>}
  </label>
);

export const ChartCard = ({ title, subtitle, right, children }) => (
  <div className="card">
    <div className="card-head">
      <div>
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {right}
    </div>
    <div className="card-body">{children}</div>
  </div>
);
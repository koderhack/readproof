import { gradeScale } from "../data/meta.js";

export const cn = (...args) => args.filter(Boolean).join(" ");

export const formatDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });
};

export const formatShortDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("pl-PL", { day: "numeric", month: "short" });
};

export const initials = (firstName, lastName) =>
  `${firstName?.charAt(0) ?? ""}${lastName?.charAt(0) ?? ""}`.toUpperCase();

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export const gradeFromPercent = (percent) => {
  if (percent == null) return null;
  const entry = gradeScale.find((g) => percent >= g.minPct);
  return entry ? entry.grade : 1;
};

export const gradeLabel = (grade) => {
  const e = gradeScale.find((g) => g.grade === grade);
  return e ? `${grade} (${e.label})` : "—";
};

export const totalPoints = (questions) =>
  questions.reduce((sum, q) => sum + (Number(q.points) || 0), 0);

export const questionTypeLabel = (type) => {
  const map = {
    single: "Jednokrotny wybór",
    multiple: "Wielokrotny wybór",
    truefalse: "Prawda / Fałsz",
    match: "Dopasowanie",
    order: "Kolejność",
    open: "Pytanie otwarte",
  };
  return map[type] || type;
};

export const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

const letters = ["A", "B", "C", "D", "E", "F", "G"];

export const letter = (i) => letters[i] || `[${i + 1}]`;

export function generateCode(prefix) {
  const chars = "ACDEFGHJKMNPQRTWXYZ34679";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${s}`;
}

export const avgOf = (arr) => {
  if (!arr || arr.length === 0) return { avg: 0, count: 0 };
  const grades = arr.filter((r) => r.status === "graded" && r.percent != null);
  if (grades.length === 0) return { avg: 0, count: 0 };
  const avg = grades.reduce((s, r) => s + r.percent, 0) / grades.length;
  return { avg: Math.round(avg), count: grades.length };
};

export const today = () => new Date().toISOString().slice(0, 10);

export const uid = (prefix) =>
  `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
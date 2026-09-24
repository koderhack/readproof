export const questionKinds = [
  { value: "single", label: "Jednokrotny wybór", icon: "radio", hint: "Jedna poprawna odpowiedź z kilku" },
  { value: "multiple", label: "Wielokrotny wybór", icon: "checkbox2", hint: "Kilka poprawnych odpowiedzi" },
  { value: "truefalse", label: "Prawda / Fałsz", icon: "toggle", hint: "Uczeń ocenia zdanie" },
  { value: "match", label: "Dopasowywanie", icon: "link", hint: "Łączenie pojęć parami" },
  { value: "order", label: "Kolejność", icon: "sort", hint: "Ułożenie elementów w ciąg" },
  { value: "open", label: "Otwarte", icon: "pencil", hint: "Odpowiedź pisemna ucznia" },
];

export const gradeScale = [
  { grade: 6, label: "celujący", minPct: 95, color: "#1B5E3B" },
  { grade: 5, label: "bardzo dobry", minPct: 85, color: "#173A8A" },
  { grade: 4, label: "dobry", minPct: 70, color: "#2456C8" },
  { grade: 3, label: "dostateczny", minPct: 50, color: "#B98A2F" },
  { grade: 2, label: "dopuszczający", minPct: 30, color: "#B3261E" },
  { grade: 1, label: "niedostateczny", minPct: 0, color: "#7F1D1D" },
];

export const statusMeta = {
  draft: { label: "Szkic", tone: "gray" },
  published: { label: "Opublikowany", tone: "blue" },
  active: { label: "Aktywny", tone: "blue" },
  pending: { label: "Oczekuje na sprawdzenie", tone: "amber" },
  checked: { label: "Sprawdzony", tone: "green" },
  closed: { label: "Zamknięty", tone: "green" },
};

export const typeMeta = {
  virtual: { label: "Wirtualny", tone: "blue", icon: "device" },
  paper: { label: "Papierowy", tone: "amber", icon: "paper" },
  both: { label: "Hybrydowy", tone: "green", icon: "layers" },
};

export const BOOK_DEFAULT = "lek-polska";
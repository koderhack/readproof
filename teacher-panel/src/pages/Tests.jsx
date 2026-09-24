import React, { useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Btn, PageHeader, Segmented, StatusBadge, TypeBadge, EmptyState, Modal } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn, formatDate, totalPoints } from "../lib/utils.js";
import { statusMeta } from "../data/meta.js";

const ACTIONS = [
  { key: "open", label: "Otwórz", icon: "eye" },
  { key: "edit", label: "Edytuj", icon: "edit" },
  { key: "duplicate", label: "Duplikuj", icon: "copy" },
  { key: "results", label: "Wyniki", icon: "chart" },
  { key: "print", label: "Drukuj / Pobierz PDF", icon: "printer" },
  { key: "delete", label: "Usuń", icon: "trash", danger: true },
];

export function Tests() {
  const { tests, classes, results, navigate, toast, deleteTest, duplicateTest } = useApp();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [menuOpen, setMenuOpen] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const classById = (id) => classes.find((c) => c.id === id);
  const resultsForTest = (tid) => results.filter((r) => r.testId === tid);

  const filtered = useMemo(() => {
    return tests.filter((t) => {
      if (query && !t.name.toLowerCase().includes(query.toLowerCase()) && !t.topic.toLowerCase().includes(query.toLowerCase())) return false;
      if (typeFilter !== "all" && t.type !== typeFilter) return false;
      if (statusFilter !== "all" && t.status !== statusFilter) return false;
      if (classFilter !== "all" && t.classId !== classFilter) return false;
      return true;
    });
  }, [tests, query, typeFilter, statusFilter, classFilter]);

  const runAction = (action, test) => {
    setMenuOpen(null);
    switch (action.key) {
      case "open": navigate("test", { testId: test.id }); break;
      case "edit": navigate("builder", { testId: test.id }); break;
      case "duplicate":
        duplicateTest(test);
        break;
      case "results": navigate("test", { testId: test.id, tab: "results" }); break;
      case "print": navigate("test", { testId: test.id, tab: "paper" }); break;
      case "delete": setDeleteTarget(test); break;
    }
  };

  const confirmDelete = () => {
    const t = deleteTarget;
    setDeleteTarget(null);
    if (t) deleteTest(t);
  };

  return (
    <div className="page" onClick={() => menuOpen && setMenuOpen(null)}>
      <PageHeader
        title="Testy"
        subtitle="Wszystkie testy — wirtualne, papierowe i hybrydowe."
        actions={
          <>
            <Btn variant="secondary" icon="download" onClick={() => { navigator.clipboard?.writeText("Eksport: lista testów (CSV)"); toast("Lista testów skopiowana do schowka"); }}>Eksportuj</Btn>
            <Btn icon="plus" onClick={() => navigate("builder")}>Utwórz test</Btn>
          </>
        }
      />

      <div className="filters-bar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input placeholder="Szukaj testu…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="select filter-select" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
          <option value="all">Wszystkie klasy</option>
          {classes.map((c) => <option key={c.id} value={c.id}>Klasa {c.name}</option>)}
        </select>
        <select className="select filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Każdy status</option>
          {Object.entries(statusMeta).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <Segmented
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: "all", label: "Wszystkie" },
            { value: "virtual", label: "Wirtualne" },
            { value: "paper", label: "Papierowe" },
            { value: "both", label: "Hybrydowe" },
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="doc"
          title="Brak testów pasujących do filtrów"
          text="Zmień kryteria wyszukiwania albo stwórz nowy test."
          action={<Btn icon="plus" onClick={() => navigate("builder")}>Utwórz test</Btn>}
        />
      ) : (
        <div className="table-wrap card">
          <table className="table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Klasa</th>
                <th>Pytania</th>
                <th>Forma</th>
                <th>Status</th>
                <th>Termin</th>
                <th>Uczniowie</th>
                <th>Średni</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const cls = classById(t.classId);
                const res = resultsForTest(t.id);
                const avg = t.avg && t.avg !== "—" ? t.avg : res.length ? `${Math.round(res.filter(r => r.percent != null).reduce((s, r) => s + r.percent, 0) / Math.max(1, res.filter(r => r.percent != null).length))}%` : "—";
                return (
                  <tr key={t.id} className="table-row">
                    <td className="td-name">
                      <button className="td-link" onClick={() => navigate("test", { testId: t.id })}>
                        <span className="td-title">{t.name}</span>
                      </button>
                      <span className="td-sub">{t.subject}{t.topic ? ` · ${t.topic}` : ""}</span>
                    </td>
                    <td><span className="cls-pill" style={{ color: cls?.color, background: `${cls?.color}14` }}>{cls?.name}</span></td>
                    <td className="td-mono">{t.questions.length} <small>({totalPoints(t.questions)} pkt)</small></td>
                    <td><TypeBadge type={t.type} small /></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="td-mono">{formatDate(t.deadline)}</td>
                    <td className="td-mono">
                      {res.length || 0}
                      <small className="dim"> / {cls?.students || "—"}</small>
                    </td>
                    <td className="td-avg">{avg}</td>
                    <td className="td-actions">
                      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate("test", { testId: t.id })}><Icon name="eye" size={15} /> Otwórz</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate("builder", { testId: t.id })}><Icon name="edit" size={15} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => runAction(ACTIONS[2], t)}><Icon name="copy" size={15} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate("test", { testId: t.id, tab: "results" })}><Icon name="chart" size={15} /></button>
                        <button className="btn btn-ghost btn-sm" onClick={() => navigate("test", { testId: t.id, tab: "paper" })}><Icon name="printer" size={15} /></button>
                        <div className="menu-anchor">
                          <button className="btn btn-ghost btn-sm" onClick={() => setMenuOpen(menuOpen === t.id ? null : t.id)}><Icon name="more" size={15} /></button>
                          {menuOpen === t.id && (
                            <div className="dropdown" onClick={(e) => e.stopPropagation()}>
                              {ACTIONS.map((a) => (
                                <button key={a.key} className={cn("dropdown-item", a.danger && "danger")} onClick={() => runAction(a, t)}>
                                  <Icon name={a.icon} size={15} /> {a.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="legend">
        <span className="legend-title">Formy testów:</span>
        <div className="legend-items">
          <TypeBadge type="virtual" small />
          <span className="legend-text">uczniowie rozwiązują na urządzeniu, automatyczne sprawdzanie</span>
        </div>
        <div className="legend-items">
          <TypeBadge type="paper" small />
          <span className="legend-text">drukujesz, uczniowie pracują na kartce, Ty sprawdzasz i wpisujesz punkty</span>
        </div>
        <div className="legend-items">
          <TypeBadge type="both" small />
          <span className="legend-text">ten sam test działa w obu formach</span>
        </div>
      </div>

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Usunąć test?"
        footer={
          <>
            <Btn variant="secondary" onClick={() => setDeleteTarget(null)}>Anuluj</Btn>
            <Btn variant="danger" onClick={confirmDelete}>Usuń trwale</Btn>
          </>
        }
      >
        <p>Test <strong>„{deleteTarget?.name}”</strong> wraz z pytaniami i wynikami zostanie usunięty. Tej operacji nie można cofnąć.</p>
      </Modal>
    </div>
  );
}
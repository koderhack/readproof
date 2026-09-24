import React, { useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Badge, Btn, EmptyState, PageHeader } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn } from "../lib/utils.js";

export function Students() {
  const { students, classes, results, tests, navigate } = useApp();
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("all");

  const classById = (id) => classes.find((c) => c.id === id);
  const testById = (id) => tests.find((t) => t.id === id);

  const rows = useMemo(() => {
    return students
      .map((s) => {
        const rs = results.filter((r) => r.studentId === s.id && r.status === "graded");
        const avg = rs.length ? Math.round(rs.reduce((a, r) => a + r.percent, 0) / rs.length) : null;
        const last = [...rs].sort((a, b) => b.date.localeCompare(a.date))[0];
        return { ...s, avg, testsDone: rs.length, last };
      })
      .filter((s) => {
        if (classFilter !== "all" && s.classId !== classFilter) return false;
        if (query && !`${s.firstName} ${s.lastName}`.toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => a.lastName.localeCompare(b.lastName));
  }, [students, results, query, classFilter]);

  return (
    <div className="page">
      <PageHeader
        title="Uczniowie"
        subtitle={`${students.length} zapisanych uczniów w ${classes.length} klasach.`}
      />

      <div className="filters-bar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input placeholder="Szukaj ucznia…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="select filter-select" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
          <option value="all">Wszystkie klasy</option>
          {classes.map((c) => <option key={c.id} value={c.id}>Klasa {c.name}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="users" title="Brak uczniów" text="Uczniowie pojawią się, gdy dołączą do klasy kodem z widoku Klasy." />
      ) : (
        <div className="table-wrap card">
          <table className="table">
            <thead>
              <tr><th>Uczeń</th><th>Klasa</th><th>Średnia</th><th>Testy</th><th>Ostatni wynik</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const cls = classById(s.classId);
                const lastTest = s.last ? testById(s.last.testId) : null;
                return (
                  <tr key={s.id}>
                    <td className="td-name">
                      <button className="td-link" onClick={() => navigate("student", { studentId: s.id })}>
                        <span className="td-user"><Avatar student={s} size={28} />{s.firstName} {s.lastName}</span>
                      </button>
                    </td>
                    <td><span className="cls-pill" style={{ color: cls?.color, background: `${cls?.color}14` }}>{cls?.name || "—"}</span></td>
                    <td>
                      <span className={cn("score-pct", s.avg == null ? "dim" : s.avg >= 70 ? "good" : s.avg >= 50 ? "mid" : "bad")}>{s.avg == null ? "—" : `${s.avg}%`}</span>
                    </td>
                    <td className="td-mono">{s.testsDone}</td>
                    <td>
                      {s.last ? (
                        <div className="last-cell">
                          <span>{lastTest ? lastTest.name : "—"}</span>
                          <Badge tone={s.last.percent >= 70 ? "green" : s.last.percent >= 50 ? "amber" : "rose"}>{s.last.percent}%</Badge>
                        </div>
                      ) : (
                        <Badge tone="gray">brak</Badge>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => navigate("student", { studentId: s.id })}><Icon name="chevronRight" size={15} /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
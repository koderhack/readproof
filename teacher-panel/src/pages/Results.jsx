import React, { useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Badge, Btn, EmptyState, PageHeader } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn, formatDate } from "../lib/utils.js";

const BUCKETS = [
  { min: 0, max: 29, label: "0–29%" },
  { min: 30, max: 49, label: "30–49%" },
  { min: 50, max: 69, label: "50–69%" },
  { min: 70, max: 84, label: "70–84%" },
  { min: 85, max: 100, label: "85–100%" },
];

export function Results() {
  const { tests, classes, students, results, navigate } = useApp();
  const [classFilter, setClassFilter] = useState("all");
  const [testFilter, setTestFilter] = useState("all");
  const [formFilter, setFormFilter] = useState("all");
  const [scoreFilter, setScoreFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [query, setQuery] = useState("");

  const testById = (id) => tests.find((t) => t.id === id);
  const studentById = (id) => students.find((s) => s.id === id);

  const rows = useMemo(() => {
    return results
      .map((r) => {
        const t = testById(r.testId);
        const s = studentById(r.studentId);
        return { ...r, test: t, student: s };
      })
      .filter((r) => {
        if (classFilter !== "all" && r.test?.classId !== classFilter) return false;
        if (testFilter !== "all" && r.testId !== testFilter) return false;
        if (formFilter !== "all" && r.form !== formFilter) return false;
        if (scoreFilter === "passed" && (r.percent == null || r.percent < 50)) return false;
        if (scoreFilter === "failed" && (r.percent == null || r.percent >= 50)) return false;
        if (scoreFilter === "top" && (r.percent == null || r.percent < 85)) return false;
        if (dateFrom && r.date < dateFrom) return false;
        if (dateTo && r.date > dateTo) return false;
        if (query) {
          const name = `${r.student?.firstName} ${r.student?.lastName}`.toLowerCase();
          const tname = r.test?.name.toLowerCase();
          if (!name.includes(query.toLowerCase()) && !tname.includes(query.toLowerCase())) return false;
        }
        return true;
      })
      .sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  }, [results, classFilter, testFilter, formFilter, scoreFilter, dateFrom, dateTo, query]);

  const charts = useMemo(() => {
    const graded = results.filter((r) => r.status === "graded" && r.percent != null);
    const byClass = classes.map((c) => {
      const ids = tests.filter((t) => t.classId === c.id).map((t) => t.id);
      const rows = graded.filter((r) => ids.includes(r.testId));
      const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.percent, 0) / rows.length) : 0;
      return { ...c, avg, count: rows.length };
    });
    const dist = BUCKETS.map((b) => ({
      ...b,
      count: graded.filter((r) => r.percent >= b.min && r.percent <= b.max).length,
    }));
    const overTime = (() => {
      const map = {};
      graded.forEach((r) => {
        map[r.date] = (map[r.date] || []).concat(r.percent);
      });
      return Object.keys(map)
        .sort()
        .map((d) => ({ date: formatDate(d), avg: Math.round(map[d].reduce((s, x) => s + x, 0) / map[d].length), count: map[d].length }))
        .slice(-8);
    })();
    return { byClass, dist, overTime, graded };
  }, [results, classes, tests]);

  const counts = {
    all: rows.length,
    passed: rows.filter((r) => r.percent != null && r.percent >= 50).length,
    failed: rows.filter((r) => r.percent != null && r.percent < 50).length,
    waiting: results.filter((r) => r.status === "waiting").length,
  };

  const maxDist = Math.max(1, ...charts.dist.map((d) => d.count));
  const maxTime = Math.max(1, ...charts.overTime.map((o) => o.avg));
  const maxClass = Math.max(1, ...charts.byClass.map((c) => c.avg));

  return (
    <div className="page">
      <PageHeader
        title="Wyniki"
        subtitle="Wirtualne i papierowe w jednym miejscu — pełny obraz klasy."
        actions={<Btn icon="download" variant="secondary" onClick={() => { navigator.clipboard?.writeText("Eksport wyników (CSV)"); }}>Eksport CSV</Btn>}
      />

      <div className="results-kpi">
        <div className="kpi"><div className="kpi-ic indigo"><Icon name="list" size={16} /></div><div><strong>{counts.all}</strong><span>wszystkie wyniki</span></div></div>
        <div className="kpi"><div className="kpi-ic green"><Icon name="checkCircle" size={16} /></div><div><strong>{counts.passed}</strong><span>zdane (≥50%)</span></div></div>
        <div className="kpi"><div className="kpi-ic rose"><Icon name="x" size={16} /></div><div><strong>{counts.failed}</strong><span>niezdane</span></div></div>
        <div className="kpi"><div className="kpi-ic amber"><Icon name="pencil" size={16} /></div><div><strong>{counts.waiting}</strong><span>do sprawdzenia</span></div></div>
      </div>

      <div className="charts-row">
        <ChartBox title="Średni wynik klasy" subtitle="procent — tylko sprawdzone">
          <div className="bar-list">
            {charts.byClass.map((c) => (
              <div key={c.id} className="bar-row">
                <span className="bar-row-label" style={{ color: c.color }}>Klasa {c.name}</span>
                <div className="bar-row-track"><div className="bar-row-fill" style={{ width: `${(c.avg / maxClass) * 100}%`, background: c.color }} /></div>
                <span className="bar-row-val">{c.avg}%</span>
              </div>
            ))}
            {charts.byClass.every((c) => c.count === 0) && <p className="dim">Brak danych do agregacji klas.</p>}
          </div>
        </ChartBox>

        <ChartBox title="Rozkład wyników" subtitle="ilość uczniów w przedziałach">
          <div className="dist-chart">
            {charts.dist.map((b) => (
              <div key={b.label} className="dist-col">
                <div className="dist-bar-wrap">
                  <div className="dist-bar" style={{ height: `${(b.count / maxDist) * 100}%` }}>{b.count > 0 && <span className="dist-count">{b.count}</span>}</div>
                </div>
                <span className="dist-label">{b.label}</span>
              </div>
            ))}
          </div>
        </ChartBox>

        <ChartBox title="Wyniki w czasie" subtitle="średnia procentowa na dzień">
          <div className="line-chart-wrap">
            {charts.overTime.length === 0 && <p className="dim">Brak danych w czasie.</p>}
            <svg className="line-chart" viewBox="0 0 320 120" preserveAspectRatio="none">
              {charts.overTime.map((p, i) => {
                const x = 10 + (i * 300) / Math.max(1, charts.overTime.length - 1);
                const y = 110 - (p.avg / 100) * 100;
                return <line key={"g" + i} x1="10" y1={y + (i % 2 ? 6 : -4) * 0} x2="310" y2={y} stroke="#E7F2EB" strokeDasharray="3 5" />;
              })}
              <polyline
                points={charts.overTime.map((p, i) => `${10 + (i * 300) / Math.max(1, charts.overTime.length - 1)},${110 - (p.avg / 100) * 100}`).join(" ")}
                fill="none" stroke="#173A8A" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              />
              {charts.overTime.map((p, i) => {
                const x = 10 + (i * 300) / Math.max(1, charts.overTime.length - 1);
                const y = 110 - (p.avg / 100) * 100;
                return <circle key={"c" + i} cx={x} cy={y} r="3.5" fill="#fff" stroke="#173A8A" strokeWidth="2" />;
              })}
            </svg>
            {charts.overTime.length > 0 && (
              <div className="line-labels">
                {charts.overTime.map((o, i) => (
                  <span key={i}>{o.date}</span>
                ))}
              </div>
            )}
          </div>
        </ChartBox>
      </div>

      <div className="filters-bar results-filters">
        <div className="search-input">
          <Icon name="search" size={16} />
          <input placeholder="Szukaj ucznia lub testu…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className="select filter-select" value={classFilter} onChange={(e) => setClassFilter(e.target.value)}>
          <option value="all">Klasa: wszystkie</option>
          {classes.map((c) => <option key={c.id} value={c.id}>Klasa {c.name}</option>)}
        </select>
        <select className="select filter-select" value={testFilter} onChange={(e) => setTestFilter(e.target.value)}>
          <option value="all">Test: wszystkie</option>
          {tests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="select filter-select" value={formFilter} onChange={(e) => setFormFilter(e.target.value)}>
          <option value="all">Forma: obie</option>
          <option value="virtual">Wirtualny</option>
          <option value="paper">Papierowy</option>
        </select>
        <select className="select filter-select" value={scoreFilter} onChange={(e) => setScoreFilter(e.target.value)}>
          <option value="all">Wynik: wszystkie</option>
          <option value="passed">Zdane (≥50%)</option>
          <option value="failed">Niezdane (&lt;50%)</option>
          <option value="top">Najlepsze (≥85%)</option>
        </select>
        <input className="input filter-date" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <span className="filter-date-sep">–</span>
        <input className="input filter-date" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>

      <div className="table-wrap card">
        {rows.length === 0 ? (
          <EmptyState icon="chart" title="Brak wyników" text="Zmień filtry lub sprawdź zakładkę testów." />
        ) : (
          <table className="table">
            <thead>
              <tr><th>Uczeń</th><th>Test</th><th>Forma</th><th>Wynik</th><th>Punkty</th><th>Data</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td-name">
                    <button className="td-link" onClick={() => navigate("student", { studentId: r.studentId })}>
                      <span className="td-user"><Avatar student={r.student} size={28} />{r.student ? `${r.student.firstName} ${r.student.lastName}` : "—"}</span>
                    </button>
                  </td>
                  <td>
                    <button className="link-btn text" onClick={() => navigate("test", { testId: r.testId })}>{r.test?.name}</button>
                    <span className="td-sub">{r.test?.topic}</span>
                  </td>
                  <td>{r.form === "virtual" ? <Badge tone="blue">Wirtualny</Badge> : <Badge tone="amber">Papierowy</Badge>}</td>
                  <td>
                    <div className="score-cell">
                      <span className={cn("score-pct", r.percent >= 70 ? "good" : r.percent >= 50 ? "mid" : "bad")}>{r.percent ?? "—"}%</span>
                      {r.percent != null && <div className="mini-prog"><div style={{ width: `${r.percent}%` }} /></div>}
                    </div>
                  </td>
                  <td className="td-mono">{r.score != null ? `${r.score}/${r.maxScore}` : "—"}</td>
                  <td className="td-mono">{formatDate(r.date)}</td>
                  <td>
                    {r.status === "graded" ? <Badge tone="green">Sprawdzony</Badge> : r.status === "waiting" ? <Badge tone="amber">Do sprawdzenia</Badge> : <Badge tone="gray">{r.status}</Badge>}
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate("student", { studentId: r.studentId })}><Icon name="chevronRight" size={15} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ChartBox({ title, subtitle, children }) {
  return (
    <div className="card chart-box">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}
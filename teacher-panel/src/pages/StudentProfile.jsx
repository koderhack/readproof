import React, { useMemo } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Badge, Btn, EmptyState, PageHeader, StatCard } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn, formatDate } from "../lib/utils.js";

export function StudentProfile({ studentId }) {
  const { students, results, tests, classes, activities, navigate } = useApp();
  const student = students.find((s) => s.id === studentId);
  const cls = classes.find((c) => c.id === student?.classId);

  const rows = useMemo(
    () =>
      results
        .filter((r) => r.studentId === studentId && r.status === "graded")
        .map((r) => ({ ...r, test: tests.find((t) => t.id === r.testId) }))
        .sort((a, b) => b.date.localeCompare(a.date)),
    [results, tests, studentId]
  );

  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.percent, 0) / rows.length) : 0;
  const avgGrade = rows.length ? Math.round(rows.reduce((s, r) => s + r.grade, 0) / rows.length) : 0;
  const best = rows.reduce((m, r) => Math.max(m, r.percent), 0);
  const trend = rows.length >= 2 ? rows[0].percent - rows[rows.length - 1].percent : 0;

  const history = useMemo(() => {
    const mine = activities.filter((a) => a.studentId === studentId);
    const fromResults = rows.map((r) => ({
      id: "h" + r.id,
      type: "result",
      text: `Sprawdzian „${r.test?.name}” zakończony z wynikiem ${r.percent}% (${r.form === "virtual" ? "wirtualnie" : "na papierze"})`,
      time: formatDate(r.date),
      before: true,
    }));
    return [...fromResults, ...mine].slice(0, 8);
  }, [activities, rows]);

  const mistakes = [];

  if (!student) return <EmptyState icon="user" title="Nie znaleziono ucznia" action={<Btn onClick={() => navigate("students")}>Wróć do listy</Btn>} />;

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="inline-title">
            <Avatar student={student} size={40} /> {student.firstName} {student.lastName}
          </span>
        }
        subtitle={`Klasa ${cls?.name || "—"} · ${cls?.year || ""}`}
        actions={<Btn variant="secondary" icon="comment" onClick={() => navigate("students")}>Napisz wiadomość</Btn>}
      />

      <div className="profile-grid">
        <div className="profile-side">
          <div className="card profile-card">
            <div className="profile-top">
              <Avatar student={student} size={64} />
              <div>
                <strong>{student.firstName} {student.lastName}</strong>
                <span>Klasa {cls?.name} · {cls?.year}</span>
              </div>
            </div>
            <div className="profile-divider" />
            <div className="profile-rows">
              <div className="p-row"><span>Średnia wyników</span><strong>{avg}%</strong></div>
              <div className="p-row"><span>Średnia ocena</span><span className="grade-chip lg">{avgGrade || "—"}</span></div>
              <div className="p-row"><span>Najlepszy wynik</span><strong className="good">{best}%</strong></div>
              <div className="p-row"><span>Wypełnione testy</span><strong>{rows.length}</strong></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head"><div><h3>Najczęstsze błędy</h3><p>na podstawie sprawdzonych testów</p></div></div>
            {mistakes.length === 0 ? (
              <p className="dim pad">Brak danych — błędy pojawią się po większej liczbie testów.</p>
            ) : (
              <div className="mistake-list">
                {mistakes.map((m, i) => (
                  <div key={i} className="mistake">
                    <div className="mistake-head">
                      <span className="badge badge-rose">{m.area}</span>
                      <span className="mistake-pts">{m.total} pkt</span>
                    </div>
                    <p>{m.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="profile-main">
          <div className="stats-grid">
            <StatCard label="Średnia" value={`${avg}%`} icon="chart" tone={avg >= 70 ? "green" : avg >= 50 ? "amber" : "rose"} small />
            <StatCard label="Trend" value={`${trend > 0 ? "+" : ""}${trend} pkt`} icon={trend >= 0 ? "trendUp" : "trendDown"} tone={trend >= 0 ? "green" : "rose"} small />
            <StatCard label="Wykonane testy" value={rows.length} icon="doc" tone="indigo" small />
            <StatCard label="Ocena średnia" value={avgGrade || "—"} icon="grad" tone="green" small />
          </div>

          <div className="card">
            <div className="card-head">
              <div><h3>Postęp</h3><p>wyniki procentowe w kolejności wykonania</p></div>
            </div>
            {rows.length === 0 ? (
              <p className="dim pad">Brak wyników do pokazania.</p>
            ) : (
              <div className="progress-chart">
                <svg viewBox="0 0 400 110" preserveAspectRatio="none" className="progress-svg">
                  <polyline
                    points={rows.map((r, i) => `${30 + (i * 340) / Math.max(1, rows.length - 1)},${100 - r.percent}`).join(" ")}
                    fill="none" stroke="#173A8A" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
                  />
                  {rows.map((r, i) => {
                    const x = 30 + (i * 340) / Math.max(1, rows.length - 1);
                    const y = 100 - r.percent;
                    return <circle key={r.id} cx={x} cy={y} r="4" fill="#fff" stroke="#173A8A" strokeWidth="2" />;
                  })}
                </svg>
                <div className="prog-x-labels">
                  {rows.map((r) => <span key={r.id}>{r.test ? short(r.test.name) : "—"}</span>)}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <div><h3>Wykonane testy</h3><p>{rows.length === 1 ? "1 sprawdzian" : `${rows.length} sprawdzianów`}</p></div>
            </div>
            {rows.length === 0 ? (
              <EmptyState icon="doc" title="Uczeń jeszcze nic nie napisał" text="Wyniki pojawią się po pierwszym teście." />
            ) : (
              <div className="student-results">
                {rows.map((r) => (
                  <button key={r.id} className="student-result" onClick={() => navigate("test", { testId: r.testId, tab: "results" })}>
                    <span className="sr-dot" style={{ background: r.form === "virtual" ? "#2563EB" : "#D97706" }} />
                    <div className="sr-body">
                      <strong>{r.test?.name}</strong>
                      <span>{r.form === "virtual" ? "Wirtualny" : "Papierowy"} · {formatDate(r.date)} · punkty {r.score}/{r.maxScore}</span>
                    </div>
                    <div className="sr-score">
                      <span className={cn("score-pct", r.percent >= 70 ? "good" : r.percent >= 50 ? "mid" : "bad")}>{r.percent}%</span>
                      <span className="grade-chip">{r.grade}</span>
                    </div>
                    <Icon name="chevronRight" size={16} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div><h3>Historia aktywności</h3><p>ostatnie 8 zdarzeń</p></div></div>
            <div className="activity-list">
              {history.map((h) => (
                <div key={h.id} className="activity">
                  <span className={cn("activity-ic", h.before ? "act-blue" : "act-gray")}>
                    <Icon name={h.type === "graded" ? "chart" : h.type === "published" ? "send" : "checkCircle"} size={15} />
                  </span>
                  <div className="activity-body"><p>{h.text}</p><span>{h.time}</span></div>
                </div>
              ))}
              {history.length === 0 && <p className="dim pad">Brak aktywności.</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function short(name) {
  const w = name.split(" ");
  return w.length > 2 ? w.slice(0, 2).join(" ") + "…" : name;
}
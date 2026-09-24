import React, { useMemo } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Badge, Btn, PageHeader, StatCard, TypeBadge } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { avgOf, formatShortDate } from "../lib/utils.js";
import { typeMeta } from "../data/meta.js";

const ACT_ICONS = { result: "checkCircle", joined: "link", published: "send", graded: "chart", system: "zap" };
const ACT_TONES = { result: "blue", joined: "green", published: "blue", graded: "green", system: "amber" };

export function Dashboard() {
  const { tests, students, classes, results, activities, navigate } = useApp();

  const stats = useMemo(() => {
    const active = tests.filter((t) => t.status === "published");
    const pending = results.filter((r) => r.status === "waiting").length;
    const graded = results.filter((r) => r.status === "graded");
    const avg = graded.length ? Math.round(graded.reduce((s, r) => s + (r.percent || 0), 0) / graded.length) : 0;
    return { activeTests: active.length, students: students.length, pending, avg, graded };
  }, [tests, students, results]);

  const recentTests = useMemo(
    () => [...tests].sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || "")).slice(0, 4),
    [tests]
  );

  const hero = useMemo(() => {
    const published = recentTests.find((t) => t.status === "published");
    return published || recentTests[0] || null;
  }, [recentTests]);

  const participantCount = (t) => results.filter((r) => r.testId === (t.challengeId || t.id)).length;

  const attention = [
    ...(stats.pending ? [{ icon: "checkCircle", title: `${stats.pending} ${stats.pending === 1 ? "praca czeka" : "prace czekają"} na sprawdzenie`, text: "Otwórz kolejkę i zakończ ocenianie.", view: "grading" }] : []),
    ...(tests.some((t) => t.status === "draft") ? [{ icon: "pencil", title: "Szkic wymaga dokończenia", text: "Uzupełnij pytania i opublikuj test.", view: "tests" }] : []),
    ...(tests.some((t) => t.status === "published" && participantCount(t) === 0) ? [{ icon: "send", title: "Opublikowany test bez wyników", text: "Sprawdź kod dołączenia i przekaż go uczniom.", view: "tests" }] : []),
  ];

  const weekData = useMemo(() => {
    const days = ["Pon", "Wt", "Śr", "Czw", "Pt", "Sob", "Nd"];
    const counts = [0, 0, 0, 0, 0, 0, 0];
    results.forEach((r) => {
      if (!r.date) return;
      const iso = r.date.length === 10 ? r.date + "T00:00:00" : r.date;
      const d = new Date(iso);
      if (isNaN(d)) return;
      const pl = (d.getDay() + 6) % 7;
      counts[pl] += 1;
    });
    return { days, counts };
  }, [results]);

  const maxWeek = Math.max(1, ...weekData.counts);

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="Witaj w panelu. Oto podsumowanie Twoich testów i klas."
        actions={<Btn icon="plus" onClick={() => navigate("builder")}>Utwórz test</Btn>}
      />

      <div className="dashboard-hero">
        <div className="hero-content">
          <div className="hero-eyebrow">
            <Icon name="zap" size={14} /> {hero ? (hero.status === "published" ? "Test opublikowany" : "Najnowszy test") : "Pierwszy krok"}
          </div>
          {hero ? (
            <>
              <h2>„{hero.name}”<br />{hero.status === "published" ? "jest gotowy." : "wymaga dokończenia."}</h2>
              <p>
                {hero.status === "published"
                  ? `${stats.activeTests} test publikowanych · ${participantCount(hero)} oddanych wyników. Wyniki zbierają się w jednym miejscu.`
                  : `To szkic — ${hero.questionCount || hero.questions?.length || 0} pytań. Dokończ i opublikuj, a uczniowie dołączą kodem.`}
              </p>
              <div className="hero-cts">
                <Btn icon="eye" onClick={() => navigate("test", { testId: hero.id, tab: hero.type !== "virtual" ? "paper" : "virtual" })}>Zobacz test</Btn>
                <Btn variant="ghost" icon="doc" onClick={() => navigate("tests")}>Wszystkie testy</Btn>
              </div>
            </>
          ) : (
            <>
              <h2>Stwórz pierwszy test<br />z gotowych pytań lektury.</h2>
              <p>
                Wybierz książkę z listy lektur, a panel podpowie pytania z banku pytań. Publikacja online lub w wersji papierowej.
              </p>
              <div className="hero-cts">
                <Btn icon="plus" onClick={() => navigate("builder")}>Utwórz test</Btn>
                <Btn variant="ghost" icon="doc" onClick={() => navigate("tests")}>Lista testów</Btn>
              </div>
            </>
          )}
        </div>
        {hero && (
          <div className="hero-art">
            <div className="mini-code">
              <div className="mini-code-label"><Icon name="code" size={13} /> Kod dołączenia</div>
              <div className="mini-code-value">{hero.code || "—"}</div>
            </div>
          </div>
        )}
      </div>

      <section className="attention-board">
        <div className="attention-head">
          <div><span>Do zrobienia</span><strong>{attention.length ? `${attention.length} zadania` : "Wszystko gotowe"}</strong></div>
          <p>{attention.length ? "Najważniejsze rzeczy, które czekają na Ciebie." : "Brak zaległych prac i nieukończonych testów."}</p>
        </div>
        <div className="attention-list">
          {attention.map((item) => (
            <button key={item.title} className="attention-item" onClick={() => navigate(item.view)}>
              <span className="attention-icon"><Icon name={item.icon} size={17} /></span>
              <span><strong>{item.title}</strong><small>{item.text}</small></span>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
          {!attention.length && (
            <div className="attention-empty"><span><Icon name="checkCircle" size={18} /></span><div><strong>Panel jest na bieżąco</strong><small>Możesz wrócić tutaj po nowych wynikach.</small></div></div>
          )}
        </div>
      </section>

      <div className="stats-grid">
        <StatCard label="Aktywne testy" value={stats.activeTests} icon="doc" hint={stats.activeTests ? (stats.activeTests === 1 ? "obecnie publikowany" : "obecnie publikowane") : "brak publikacji"} tone="indigo" />
        <StatCard label="Uczniowie" value={stats.students} icon="users" hint={classes.length ? `w ${classes.length} klasach` : "brak klas"} tone="blue" />
        <StatCard label="Do sprawdzenia" value={stats.pending} icon="checkCircle" hint="wersje papierowe" tone="amber" />
        <StatCard label="Średni wynik" value={stats.graded.length ? `${stats.avg}%` : "—"} icon="chart" hint={`z ${stats.graded.length} sprawdzonych`} tone="green" />
      </div>

      <div className="dash-grid">
        <div className="card">
          <div className="card-head">
            <div>
              <h3>Ostatnie testy</h3>
              <p>Szybki wgląd w ostatnio przygotowane sprawdziany.</p>
            </div>
            <button className="link-btn" onClick={() => navigate("tests")}>Zobacz wszystkie</button>
          </div>
          <div className="test-mini-list">
            {recentTests.length === 0 && <p className="dim pad">Brak testów — utwórz pierwszy sprawdzian.</p>}
            {recentTests.map((t) => {
              const cls = classes.find((c) => c.id === t.classId);
              const meta = typeMeta[t.type];
              const done = participantCount(t);
              return (
                <button key={t.id} className="test-mini" onClick={() => navigate("test", { testId: t.id })}>
                  <div className="test-mini-ic"><Icon name={meta.icon} size={16} /></div>
                  <div className="test-mini-body">
                    <strong>{t.name}</strong>
                    <span>Klasa {cls ? cls.name : "—"} · {done} wynik{Math.abs(done) === 1 ? "" : "ów"}</span>
                  </div>
                  <div className="test-mini-right">
                    <span className="test-mini-avg">{done || "—"}</span>
                    <span className="test-mini-date">{formatShortDate(t.publishedAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3>Ostatnia aktywność</h3>
              <p>Z Twoich testów i klas.</p>
            </div>
          </div>
          <div className="activity-list">
            {activities.length === 0 && <p className="dim pad">Brak aktywności — wyniki pojawią się po pierwszych testach.</p>}
            {activities.slice(0, 7).map((a) => (
              <div key={a.id} className="activity">
                <span className={`activity-ic act-${ACT_TONES[a.type] || "gray"}`}>
                  <Icon name={ACT_ICONS[a.type] || "zap"} size={15} />
                </span>
                <div className="activity-body">
                  <p>{a.text}</p>
                  <span>{a.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Oddane testy w tygodniu</h3>
            <p>Liczba ukończonych podejść uczniów wg dni tygodnia.</p>
          </div>
          {results.length > 0 && <Badge tone="green"><Icon name="checkCircle" size={12} /> {results.length} wyników łącznie</Badge>}
        </div>
        <div className="week-chart">
          {weekData.counts.map((c, i) => (
            <div key={i} className="week-col">
              <div className="week-bar-wrap">
                <div className="week-bar" style={{ height: `${(c / maxWeek) * 100}%` }} />
                <span className="week-bar-count">{c || ""}</span>
              </div>
              <span className="week-day">{weekData.days[i]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
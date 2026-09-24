import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Badge, Btn, PageHeader, ProgressBar, Segmented, StatusBadge, TypeBadge, EmptyState } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn, formatDate, totalPoints } from "../lib/utils.js";
import { PaperDocument, PaperKey } from "../components/PaperDocument.jsx";
import { PrintPortal } from "../components/PrintPortal.jsx";

const STATUS_LABELS = {
  not_started: "Nie rozpoczął",
  started: "Rozpoczął",
  in_progress: "W trakcie",
  finished: "Zakończył",
};

export function TestDetail({ testId, tab }) {
  const { tests, classes, students, results, navigate, toast, activateTest, closeTest, duplicateTest, deleteTest } = useApp();
  const test = tests.find((t) => t.id === testId);
  const [activeTab, setActiveTab] = useState(tab || (test?.type === "paper" ? "paper" : "virtual"));
  const [paperVersion, setPaperVersion] = useState("A");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (test) setActiveTab(tab || (test.type === "paper" ? "paper" : "virtual"));
  }, [tab, test?.type, test]);

  const cls = classes.find((c) => c.id === test?.classId);
  const maxPoints = useMemo(() => (test ? totalPoints(test.questions || []) : 0), [test]);

  const testResults = useMemo(() => results.filter((r) => r.testId === testId), [results, testId]);
  const graded = testResults.filter((r) => r.status === "graded");
  const waiting = testResults.filter((r) => r.status === "waiting");
  const avg = graded.length ? Math.round(graded.reduce((s, r) => s + r.percent, 0) / graded.length) : null;

  const participants = useMemo(() => {
    if (!test) return [];
    const map = {};
    testResults.forEach((r) => {
      map[r.studentId] = {
        studentId: r.studentId,
        status: "finished",
        progress: 1,
        score: r.score ?? 0,
        max: r.maxScore ?? maxPoints,
        startedAt: r.date,
      };
    });
    if (test.classId) {
      students
        .filter((s) => s.classId === test.classId)
        .forEach((s) => {
          if (!map[s.id]) map[s.id] = { studentId: s.id, status: "not_started", progress: 0 };
        });
    }
    return Object.values(map);
  }, [test, testResults, students, maxPoints]);

  if (!test) {
    return <EmptyState icon="doc" title="Nie znaleziono testu" action={<Btn onClick={() => navigate("tests")}>Wróć do listy</Btn>} />;
  }

  const handleActivate = async () => (await activateTest(test)) && toast("Test rozpoczęty — postęp uczniów zbiera się automatycznie.");
  const handleClose = async () => {
    await closeTest(test);
    toast("Test zamknięty", "info");
  };
  const handleDelete = async () => {
    if (!window.confirm(`Usunąć test „${test.name}”? Tej operacji nie można cofnąć.`)) return;
    if (await deleteTest(test)) navigate("tests");
  };

  const tabs = [];
  if (test.type !== "paper") tabs.push({ value: "virtual", label: "Wirtualny", icon: "device" });
  if (test.type !== "virtual") tabs.push({ value: "paper", label: "Papierowy", icon: "paper" });
  tabs.push({ value: "results", label: "Wyniki", icon: "chart" });

  return (
    <div className="page">
      <PageHeader
        title={test.name}
        subtitle={`${test.subject} · Klasa ${cls?.name || "—"} · ${test.questions?.length || 0} pytań · ${maxPoints} pkt`}
        actions={
          <>
            <Btn variant="secondary" icon="edit" onClick={() => navigate("builder", { testId })}>Edytuj</Btn>
             <Btn variant="ghost" icon="copy" onClick={() => duplicateTest(test)}>Duplikuj</Btn>
             <Btn variant="danger" icon="trash" onClick={handleDelete}>Usuń</Btn>
          </>
        }
      />

      <div className="test-hero">
        <div className="test-hero-info">
          <TypeBadge type={test.type} />
          <span className="test-hero-sep" />
          <StatusBadge status={test.status} />
          <span className="test-hero-sep" />
          <span className="test-hero-meta"><Icon name="timer" size={14} /> {test.time || 0} minut</span>
          {test.code && <span className="test-hero-code"><Icon name="code" size={13} /> {test.code}</span>}
        </div>
        {avg != null && <div className="test-hero-avg"><strong>{avg}%</strong><span>średnia z {graded.length} wyników</span></div>}
      </div>

      <Segmented options={tabs} value={activeTab} onChange={setActiveTab} className="test-tabs" />

      {activeTab === "virtual" && (
        <VirtualTab test={test} participants={participants} onActivate={handleActivate} onClose={handleClose} students={students} />
      )}

      {activeTab === "paper" && (
        <PaperTab test={test} cls={cls} version={paperVersion} setVersion={setPaperVersion} showKey={showKey} setShowKey={setShowKey} navigate={navigate} />
      )}

      {activeTab === "results" && (
        <ResultsTab test={test} results={testResults} waiting={waiting.length} students={students} navigate={navigate} maxPoints={maxPoints} />
      )}
    </div>
  );
}

function VirtualTab({ test, participants, onActivate, onClose, students }) {
  const finished = participants.filter((p) => p.status === "finished").length;
  const activeCount = participants.filter((p) => p.status !== "not_started").length;

  const joined = (sid) => students.find((s) => s.id === sid);
  const statusTone = (status) =>
    status === "finished" ? "ok" : status === "in_progress" ? "run" : status === "started" ? "run2" : "idle";

  return (
    <div className="vtab-grid">
      <div className="card code-card">
        <div className="card-head">
          <div>
            <h3>Kod dostępu</h3>
            <p>Uczniowie wpisują kod w aplikacji ReadProof.</p>
          </div>
          {test.status === "published" && <Badge tone="green"><span className="pulse-dot" /> Aktywny</Badge>}
        </div>
        <div className="code-display">
          <Icon name="code" size={28} />
          <span className="code-big">{test.code}</span>
          <div className="code-actions">
            <button className="icon-btn sm" onClick={() => { navigator.clipboard?.writeText(test.code); }}><Icon name="copy" size={15} /></button>
          </div>
        </div>
        <div className="link-display">
          <Icon name="link" size={14} />
          <span>{test.link || "https://readproof.pages.dev/app/#/student"}</span>
          <button className="icon-btn sm" onClick={() => { navigator.clipboard?.writeText(test.link || ""); }}><Icon name="copy" size={14} /></button>
        </div>
        <div className="code-ct">
          {test.status !== "published" ? (
            <Btn icon="zap" onClick={onActivate}>Rozpocznij test online</Btn>
          ) : (
            <Btn variant="danger" icon="x" onClick={onClose}>Zamknij test</Btn>
          )}
          <p className="code-help">{test.status === "published" ? "Uczniowie mogą dołączać i rozwiązywać test." : "Po aktywacji wygenerujemy kod, który przekażesz klasie."}</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Postęp uczniów</h3>
            <p>{activeCount} z {participants.length} osób oddało wynik · {finished} zakończyło</p>
          </div>
        </div>
        <div className="live-list">
          {participants.length === 0 && (
            <EmptyState icon="users" title="Brak uczestników" text="Gdy uczeń rozwiąże test, pojawi się tutaj." />
          )}
          {participants.map((p) => {
            const st = joined(p.studentId);
            return (
              <div key={p.studentId} className="live-row">
                <Avatar student={st} size={32} />
                <div className="live-name">
                  <strong>{st ? `${st.firstName} ${st.lastName}` : "—"}</strong>
                  <span className={`live-status st-${statusTone(p.status)}`}>{STATUS_LABELS[p.status] || p.status}</span>
                </div>
                <div className="live-prog">
                  {p.status === "finished" ? (
                    <span className="live-score">{p.score ?? 0}/{p.max ?? 0} <small>pkt</small></span>
                  ) : (
                    <ProgressBar value={(p.progress || 0) * 100} tone="gray" height={6} />
                  )}
                </div>
                <span className="live-time">{p.startedAt || "—"}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3>Automatyczne sprawdzanie</h3>
            <p>Wyniki pytań zamkniętych trafiają do zakładki „Wyniki” od razu po zakończeniu.</p>
          </div>
        </div>
        <div className="auto-note">
          <Icon name="zap" size={18} />
          <p>Odpowiedzi na pytania zamknięte są punktowane natychmiast. Pytania otwarte oznaczysz ręcznie w widoku <button className="link-btn inline" onClick={() => {}}>Sprawdzanie</button>.</p>
        </div>
        <div className="access-steps">
          <div className="access-step"><span>1</span><p>Uczeń wpisuje kod <strong>{test.code}</strong> w aplikacji ReadProof.</p></div>
          <div className="access-step"><span>2</span><p>Rozwiązuje test na swoim urządzeniu.</p></div>
          <div className="access-step"><span>3</span><p>Wynik automatycznie ląduje w Twoim dzienniku.</p></div>
        </div>
      </div>
    </div>
  );
}

function PaperTab({ test, cls, version, setVersion, showKey, setShowKey, navigate }) {
  const docProps = { ...test, className: cls?.name };
  return (
    <>
      <div className="banner paper-banner">
        <Icon name="paper" size={18} />
        <div>
          <strong>Wersja papierowa</strong>
          <p>Wygeneruj arkusz do druku i klucz odpowiedzi. Po rozdaniu sprawdzisz testy w widoku „Sprawdzanie”.</p>
        </div>
        <div className="banner-acts">
          <Btn variant="secondary" icon="checkCircle" onClick={() => navigate("grading")}>Przejdź do sprawdzania</Btn>
          <Btn icon="printer" onClick={() => window.print()}>Drukuj</Btn>
          <Btn variant="secondary" icon="download" onClick={() => window.print()}>Pobierz PDF</Btn>
        </div>
      </div>

      <div className="paper-toolbar">
        <div className="pv-panel-row">
          <span>Wersja</span>
          <div className="versions-stepper">
            {["A", "B"].map((v) => (
              <button key={v} className={cn("ver-pill", version === v && "sel")} onClick={() => setVersion(v)}>Wersja {v}</button>
            ))}
          </div>
        </div>
        <div className="pv-panel-row">
          <span>Klucz odpowiedzi</span>
          <button className={cn("mini-switch", showKey && "on")} onClick={() => setShowKey((k) => !k)} />
        </div>
      </div>

      {!showKey ? (
        <div className="paper-stage">
          <PaperDocument test={docProps} version={version} />
        </div>
      ) : (
        <div className="paper-stage key-stage">
          <div className="pv-key-strip">
            <div className="pv-key-head"><Icon name="lock" size={14} /> Klucz odpowiedzi — wersja {version} (tylko dla nauczyciela)</div>
            <PaperKey test={docProps} version={version} />
          </div>
        </div>
      )}

      <PrintPortal>
        <PaperDocument test={docProps} version={version} />
        {showKey && <PaperKey test={docProps} version={version} />}
      </PrintPortal>
    </>
  );
}

function ResultsTab({ test, results, waiting, students, navigate, maxPoints }) {
  const rows = results.filter((r) => r.status === "graded").map((r) => ({
    ...r,
    student: students.find((s) => s.id === r.studentId),
  }));

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>Wyniki testu</h3>
          <p>{rows.length} sprawdzonych wyników{waiting ? ` · ${waiting} oczekuje na sprawdzenie` : ""}</p>
        </div>
        {waiting > 0 && <Btn variant="secondary" icon="pencil" onClick={() => navigate("grading")}>Sprawdź papierowe</Btn>}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="chart" title="Brak wyników" text="Gdy uczniowie ukończą test, wyniki pojawią się tutaj." />
      ) : (
        <table className="table">
          <thead>
            <tr><th>Uczeń</th><th>Forma</th><th>Wynik</th><th>Punkty</th><th>Data</th><th>Ocena</th><th></th></tr>
          </thead>
          <tbody>
            {[...rows].sort((a, b) => b.percent - a.percent).map((r) => (
              <tr key={r.id}>
                <td className="td-name">
                  <button className="td-link" onClick={() => navigate("student", { studentId: r.studentId })}>
                    <span className="td-user"><Avatar student={r.student} size={28} />{r.student ? `${r.student.firstName} ${r.student.lastName}` : "—"}</span>
                  </button>
                </td>
                <td>{r.form === "virtual" ? <Badge tone="blue">Wirtualny</Badge> : <Badge tone="amber">Papierowy</Badge>}</td>
                <td>
                  <div className="score-cell">
                    <span className={cn("score-pct", r.percent >= 70 ? "good" : r.percent >= 50 ? "mid" : "bad")}>{r.percent ?? 0}%</span>
                  </div>
                </td>
                <td className="td-mono">{r.score}/{r.maxScore}</td>
                <td className="td-mono">{formatDate(r.date)}</td>
                <td><span className="grade-chip">{r.grade}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => navigate("student", { studentId: r.studentId })}><Icon name="chevronRight" size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
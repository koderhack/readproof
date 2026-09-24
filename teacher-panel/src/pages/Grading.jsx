import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { api } from "../lib/api.js";
import { Badge, Btn, EmptyState, Modal, PageHeader } from "../components/ui.jsx";
import { GradingQuestion, checkClosed } from "../components/QuestionRenderers.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn } from "../lib/utils.js";
import { typeMeta } from "../data/meta.js";

export function Grading() {
  const { tests, results, students, toast, loading } = useApp();
  const [testId, setTestId] = useState(null);
  const [review, setReview] = useState(null); // { attemptId, studentName }
  const [attemptData, setAttemptData] = useState(null);
  const [scores, setScores] = useState({});
  const [loadingAttempt, setLoadingAttempt] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [paperResult, setPaperResult] = useState(null);

  const paperTests = useMemo(
    () => tests.filter((t) => t.type === "paper" || t.type === "both"),
    [tests]
  );

  const testById = (id) => tests.find((t) => t.id === id);
  const testRows = (id) => results.filter((r) => r.testId === id);
  const pendingOf = (id) => testRows(id).filter((r) => r.status === "waiting");
  const studentName = (r) =>
    r.studentName ||
    (r.studentId ? (() => { const s = students.find((x) => x.id === r.studentId); return s ? `${s.firstName} ${s.lastName}` : null; })() : null);

  useEffect(() => {
    if (!paperTests.length && testId == null) setTestId(null);
    if (testId != null && !testById(testId)) setTestId(paperTests[0]?.id || null);
  }, [paperTests, testId]);

  useEffect(() => {
    setAttemptData(null);
    setScores({});
    if (!review) return;
    setLoadingAttempt(true);
    api(`/teacher/attempts/${review.attemptId}`)
      .then((d) => setAttemptData(d?.attempt || null))
      .catch(() => setAttemptData(null))
      .finally(() => setLoadingAttempt(false));
  }, [review]);

  const test = testId ? testById(testId) : null;

  const handleScan = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !test) return;
    setScanBusy(true);
    setPaperResult(null);
    try {
      const image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const uploaded = await api(`/teacher/challenges/${encodeURIComponent(test.id)}/paper`, {
        method: "POST",
        body: JSON.stringify({ image, studentName: "Skan do oceny" }),
      });
      const recognized = await api(`/teacher/paper/${encodeURIComponent(uploaded.paper.id)}/ocr`, { method: "POST", body: JSON.stringify({}) });
      setPaperResult(recognized.paper);
      toast(recognized.paper.engineMissing ? "Silnik OCR jest niedostępny — uzupełnij odpowiedzi ręcznie." : "Skan odczytany. Sprawdź wynik przed zatwierdzeniem.", recognized.paper.engineMissing ? "info" : "success");
    } catch (error) {
      toast("Nie udało się odczytać skanu: " + error.message, "info");
    } finally {
      setScanBusy(false);
      event.target.value = "";
    }
  };

  const confirmPaper = async () => {
    if (!paperResult) return;
    try {
      await api(`/teacher/paper/${encodeURIComponent(paperResult.id)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ answers: paperResult.ocrAnswers }),
      });
      setPaperResult(null);
      toast("Odpowiedzi zapisane i test oceniony.", "success");
    } catch (error) {
      toast("Nie udało się zapisać odpowiedzi: " + error.message, "info");
    }
  };

  const worksheet = useMemo(() => {
    if (!test || !attemptData) return null;
    const answers = attemptData.answers || {};
    return (test.questions || []).map((q, i) => {
      const ans = answers[q.id];
      const auto = checkClosed(q, ans);
      const picked = q.type === "match" ? null : ans;
      const pairs = q.type === "match" ? ans : null;
      const studentAnswer = {
        picked: q.type === "match" ? undefined : picked,
        pairs,
        answer: q.type === "open" ? ans || "" : undefined,
        achieved: q.type === "open" ? scores[q.id] ?? auto.achieved : auto.achieved,
      };
      return { q, i: i + 1, studentAnswer, auto };
    });
  }, [test, attemptData, scores]);

  const total = (test?.questions || []).reduce((s, q) => s + Number(q.points || 0), 0);
  const done = worksheet ? worksheet.reduce((s, w) => s + (w.studentAnswer.achieved || 0), 0) : 0;

  const handleOpenReview = (r) => setReview({ attemptId: r.attemptId, studentName: studentName(r) || "Uczeń" });

  const saveAndClose = () => {
    toast(`Ocena ${studentName(review) || "ucznia"}: ${done}/${total} pkt (${total ? Math.round((done / total) * 100) : 0}%)`);
    setReview(null);
  };

  const rows = test ? testRows(test.id) : [];
  const pending = test ? pendingOf(test.id) : [];

  return (
    <div className="page">
      <PageHeader title="Ocenianie" subtitle="Sprawdź prace papierowe i odpowiedzi otwarte." />

      <div className="grading-layout">
        <aside className="card grading-side">
          <div className="side-label">Testy papierowe</div>
          {paperTests.length === 0 ? (
            <p className="dim pad-sm">Brak testów z trybem papierowym.</p>
          ) : (
            <div className="side-list">
              {paperTests.map((t) => {
                const p = pendingOf(t.id).length;
                const ok = rows.filter((r) => r.status !== "waiting").length;
                return (
                  <button key={t.id} className={cn("side-item", testId === t.id && "sel")} onClick={() => setTestId(t.id)}>
                    <span className="side-item-name">{t.name}</span>
                    <span className="side-item-meta">
                      {p > 0 && <Badge tone="amber">{p} do oceny</Badge>}
                      {ok > 0 && <Badge tone="green">{ok} sprawdz.</Badge>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        <div className="grading-main card">
          {!test ? (
            <EmptyState icon="clipboard" title="Wybierz test" text="Z lewej wybierz test do oceny. Prace uczniów pojawią się tutaj." />
          ) : (
            <>
              <div className="grading-head">
                <div>
                  <div className="grading-title">{test.name}</div>
                  <div className="grading-sub">
                    {typeMeta[test.type]?.label} · {(test.questions || []).length} pytań · {total} pkt
                  </div>
                </div>
                <div className="grading-tally">
                  <span>{pending.length} do oceny</span>
                  <span>{rows.length - pending.length} sprawdzonych</span>
                </div>
              </div>

              <div className="scan-card">
                <div>
                  <strong>Odczyt maszynowy</strong>
                  <p>Wgraj zdjęcie arkusza. Odpowiedzi zostaną rozpoznane automatycznie przed zatwierdzeniem.</p>
                </div>
                <label className="scan-button">
                  <Icon name="paper" size={15} />
                  {scanBusy ? "Odczytuję…" : "Wgraj skan"}
                  <input type="file" accept="image/*" capture="environment" onChange={handleScan} disabled={scanBusy} />
                </label>
              </div>

              {paperResult && (
                <div className="scan-review">
                  <div className="scan-review-head"><div><strong>Odczyt skanu</strong><span>Sprawdź poprawność przed zapisem.</span></div><Btn icon="check" onClick={confirmPaper}>Zatwierdź i oceń</Btn></div>
                  <div className="scan-answer-grid">
                    {Object.entries(paperResult.ocrAnswers || {}).map(([id, value]) => {
                      const answer = value && typeof value === "object" ? value.answer : value;
                      return <div key={id} className="scan-answer"><span>{id}</span><strong>{Array.isArray(answer) ? answer.join(", ") : (answer ?? "—")}</strong></div>;
                    })}
                  </div>
                </div>
              )}

              {rows.length === 0 ? (
                <EmptyState icon="inbox" title="Brak prac" text="Wyniki pojawią się, gdy uczniowie rozwiążą ten test." />
              ) : (
                <div className="grading-list">
                  {[...rows]
                    .sort((a, b) => Number(a.status === "waiting") - Number(b.status === "waiting") || b.date.localeCompare(a.date))
                    .map((r) => {
                      const pct = r.percent;
                      return (
                        <div key={r.id} className="grading-row">
                          <div className="grading-row-main">
                            <span className="grading-name">{studentName(r) || "Uczeń"}</span>
                            <span className="grading-date">{r.date?.slice(0, 10)}</span>
                          </div>
                          {r.status === "waiting" ? (
                            <>
                              <Badge tone="amber">do oceny</Badge>
                              <Btn size="sm" icon="check" onClick={() => handleOpenReview(r)}>Sprawdź</Btn>
                            </>
                          ) : (
                            <>
                              <span className={cn("score-pct", pct >= 70 ? "good" : pct >= 50 ? "mid" : "bad")}>{pct ?? "—"}%</span>
                              <Btn size="sm" variant="ghost" icon="eye" onClick={() => handleOpenReview(r)}>Podgląd</Btn>
                            </>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <Modal
        open={!!review}
        onClose={() => setReview(null)}
        title={review ? `${review.studentName} — ${test?.name || ""}` : ""}
        footer={
          <>
            <Btn variant="secondary" onClick={() => setReview(null)}>Anuluj</Btn>
            <Btn icon="check" onClick={saveAndClose}>Zapisz ({done}/{total} pkt)</Btn>
          </>
        }
      >
        {loadingAttempt ? (
          <p className="dim pad">Pobieranie odpowiedzi…</p>
        ) : worksheet ? (
          <div className="grad-worksheet">
            {worksheet.map((w) => (
              <GradingQuestion
                key={w.q.id}
                q={w.q}
                index={w.i}
                studentAnswer={w.studentAnswer}
                auto={w.auto}
                onScore={(v) => setScores((s) => ({ ...s, [w.q.id]: v }))}
              />
            ))}
            {attemptData?.mapsTo && (
              <p className="dim pad-sm"><Icon name="info" size={13} /> {attemptData.mapsTo}</p>
            )}
          </div>
        ) : (
          <p className="dim pad">Brak danych odpowiedzi dla tego podejścia. Możesz ocenić pytania otwarte po przesłaniu skanu (OCR).</p>
        )}
      </Modal>
    </div>
  );
}
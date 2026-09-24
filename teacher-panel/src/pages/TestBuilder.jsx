import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { api } from "../lib/api.js";
import { Btn, Field, PageHeader, TypeBadge } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn, letter, questionTypeLabel, totalPoints, uid } from "../lib/utils.js";
import { questionKinds, typeMeta, BOOK_DEFAULT } from "../data/meta.js";
import { fromBackendQuestion } from "../lib/api.js";
import { StudentQuestion, blankAnswer, useAutoGrade } from "../components/QuestionRenderers.jsx";
import { PaperDocument, PaperKey } from "../components/PaperDocument.jsx";
import { PrintPortal } from "../components/PrintPortal.jsx";

const STEPS = [
  { n: 1, label: "Informacje", icon: "doc" },
  { n: 2, label: "Typ testu", icon: "layers" },
  { n: 3, label: "Pytania", icon: "list" },
  { n: 4, label: "Podgląd", icon: "eye" },
];

const blankQ = (type) => {
  const base = { id: uid("q"), type, points: 1, text: "" };
  if (type === "single") base.options = [mkOpt(), mkOpt(), mkOpt(), mkOpt()];
  if (type === "multiple") base.options = [mkOpt(), mkOpt(), mkOpt(), mkOpt()];
  if (type === "truefalse") base.correct = true;
  if (type === "match") base.pairs = [mkPair(), mkPair(), mkPair()];
  if (type === "order") base.sequence = ["", "", ""];
  if (type === "open") base.model = "";
  return base;
};
const mkOpt = () => ({ id: uid("o"), text: "", correct: false });
const mkPair = () => ({ id: uid("m"), left: "", right: "" });

export function TestBuilder({ testId }) {
  const { tests, classes, books, saveTest, publishTest, navigate, toast } = useApp();
  const existing = testId ? tests.find((t) => t.id === testId) : null;
  const questionsLocked = !!existing && existing.status !== "draft";
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: existing?.name || "",
    classId: existing?.classId || "",
    bookId: existing?.bookId || "",
    chapterId: existing?.chapter || "",
    chapters: existing?.chapters || [],
    scope: existing?.scope || "chapter",
    topic: existing?.topic || "",
    time: existing?.time || 20,
    deadline: existing?.deadline || "",
  });
  const [type, setType] = useState(existing?.type || null);
  const [questions, setQuestions] = useState(existing ? existing.questions : [blankQ("single")]);
  const [previewForm, setPreviewForm] = useState(existing?.type === "paper" ? "paper" : "virtual");
  const [published, setPublished] = useState(existing?.status === "published");
  const [publishedTest, setPublishedTest] = useState(existing?.status === "published" ? existing : null);
  const [pubForm, setPubForm] = useState(null);
  const [paperVersions, setPaperVersions] = useState(1);
  const [showKey, setShowKey] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  const [poolQuestions, setPoolQuestions] = useState([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [addedIds, setAddedIds] = useState(new Set(existing ? existing.questions.map((q) => q.id) : []));

  const errors = {};

  const book = books.find((b) => String(b.id) === String(form.bookId));
  const chapter = book && (book.chapters || []).find((c) => String(c.id) === String(form.chapterId));

  useEffect(() => {
    if (chapter && form.chapterId && form.topic !== chapter.title) {
      setForm((f) => ({ ...f, topic: chapter.title }));
    }
  }, [chapter, form.chapterId]);

  const setFormField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const canNext = () => {
    if (step === 1) return form.name.trim() && form.bookId;
    if (step === 2) return !!type;
    if (step === 3) {
      if (!(questions.length > 0 && questions.every((q) => q.text.trim()))) return false;
      if (form.scope === "book" && book) {
        return book.chapters.every((chapter) => questions.filter((q) => q.chapterId === chapter.id).length === 5);
      }
      return true;
    }
    return true;
  };

  const buildWholeBookQuestions = async () => {
    if (!book) {
      toast("Najpierw wybierz książkę.", "info");
      return false;
    }
    setPoolLoading(true);
    try {
      const groups = await Promise.all(
        (book.chapters || []).map(async (chapter) => {
          const data = await api("/api/teacher/pool?chapter=" + encodeURIComponent(chapter.id));
          const selected = (data?.pool || []).slice(0, 5).map((question) => ({
            ...fromBackendQuestion(question),
            chapterId: chapter.id,
          }));
          if (selected.length !== 5) throw new Error(`Rozdział ${chapter.title || chapter.id} ma tylko ${selected.length} pytań.`);
          return selected;
        }),
      );
      const nextQuestions = groups.flat();
      setQuestions(nextQuestions);
      setAddedIds(new Set(nextQuestions.map((question) => question.id)));
      setForm((current) => ({
        ...current,
        scope: "book",
        chapterId: "",
        chapters: (book.chapters || []).map((chapter) => chapter.id),
        topic: `Cała książka — ${book.chapters.length * 5} pytań`,
      }));
      toast(`Dodano ${nextQuestions.length} pytań: 5 z każdego rozdziału.`, "success");
      return true;
    } catch (error) {
      toast("Nie udało się przygotować całej książki: " + error.message, "info");
      return false;
    } finally {
      setPoolLoading(false);
    }
  };

  const goNext = async () => {
    if (!canNext()) return;
    if (step === 1 && form.scope === "book") {
      const ready = await buildWholeBookQuestions();
      if (!ready) return;
    }
    if (step === 3 && !questionsLocked) {
      const saved = await saveAndContinue();
      if (!saved) return;
    }
    setStep((s) => Math.min(4, s + 1));
  };
  const back = () => setStep((s) => Math.max(1, s - 1));

  const updateQ = (id, patch) => setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const moveQ = (id, dir) =>
    setQuestions((qs) => {
      const i = qs.findIndex((q) => q.id === id);
      const j = i + dir;
      if (j < 0 || j >= qs.length) return qs;
      const copy = [...qs];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const addQ = (q) => {
    setQuestions((qs) => [...qs, q]);
    setAddedIds((s) => new Set(s).add(q.id));
  };
  const dupeQ = (id) =>
    setQuestions((qs) => {
      const i = qs.findIndex((q) => q.id === id);
      const copy = { ...qs[i], id: uid("q"), options: qs[i].options?.map((o) => ({ ...o })), pairs: qs[i].pairs?.map((p) => ({ ...p })) };
      return [...updateAt(qs, i + 1, copy)];
    });
  const delQ = (id) => setQuestions((qs) => qs.filter((q) => q.id !== id));

  const doPublish = async (formType) => {
    const assembled = {
      id: existing?.id || uid("t"),
      ...form,
      type,
      questions,
      status: "published",
    };
    const ch = await publishTest(assembled, formType);
    if (!ch) return;
    setPublishedTest(ch);
    setPublished(true);
    setPubForm(formType);
    toast(
      formType === "paper"
        ? "Test opublikowany — wersja papierowa gotowa do wydruku"
        : "Test opublikowany — wygenerowano kod dostępu"
    );
  };

  const saveDraft = async () => {
    const assembled = { id: existing?.id || uid("t"), ...form, type, questions, status: "draft" };
    await saveTest(assembled);
    toast("Zapisano jako szkic", "info");
  };

  const saveAndContinue = async () => {
    const assembled = { id: existing?.id || uid("t"), ...form, type, questions, status: "draft" };
    try {
      await saveTest(assembled);
      return true;
    } catch {
      return false;
    }
  };

  const loadPool = async () => {
    if (!form.chapterId) return;
    setPoolLoading(true);
    try {
      const d = await api("/api/teacher/pool?chapter=" + encodeURIComponent(form.chapterId));
      const pool = (d?.pool || []).map((question) => ({ ...fromBackendQuestion(question), chapterId: form.chapterId }));
      setPoolQuestions(pool);
    } catch (e) {
      toast("Nie udało się pobrać banku pytań: " + e.message, "info");
    } finally {
      setPoolLoading(false);
    }
  };

  const addFromPool = (q) => {
    if (addedIds.has(q.id)) return;
    addQ(q);
  };
  const addAllByType = () => {
    const sel = new Set(questions.filter((q) => questionKinds.some((k) => k.value === q.type)).map((q) => q.type));
    const toAdd = poolQuestions.filter((q) => sel.has(q.type) && !addedIds.has(q.id));
    toAdd.forEach((q) => addQ(q));
  };
  const selectedTypes = useMemo(() => new Set(questions.map((q) => q.type)), [questions]);

  const printAll = () => window.print();
  const printTest = {
    ...form,
    type,
    questions,
    id: existing?.id || "draft-preview",
    className: classes.find((item) => item.id === form.classId)?.name,
  };

  return (
    <div className="page">
      <PageHeader
        title={existing ? "Edytuj test" : "Nowy test"}
        subtitle={existing ? (questionsLocked ? `„${existing.name}” — pytania są zablokowane po publikacji.` : `„${existing.name}” — popraw treść i opublikuj ponownie.`) : "Cztery kroki dzielą Cię od gotowego sprawdzianu."}
        actions={step === 4 && !questionsLocked ? <Btn variant="secondary" icon="doc" onClick={saveDraft}>Zapisz szkic</Btn> : undefined}
      />

      <div className="wizard">
        <aside className="wizard-rail">
          <div className="wizard-steps">
            {STEPS.map((s) => (
              <button key={s.n} className={cn("wizard-step", step === s.n && "active", step > s.n && "done")} onClick={() => step > s.n && setStep(s.n)}>
                <span className="wizard-step-n">{step === s.n ? <Icon name={s.icon} size={15} /> : step > s.n ? <Icon name="check" size={15} /> : s.n}</span>
                <span className="wizard-step-label">{s.label}</span>
                {step > s.n && <span className="wizard-step-lines" />}
              </button>
            ))}
          </div>
          {step === 1 && (
            <div className="wizard-info">
              <Icon name="info" size={14} />
              <p>Test będzie oparty na pytaniach z lektury. Wybierz książkę i rozdział, aby załadować bank pytań.</p>
            </div>
          )}
        </aside>

        <div className="wizard-main">
          {step === 1 && (
            <section className="wizard-section">
              <div className="wizard-section-head">
                <h2>Podstawowe informacje</h2>
                <p>Kto, kiedy i z czego pisze.</p>
              </div>
              <div className="form-grid">
                <Field label="Nazwa testu">
                  <input className="input" value={form.name} placeholder="np. Fotosynteza — sprawdzian" onChange={(e) => setFormField("name", e.target.value)} />
                </Field>
                <Field label="Przedmiot">
                  <input className="input" value="Język polski" readOnly />
                </Field>
                <Field label="Klasa" hint={form.classId ? undefined : "Wybierz klasę, dla której tworzysz test"}>
                  <div className="class-chips">
                    {classes.map((c) => (
                      <button key={c.id} className={cn("class-chip", form.classId === c.id && "sel")} onClick={() => setFormField("classId", c.id)}>
                        <span style={{ background: c.color }}>{c.name.charAt(0)}</span>
                        {c.name}
                      </button>
                    ))}
                    {classes.length === 0 && <span className="dim pad-sm">Brak klas — utwórz je na stronie Klasy.</span>}
                  </div>
                </Field>
                <Field label="Lekcja (książka)">
                  <select className="select" name="bookId" value={form.bookId} onChange={(e) => setFormField("bookId", e.target.value)} disabled={questionsLocked}>
                    <option value="">— wybierz książkę —</option>
                    {books.map((b) => <option key={b.id} value={b.id}>{b.title || b.name}</option>)}
                  </select>
                </Field>
                <Field label="Zakres testu" hint="Cała książka tworzy jeden test i jeden certyfikat po zakończeniu">
                  <select
                    className="select"
                    name="scope"
                    value={form.scope}
                    disabled={!form.bookId || questionsLocked}
                    onChange={(e) => {
                      const scope = e.target.value;
                      setForm((current) => ({
                        ...current,
                        scope,
                        chapterId: scope === "book" ? "" : current.chapterId,
                        chapters: scope === "book" ? (book?.chapters || []).map((chapter) => chapter.id) : current.chapters,
                        topic: scope === "book" ? "Cała książka" : current.topic,
                      }));
                      setQuestions([]);
                      setPoolQuestions([]);
                    }}
                  >
                    <option value="chapter">Jeden rozdział</option>
                    <option value="book">Wszystkie rozdziały — 5 pytań z każdego</option>
                  </select>
                </Field>
                {form.scope === "book" ? (
                  <Field label="Certyfikat końcowy">
                    <button type="button" className="btn btn-secondary" onClick={buildWholeBookQuestions} disabled={poolLoading || questionsLocked}>
                      <Icon name="book" size={15} /> {poolLoading ? "Tworzę pytania…" : `Utwórz test z ${(book?.chapters?.length || 0) * 5} pytań`}
                    </button>
                  </Field>
                ) : (
                  <Field label="Rozdział">
                    <select className="select" name="chapterId" value={form.chapterId} onChange={(e) => setFormField("chapterId", e.target.value)} disabled={!form.bookId || questionsLocked}>
                      <option value="">— wybierz rozdział —</option>
                      {(book && book.chapters ? book.chapters : []).map((c) => (
                        <option key={c.id} value={c.id}>{c.title || c.name}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label="Temat / dział" hint={chapter ? "Uzupełniono z rozdziału" : undefined}>
                  <input className="input" value={form.topic} placeholder="np. Fotosynteza i jej produkty" onChange={(e) => setFormField("topic", e.target.value)} />
                </Field>
                <Field label="Czas (minuty)">
                  <div className="input-suffix">
                    <input className="input" type="number" min={1} max={180} value={form.time} onChange={(e) => setFormField("time", Number(e.target.value))} />
                    <Icon name="timer" size={16} />
                  </div>
                </Field>
                <Field label="Termin">
                  <input className="input" type="date" value={form.deadline} onChange={(e) => setFormField("deadline", e.target.value)} />
                </Field>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="wizard-section">
              <div className="wizard-section-head">
                <h2>W jakiej formie będzie test?</h2>
                <p>Możesz później zmienić decyzję — treść pytania jest wspólna dla obu form.</p>
              </div>
              <Field label="Rodzaj testu" hint="Wybierz formę, w której test zostanie opublikowany">
                <select className="select" name="testType" value={type || ""} onChange={(e) => setType(e.target.value)}>
                  <option value="">— wybierz rodzaj testu —</option>
                  <option value="virtual">Wirtualny</option>
                  <option value="paper">Papierowy</option>
                  <option value="both">Hybrydowy</option>
                </select>
              </Field>
              <div className="type-cards" role="radiogroup" aria-label="Rodzaj testu">
                <TypeCard
                  type="virtual"
                  active={type === "virtual"}
                  onClick={() => setType("virtual")}
                  icon="device"
                  title="Wirtualny"
                  tagline="Uczniowie rozwiązują na urządzeniu"
                  bullets={["Dołączanie kodem lub linkiem", "Postęp uczniów na żywo", "Automatyczne sprawdzanie pytań zamkniętych", "Wyniki trafiają do dziennika od razu"]}
                />
                <TypeCard
                  type="paper"
                  active={type === "paper"}
                  onClick={() => setType("paper")}
                  icon="paper"
                  title="Papierowy"
                  tagline="Drukujesz, uczniowie rozwiązują na kartce"
                  bullets={["Generowanie gotowego dokumentu A4", "Wersje A/B i klucz odpowiedzi", "Pobierz PDF lub wydrukuj", "Punkty wpisujesz ręcznie w trybie sprawdzania"]}
                />
                <TypeCard
                  type="both"
                  active={type === "both"}
                  onClick={() => setType("both")}
                  icon="layers"
                  title="Hybrydowy"
                  tagline="Jeden test — obie formy"
                  bullets={["Część klasy pisze online", "Część klasy dostaje kartkę", "Obie części trafiają do jednych wyników", "Idealne, gdy brakuje sprzętu"]}
                />
              </div>
            </section>
          )}

          {step === 3 && (
            <section className="wizard-section">
              <div className="wizard-section-head row">
                <div>
                  <h2>Pytania</h2>
                  <p>{questions.length} pytań · {totalPoints(questions)} pkt łącznie</p>
                </div>
                {!questionsLocked && (
                  <div className="add-q-menu">
                    <Btn icon="plus" onClick={() => addQ(blankQ("single"))}>Dodaj pytanie</Btn>
                  </div>
                )}
              </div>

              {questionsLocked && (
                <div className="questions-lock-notice">
                  <Icon name="lock" size={16} />
                  <div><strong>Pytania są zablokowane</strong><span>Po publikacji nie można zmieniać treści ani odpowiedzi, aby wynik uczniów pozostał wiarygodny.</span></div>
                </div>
              )}

              {!questionsLocked && form.scope === "book" && (
                <div className="pool-panel whole-book-panel">
                  <div>
                    <strong>Jeden test · jeden certyfikat</strong>
                    <p className="dim">Każdy rozdział ma dokładnie 5 pytań. Poniżej: {questions.length} z {(book?.chapters?.length || 0) * 5} wymaganych.</p>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={buildWholeBookQuestions} disabled={poolLoading}>
                    <Icon name="refresh" size={14} /> Odtwórz zestaw
                  </button>
                </div>
              )}

              {!questionsLocked && (
              <div className="question-kind-hint">
                <span>Dodaj szybkie pytanie:</span>
                {questionKinds.map((k) => (
                  <button key={k.value} className="kind-chip" onClick={() => addQ(blankQ(k.value))}>
                    <Icon name={k.icon} size={13} /> {k.label}
                  </button>
                ))}
              </div>
              )}

              {!questionsLocked && (form.bookId && form.chapterId) && (
                <div className="pool-panel">
                  <div className="pool-head">
                    <button className="btn btn-secondary" onClick={loadPool} disabled={poolLoading}>
                      <Icon name="book" size={14} /> {poolLoading ? "Pobieram bank…" : "Pobierz bank pytań z lektury"}
                    </button>
                    {poolQuestions.length > 0 && (
                      <Btn size="sm" icon="plus" onClick={addAllByType} disabled={![...selectedTypes].length}>Dodaj wszystkie wybrane</Btn>
                    )}
                  </div>
                  {poolQuestions.length > 0 && (
                    <div className="pool-list">
                      {poolQuestions.map((q) => (
                        <div key={q.id} className={cn("pool-card", addedIds.has(q.id) && "added")}>
                          <div className="pool-card-info">
                            <TypeBadge type={q.type} />
                            <span className="pool-card-text">{q.text.slice(0, 90)}{q.text.length > 90 ? "…" : ""}</span>
                          </div>
                          <button
                            className="btn btn-sm"
                            disabled={addedIds.has(q.id)}
                            onClick={() => addFromPool(q)}
                          >
                            {addedIds.has(q.id) ? "Dodano" : "+"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {!poolLoading && poolQuestions.length === 0 && (
                    <p className="dim pad-sm">Wybrany rozdział nie ma jeszcze pytań w bazie — dodaj je ręcznie lub wrzuć pytania do lektury.</p>
                  )}
                </div>
              )}

              <div className="q-editor-list" inert={questionsLocked ? "" : undefined} aria-readonly={questionsLocked}>
                {questions.map((q, i) => {
                  const questionChapter = book?.chapters?.find((chapter) => String(chapter.id) === String(q.chapterId));
                  const chapterPosition = questions.slice(0, i + 1).filter((question) => question.chapterId === q.chapterId).length;
                  return (
                    <div key={q.id} className="q-editor-group">
                      {form.scope === "book" && (
                        <div className="q-editor-chapter">{questionChapter?.title || q.chapterId} · pytanie {chapterPosition}/5</div>
                      )}
                      <QuestionEditor
                        q={q}
                        index={i}
                        total={questions.length}
                        onPatch={(patch) => updateQ(q.id, patch)}
                        onMove={(d) => moveQ(q.id, d)}
                        onDupe={() => dupeQ(q.id)}
                        onDel={() => delQ(q.id)}
                      />
                    </div>
                  );
                })}
                {questions.length === 0 && !questionsLocked && (
                  <div className="q-editor-empty" onClick={() => addQ("single")}>
                    <Icon name="plus" size={22} /> Dodaj pierwsze pytanie
                  </div>
                )}
              </div>
            </section>
          )}

          {step === 4 && (
            <section className="wizard-section">
              <div className="wizard-section-head row">
                <div>
                  <h2>Podgląd i publikacja</h2>
                  <p>Dokładnie tak zobaczą to Twoi uczniowie.</p>
                </div>
                <div className="preview-switch">
                  {(type !== "paper") && <button className={cn("pv-tab", previewForm === "virtual" && "active")} onClick={() => setPreviewForm("virtual")}><Icon name="device" size={15} /> Widok wirtualny</button>}
                  {(type !== "virtual") && <button className={cn("pv-tab", previewForm === "paper" && "active")} onClick={() => setPreviewForm("paper")}><Icon name="paper" size={15} /> Widok papierowy</button>}
                </div>
              </div>

              {!published ? (
                <>
                  <div className="preview-stage">
                    {previewForm === "virtual" && <VirtualPreview test={{ ...form, type, questions }} />}
                    {previewForm === "paper" && <PaperPreview test={{ ...form, type, questions }} versions={paperVersions} setVersions={setPaperVersions} showKey={showKey} setShowKey={setShowKey} />}
                  </div>

                  <div className="publish-bar">
                    <div className="publish-summary">
                      <TypeBadge type={type} />
                      <span>{form.name || "Bez nazwy"} · {form.classId ? `Klasa ${classes.find((c) => c.id === form.classId)?.name}` : "—"} · {questions.length} pytań · {totalPoints(questions)} pkt</span>
                    </div>
                    <div className="publish-acts">
                      <Btn variant="secondary" onClick={back} icon="back">Wstecz</Btn>
                      {type === "virtual" && <Btn icon="device" onClick={() => doPublish("virtual")}>Opublikuj — wygeneruj kod</Btn>}
                      {type === "paper" && <Btn icon="printer" onClick={() => doPublish("paper")}>Opublikuj — gotowy do druku</Btn>}
                      {type === "both" && (
                        <>
                          <Btn variant="secondary" icon="printer" onClick={() => doPublish("paper")}>Publikuj papierowo</Btn>
                          <Btn icon="device" onClick={() => doPublish("virtual")}>Publikuj wirtualnie</Btn>
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <PublishedScreen test={publishedTest} formType={pubForm || (type === "both" ? "virtual" : type)} navigate={navigate} types={type} />
              )}
            </section>
          )}

          {step < 4 && (
            <div className="wizard-nav">
              {step > 1 && <Btn variant="secondary" icon="back" onClick={back}>Wstecz</Btn>}
              <div className="wizard-nav-spacer" />
              {step <= 2 && <Btn icon="chevronRight" onClick={goNext}>Dalej</Btn>}
              {step === 3 && (
                <>
                  {!questionsLocked && <Btn variant="secondary" onClick={saveDraft}>Zapisz szkic</Btn>}
                  <Btn icon="eye" onClick={goNext}>Podgląd testu</Btn>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {(type === "paper" || type === "both") && (
        <PrintPortal>
          {Array.from({ length: Math.max(1, paperVersions) }).map((_, i) => {
            const v = i % 2 === 0 ? "A" : "B";
            return <PaperDocument key={`doc-${i}`} test={printTest} version={v} />;
          })}
          {showKey && (
            <>
              <PaperKey test={printTest} version="A" />
              <PaperKey test={printTest} version="B" />
            </>
          )}
        </PrintPortal>
      )}
    </div>
  );
}

function updateAt(arr, i, item) {
  const copy = [...arr];
  copy.splice(i, 0, item);
  return copy;
}

function TypeCard({ type, active, onClick, icon, title, tagline, bullets }) {
  const meta = typeMeta[type];
  return (
    <button type="button" role="radio" aria-checked={active} className={cn("type-card", `tc-${type}`, active && "active")} onClick={onClick}>
      <div className="type-card-head">
        <span className="type-card-icon"><Icon name={icon} size={20} /></span>
        <span className={cn("type-card-radio")}>{active && <span />}</span>
      </div>
      <h3>{title}</h3>
      <p className="type-card-tag">{tagline}</p>
      <ul className="type-card-bullets">
        {bullets.map((b) => (
          <li key={b}>{active ? <Icon name="check" size={13} /> : <span className="bullet-dot" />}{b}</li>
        ))}
      </ul>
    </button>
  );
}

function QuestionEditor({ q, index, total, onPatch, onMove, onDupe, onDel }) {
  const [typeMenu, setTypeMenu] = useState(false);
  return (
    <div className="q-editor">
      <div className="q-editor-bar">
        <span className="q-editor-index">{index + 1}</span>
        <div className="q-editor-type">
          <button className="q-editor-type-btn" onClick={() => setTypeMenu((m) => !m)}>
            <Icon name={QUESTION_ICONS[q.type]} size={14} /> {questionTypeLabel(q.type)} <Icon name="chevronDown" size={13} />
          </button>
          {typeMenu && (
            <div className="dropdown q-type-dropdown">
              {questionKinds.map((k) => (
                <button key={k.value} className={cn("dropdown-item", q.type === k.value && "sel")} onClick={() => { onPatch({ type: k.value }); setTypeMenu(false); }}>
                  <Icon name={k.icon} size={15} /> {k.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="q-editor-pts">
          <span>Punkty</span>
          <input className="input pts-input" type="number" min={1} max={20} value={q.points} onChange={(e) => onPatch({ points: Number(e.target.value) || 1 })} />
        </div>
        <div className="q-editor-tools">
          <button className="icon-btn sm" disabled={index === 0} title="Przenieś wyżej" onClick={() => onMove(-1)}><Icon name="up" size={14} /></button>
          <button className="icon-btn sm" disabled={index === total - 1} title="Przenieś niżej" onClick={() => onMove(1)}><Icon name="down" size={14} /></button>
          <button className="icon-btn sm" title="Duplikuj" onClick={onDupe}><Icon name="copy" size={14} /></button>
          <button className="icon-btn sm danger" title="Usuń" onClick={onDel}><Icon name="trash" size={14} /></button>
        </div>
      </div>

      <div className="q-editor-body">
        <input className="input q-text-input" placeholder="Treść pytania…" value={q.text} onChange={(e) => onPatch({ text: e.target.value })} />

        {q.type === "single" && (
          <div className="opt-editor-list">
            {(q.options || []).map((o, i) => (
              <div key={o.id} className="opt-editor-row">
                <button className={cn("correct-btn", o.correct && "on")} onClick={() => onPatch({ options: q.options.map((x) => ({ ...x, correct: x.id === o.id })) })} title="Poprawna odpowiedź">
                  <Icon name={o.correct ? "checkCircle" : "radio"} size={16} />
                </button>
                <span className="opt-letter">{letter(i)}.</span>
                <input className="input" value={o.text} placeholder={`Odpowiedź ${letter(i)}…`} onChange={(e) => onPatch({ options: q.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })} />
                <button className="icon-btn sm" onClick={() => onPatch({ options: q.options.filter((x) => x.id !== o.id) })}><Icon name="x" size={14} /></button>
              </div>
            ))}
            <button className="add-opt-btn" onClick={() => onPatch({ options: [...q.options, mkOpt()] })}><Icon name="plus" size={14} /> Dodaj odpowiedź</button>
          </div>
        )}

        {q.type === "multiple" && (
          <div className="opt-editor-list">
            {(q.options || []).map((o, i) => (
              <div key={o.id} className="opt-editor-row">
                <button className={cn("correct-btn", o.correct && "on")} onClick={() => onPatch({ options: q.options.map((x) => (x.id === o.id ? { ...x, correct: !x.correct } : x)) })} title="Przełącz poprawność">
                  <Icon name={o.correct ? "checkbox2" : "checkboxBox"} size={16} />
                </button>
                <span className="opt-letter">{letter(i)}.</span>
                <input className="input" value={o.text} placeholder={`Odpowiedź ${letter(i)}…`} onChange={(e) => onPatch({ options: q.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })} />
                <button className="icon-btn sm" onClick={() => onPatch({ options: q.options.filter((x) => x.id !== o.id) })}><Icon name="x" size={14} /></button>
              </div>
            ))}
            <button className="add-opt-btn" onClick={() => onPatch({ options: [...q.options, mkOpt()] })}><Icon name="plus" size={14} /> Dodaj odpowiedź</button>
            <p className="editor-note">Zaznacz <Icon name="checkbox2" size={13} /> przy wszystkich poprawnych odpowiedziach.</p>
          </div>
        )}

        {q.type === "truefalse" && (
          <div className="tf-editor">
            <button className={cn("tf-pick", q.correct === true && "on")} onClick={() => onPatch({ correct: true })}><Icon name="check" size={15} /> Prawda</button>
            <button className={cn("tf-pick", q.correct === false && "on")} onClick={() => onPatch({ correct: false })}><Icon name="x" size={15} /> Fałsz</button>
            <span className="tf-editor-hint">Poprawna odpowiedź:</span>
          </div>
        )}

        {q.type === "match" && (
          <div className="match-editor">
            <div className="match-editor-cols">
              <span className="match-col-head">Lewa kolumna</span>
              <span className="match-col-head">Prawa kolumna</span>
            </div>
            {(q.pairs || []).map((p, i) => (
              <div key={p.id} className="match-editor-row">
                <input className="input" value={p.left} placeholder="Pojęcie…" onChange={(e) => onPatch({ pairs: q.pairs.map((x) => (x.id === p.id ? { ...x, left: e.target.value } : x)) })} />
                <Icon name="link" size={15} />
                <input className="input" value={p.right} placeholder="Definicja…" onChange={(e) => onPatch({ pairs: q.pairs.map((x) => (x.id === p.id ? { ...x, right: e.target.value } : x)) })} />
                <button className="icon-btn sm" onClick={() => onPatch({ pairs: q.pairs.filter((x) => x.id !== p.id) })}><Icon name="x" size={14} /></button>
              </div>
            ))}
            <button className="add-opt-btn" onClick={() => onPatch({ pairs: [...q.pairs, mkPair()] })}><Icon name="plus" size={14} /> Dodaj parę</button>
          </div>
        )}

        {q.type === "order" && (
          <div className="order-editor">
            {(q.sequence || []).map((s, i) => (
              <div key={i} className="order-editor-row">
                <span className="order-pos">{i + 1}.</span>
                <input className="input" value={s} placeholder="Element układanki…" onChange={(e) => onPatch({ sequence: q.sequence.map((x, j) => (j === i ? e.target.value : x)) })} />
                <button className="icon-btn sm" onClick={() => onPatch({ sequence: q.sequence.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
              </div>
            ))}
            <button className="add-opt-btn" onClick={() => onPatch({ sequence: [...q.sequence, ""] })}><Icon name="plus" size={14} /> Dodaj element</button>
          </div>
        )}

        {q.type === "open" && (
          <div className="open-editor">
            <textarea
              className="input"
              rows={2}
              placeholder="Model odpowiedzi / kryteria punktowania (pokaże się nauczycielowi przy sprawdzaniu)…"
              value={q.model || ""}
              onChange={(e) => onPatch({ model: e.target.value })}
            />
            <p className="editor-note">Model odpowiedzi jest opcjonalny — pomaga przy ręcznym sprawdzaniu.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const QUESTION_ICONS = { single: "radio", multiple: "checkbox2", truefalse: "toggle", match: "link", order: "sort", open: "pencil" };

function VirtualPreview({ test }) {
  const [answers, setAnswers] = useState({});
  const [finished, setFinished] = useState(false);
  const auto = useAutoGrade(test.questions, answers);
  const filled = useMemo(() => {
    const a = {};
    test.questions.forEach((q) => {
      if (q.type === "single" || q.type === "truefalse") a[q.id] = q.options ? q.options.find((o) => o.correct)?.id : q.correct;
      if (q.type === "multiple") a[q.id] = q.options.filter((o) => o.correct).map((o) => o.id);
      if (q.type === "match") { const m = {}; q.pairs.forEach((p) => (m[p.id] = p.right)); a[q.id] = m; }
      if (q.type === "order") a[q.id] = [...q.sequence];
      if (q.type === "open") a[q.id] = "Przykładowa odpowiedź ucznia na pytanie otwarte…";
    });
    return a;
  }, [test.questions]);

  return (
    <div className="virtual-preview-wrap">
      <div className="phone">
        <div className="phone-notch">
          <div className="phone-time">{test.time || 20} min</div>
          <div className="phone-prog-dots">
            {test.questions.map((q) => (
              <span key={q.id} className={cn("dot", (answers[q.id] && !(Array.isArray(answers[q.id]) && answers[q.id].length === 0) && answers[q.id] !== "") || finished ? "filled" : "")} />
            ))}
          </div>
        </div>
        <div className="phone-body">
          {!finished ? (
            <>
              <div className="phone-head">
                <strong>{test.name}</strong>
                <span>{test.questions.length} pytań</span>
              </div>
              <div className="phone-qs">
                {test.questions.map((q, i) => (
                  <StudentQuestion key={q.id} q={q} index={i + 1} answer={answers[q.id]} onAnswer={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} reveal={false} />
                ))}
              </div>
              <button className="btn btn-primary full" onClick={() => { setAnswers(filled); setFinished(true); }}>Zakończ i sprawdź</button>
            </>
          ) : (
            <div className="auto-result">
              <div className="auto-result-ring" style={{ "--p": auto.max ? Math.round((auto.score / auto.max) * 100) : 0 }}>
                <div className="ar-val">
                  <strong>{auto.score}/{auto.max}</strong>
                  <span>{auto.max ? Math.round((auto.score / auto.max) * 100) : 0}%</span>
                </div>
              </div>
              <h3>Test zaliczony!</h3>
              <p className="ar-note">Pytania zamknięte sprawdzone automatycznie. Pytanie otwarte oceni nauczyciel.</p>
              <button className="btn btn-secondary mt" onClick={() => { setFinished(false); setAnswers({}); }}><Icon name="refresh" size={15} /> Od nowa</button>
            </div>
          )}
        </div>
      </div>
      <div className="pv-side-note">
        <Icon name="zap" size={15} />
        <p><strong>Automatyczne sprawdzanie</strong> obejmuje pytania zamknięte (wybór, prawda/fałsz, dopasowanie, kolejność). Pytania otwarte czekają na Twoją ocenę w widoku „Sprawdzanie”.</p>
      </div>
    </div>
  );
}

function PaperPreview({ test, versions, setVersions, showKey, setShowKey }) {
  const previewDoc = useMemo(() => ({ ...test, questions: test.questions }), [test]);
  return (
    <div className="paper-preview-wrap">
      <div className="paper-preview-grid">
        <div className="pv-paper-scroll">
          <PaperDocument test={previewDoc} version="A" compact />
          {versions > 1 && <PaperDocument test={previewDoc} version="B" compact />}
        </div>
        <div className="pv-panel">
          <div className="pv-panel-row">
            <span>Liczba wersji</span>
            <div className="versions-stepper">
              <button className="icon-btn sm" disabled={versions <= 1} onClick={() => setVersions((v) => v - 1)}><Icon name="x" size={13} /></button>
              <span>{versions} {versions === 1 ? "wersja" : "wersje"}</span>
              <button className="icon-btn sm" disabled={versions >= 2} onClick={() => setVersions((v) => v + 1)}><Icon name="plus" size={13} /></button>
            </div>
          </div>
          <div className="pv-panel-row">
            <span>Dołącz klucz odpowiedzi</span>
            <button className={cn("mini-switch", showKey && "on")} onClick={() => setShowKey((k) => !k)} />
          </div>
          <p className="pv-panel-note">Wersja B to losowo przetasowane odpowiedzi i pytania — idealne, gdy uczniowie siedzą blisko siebie.</p>
          <div className="pv-panel-actions">
            <button className="btn btn-secondary" onClick={() => window.print()}><Icon name="printer" size={15} /> Drukuj</button>
            <button className="btn btn-primary" onClick={() => window.print()}><Icon name="download" size={15} /> Pobierz PDF</button>
          </div>
        </div>
      </div>
      {showKey && (
        <div className="pv-key-strip">
          <div className="pv-key-head"><Icon name="lock" size={14} /> Klucz odpowiedzi (widoczny tylko dla nauczyciela)</div>
          <PaperKey test={previewDoc} version="A" />
        </div>
      )}
    </div>
  );
}

function PublishedScreen({ test, formType, navigate, types }) {
  return (
    <div className="published-screen">
      {formType !== "paper" && (
        <div className="pub-card pub-virtual">
          <div className="pub-badge"><Icon name="device" size={18} /> Wirtualny</div>
          <h3>Test został opublikowany!</h3>
          <p>Uczniowie dołączają z poziomu przeglądarki — wystarczy kod albo link.</p>
          <div className="pub-code-box">
            <div className="pub-code">{test.code}</div>
            <Btn variant="secondary" icon="copy" onClick={() => { navigator.clipboard?.writeText(test.code); }}>Kopiuj</Btn>
          </div>
          <div className="pub-link-row">
            <Icon name="link" size={14} />
            <span>{test.link || `solve.testly.pl/${String(test.code).toLowerCase()}`}</span>
            <button className="icon-btn sm" onClick={() => { navigator.clipboard?.writeText(test.link || `solve.testly.pl/${String(test.code).toLowerCase()}`); }}><Icon name="copy" size={14} /></button>
          </div>
          <Btn icon="eye" onClick={() => navigate("test", { testId: test.id, tab: "virtual" })}>Monitoruj postęp na żywo</Btn>
        </div>
      )}
      {formType !== "virtual" && (
        <div className="pub-card pub-paper">
          <div className="pub-badge amber"><Icon name="paper" size={18} /> Papierowy</div>
          <h3>Wersja papierowa gotowa</h3>
          <p>Wygeneruj dokumenty i wydrukuj. Klucz odpowiedzi dołączysz oddzielnie.</p>
          <div className="pub-file">
            <span className="pub-file-ic"><Icon name="paper" size={20} /></span>
            <div>
              <strong>{test.name} — wersja A/B</strong>
              <span>A4 · 2 strony plus klucz</span>
            </div>
          </div>
          <div className="pub-cts">
            <Btn variant="secondary" icon="printer" onClick={() => window.print()}>Drukuj</Btn>
            <Btn icon="download" onClick={() => window.print()}>Pobierz PDF</Btn>
          </div>
          <Btn variant="ghost" icon="checkCircle" onClick={() => navigate("test", { testId: test.id, tab: "paper" })}>Przejdź do arkusza testu</Btn>
        </div>
      )}
    </div>
  );
}

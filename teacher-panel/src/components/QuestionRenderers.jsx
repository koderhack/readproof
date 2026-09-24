import React, { useMemo } from "react";
import { cn, letter, questionTypeLabel } from "../lib/utils.js";
import { Icon } from "../lib/icons.jsx";

export const MatchPair = ({ q }) => (
  <div className="match-pair">
    <div className="match-left">{q.left}</div>
    <div className="match-dash" />
    <div className="match-right">{q.right}</div>
  </div>
);

export function checkClosed(q, answer) {
  if (!answer) return { correct: false, achieved: 0, outOf: Number(q.points) || 0, note: "Brak odpowiedzi" };
  const pts = Number(q.points) || 0;
  switch (q.type) {
    case "single": {
      const opts = q.options || [];
      const correct = opts.find((o) => o.correct);
      const ok = answer === correct?.id;
      return { correct: ok, achieved: ok ? pts : 0, outOf: pts };
    }
    case "multiple": {
      const correctIds = (q.options || []).filter((o) => o.correct).map((o) => o.id);
      const sel = Array.isArray(answer) ? answer : [];
      if (sel.length === 0) return { correct: false, achieved: 0, outOf: pts, note: "Brak zaznaczeń" };
      const allCorrect = correctIds.every((id) => sel.includes(id)) && sel.length === correctIds.length;
      const partial = sel.every((id) => correctIds.includes(id));
      return { correct: allCorrect, achieved: allCorrect ? pts : partial ? Math.round((sel.length / correctIds.length) * pts) : 0, outOf: pts, partial };
    }
    case "truefalse": {
      const ok = answer === q.correct;
      return { correct: ok, achieved: ok ? pts : 0, outOf: pts };
    }
    case "match": {
      const total = (q.pairs || []).length;
      const rightMap = Object.fromEntries((q.pairs || []).map((p) => [p.id, p.right]));
      const matched = (q.pairs || []).filter((p) => answer[p.id] === p.right).length;
      const achieved = Math.round((matched / total) * pts);
      return { correct: true, achieved, outOf: pts, partial: matched < total, matched, total };
    }
    case "order": {
      const total = (q.sequence || []).length;
      if (total === 0) return { correct: false, achieved: 0, outOf: pts };
      const matched = (q.sequence || []).filter((item, i) => answer[i] === item).length;
      const achieved = Math.round((matched / total) * pts);
      return { correct: matched === total, achieved, outOf: pts, partial: matched < total, matched, total };
    }
    case "open":
      return { correct: null, achieved: 0, outOf: pts, open: true };
    default:
      return { correct: false, achieved: 0, outOf: pts };
  }
}

function PointsChip({ q }) {
  return <span className="q-points">{Number(q.points) || 0} pkt</span>;
}

function TypeChip({ q }) {
  return (
    <span className={cn("q-chip", `q-type-${q.type}`)}>
      <Icon name={QTYPE_ICON[q.type]} size={12} />
      {questionTypeLabel(q.type)}
    </span>
  );
}

const QTYPE_ICON = { single: "radio", multiple: "checkbox2", truefalse: "toggle", match: "link", order: "sort", open: "pencil" };

export function StudentQuestion({ q, index, answer, onAnswer, disabled, reveal, answeredCorrect }) {
  const opts = q.options || [];
  const mark = reveal ? checkClosed(q, answer) : null;
  const wrong = mark && mark.correct === false;

  return (
    <div className={cn("sq", disabled && "sq-disabled", reveal && (mark?.correct === false ? "sq-wrong" : mark?.correct === true ? "sq-right" : mark?.open && "sq-mixed"))}>
      <div className="sq-head">
        <span className="sq-index">{index}</span>
        <TypeChip q={q} />
        <PointsChip q={q} />
        {reveal && mark && mark.correct != null && (
          <span className={cn("sq-verdict", mark.correct ? "ok" : "bad")}>
            <Icon name={mark.correct ? "checkCircle" : "x"} size={13} />
            {mark.correct ? "Prawidłowo" : "Błędnie"}
          </span>
        )}
      </div>
      <div className="sq-stem">{q.text}</div>

      <div className="sq-body">
        {q.type === "single" && (
          <div className="opt-list">
            {opts.map((o) => (
              <button
                key={o.id}
                className={cn("opt", answer === o.id && "sel",
                  reveal && o.correct && "correct", reveal && answer === o.id && !o.correct && "incorrect")}
                disabled={disabled}
                onClick={() => onAnswer(o.id)}
              >
                <span className="opt-dot">{answer === o.id && <span />}</span>
                {letter(opts.indexOf(o))}. {o.text}
                {reveal && o.correct && <Icon className="opt-mark" name="checkCircle" size={15} />}
              </button>
            ))}
          </div>
        )}

        {q.type === "multiple" && (
          <div className="opt-list">
            {opts.map((o) => {
              const sel = Array.isArray(answer) && answer.includes(o.id);
              return (
                <button
                  key={o.id}
                  className={cn("opt", sel && "sel",
                    reveal && o.correct && "correct", reveal && sel && !o.correct && "incorrect")}
                  disabled={disabled}
                  onClick={() => onAnswer(sel ? answer.filter((x) => x !== o.id) : [...(answer || []), o.id])}
                >
                  <span className="opt-check">{sel && <Icon name="check" size={12} />}</span>
                  {letter(opts.indexOf(o))}. {o.text}
                  {reveal && o.correct && <Icon className="opt-mark" name="checkCircle" size={15} />}
                </button>
              );
            })}
          </div>
        )}

        {q.type === "truefalse" && (
          <div className="tf-list">
            {[true, false].map((val) => (
              <button
                key={String(val)}
                className={cn("tf-btn", answer === val && "sel",
                  reveal && q.correct === val && "correct", reveal && answer === val && q.correct !== val && "incorrect")}
                disabled={disabled}
                onClick={() => onAnswer(val)}
              >
                <span className="tf-icon">{val ? <Icon name="check" size={16} /> : <Icon name="x" size={16} />}</span>
                {val ? "Prawda" : "Fałsz"}
              </button>
            ))}
          </div>
        )}

        {q.type === "match" && (
          <div className="match-list">
            {(q.pairs || []).map((p, i) => {
              const chosen = answer?.[p.id];
              const ok = reveal && chosen === p.right;
              return (
                <div key={p.id} className={cn("match-row", reveal && ok && "correct", reveal && chosen && !ok && "incorrect")}>
                  <span className="match-num">{i + 1}.</span>
                  <span className="match-prompt">{p.left}</span>
                  <span className="match-arrow"><Icon name="chevronRight" size={14} /></span>
                  <select
                    className={cn("select", chosen && "select-chosen")}
                    value={chosen || ""}
                    disabled={disabled}
                    onChange={(e) => onAnswer({ ...answer, [p.id]: e.target.value })}
                  >
                    <option value="">— wybierz —</option>
                    {[...q.pairs].sort((a, b) => a.right.localeCompare(b.right)).map((o) => (
                      <option key={o.id} value={o.right}>{letter((q.pairs || []).indexOf(o))}. {o.right}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}

        {q.type === "order" && (
          <div className="order-list">
            {((answer && answer.length) ? answer : q.sequence || []).map((item, i) => (
              <div key={item} className="order-row">
                <span className="order-grip"><Icon name="sort" size={14} /></span>
                <span className="order-pos">{i + 1}.</span>
                <span className="order-item">{item}</span>
                {!disabled && (
                  <span className="order-ctrl">
                    <button className="icon-btn sm" disabled={i === 0} onClick={() => onAnswer(swap2(answer, i, i - 1))}><Icon name="up" size={13} /></button>
                    <button className="icon-btn sm" disabled={i === answer.length - 1} onClick={() => onAnswer(swap2(answer, i, i + 1))}><Icon name="down" size={13} /></button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {q.type === "open" && (
          <textarea
            className="sq-textarea"
            rows={3}
            placeholder="Wpisz odpowiedź…"
            disabled={disabled}
            value={answer || ""}
            onChange={(e) => onAnswer(e.target.value)}
          />
        )}
      </div>

      {reveal && mark && (mark.note || mark.open) && (
        <div className={cn("sq-note", mark.open && "sq-note-open")}>
          {mark.open ? (
            <>Pytanie otwarte — oceniane przez nauczyciela.</>
          ) : (
            <>Niekompletna odpowiedź ({mark.achieved}/{mark.outOf} pkt).</>
          )}
        </div>
      )}
    </div>
  );
}

function swap2(arr, i, j) {
  if (!arr) return arr;
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function PaperQuestion({ q, index, version, showKey, answerMap }) {
  const opts = q.options || [];
  return (
    <div className="paper-q">
      <div className="paper-q-head">
        <span className="paper-q-num">{index}.</span>
        <PointsChip q={q} />
      </div>
      <div className="paper-q-text">{q.text}</div>

      {q.type === "single" && (
        <div className="paper-opts">
          {opts.map((o, i) => (
            <div key={o.id} className="paper-opt">
              <span className="paper-oval" />{letter(i)}. {o.text}
              {showKey && o.correct && <Icon className="paper-key-mark" name="checkCircle" size={13} />}
            </div>
          ))}
        </div>
      )}

      {q.type === "multiple" && (
        <div className="paper-opts">
          {opts.map((o, i) => (
            <div key={o.id} className="paper-opt">
              <span className="paper-box" />{letter(i)}. {o.text}
              {showKey && o.correct && <Icon className="paper-key-mark" name="checkCircle" size={13} />}
            </div>
          ))}
        </div>
      )}

      {q.type === "truefalse" && (
        <div className="paper-opts">
          <span className="paper-tf">P <span className="paper-box" /></span>
          <span className="paper-tf">F <span className="paper-box" /></span>
          {showKey && <span className="paper-key-tf">poprawna: {q.correct ? "P" : "F"}</span>}
        </div>
      )}

      {q.type === "match" && (
        <div className="paper-match">
          {(q.pairs || []).map((p, i) => (
            <div key={p.id} className="paper-match-row">
              <div className="paper-match-col-left">{i + 1}. {p.left}</div>
              <div className="paper-match-col-right">
                {[0, 1, 2].map((k) => <div key={k} className="paper-letter">·</div>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {q.type === "order" && (
        <div className="paper-order">
          <div className="paper-order-instr">Uporządkuj elementy — wpisz litery we właściwej kolejności: ___ ___ ___</div>
          {(q.sequence || []).map((s, i) => (
            <div key={s} className="paper-opt">
              <span className="paper-box" />{letter(i)}. {s}
            </div>
          ))}
        </div>
      )}

      {q.type === "open" && (
        <div className="paper-lines">{showKey ? <span className="paper-key-open">{q.model}</span> : <span />}</div>
      )}
    </div>
  );
}

export const PaperKeyLine = ({ q, index }) => {
  const opts = q.options || [];
  let answerText = "—";
  switch (q.type) {
    case "single": {
      const c = opts.find((o) => o.correct);
      answerText = letter(opts.indexOf(c)) + ". " + c?.text;
      break;
    }
    case "multiple": {
      const c = opts.filter((o) => o.correct).map((o) => letter(opts.indexOf(o)));
      answerText = c.join(", ") || "—";
      break;
    }
    case "truefalse":
      answerText = q.correct ? "Prawda" : "Fałsz";
      break;
    case "match":
      answerText = (q.pairs || []).map((p) => `1–${p.left}: ${p.right}`).join(" · ");
      break;
    case "order":
      answerText = (q.sequence || []).map((s, i) => `${i + 1}. ${s}`).join(" · ");
      break;
    case "open":
      answerText = q.model || "kryteria punktowania";
      break;
  }
  return (
    <div className="key-row">
      <span className="key-num">{index}.</span>
      <span className="key-answer">{answerText}</span>
      <span className="key-pts">{Number(q.points) || 0} pkt</span>
    </div>
  );
};

export function GradingQuestion({ q, index, studentAnswer, auto, onScore }) {
  const pts = Number(q.points) || 0;
  const isOpen = q.type === "open";
  const opts = q.options || [];

  return (
    <div className={cn("grad-q")}>
      <div className="grad-q-head">
        <div className="grad-q-left">
          <span className="sq-index">{index}</span>
          <div>
            <div className="sq-stem inl">{q.text}</div>
            <div className="grad-q-meta">
              <TypeChip q={q} /> <PointsChip q={q} />
              {!isOpen && <span className={cn("grad-auto", auto?.correct ? "ok" : auto?.partial ? "partial" : "bad")}>{auto?.correct ? "zaliczono" : auto?.partial ? "częściowo" : "nie zaliczono"}</span>}
            </div>
          </div>
        </div>
        <div className="grad-score">
          <SpanInp value={isOpen ? studentAnswer.achieved ?? 0 : studentAnswer.achieved ?? auto?.achieved ?? 0} max={pts} onChange={(v) => onScore(v)} disabled={!isOpen} />
        </div>
      </div>

      <div className="grad-q-body">
        {q.type === "single" && (
          <div className="opt-list ro">
            {opts.map((o) => (
              <div key={o.id} className={cn("opt", studentAnswer.picked === o.id && "sel",
                o.correct && "correct", studentAnswer.picked === o.id && !o.correct && "incorrect")}>
                <span className="opt-dot">{studentAnswer.picked === o.id && <span />}</span>
                {letter(opts.indexOf(o))}. {o.text}
              </div>
            ))}
          </div>
        )}
        {q.type === "multiple" && (
          <div className="opt-list ro">
            {opts.map((o) => (
              <div key={o.id} className={cn("opt", Array.isArray(studentAnswer.picked) && studentAnswer.picked.includes(o.id) && "sel",
                o.correct && "correct")}>
                <span className="opt-check"><Icon name="check" size={12} /></span>
                {letter(opts.indexOf(o))}. {o.text}
              </div>
            ))}
          </div>
        )}
        {q.type === "truefalse" && (
          <div className="opt-list ro">
            {[true, false].map((val) => (
              <div key={String(val)} className={cn("opt", studentAnswer.picked === val && "sel",
                q.correct === val && "correct", studentAnswer.picked === val && q.correct !== val && "incorrect")}>
                <span className="opt-dot">{studentAnswer.picked === val && <span />}</span>
                {val ? "Prawda" : "Fałsz"}
              </div>
            ))}
          </div>
        )}
        {q.type === "match" && (
          <div className="match-list ro">
            {(q.pairs || []).map((p, i) => (
              <div key={p.id} className={cn("match-row", studentAnswer.pairs?.[p.id] === p.right && "correct", studentAnswer.pairs?.[p.id] && studentAnswer.pairs[p.id] !== p.right && "incorrect")}>
                <span className="match-num">{i + 1}.</span>
                <span className="match-prompt">{p.left}</span>
                <span className="match-arrow"><Icon name="chevronRight" size={14} /></span>
                <span className="grad-matched">{studentAnswer.pairs?.[p.id] || "—"}</span>
              </div>
            ))}
          </div>
        )}
        {q.type === "order" && (
          <div className="order-list ro">
            {(q.sequence || []).map((s, i) => {
              const given = studentAnswer.picked?.[i];
              return (
                <div key={s} className={cn("order-row", given === s && "correct")}>
                  <span className="order-pos">{i + 1}.</span>
                  <span className="order-item">{given || "—"} {given !== s && <em>powinno: {s}</em>}</span>
                </div>
              );
            })}
          </div>
        )}
        {q.type === "open" && (
          <div className="grad-open">
            <div className="grad-open-label">
              <Icon name="pencil" size={14} /> Odpowiedź ucznia
            </div>
            <blockquote className="grad-open-text">{studentAnswer.answer || "—"}</blockquote>
            {q.model && (
              <div className="grad-model"><strong>Model odpowiedzi:</strong> {q.model}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function SpanInp({ value, max, onChange, disabled, className }) {
  return (
    <div className={cn("span-inp", className)}>
      <input
        type="number"
        min={0}
        max={max}
        value={value ?? 0}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
      />
      <span>/{max}</span>
    </div>
  );
}

export const blankAnswer = (q) => {
  switch (q.type) {
    case "single": return null;
    case "multiple": return [];
    case "truefalse": return null;
    case "match": return {};
    case "order": return q.sequence ? [...q.sequence] : [];
    case "open": return "";
    default: return null;
  }
};

export const useAutoGrade = (questions, answers) =>
  useMemo(() => {
    let score = 0, max = 0;
    const per = {};
    questions.forEach((q) => {
      const res = checkClosed(q, answers[q.id]);
      max += res.outOf;
      if (res.open) return;
      score += res.achieved;
      per[q.id] = res;
    });
    return { score, max, per };
  }, [questions, answers]);
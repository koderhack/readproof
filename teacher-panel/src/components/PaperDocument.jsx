import React from "react";
import { cn } from "../lib/utils.js";
import { PaperQuestion, PaperKeyLine } from "./QuestionRenderers.jsx";

function seededRng(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = seededRng(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function makeVersion(test, version) {
  const source = Array.isArray(test?.questions) ? test.questions : [];
  if (version === "A") return source;
  const seed = `${test?.id || "draft-preview"}-${version}`;
  const shuffled = seededShuffle(source, seed);
  return shuffled.map((question) => {
    if (question.type === "single" || question.type === "multiple") {
      const options = Array.isArray(question.options) ? question.options : [];
      const perm = seededShuffle(options.map((option) => option.id), seed + question.id);
      return { ...question, options: perm.map((id) => options.find((option) => option.id === id)).filter(Boolean) };
    }
    if (question.type === "match") {
      const pairs = seededShuffle(Array.isArray(question.pairs) ? question.pairs : [], seed + question.id);
      return { ...question, pairs: pairs.map((pair) => ({ ...pair, right: shuffleLabel(String(pair.right || ""), seed + pair.id) })) };
    }
    if (question.type === "order") {
      return { ...question, sequence: seededShuffle(Array.isArray(question.sequence) ? question.sequence : [], seed + question.id) };
    }
    return question;
  });
}

function shuffleLabel(text, seed) {
  const words = text.split(" ");
  if (words.length < 2) return text;
  return seededShuffle(words, seed).join(" ");
}

export function PaperDocument({ test, version = "A", showKey = false, compact }) {
  const questions = makeVersion(test, version);
  const max = questions.reduce((s, q) => s + (Number(q.points) || 0), 0);

  return (
    <div className={cn("print-page", compact && "print-page-compact")} id={`paper-${version}`}>
      <div className="print-header">
        <div className="print-school">Szkoła Podstawowa nr 12 w Krakowie</div>
        <div className="print-title">{test.name}</div>
        <div className="print-sub">Wersja {version} · Czas rozwiązania: {test.time} min · Maksymalnie: {max} pkt · Klasa: <span className="print-class">{testClassLabel(test)}</span></div>
      </div>

      <div className="print-meta-row">
        <div className="print-field">Imię i nazwisko: <span className="print-line" /></div>
        <div className="print-field">Numer ucznia: <span className="print-line short" /></div>
        <div className="print-field">Data: <span className="print-line short" /></div>
      </div>

      <div className="print-instr">
        Przeczytaj uważnie każde pytanie. Odpowiedzi w pytaniach zamkniętych zaznacz wyraźnie,
        a w otwartych wpisz zwięzłą odpowiedź w wyznaczonym miejscu. Powodzenia!
      </div>

      <div className="print-body">
        {questions.map((q, i) => (
          <PaperQuestion key={q.id} q={q} index={i + 1} showKey={showKey} />
        ))}
      </div>

      <div className="print-foot">
        <div className="print-score-row">
          <span>Zdobyte punkty: <span className="print-line short" /></span>
          <span>Ocena: <span className="print-line short" /></span>
          <span>Podpis: <span className="print-line short" /></span>
        </div>
      </div>
    </div>
  );
}

export function PaperKey({ test, version = "A" }) {
  const questions = makeVersion(test, version);
  return (
    <div className="print-page key-page" id={`key-${version}`}>
      <div className="print-header">
        <div className="print-title">Klucz odpowiedzi — {test.name}</div>
        <div className="print-sub">Wersja {version} · tylko dla nauczyciela</div>
      </div>
      <div className="key-body">
        {questions.map((q, i) => (
          <PaperKeyLine key={q.id} q={q} index={i + 1} />
        ))}
      </div>
    </div>
  );
}

export function testClassLabel(test) {
  return test.className || test.classId || "—";
}
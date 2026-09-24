import { uid } from "./utils.js";

export const API_BASES = ["https://frog02-32287.wykr.es"];

const DEMO_WALLET = "DemoNauczyciel-panel";

export function getTeacherWallet() {
  try {
    const raw =
      localStorage.getItem("rp_teacher_wallet") ||
      localStorage.getItem("rp_app_wallet") ||
      DEMO_WALLET;
    return (raw || "").trim() || DEMO_WALLET;
  } catch {
    return DEMO_WALLET;
  }
}

export function setTeacherWallet(w) {
  try {
    if (w && w.trim()) localStorage.setItem("rp_teacher_wallet", w.trim());
    else localStorage.removeItem("rp_teacher_wallet");
  } catch {
    /* ignore */
  }
}

const scopeRe = /\/api\/(classes|teacher|student)/;

export async function api(path, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-Lang": "pl",
    "X-User-Id": getTeacherWallet(),
    ...(opts.headers || {}),
  };

  let p = path;
  if (scopeRe.test(p) && !/\b(teacher|wallet)=/.test(p)) {
    p += (p.includes("?") ? "&" : "?") + "teacher=" + encodeURIComponent(getTeacherWallet());
  }

  const init = {
    method: opts.method || "GET",
    headers,
    body: opts.body ? opts.body : undefined,
  };

  let lastErr = null;
  for (const base of API_BASES) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(base + p, init);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data.error || "Błąd HTTP " + response.status);
          error.status = response.status;
          if (![502, 503, 504].includes(response.status) || attempt === 2) throw error;
          throw Object.assign(error, { retryable: true });
        }
        return data;
      } catch (error) {
        lastErr = error;
        const retryable = !error?.status || error.retryable;
        if (!retryable || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr || new Error("Backend nie odpowiada");
}

const orderSequence = (c) => {
  const items = (c.items || []).map((x) => String(x));
  const order = c.correctOrder || items.map((_, i) => i);
  const seq = order.map((i) => items[Number(i)]).filter((x) => x !== undefined);
  return seq.length ? seq : items;
};

export function fromBackendQuestion(c) {
  const sid = String(c.id || uid("q") || "q");
  const id = sid;
  const base = { id, chapterId: String(c.chapterId || ""), text: String(c.question || c.text || "").trim(), points: Number(c.points) || 1 };
  switch (String(c.type)) {
    case "multiple_choice":
    case "what_next":
      return {
        ...base,
        type: "single",
        options: (c.options || []).map((t, i) => ({
          id: i + "-" + sid,
          text: String(t),
          correct: Number(c.correctAnswer) === i,
        })),
      };
    case "multiple_select":
      return {
        ...base,
        type: "multiple",
        options: (c.options || []).map((t, i) => ({
          id: i + "-" + sid,
          text: String(t),
          correct: (c.correctAnswers || []).includes(Number(i)),
        })),
      };
    case "true_false":
    case "statement":
      return { ...base, type: "truefalse", correct: Number(c.correctAnswer) === 0 };
    case "open_question":
    case "why_question":
      return { ...base, type: "open", model: String(c.expectedMeaning || c.answer || "") };
    case "ordering":
    case "ranking":
      return { ...base, type: "order", sequence: orderSequence(c) };
    case "who_said":
    case "match":
      return {
        ...base,
        type: "match",
        pairs: (c.pairs || []).map((p, i) => ({
          id: "m" + i + "-" + sid,
          left: String(p.left || ""),
          right: String(p.right || ""),
        })),
      };
    case "find_error":
      return {
        ...base,
        type: "single",
        options: (c.options || []).map((t, i) => ({
          id: i + "-" + sid,
          text: String(t),
          correct: Number(c.errorIndex) === i,
        })),
      };
    default:
      return { ...base, type: "open" };
  }
}

export function toBackendQuestion(q) {
  const enc = String(q.id || uid("q"));
  const text = String(q.text || "").trim();
  if (!text) return null;
  switch (q.type) {
    case "single": {
      const opts = (q.options || []).map((o) => String(o.text || "").trim());
      const clean = opts.filter(Boolean);
      const idx = (q.options || []).findIndex((o) => o.correct);
      if (!clean.length || idx < 0) return null;
      return { id: enc, type: "multiple_choice", question: text, options: clean, correctAnswer: idx };
    }
    case "multiple": {
      const opts = (q.options || []).map((o) => String(o.text || "").trim());
      const clean = opts.filter(Boolean);
      const cis = (q.options || []).map((o, i) => (i < clean.length && o.correct ? i : -1)).filter((i) => i >= 0);
      if (!clean.length || !cis.length) return null;
      return { id: enc, type: "multiple_select", question: text, options: clean, correctAnswers: cis };
    }
    case "truefalse":
      return { id: enc, type: "true_false", question: text, correctAnswer: q.correct ? 0 : 1 };
    case "open":
      return q.model && String(q.model).trim()
        ? { id: enc, type: "open_question", question: text, expectedMeaning: String(q.model).trim() }
        : null;
    case "match": {
      const pairs = (q.pairs || []).filter((p) => String(p.left || "").trim() && String(p.right || "").trim());
      if (!pairs.length) return null;
      return {
        id: enc,
        type: "match",
        question: text,
        pairs: pairs.map((p) => ({ id: String(p.id || uid("m")), left: String(p.left).trim(), right: String(p.right).trim() })),
      };
    }
    case "order": {
      const items = (q.sequence || []).map((s) => String(s).trim()).filter(Boolean);
      if (items.length < 2) return null;
      return { id: enc, type: "ordering", question: text, items, correctOrder: items.map((_, i) => i) };
    }
    default:
      return null;
  }
}

export const codeOf = (challengeId) => {
  const s = String(challengeId || "");
  const short = s.slice(-5).replace(/[^A-Z0-9]/gi, "").toUpperCase() || "0";
  return "TEST-" + short;
};

export function toApiTest(test) {
  const questions = (test.questions || [])
    .map((question) => {
      const converted = toBackendQuestion(question);
      return converted ? { ...converted, chapterId: String(question.chapterId || test.chapterId || test.chapter || "") } : null;
    })
    .filter(Boolean);
  const chapters = [...new Set(questions.map((question) => question.chapterId).filter(Boolean))];
  return {
    bookId: test.bookId,
    title: String(test.name || "").trim(),
    chapter: test.scope === "book" ? "" : test.chapterId || test.chapter || "",
    chapters,
    certificateScope: test.scope === "book" ? "book" : "chapter",
    testMode: String(test.type || "virtual").toUpperCase(),
    timerEnabled: !!Number(test.time),
    timerMinutes: Number(test.time) || 0,
    questions,
  };
}

export function fromApiTest(ch, books = []) {
  const book = books.find((b) => String(b.id) === String(ch.bookId));
  const chapter = book && (book.chapters || []).find((c) => String(c.id) === String(ch.chapter));
  const chapterTitle =
    ch.chapterTitle ||
    (chapter && (chapter.title || chapter.id)) ||
    (book && String(book.chapter) === String(ch.chapter) ? book.chapter : "") ||
    "";
  const status =
    String(ch.status) === "active"
      ? "published"
      : String(ch.status) === "closed"
        ? "checked"
        : "draft";
  const id = String(ch.id);
  const questions = (ch.questions || []).map(fromBackendQuestion);
  const total = questions.reduce((s, q) => s + (Number(q.points) || 0), 0);
  return {
    id,
    name: String(ch.title || ch.name || "Test"),
    subject: "Język polski",
    classId: "",
    topic: chapterTitle,
    time: Number(ch.timerMinutes) || 0,
    deadline: ch.dueDate || "",
    type: String(ch.testMode || "VIRTUAL").toLowerCase(),
    status,
    code: codeOf(id),
    link: "https://readproof.pages.dev/app/#/student",
    avg: "—",
    publishedAt: ch.createdAt ? String(ch.createdAt).slice(0, 10) : "",
    participants: [],
    questions,
    questionCount: questions.length,
    totalPoints: total,
    bookId: ch.bookId,
    chapter: ch.chapter,
    chapters: ch.chapters || ch.settings?.chapters || (ch.chapter ? [ch.chapter] : []),
    scope: ch.settings?.scope || ch.certificateScope || "chapter",
    challengeId: id,
  };
}

const CLASS_COLORS = ["#1B5E3B", "#173A8A", "#2456C8", "#B98A2F", "#173A8A", "#7F3A0D"];

export const classColor = (name) => {
  const h = String(name || "").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return CLASS_COLORS[h % CLASS_COLORS.length];
};

export function fromApiClass(cls) {
  const students = cls.students || [];
  return {
    id: String(cls.id),
    name: String(cls.name || "Klasa"),
    year: "2025/2026",
    students: students.length,
    code: String(cls.id),
    color: classColor(String(cls.name || "")),
    bookId: cls.bookId,
    chapters: cls.chapters || [],
    _rawStudents: students,
  };
}

export function fromApiStudent(s, classId) {
  const raw = String(s.displayName || s.name || "").trim();
  const [firstName, ...rest] = raw.split(/\s+/);
  return {
    id: String(s.walletAddress || uid("s")),
    firstName: firstName || "Uczeń",
    lastName: rest.join(" ") || "—",
    classId: String(classId),
  };
}

export function fromApiProof(p) {
  const ch = p.chapter || {};
  return {
    id: String(p.id || uid("w")),
    title: String(ch.title || "Dowód"),
    status: "passed",
    timestamp: String(p.createdAt || p.timestamp || ""),
  };
}
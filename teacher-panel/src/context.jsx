import React, { createContext, useContext, useMemo, useState, useEffect, useCallback } from "react";
import {
  api,
  getTeacherWallet,
  setTeacherWallet,
  fromApiTest,
  toApiTest,
  fromApiClass,
  fromApiStudent,
  fromApiProof,
  codeOf,
} from "./lib/api.js";
import { gradeFromPercent, uid } from "./lib/utils.js";

const AppContext = createContext(null);

export const useApp = () => useContext(AppContext);

const readClassMap = () => {
  try {
    return JSON.parse(localStorage.getItem("rp_test_classes") || "{}");
  } catch {
    return {};
  }
};

export function AppProvider({ children }) {
  const [tests, setTests] = useState([]);
  const [results, setResults] = useState([]);
  const [classes, setClasses] = useState([]);
  const [students, setStudents] = useState([]);
  const [activities, setActivities] = useState([]);
  const [proofs, setProofs] = useState([]);
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState({ name: "dashboard", params: {} });
  const [toasts, setToasts] = useState([]);

  const navigate = (name, params = {}) => {
    setView({ name, params });
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  const toast = (message, tone = "success") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [booksJ, classesJ, challengesJ, proofsJ] = await Promise.all([
        api("/api/books").catch(() => ({ books: [] })),
        api("/api/classes").catch(() => ({ classes: [] })),
        api("/api/teacher/challenges").catch(() => ({ challenges: [] })),
        api("/api/proofs").catch(() => ({ proofs: [] })),
      ]);

      const bk = Array.isArray(booksJ) ? booksJ : booksJ.books || [];
      setBooks(bk);

      const cls = (classesJ && classesJ.classes ? classesJ.classes : []).map(fromApiClass);
      setClasses(cls.map((c) => ({ ...c, _rawStudents: undefined })));

      const flat = [];
      cls.forEach((c) => (c._rawStudents || []).forEach((s) => flat.push(fromApiStudent(s, c.id))));
      setStudents(flat);

      const chs = (challengesJ && challengesJ.challenges ? challengesJ.challenges : []) || [];
      const testsFromApi = [];
      const classMap = readClassMap();
      for (const ch of chs) {
        let full = ch;
        try {
          const f = await api("/api/teacher/challenges/" + encodeURIComponent(ch.id));
          if (f && f.challenge) full = f.challenge;
        } catch {
          /* zostajemy przy pozycji z listy */
        }
        const t = fromApiTest(full, bk);
        if (classMap[t.challengeId || t.id]) t.classId = classMap[t.challengeId || t.id];
        testsFromApi.push(t);
      }
      setTests(testsFromApi);
      setProofs((proofsJ && proofsJ.proofs ? proofsJ.proofs : []).map(fromApiProof));

      const res = [];
      const byId = {};
      testsFromApi.forEach((t) => {
        byId[t.challengeId || t.id] = t;
      });
      for (const ch of chs) {
        try {
          const rj = await api(
            "/api/teacher/challenges/" + encodeURIComponent(ch.id) + "/results"
          );
          const rows = (rj && rj.results) || [];
          rows.forEach((r) => {
            const date = String(r.completedAt || r.submittedAt || r.createdAt || "").slice(0, 10);
            if (String(r.status) === "pending") {
              res.push({
                id: String(r.attemptId || uid("r")),
                testId: String(ch.id),
                studentId: String(r.studentId || ""),
                studentName: String(r.studentName || "Uczeń"),
                form: String(r.mode || "PAPER").toLowerCase(),
                date,
                status: "waiting",
                score: null,
                maxScore: Number(r.maxScore) || null,
                percent: null,
                grade: null,
                attemptId: String(r.attemptId || ""),
                comment: "",
              });
              return;
            }
            res.push({
              id: String(r.attemptId || uid("r")),
              testId: String(ch.id),
              studentId: String(r.studentId || ""),
              studentName: String(r.studentName || "Uczeń"),
              form: String(r.mode || "VIRTUAL").toLowerCase(),
              date: String(r.completedAt || r.submittedAt || "").slice(0, 10),
              status: "graded",
              score: Number(r.score) || 0,
              maxScore: Number(r.maxScore) || 0,
              percent: Number(r.pct),
              grade: gradeFromPercent(Number(r.pct)),
              comment: String(r.comment || ""),
            });
          });
        } catch {
          /* pomijamy test bez wyników */
        }
      }
      res.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      setResults(res);

      const act = [];
      testsFromApi.forEach((t) => {
        if (t.status === "published" && t.publishedAt) {
          act.push({
            id: "ap" + t.challengeId,
            type: "published",
            text: `Opublikowano test „${t.name}”`,
            time: t.publishedAt || "",
            testId: t.challengeId || t.id,
          });
        }
      });
      res.forEach((r) => {
        const t = byId[r.testId];
        act.push({
          id: "ar" + r.id,
          type: "result",
          text: `${r.studentName} zakończył(a) test „${t ? t.name : "—"}” (${r.percent}%)`,
          time: r.date || "",
          testId: r.testId,
          studentId: r.studentId,
        });
      });
      act.sort((a, b) => String(b.time).localeCompare(String(a.time)));
      setActivities(act.slice(0, 12));
    } catch (e) {
      toast("Nie udało się połączyć z backendem: " + e.message, "info");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const syncClasses = async () => {
      try {
        const response = await api("/api/classes");
        const next = (response?.classes || []).map(fromApiClass);
        setClasses(next.map((item) => ({ ...item, _rawStudents: undefined })));
        const flat = [];
        next.forEach((item) => (item._rawStudents || []).forEach((student) => flat.push(fromApiStudent(student, item.id))));
        setStudents(flat);
      } catch {
        return;
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") syncClasses();
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  const saveTest = async (test) => {
    const challengeId = test.challengeId || test.id;
    const exists =
      challengeId && (challengeId.startsWith("t") === false || tests.some((t) => t.challengeId === challengeId));
    const body = toApiTest(test);
    try {
      const r = exists
        ? await api("/api/teacher/challenges/" + encodeURIComponent(challengeId), {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : await api("/api/teacher/challenges", {
            method: "POST",
            body: JSON.stringify(body),
          });
      const ch = r && (r.challenge || r.test) ? r.challenge || r.test : null;
      if (test.classId && ch) {
        try {
          const m = readClassMap();
          m[String(ch.id)] = test.classId;
          localStorage.setItem("rp_test_classes", JSON.stringify(m));
        } catch {
          /* ignore */
        }
      }
      await refresh();
      return ch;
    } catch (e) {
      toast("Zapisywanie testu nie powiodło się: " + e.message, "info");
      throw e;
    }
  };

  const publishTest = async (test, formType) => {
    const ch = await saveTest({ ...test, status: "published" });
    if (!ch) {
      toast("Nie udało się utworzyć testu.", "info");
      return null;
    }
    try {
      await api("/api/teacher/challenges/" + encodeURIComponent(ch.id) + "/activate", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (e) {
      toast("Test utworzony, ale aktywacja się nie powiodła: " + e.message, "info");
    }
    await refresh();
    return fromApiTest(ch, books);
  };

  const activateTest = async (test) => {
    const id = test.challengeId || test.id;
    try {
      await api("/api/teacher/challenges/" + encodeURIComponent(id) + "/activate", {
        method: "POST",
        body: JSON.stringify({}),
      });
      await refresh();
      toast("Test opublikowany. Kod wejścia: " + codeOf(id), "success");
      return true;
    } catch (e) {
      toast("Aktywacja nie powiodła się: " + e.message, "info");
      return false;
    }
  };

  const closeTest = async (test) => {
    const id = test.challengeId || test.id;
    try {
      await api("/api/teacher/challenges/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ status: "closed" }),
      });
      await refresh();
      toast("Test zamknięty.", "success");
    } catch (e) {
      toast("Zamykanie nie powiodło się: " + e.message, "info");
    }
  };

  const deleteTest = async (test) => {
    const id = test.challengeId || test.id;
    try {
      await api("/api/teacher/challenges/" + encodeURIComponent(id), { method: "DELETE" });
      await refresh();
      toast("Test usunięty.", "success");
      return true;
    } catch (e) {
      toast("Usuwanie nie powiodło się: " + e.message, "info");
      return false;
    }
  };

  const duplicateTest = async (test) => {
    try {
      const copy = { ...test, id: uid("t"), challengeId: null, name: test.name + " (kopia)" };
      const ch = await saveTest(copy);
      toast("Test zduplikowany.", "success");
      return ch;
    } catch (e) {
      toast("Duplikowanie nie powiodło się.", "info");
      return null;
    }
  };

  const createClass = async (name) => {
    try {
      const r = await api("/api/classes", {
        method: "POST",
        body: JSON.stringify({ name, teacher: getTeacherWallet() }),
      });
      await refresh();
      toast(`Utworzono klasę „${name}”. Kod: ${r.class ? r.class.id : ""}`, "success");
      return r.class;
    } catch (e) {
      toast("Tworzenie klasy nie powiodło się: " + e.message, "info");
      return null;
    }
  };

  return (
    <AppContext.Provider
      value={useMemo(
        () => ({
          tests,
          results,
          classes,
          students,
          activities,
          proofs,
          books,
          loading,
          view,
          navigate,
          toasts,
          toast,
          saveTest,
          publishTest,
          activateTest,
          closeTest,
          deleteTest,
          duplicateTest,
          createClass,
          getTeacherWallet,
          setTeacherWallet,
          refresh,
        }),
        [tests, results, classes, students, activities, proofs, books, loading, view, toasts]
      )}
    >
      {children}
    </AppContext.Provider>
  );
}
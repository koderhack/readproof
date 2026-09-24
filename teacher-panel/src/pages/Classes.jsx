import React, { useMemo, useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Btn, EmptyState, Modal, PageHeader } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { cn } from "../lib/utils.js";

export function Classes() {
  const { classes, students, tests, results, createClass, navigate, toast } = useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [manageId, setManageId] = useState(null);
  const [newName, setNewName] = useState("");

  const classStudents = (id) => students.filter((s) => s.classId === id);
  const classAvg = (id) => {
    const tids = tests.filter((t) => t.classId === id && t.challengeId).map((t) => t.challengeId || t.id);
    const rs = results.filter((r) => tids.includes(r.testId) && r.status === "graded");
    const graded = rs.filter((r) => r.percent != null);
    return graded.length ? Math.round(graded.reduce((s, r) => s + r.percent, 0) / graded.length) : null;
  };
  const classTests = (id) => tests.filter((t) => t.classId === id);

  const maxStudents = Math.max(1, ...classes.map((c) => classStudents(c.id).length));

  const handleCreate = () => {
    if (!newName.trim()) return;
    createClass(newName.trim().toUpperCase());
    setCreateOpen(false);
    setNewName("");
  };

  const managed = classes.find((c) => c.id === manageId);
  const managedStudents = managed ? classStudents(managed.id) : [];

  return (
    <div className="page">
      <PageHeader
        title="Klasy"
        subtitle="Zarządzaj oddziałami, kodami dostępu i wynikami."
        actions={<Btn icon="plus" onClick={() => setCreateOpen(true)}>Utwórz klasę</Btn>}
      />

      <div className="classes-grid">
        {classes.map((c) => {
          const st = classStudents(c.id);
          const avg = classAvg(c.id);
          const ts = classTests(c.id);
          return (
            <div key={c.id} className="card class-card">
              <div className="class-card-head">
                <span className="class-badge" style={{ background: c.color }}>{c.name}</span>
                <div className="class-code"><Icon name="code" size={13} /> KLA-{c.code}</div>
              </div>
              <div className="class-stats">
                <div><strong>{st.length}</strong><span>uczniów</span></div>
                <div><strong>{ts.length}</strong><span>testów</span></div>
                <div><strong className={avg == null ? "dim" : avg >= 70 ? "good" : avg >= 50 ? "mid" : "bad"}>{avg == null ? "—" : `${avg}%`}</strong><span>śr. wynik</span></div>
              </div>
              <div className="class-bars">
                {st.slice(0, 12).map((s, i) => (
                  <div key={s.id} className="class-bar" style={{ height: `${Math.max(20, ((st.length - i) / maxStudents) * 100)}%`, background: c.color }} title={`${s.firstName} ${s.lastName}`} />
                ))}
              </div>
              <div className="class-acts">
                <Btn variant="secondary" size="sm" icon="users" onClick={() => setManageId(c.id)}>Uczniowie</Btn>
                <Btn variant="ghost" size="sm" icon="chart" onClick={() => navigate("results")}>Wyniki</Btn>
              </div>
            </div>
          );
        })}

        <button className="new-class-teaser" onClick={() => setCreateOpen(true)}>
          <span className="nc-ic"><Icon name="plus" size={20} /></span>
          <strong>Nowa klasa</strong>
          <span>Utwórz oddział i wygeneruj kod dołączenia</span>
        </button>
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Utwórz klasę"
        footer={
          <>
            <Btn variant="secondary" onClick={() => setCreateOpen(false)}>Anuluj</Btn>
            <Btn icon="plus" onClick={handleCreate} disabled={!newName.trim()}>Utwórz</Btn>
          </>
        }
      >
        <label className="field">
          <span className="field-label">Nazwa klasy</span>
          <input className="input" placeholder="np. 8A" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </label>
        <p className="modal-hint">Po utworzeniu wygenerujemy unikalny kod klasy, który przekażesz uczniom (ekran dołączenia w aplikacji).</p>
      </Modal>

      <Modal
        open={!!managed}
        onClose={() => setManageId(null)}
        title={managed ? `Klasa ${managed.name} — uczniowie` : ""}
        width={640}
        footer={<Btn variant="secondary" icon="x" onClick={() => setManageId(null)}>Zamknij</Btn>}
      >
        <div className="manage-students">
          <div className="manage-section">
            <div className="manage-section-title">Uczniowie w klasie ({managedStudents.length})</div>
            {managedStudents.length === 0 ? (
              <p className="dim pad">Klasa jest pusta. Uczniowie dołączają kodem klasy {managed ? `KLA-${managed.code}` : ""} w aplikacji.</p>
            ) : (
              <div className="manage-list">
                {managedStudents.map((s) => (
                  <div key={s.id} className="manage-row">
                    <Avatar student={s} size={28} />
                    <span>{s.firstName} {s.lastName}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => navigate("student", { studentId: s.id })}><Icon name="eye" size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
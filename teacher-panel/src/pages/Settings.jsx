import React, { useState } from "react";
import { useApp } from "../context.jsx";
import { Avatar, Btn, PageHeader, Toggle } from "../components/ui.jsx";
import { Icon } from "../lib/icons.jsx";
import { getTeacherWallet, setTeacherWallet, API_BASES } from "../lib/api.js";

export function Settings() {
  const { toast } = useApp();
  const [profile, setProfile] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("rp_teacher_profile") || "{}");
    } catch {
      return {};
    }
  });
  const [wallet, setWallet] = useState(getTeacherWallet());
  const [prefs, setPrefs] = useState({
    autoCheck: true,
    notifyJoin: true,
    notifyGrade: true,
    notifyDigest: false,
    lockAfterDeadline: true,
    showPercentToStudents: true,
  });

  const toggle = (k) => setPrefs((p) => ({ ...p, [k]: !p[k] }));

  const save = () => {
    try {
      localStorage.setItem("rp_teacher_profile", JSON.stringify(profile));
      setTeacherWallet(wallet);
    } catch {
      /* ignore */
    }
    toast("Zapisano profil i identyfikator nauczyciela");
  };

  const logout = () => {
    setTeacherWallet("");
    setWallet(getTeacherWallet());
    toast("Wylogowano portfel — używany jest domyślny identyfikator demo", "info");
  };

  const pname = profile.name || "Nauczyciel (demo)";
  const avatarName = { firstName: String(pname).split(" ")[0], lastName: String(pname).split(" ")[1] || "" };

  return (
    <div className="page settings-page">
      <PageHeader title="Ustawienia" subtitle="Profil, identyfikator nauczyciela i domyślne zachowania testów." />

      <div className="settings-layout">
        <div className="settings-form">
          <section className="card">
            <div className="card-head"><div><h3>Profil nauczyciela</h3><p>Dane widoczne dla uczniów i rodziców.</p></div></div>
            <div className="settings-avatar-row">
              <Avatar student={avatarName} size={64} />
              <div>
                <Btn variant="secondary" size="sm" icon="upload">Zmień zdjęcie</Btn>
                <p className="dim small">PNG lub JPG, max 2 MB</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field"><span className="field-label">Stopień i imię</span><input className="input" value={profile.title || "mgr"} onChange={(e) => setProfile({ ...profile, title: e.target.value })} /></label>
              <label className="field"><span className="field-label">Imię i nazwisko</span><input className="input" value={profile.name || ""} placeholder="np. Jan Kowalski" onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></label>
              <label className="field"><span className="field-label">Email</span><input className="input" value={profile.email || ""} placeholder="np. j.kowalski@sp12.edu.pl" onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
              <label className="field"><span className="field-label">Przedmiot</span><input className="input" value="Język polski" readOnly /></label>
            </div>
            <div className="settings-save"><Btn icon="check" onClick={save}>Zapisz zmiany</Btn></div>
          </section>

          <section className="card">
            <div className="card-head"><div><h3>Połączenie z backendem</h3><p>Twój panel działa na danych z serwera ReadProof.</p></div></div>
            <label className="field">
              <span className="field-label">Identyfikator nauczyciela (wallet)</span>
              <input className="input" value={wallet} onChange={(e) => setWallet(e.target.value)} />
              <span className="field-hint">
                Wysyłany jako nagłówek <code>X-User-Id</code> i parametr <code>teacher</code>. Testy będą widoczne tylko pod tym identyfikatorem.
              </span>
            </label>
            <div className="settings-save"><Btn icon="check" onClick={save}>Zapisz identyfikator</Btn></div>
            <div className="about-row mt"><Icon name="zap" size={15} /><div><strong>Adresy API</strong><span>{API_BASES[0]}{API_BASES[1] ? ` · ${API_BASES[1]}` : ""}</span></div></div>
          </section>

          <section className="card">
            <div className="card-head"><div><h3>Testy</h3><p>Domyślne zachowania dla nowych testów.</p></div></div>
            <div className="toggle-list">
              <ToggleRow icon="zap" title="Automatyczne sprawdzanie zamkniętych" desc="Wyniki pytań zamkniętych bez Twojego udziału" checked={prefs.autoCheck} onChange={() => toggle("autoCheck")} />
              <ToggleRow icon="lock" title="Blokada po terminie" desc="Uczeń nie otworzy testu po wyznaczonym terminie" checked={prefs.lockAfterDeadline} onChange={() => toggle("lockAfterDeadline")} />
              <ToggleRow icon="eye" title="Uczniowie widzą wynik procentowy" desc="Po zakończeniu testu wirtualnego" checked={prefs.showPercentToStudents} onChange={() => toggle("showPercentToStudents")} />
            </div>
            <div className="settings-save"><Btn icon="check" onClick={save}>Zapisz zmiany</Btn></div>
          </section>

          <section className="card">
            <div className="card-head"><div><h3>Powiadomienia</h3><p>Kiedy ReadProof ma nam przypominać.</p></div></div>
            <div className="toggle-list">
              <ToggleRow icon="link" title="Uczeń dołącza do testu" desc="Poinformuj mnie o rozpoczęciu testu wirtualnego" checked={prefs.notifyJoin} onChange={() => toggle("notifyJoin")} />
              <ToggleRow icon="checkCircle" title="Wystawienie oceny" desc="Potwierdzenie zapisanych ocen" checked={prefs.notifyGrade} onChange={() => toggle("notifyGrade")} />
              <ToggleRow icon="bell" title="Dzienny raport" desc="Podsumowanie aktywności klas każdego wieczoru" checked={prefs.notifyDigest} onChange={() => toggle("notifyDigest")} />
            </div>
            <div className="settings-save"><Btn icon="check" onClick={save}>Zapisz zmiany</Btn></div>
          </section>

          <section className="card danger-zone">
            <div className="card-head"><div><h3>Strefa niebezpieczna</h3><p>Ważne operacje — ostrożnie.</p></div></div>
            <div className="dz-row">
              <div><strong>Wyloguj portfel</strong><p>Wróć do domyślnego identyfikatora demo na tym urządzeniu.</p></div>
              <Btn variant="danger" icon="x" onClick={logout}>Wyloguj</Btn>
            </div>
            <div className="dz-row">
              <div><strong>Eksport wszystkich wyników</strong><p>Pobierz kompletny CSV z całego roku.</p></div>
              <Btn variant="secondary" icon="download" onClick={() => toast("Przygotowano plik CSV z wynikami")}>Eksportuj</Btn>
            </div>
          </section>
        </div>

        <aside className="settings-side">
          <div className="card">
            <div className="card-head"><div><h3>O aplikacji</h3></div></div>
            <div className="about-row"><Icon name="book" size={15} /><div><strong>ReadProof — Panel nauczyciela</strong><span>Wersja 0.9 (MVP)</span></div></div>
            <div className="about-row"><Icon name="zap" size={15} /><div><strong>Tryb</strong><span className="ok-text">połączony z backendem</span></div></div>
            <div className="about-row"><Icon name="shield" size={15} /><div><strong>Status</strong><span className="ok-text">wszystkie systemy działają</span></div></div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ToggleRow({ icon, title, desc, checked, onChange }) {
  return (
    <div className="toggle-row">
      <span className="toggle-ic"><Icon name={icon} size={17} /></span>
      <div className="toggle-row-body">
        <strong>{title}</strong>
        <p>{desc}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}
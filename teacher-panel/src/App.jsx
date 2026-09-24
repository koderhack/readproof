import React, { useEffect, useState } from "react";
import { AppProvider, useApp } from "./context.jsx";
import { Layout } from "./components/Layout.jsx";
import { Dashboard } from "./pages/Dashboard.jsx";
import { Tests } from "./pages/Tests.jsx";
import { TestDetail } from "./pages/TestDetail.jsx";
import { TestBuilder } from "./pages/TestBuilder.jsx";
import { Classes } from "./pages/Classes.jsx";
import { Students } from "./pages/Students.jsx";
import { Results } from "./pages/Results.jsx";
import { Grading } from "./pages/Grading.jsx";
import { StudentProfile } from "./pages/StudentProfile.jsx";
import { Settings } from "./pages/Settings.jsx";

function Router() {
  const { view } = useApp();
  switch (view.name) {
    case "tests":
      return <Tests />;
    case "test":
      return <TestDetail testId={view.params.testId} tab={view.params.tab} />;
    case "builder":
      return <TestBuilder testId={view.params.testId} />;
    case "classes":
      return <Classes />;
    case "students":
      return <Students />;
    case "student":
      return <StudentProfile studentId={view.params.studentId} />;
    case "results":
      return <Results />;
    case "grading":
      return <Grading />;
    case "settings":
      return <Settings />;
    case "dashboard":
    default:
      return <Dashboard />;
  }
}

function TeacherGate({ children }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const wallet = localStorage.getItem("rp_app_wallet") || localStorage.getItem("rp_teacher_wallet");
    if (!wallet) {
      window.location.replace("/app/#/");
      return;
    }
    setReady(true);
  }, []);

  if (!ready) return <div className="gate-loading"><span className="spinner" /> Ładowanie konta nauczyciela…</div>;
  return children;
}

export function App() {
  return (
    <TeacherGate>
      <AppProvider>
        <Layout>
          <Router />
        </Layout>
      </AppProvider>
    </TeacherGate>
  );
}
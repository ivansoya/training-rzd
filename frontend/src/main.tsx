import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import AccountPage from "./components/auth/AccountPage";
import AuthGate from "./components/auth/AuthGate";
import ConfirmPage from "./components/auth/ConfirmPage";
import MagShell from "./components/mag/MagShell";
import ProjectPage from "./components/mag/ProjectPage";
import ProjectsPage from "./components/mag/ProjectsPage";
import "./styles/common.css";
import "./styles/datasets.css";
import "./styles/augment.css";
import "./styles/train.css";
import "./styles/inference.css";
import "./styles/auth.css";

// Новый сайт («Магистраль»: проекты, кабинет) — главный. Старое приложение
// живёт отдельно на /tools за тем же входом и напрямую не связано с новым.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/confirm/:token" element={<ConfirmPage />} />
        <Route
          path="*"
          element={
            <AuthGate>
              <Routes>
                <Route
                  path="/"
                  element={
                    <MagShell>
                      <ProjectsPage />
                    </MagShell>
                  }
                />
                <Route
                  path="/projects/:code"
                  element={
                    <MagShell>
                      <ProjectPage />
                    </MagShell>
                  }
                />
                <Route
                  path="/account"
                  element={
                    <MagShell>
                      <AccountPage />
                    </MagShell>
                  }
                />
                <Route path="/tools" element={<App />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AuthGate>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);

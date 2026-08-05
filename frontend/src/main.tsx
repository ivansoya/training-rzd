import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import App from "./App";
import AccountPage from "./components/auth/AccountPage";
import AuthGate from "./components/auth/AuthGate";
import ConfirmPage from "./components/auth/ConfirmPage";
import DatasetPage from "./components/mag/DatasetPage";
import ImportWizard from "./components/mag/ImportWizard";
import MagShell from "./components/mag/MagShell";
import ProjectClasses from "./components/mag/ProjectClasses";
import ProjectDatasets from "./components/mag/ProjectDatasets";
import ProjectMembers from "./components/mag/ProjectMembers";
import ProjectOverview from "./components/mag/ProjectOverview";
import ProjectShell from "./components/mag/ProjectShell";
import ProjectTasks from "./components/mag/ProjectTasks";
import ProjectsPage from "./components/mag/ProjectsPage";
import TaskPage from "./components/mag/TaskPage";
import "./styles/common.css";
import "./styles/datasets.css";
import "./styles/augment.css";
import "./styles/train.css";
import "./styles/inference.css";
import "./styles/auth.css";
import "./styles/import.css";
import "./styles/project.css";
import "./styles/dataset.css";
import "./styles/task.css";
import "./styles/taskpage.css";
import "./styles/editor.css";
import "./styles/export.css";

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
                {/* Разделы проекта — вкладки в URL: перезагрузка не сбрасывает
                    раздел, на него можно дать ссылку. */}
                <Route
                  path="/projects/:code"
                  element={
                    <MagShell>
                      <ProjectShell />
                    </MagShell>
                  }
                >
                  <Route index element={<ProjectOverview />} />
                  <Route path="datasets" element={<ProjectDatasets />} />
                  <Route path="classes" element={<ProjectClasses />} />
                  <Route path="members" element={<ProjectMembers />} />
                  <Route path="tasks" element={<ProjectTasks />} />
                </Route>
                <Route
                  path="/projects/:code/tasks/:taskId"
                  element={
                    <MagShell>
                      <TaskPage />
                    </MagShell>
                  }
                />
                <Route
                  path="/projects/:code/import"
                  element={
                    <MagShell>
                      <ImportWizard />
                    </MagShell>
                  }
                />
                <Route
                  path="/projects/:code/datasets/:datasetId"
                  element={
                    <MagShell>
                      <DatasetPage />
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

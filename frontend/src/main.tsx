import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AccountPage from "./components/auth/AccountPage";
import AugGraphEditor from "./components/aug/AugGraphEditor";
import AugGraphList from "./components/aug/AugGraphList";
import HardwarePage from "./components/hardware/HardwarePage";
import ProjectAug from "./components/aug/ProjectAug";
import TrainingHome from "./components/training/TrainingHome";
import TrainRunPage from "./components/training/TrainRunPage";
import TrainSetWizard from "./components/training/TrainSetWizard";
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
import TrainSetView from "./components/training/TrainSetView";
import "./styles/common.css";
import "./styles/auth.css";
import "./styles/import.css";
import "./styles/project.css";
import "./styles/dataset.css";
import "./styles/task.css";
import "./styles/taskpage.css";
import "./styles/editor.css";
import "./styles/video.css";
import "./styles/export.css";
import "./styles/graph.css";
import "./styles/training.css";
// Общая палитра и компоновка подключаются после стилей компонентов.
import "./styles/gabarit.css";
import "./styles/workspace.css";
import "./styles/timeline.css";

// Один сайт. Старое приложение на /tools удалено вместе со своими файловыми
// датасетами: всё, что оно умело, живёт теперь внутри проектов.
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
                  <Route path="aug" element={<ProjectAug />} />
                  <Route path="training" element={<TrainingHome />} />
                  {/* Датасет и собранный набор — тоже разделы проекта: без
                      этого на них пропадали и строка разделов, и паспорт
                      проекта, и уйти отсюда было некуда. */}
                  <Route path="datasets/:datasetId" element={<DatasetPage />} />
                  <Route path="trainsets/:setId" element={<TrainSetView />} />
                </Route>
                <Route
                  path="/projects/:code/training/new"
                  element={
                    <MagShell>
                      <TrainSetWizard />
                    </MagShell>
                  }
                />
                <Route
                  path="/projects/:code/training/runs/:runId"
                  element={
                    <MagShell>
                      <div className="mag-content">
                        <TrainRunPage />
                      </div>
                    </MagShell>
                  }
                />
                <Route
                  path="/hardware"
                  element={
                    <MagShell>
                      <HardwarePage />
                    </MagShell>
                  }
                />
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
                {/* Аугментации живут вне проектов: граф принадлежит
                    человеку, а прогон — проекту. */}
                <Route
                  path="/augment"
                  element={
                    <MagShell>
                      <AugGraphList />
                    </MagShell>
                  }
                />
                <Route
                  path="/augment/:graphId"
                  element={
                    <MagShell>
                      <AugGraphEditor />
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
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AuthGate>
          }
        />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);

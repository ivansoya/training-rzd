import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AccountPage from "./components/auth/AccountPage";
import AgentEditor from "./components/agents/AgentEditor";
import AgentList from "./components/agents/AgentList";
import AugGraphEditor from "./components/aug/AugGraphEditor";
import AugGraphList from "./components/aug/AugGraphList";
import HardwarePage from "./components/hardware/HardwarePage";
import ProjectAug from "./components/aug/ProjectAug";
import SetList from "./components/mag/sets/SetList";
import SetWizard from "./components/mag/sets/SetWizard";
import AuthGate from "./components/auth/AuthGate";
import ConfirmPage from "./components/auth/ConfirmPage";
import { DatasetRedirect } from "./components/mag/frames/redirect";
import { ImportRoute } from "./components/mag/ImportDialog";
import RoleGate from "./components/mag/RoleGate";
import MagShell from "./components/mag/MagShell";
import ProjectClasses from "./components/mag/classes/ProjectClasses";
import ProjectTags from "./components/mag/classes/ProjectTags";
import ProjectFrames from "./components/mag/frames/ProjectFrames";
import ProjectMembers from "./components/mag/members/ProjectMembers";
import ProjectOverview from "./components/mag/ProjectOverview";
import ProjectShell from "./components/mag/ProjectShell";
import TaskBoard from "./components/mag/tasks/TaskBoard";
import ProjectsPage from "./components/mag/ProjectsPage";
import TaskPage from "./components/mag/tasks/TaskPage";
import RunHistory from "./components/mag/runs/RunHistory";
import RunPage from "./components/mag/runs/RunPage";
import { RunRedirect } from "./components/mag/runs/redirect";
import SetPage from "./components/mag/sets/SetPage";
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
import "./styles/agents.css";
// Общая палитра и компоновка подключаются после стилей компонентов.
import "./styles/gabarit.css";
import "./styles/workspace.css";
import "./styles/timeline.css";
// Редизайн: шрифты со своего домена (CSP: font-src 'self'), токены с мостом к
// старым переменным, примитивы и каркас — последними, чтобы выигрывать порядком.
import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/onest/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles/tokens.css";
import "./styles/ui.css";
import "./styles/layout.css";

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
                  <Route path="datasets" element={<ProjectFrames />} />
                  <Route path="classes" element={<ProjectClasses />} />
                  <Route path="tags" element={<ProjectTags />} />
                  <Route path="members" element={<ProjectMembers />} />
                  {/* Импорт — окно поверх обзора; адрес держит его открытым после перезагрузки */}
                  <Route path="import" element={<ImportRoute />} />
                  <Route path="tasks" element={<TaskBoard />} />
                  <Route path="aug" element={<ProjectAug />} />
                  <Route path="training" element={<SetList />} />
                  <Route path="runs" element={<RunHistory />} />
                  <Route path="runs/:runId" element={<RunPage />} />
                  <Route path="training/runs/:runId" element={<RunRedirect />} />
                  {/* Старый адрес датасета ведёт в общую галерею на его группу */}
                  <Route path="datasets/:datasetId" element={<DatasetRedirect />} />
                  <Route path="trainsets/:setId" element={<SetPage />} />
                </Route>
                <Route
                  path="/projects/:code/training/new"
                  element={
                    <MagShell>
                      <RoleGate need="editor" what="Собирать обучающие наборы">
                        <SetWizard />
                      </RoleGate>
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
                {/* Агенты разметки — тоже личные: агент принадлежит человеку. */}
                <Route
                  path="/agents"
                  element={
                    <MagShell>
                      <AgentList />
                    </MagShell>
                  }
                />
                <Route
                  path="/agents/:graphId"
                  element={
                    <MagShell>
                      <AgentEditor />
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

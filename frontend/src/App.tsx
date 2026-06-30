import { useCallback, useEffect, useState } from "react";
import Sidebar from "./components/common/Sidebar";
import type { View } from "./components/common/Sidebar";
import Header from "./components/common/Header";
import type { UploadActivity } from "./components/common/Header";
import UploadModal from "./components/datasets/UploadModal";
import CreateAugmentedModal from "./components/augment/CreateAugmentedModal";
import DatasetStatsView from "./components/datasets/DatasetStats";
import DatasetsGrid from "./components/datasets/DatasetsGrid";
import AugmentView from "./components/augment/AugmentView";
import TrainView from "./components/train/TrainView";
import InferenceView from "./components/inference/InferenceView";
import {
  createAugmented,
  deleteDataset,
  getDataset,
  listConfigs,
  listDatasets,
  listTrainings,
  listTransforms,
  pollJob,
  uploadDataset,
} from "./api";
import type {
  AugConfig,
  AugScope,
  DatasetKind,
  DatasetStats,
  DatasetSummary,
  Job,
  Progress,
  TrainingSummary,
  TransformSchema,
} from "./types";

type Selected = { kind: DatasetKind; name: string };

// Map a running job to a progress descriptor. The "stats" phase is a single
// pass, so it is shown as a label-only spinner (no progress bar).
function progressForJob(job: Job, fallbackLabel: string): Progress {
  if (job.phase === "stats") {
    return { label: "Подсчёт статистики…", pct: null, spinner: true };
  }
  return {
    label: job.message || fallbackLabel,
    pct: job.total ? job.processed / job.total : null,
  };
}

export default function App() {
  const [view, setView] = useState<View>("datasets");
  const [collapsed, setCollapsed] = useState(false);
  const [trainAvailable, setTrainAvailable] = useState(true);

  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [augmentSource, setAugmentSource] = useState<string | null>(null);

  // header activity indicators
  const [uploads, setUploads] = useState<UploadActivity[]>([]);
  const [headerTrainings, setHeaderTrainings] = useState<TrainingSummary[]>([]);
  const [focusTraining, setFocusTraining] = useState<string | undefined>();

  const [configs, setConfigs] = useState<AugConfig[]>([]);
  const [registry, setRegistry] = useState<TransformSchema[]>([]);
  const [augAvailable, setAugAvailable] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setDatasets(await listDatasets());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Poll training summaries so the header can show active runs from any view.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const list = await listTrainings();
        if (active) setHeaderTrainings(list);
      } catch {
        /* ignore */
      }
    };
    tick();
    const h = setInterval(tick, 4000);
    return () => {
      active = false;
      clearInterval(h);
    };
  }, []);

  useEffect(() => {
    refresh();
    listConfigs().then(setConfigs).catch(() => {});
    listTransforms()
      .then((r) => {
        setRegistry(r.transforms);
        setAugAvailable(r.available);
      })
      .catch(() => {});
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setTrainAvailable(Boolean(h.ultralytics)))
      .catch(() => {});
  }, [refresh]);

  const selectDataset = useCallback(async (kind: DatasetKind, name: string) => {
    setSelected({ kind, name });
    setLoadingStats(true);
    setError(null);
    try {
      setStats(await getDataset(kind, name));
    } catch (e) {
      setError((e as Error).message);
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  }, []);

  // Non-blocking: close the modal at once and run the upload in the background,
  // surfacing progress through the header activity indicator.
  function handleUpload(file: File, name: string) {
    setShowUpload(false);
    setError(null);
    const upId = Math.random().toString(36).slice(2);
    const upLabel = name || file.name;
    setUploads((u) => [...u, { id: upId, label: upLabel, pct: 0 }]);
    const setUpPct = (pct: number | null) =>
      setUploads((u) => u.map((x) => (x.id === upId ? { ...x, pct } : x)));

    (async () => {
      try {
        const { job_id } = await uploadDataset(file, name, (pct) => {
          // Once the browser has flushed all bytes (pct≈1) the data is still in
          // flight to the server, so switch to an indeterminate state.
          setUpPct(pct >= 0.999 ? null : pct);
        });
        await pollJob<DatasetStats>(job_id, (job) => {
          setUpPct(job.total ? job.processed / job.total : null);
        });
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploads((u) => u.filter((x) => x.id !== upId));
      }
    })();
  }

  async function handleDelete(kind: DatasetKind, name: string) {
    if (!window.confirm(`Удалить датасет "${name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDataset(kind, name);
      if (selected?.kind === kind && selected.name === name) {
        setSelected(null);
        setStats(null);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAugmented(
    configIds: string[],
    displayName: string,
    scope: AugScope,
    onProgress: (p: Progress) => void
  ) {
    if (!augmentSource) return;
    setBusy(true);
    setError(null);
    try {
      const { job_id } = await createAugmented(
        augmentSource,
        configIds,
        displayName,
        scope
      );
      const stats = await pollJob<DatasetStats>(job_id, (job) =>
        onProgress(progressForJob(job, "Генерация аугментаций"))
      );
      setAugmentSource(null);
      await refresh();
      await selectDataset("augmented", stats.name);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function navigate(next: View) {
    if (next === "augment") {
      listConfigs().then(setConfigs).catch(() => {});
    }
    if (next === "datasets") {
      // returning to the Datasets tab shows the tile grid, not a stale detail
      setSelected(null);
      setStats(null);
    }
    setView(next);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" /> YOLO Dataset Manager
        </div>
        <Header
          uploads={uploads}
          trainings={headerTrainings.filter(
            (t) => t.status === "preparing" || t.status === "running"
          )}
          onOpenTraining={(id) => {
            setFocusTraining(id);
            setView("train");
          }}
        />
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="body">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          view={view}
          onNavigate={navigate}
        />

        {view === "datasets" &&
          (selected ? (
            <DatasetStatsView
              stats={stats}
              kind={selected.kind}
              loading={loadingStats}
              onAugment={() => selected && setAugmentSource(selected.name)}
              onBack={() => {
                setSelected(null);
                setStats(null);
              }}
            />
          ) : (
            <DatasetsGrid
              datasets={datasets}
              onUploadClick={() => setShowUpload(true)}
              onSelect={selectDataset}
              onDelete={handleDelete}
              busy={busy}
            />
          ))}
        {view === "augment" && (
          <AugmentView
            registry={registry}
            available={augAvailable}
            datasets={datasets}
          />
        )}
        {view === "train" && (
          <TrainView
            datasets={datasets}
            available={trainAvailable}
            focusRunId={focusTraining}
          />
        )}
        {view === "inference" && <InferenceView available={trainAvailable} />}
      </div>

      {showUpload && (
        <UploadModal onUpload={handleUpload} onClose={() => setShowUpload(false)} />
      )}
      {augmentSource && (
        <CreateAugmentedModal
          source={augmentSource}
          configs={configs}
          onCreate={handleCreateAugmented}
          onClose={() => setAugmentSource(null)}
        />
      )}
    </div>
  );
}

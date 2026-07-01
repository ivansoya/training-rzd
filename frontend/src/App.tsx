import { useCallback, useEffect, useRef, useState } from "react";
import Sidebar from "./components/common/Sidebar";
import type { View } from "./components/common/Sidebar";
import Header from "./components/common/Header";
import type { AugActivity, UploadActivity } from "./components/common/Header";
import UploadModal from "./components/datasets/UploadModal";
import CreateAugmentedModal from "./components/augment/CreateAugmentedModal";
import DatasetStatsView from "./components/datasets/DatasetStats";
import DatasetsGrid from "./components/datasets/DatasetsGrid";
import AugmentView from "./components/augment/AugmentView";
import TrainView from "./components/train/TrainView";
import InferenceView from "./components/inference/InferenceView";
import {
  cancelAugment,
  clearAugmented,
  createAugmented,
  deleteDataset,
  getDataset,
  JobCancelledError,
  listConfigs,
  renameDataset,
  listDatasets,
  listInferences,
  listTrainings,
  listTransforms,
  pollJob,
  stopTraining,
  uploadDataset,
} from "./api";
import type {
  AugConfig,
  AugScope,
  DatasetKind,
  DatasetStats,
  DatasetSummary,
  InferenceSummary,
  TrainingSummary,
  TransformSchema,
} from "./types";

type Selected = { kind: DatasetKind; name: string };

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
  const [augments, setAugments] = useState<AugActivity[]>([]);
  const augJobs = useRef<Record<string, string>>({});
  const augCancelPending = useRef<Set<string>>(new Set());
  const [headerTrainings, setHeaderTrainings] = useState<TrainingSummary[]>([]);
  const [headerInferences, setHeaderInferences] = useState<InferenceSummary[]>(
    []
  );
  const [focusTraining, setFocusTraining] = useState<string | undefined>();
  const [focusVideo, setFocusVideo] = useState<string | undefined>();

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

  // Poll training + inference summaries so the header can show every active
  // process (and the training queue) from any view.
  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const [tr, inf] = await Promise.all([
          listTrainings(),
          listInferences(),
        ]);
        if (!active) return;
        setHeaderTrainings(tr);
        setHeaderInferences(inf);
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
        window.dispatchEvent(new Event("storage-changed"));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploads((u) => u.filter((x) => x.id !== upId));
      }
    })();
  }

  async function handleRename(displayName: string) {
    if (!selected) return;
    await renameDataset(selected.kind, selected.name, displayName);
    await refresh();
    await selectDataset(selected.kind, selected.name);
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
      window.dispatchEvent(new Event("storage-changed"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Non-blocking: close the modal at once and run generation in the background,
  // surfacing progress (and a cancel control) through the header indicator.
  function handleCreateAugmented(
    configIds: string[],
    displayName: string,
    scope: AugScope
  ) {
    if (!augmentSource) return;
    const source = augmentSource;
    setAugmentSource(null);
    setError(null);
    const augId = Math.random().toString(36).slice(2);
    setAugments((a) => [...a, { id: augId, label: displayName || source, pct: 0 }]);
    const patch = (fields: Partial<AugActivity>) =>
      setAugments((a) => a.map((x) => (x.id === augId ? { ...x, ...fields } : x)));

    (async () => {
      try {
        const { job_id } = await createAugmented(
          source,
          configIds,
          displayName,
          scope
        );
        augJobs.current[augId] = job_id;
        // If the user hit cancel before the job id came back, honour it now.
        if (augCancelPending.current.has(augId)) {
          augCancelPending.current.delete(augId);
          cancelAugment(job_id).catch(() => {});
        }
        await pollJob<DatasetStats>(job_id, (job) => {
          patch({ pct: job.total ? job.processed / job.total : null });
        });
        await refresh();
        window.dispatchEvent(new Event("storage-changed"));
      } catch (e) {
        if (!(e instanceof JobCancelledError)) setError((e as Error).message);
      } finally {
        setAugments((a) => a.filter((x) => x.id !== augId));
        delete augJobs.current[augId];
        augCancelPending.current.delete(augId);
      }
    })();
  }

  function handleCancelAugment(augId: string) {
    setAugments((a) =>
      a.map((x) => (x.id === augId ? { ...x, cancelling: true } : x))
    );
    const jobId = augJobs.current[augId];
    if (jobId) {
      cancelAugment(jobId).catch(() => {});
    } else {
      // job id not assigned yet — cancel as soon as it is
      augCancelPending.current.add(augId);
    }
  }

  async function handleClearAugmented() {
    if (
      !window.confirm(
        "Удалить все аугментированные датасеты? Действие необратимо."
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await clearAugmented();
      if (selected?.kind === "augmented") {
        setSelected(null);
        setStats(null);
      }
      await refresh();
      window.dispatchEvent(new Event("storage-changed"));
    } catch (e) {
      setError((e as Error).message);
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
          augments={augments}
          trainings={headerTrainings.filter(
            (t) =>
              t.status === "preparing" ||
              t.status === "running" ||
              t.status === "queued"
          )}
          inferences={headerInferences.filter((r) => r.status === "processing")}
          onOpenTraining={(id) => {
            setFocusTraining(id);
            setView("train");
          }}
          onOpenInference={(videoId) => {
            setFocusVideo(videoId);
            setView("inference");
          }}
          onCancelAugment={handleCancelAugment}
          onCancelTraining={(id) => {
            stopTraining(id).catch(() => {});
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
              onRename={handleRename}
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
              onClearAugmented={handleClearAugmented}
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
        {view === "inference" && (
          <InferenceView available={trainAvailable} focusVideoId={focusVideo} />
        )}
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

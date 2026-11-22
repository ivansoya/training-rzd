import { useEffect, useRef, useState } from 'react';
import { get, post } from '../../../api/http';
import type { Run } from '../../../api/runs';
import { AnchorButton, Button, Dialog, Field, Input, Notice, Progress, Seg, Select } from '../../../ui';

type Job = {id: string; state: 'queued' | 'running' | 'done' | 'error'; stage: string; step?: number; error?: string; name: string; platform: string; variant: string; samples: number; calibration_progress?: number; format?: 'rjdm' | 'rknn'};
const platforms = ['rk3566', 'rk3588'].map(value => ({value, label: value.toUpperCase()}));
const variants = ['fp', 'int8'].map(value => ({value, label: value.toUpperCase()}));
const formats = [{value: 'rjdm', label: 'RJDM для RJD'}, {value: 'rknn', label: 'RKNN'}];

export default function RknnExport({code, run}: {code: string; run: Run}) {
  const path = `projects/${code}/runs/${run.id}/rknn`;
  const [open, show] = useState(() => new URLSearchParams(location.search).has('export'));
  const [step, setStep] = useState(1);
  const [platform, setPlatform] = useState('rk3566');
  const [variant, setVariant] = useState('int8');
  const [format, setFormat] = useState('rjdm');
  const [available, setAvailable] = useState<number | null>(null);
  const [samples, setSamples] = useState('128');
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, retry] = useState(0);
  const calibration = job?.calibration_progress;
  const stageProgress = job?.step
    ? `Этап ${job.step} из 4${calibration === undefined ? '' : ` · Калибровка ${Math.floor(calibration * 100)}%`}`
    : 'Ожидание воркера';
  const active = job?.state === 'queued' || job?.state === 'running';
  const observed = useRef<{path: string; id: string} | null>(null);
  useEffect(() => {
    if (active) {
      observed.current = {path, id: job.id};
      return;
    }
    const previous = observed.current;
    observed.current = null;
    if (open || job?.state !== 'done' || previous?.path !== path || previous.id !== job.id) return;
    try {
      const key = `mag.export.downloaded.${path}`;
      if (localStorage.getItem(key) === job.id) return;
      localStorage.setItem(key, job.id);
    } catch { /* Скачивание доступно и без локального хранилища. */ }
    const link = document.createElement('a');
    link.href = `/api/${path}/${job.id}/download`;
    link.download = job.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [active, job, open, path]);
  useEffect(() => {
    let mounted = true;
    let timer: number;
    async function poll() {
      try {
        const result = await get<{job: Job | null}>(path);
        if (!mounted) return;
        setJob(result.job);
        if (!result.job || !['running', 'queued'].includes(result.job.state)) return;
      } catch (e) { if (mounted) setError((e as Error).message); }
      if (mounted) timer = window.setTimeout(poll, 2000);
    }
    void poll();
    return () => { mounted = false; clearTimeout(timer); };
  }, [path, revision]);
  useEffect(() => {
    if (!open || job || step !== 2 || variant !== 'int8') return;
    let mounted = true;
    setAvailable(null);
    get<{available: number}>(`${path}?frames=1`).then(data => {
      if (mounted) { setAvailable(data.available); setSamples(String(Math.min(data.available, 128))); }
    }).catch(e => { if (mounted) setError(e.message); });
    return () => { mounted = false; };
  }, [path, open, step, variant, job]);
  async function start() {
    setBusy(true); setError('');
    try {
      const result = await post<{job: Job}>(path, {platform, variant, format, samples: variant === 'int8' ? Number(samples) : 0});
      setJob(result.job); retry(v => v + 1);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function configure() { setJob(null); setStep(1); setError(''); }
  const valid = variant === 'fp' || (available !== null && Number.isInteger(+samples) && +samples > 0 && +samples <= available);
  const outputs = run.task === 'segment' ? (variant === 'fp' ? 2 : 13) : (variant === 'fp' ? 1 : 9);
  const meter = active && (job.step ?
    <Progress value={job.step - 1 + (calibration ?? 0)} max={4} label={stageProgress} /> :
    <div className="ui-progress rn-export-wait" role="progressbar" aria-label={stageProgress}><i /></div>);
  const footer = job ? <>
    {active && <span className="rn-export-footer-hint t-sm t-muted">Можно свернуть окно. Экспорт продолжится в фоне.</span>}
    <Button onClick={() => show(false)}>Свернуть</Button>
    {!active && <Button onClick={configure}>{job.state === 'error' ? 'Изменить параметры' : 'Новый экспорт'}</Button>}
    {job.state === 'done' && <AnchorButton variant="primary" icon="download" href={`/api/${path}/${job.id}/download`}>Скачать .{job.format ?? 'rknn'}</AnchorButton>}
  </> : step === 1 ? <Button variant="primary" onClick={() => setStep(2)}>Далее</Button> : <>
    <Button disabled={busy} onClick={() => setStep(1)}>Назад</Button>
    <Button variant="primary" disabled={busy || !valid} onClick={start}>Начать экспорт</Button>
  </>;

  return <>
    <Button icon="download" onClick={() => show(true)}>Экспорт</Button>
    {!open && active && <span className="rn-export-inline" title={job.stage}>
      <span>{!job.step ? 'В очереди' : calibration === undefined ? `Этап ${job.step}/4` : `Калибровка ${Math.floor(calibration * 100)}%`}</span>
      {meter}
    </span>}
    {!open && job?.state === 'error' && <span className="t-xs t-muted">Ошибка экспорта</span>}
    <Dialog open={open} onOpenChange={show} width={550} title="Экспорт модели"
      desc={`Обучение №${run.number} · ${run.name}`} footer={footer}>
      <div className="rn-export-fields">
        {error && <Notice tone="error" onClose={() => setError('')}>{error}</Notice>}
        {job ? <>
          <div className="rn-export-summary">
            <b>{run.set?.name ?? 'Набор обучения недоступен'}</b>
            <span className="t-sm t-muted">{job.platform.toUpperCase()} · {job.variant.toUpperCase()}
              {job.samples > 0 && ` · ${job.samples} кадров train`}</span>
          </div>
          <b role="status">{job.stage}</b>
          {active && <><span className="t-xs t-muted">{stageProgress}</span>{meter}</>}
          <span className="mono">{job.name}</span>
          {job.state === 'error' && <Notice tone="error"><pre className="rn-export-error">{job.error}</pre></Notice>}
        </> : <>
          <span className="t-sm t-muted">Шаг {step} из 2 · {step === 1 ? 'Веса и платформа' : 'Проверка и запуск'}</span>
          {step === 1 ? <>
            <b>Веса обучения №{run.number}</b>
            <div className="rn-export-model"><b className="mono">{run.name}.pt</b><span className="t-xs t-muted">{run.base_model}</span></div>
            <b>Параметры экспорта</b>
            <Field label="Формат файла">{id => <Select id={id} full value={format} options={formats} onChange={setFormat} />}</Field>
            <div className="rn-export-pair">
              <Field label="Платформа Rockchip">{id => <Select id={id} full value={platform} options={platforms} onChange={setPlatform} />}</Field>
              <Field label="Точность">{() => <Seg label="Точность" value={variant} onChange={setVariant} options={variants} />}</Field>
            </div>
            <span className="t-sm t-muted">Выходных тензоров: {outputs}</span>
          </> : <>
            <b>{format.toUpperCase()} · {platform.toUpperCase()} · {variant.toUpperCase()}</b>
            {variant === 'int8' && <>
              <span>Датасет обучения · {run.set?.name ?? 'набор удалён'}</span>
              <Field label="Кадров в выборке" aside={available === null ? 'Проверяем доступность…' : `Доступно ${available}`}
                hint="Исходные кадры train. Аугментации исключены."
                error={available === 0 ? 'В сборке нет доступных исходных кадров train.' : undefined}>
                {id => <Input id={id} type="number" min={1} max={available ?? undefined} value={samples} onChange={e => setSamples(e.target.value)} />}
              </Field>
            </>}
          </>}
        </>}
      </div>
    </Dialog>
  </>;
}

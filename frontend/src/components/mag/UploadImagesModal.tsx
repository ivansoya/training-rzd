import { useState } from "react";
import TagPicker from "./TagPicker";
import type { Tag } from "../../api/tags";
import { plural } from "./ProjectsPage";
import { useEscape } from "./useEscape";
import { fmtBytes } from "./VideoCutModal";

/** Окно загрузки кадров: что грузим и с какими тагами.
 *
 * Раньше выбранные файлы улетали сразу, без единого вопроса. Вопрос появился
 * ровно один и по делу: таг. Кадру из ролика он достаётся сам, от ролика, а
 * загруженному файлом — неоткуда: происхождение знает только тот, кто его
 * принёс, и знает он это ровно сейчас.
 *
 * Сверху — «всем сразу», и в девяти случаях из десяти на этом всё. Список
 * ниже нужен для десятого: в папке вперемешку день и ночь, и разбирать их
 * потом по одному кадру в редакторе — работа на вечер.
 */
export default function UploadImagesModal({
  code,
  tags,
  files,
  onTagCreated,
  onCancel,
  onSend,
}: {
  code: string;
  tags: Tag[];
  files: File[];
  onTagCreated: (tag: Tag) => void;
  onCancel: () => void;
  /** Таги по файлу, в том же порядке, что и `files`. */
  onSend: (perFile: string[][]) => void;
}) {
  // Общий набор и личные наборы держатся врозь. Смешав их в одном списке,
  // пришлось бы решать, что делать с личными при смене общего — а ответа,
  // который не удивит человека, там нет.
  const [common, setCommon] = useState<string[]>([]);
  const [own, setOwn] = useState<Record<number, string[]>>({});
  const [expanded, setExpanded] = useState(false);

  useEscape(onCancel);

  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const personal = Object.values(own).filter((v) => v.length).length;

  function send() {
    onSend(files.map((_, i) => (own[i]?.length ? own[i] : common)));
  }

  return (
    <div className="mag-backdrop" onClick={onCancel}>
      <div className="mag-modal mag-up" onClick={(e) => e.stopPropagation()}>
        <h3>Загрузка кадров</h3>
        <p className="mag-sub">
          {files.length} {plural(files.length, "файл", "файла", "файлов")}
          {" · "}
          {fmtBytes(bytes)}
        </p>

        <div className="up-common">
          <div className="g-label">Таги всем сразу</div>
          <TagPicker
            code={code}
            all={tags}
            value={common}
            onChange={setCommon}
            onCreated={onTagCreated}
            placeholder="таг для всей пачки"
          />
        </div>

        <button
          type="button"
          className="mag-dashed"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Свернуть список файлов" : "Задать тагов по отдельности"}
          {personal > 0 && ` · ${personal} ${plural(personal, "файл", "файла", "файлов")} со своими`}
        </button>

        {expanded && (
          <div className="up-list">
            {files.map((file, i) => (
              <div className="up-row" key={`${file.name}-${i}`}>
                <b title={file.name}>{file.name}</b>
                <span>{fmtBytes(file.size)}</span>
                <TagPicker
                  code={code}
                  all={tags}
                  value={own[i]?.length ? own[i] : common}
                  compact
                  placeholder="свои таги"
                  onChange={(next) => setOwn((prev) => ({ ...prev, [i]: next }))}
                  onCreated={onTagCreated}
                />
              </div>
            ))}
          </div>
        )}

        <div className="mag-modal-foot">
          <button className="mag-ghost" type="button" onClick={onCancel}>
            Отмена
          </button>
          <button className="mag-btn" type="button" onClick={send}>
            Загрузить {files.length}
          </button>
        </div>
      </div>
    </div>
  );
}

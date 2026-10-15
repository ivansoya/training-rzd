// «Фокус» в датасете (решения 14.10.2026): тот же редактор, что в таске, по кадрам группы галереи.
// Лайтбокс ImageViewer заменён им целиком; наблюдатель видит его только для чтения.

import { useMemo } from "react";
import { createPortal } from "react-dom";
import type { TaskImage } from "../../../auth/api";
import { asFrame } from "../../../api/gallery";
import type { ProjectImage } from "../../../api/gallery";
import { setImageTags } from "../../../api/tags";
import type { Tag } from "../../../api/tags";
import AnnotationEditor from "../AnnotationEditor";
import { useProject } from "../ProjectShell";

export function DatasetFocus({ title, items, index, total, base = 0, tags, onIndex, onClose, onPatch, onRemoved,
  onNeedMore, onTagCreated }: {
  /** Группа галереи: датасет, сплит или «Все кадры». */
  title: string;
  items: ProjectImage[];
  index: number;
  /** Кадров группы под отбором. */
  total: number;
  base?: number;
  tags: Tag[];
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Что поменялось у кадра — галерея правит плитку на месте. */
  onPatch: (id: string, patch: Partial<ProjectImage>) => void;
  /** Кадр ушёл из датасета. */
  onRemoved: (id: string) => void;
  onNeedMore?: () => void;
  onTagCreated: (tag: Tag) => void;
}) {
  const { detail } = useProject();
  const canEdit = detail.my_role === "admin" || detail.my_role === "editor";
  const frames = useMemo(() => items.map(asFrame), [items]);
  if (!frames[index]) return null;
  return createPortal(
    <AnnotationEditor
      code={detail.project.code}
      scope={{ kind: "dataset", title, total, base, onNeedMore, onRemoved }}
      images={frames}
      index={index}
      readOnly={!canEdit}
      canTag={canEdit}
      tags={tags}
      people={detail.members}
      onIndex={onIndex}
      onClose={onClose}
      onChanged={(id, patch: Partial<TaskImage>) => onPatch(id, patch as Partial<ProjectImage>)}
      onTags={async (id, ids) => {
        const was = items.find((x) => x.id === id)?.tag_ids ?? [];
        onPatch(id, { tag_ids: ids });
        try {
          await setImageTags(id, ids);
        } catch (e) {
          onPatch(id, { tag_ids: was });
          throw e;
        }
      }}
      onTagCreated={onTagCreated}
    />,
    document.body,
  );
}

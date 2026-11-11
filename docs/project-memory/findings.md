# Баги и уязвимости

Статусы: «открыт» — остаётся работа; «гипотеза» — причина/воспроизведение требуют подтверждения; «исправлен локально» — проверен в исходниках; «выложен» — соответствующий код опубликован, это не означает воспроизведение дефекта на рабочих данных. Обновляй существующие ID при изменении статуса.

## BUG-001 — pending-разметка ошибочно попадает в размеченные кадры

- Дата: 2026-11-10. Статус: исправлен в новой галерее и её фильтрах/счётчиках; выложен на VORAN-01 2026-11-10 (`03d2a17`).
- Условие: у изображения `task_status=annotated`, но есть `Annotation.pending=true`. Один статус изображения не доказывает проверку человеком.
- Исправление: `task_frames.reviewed()` проверяет и статус, и отсутствие pending; интерфейс использует новый счётчик `reviewed`.
- Файлы: `backend/common/task_frames.py`, `backend/datasets_svc/task_routes.py`, `frontend/src/components/mag/tasks/CutFrames.tsx`, `tasks.ts`.
- Проверка: серверные тесты состояний/счётчиков и frontend-тест фильтра с моделью; браузерный сценарий. См. [задачу](tasks/2026-11-10-cut-video-groups.md). Не означает, что все прочие исторические индикаторы приложения переведены на новый предикат.

## BUG-002 — неустойчивая пагинация кадров с одинаковыми именами

- Дата: 2026-11-10. Статус: исправлен; выложен на VORAN-01 2026-11-10 (`03d2a17`).
- Причина: сортировка `/api/tasks/<id>/images` по очереди и имени не задавала однозначный порядок при совпадении имён; это допускало повторы/пропуски между страницами.
- Исправление: последним ключом сортировки добавлен уникальный `Image.id` в `backend/datasets_svc/task_routes.py`.
- Проверка: две страницы с 35 одинаковыми именами; все 38 выбранных новых кадров уникальны, `matched` не меняется. `tests/unit/test_cut_frames.py`.

## BUG-003 — переполнение страницы таски на узком экране

- Дата: 2026-11-10. Статус: исправлен; выложен на VORAN-01 2026-11-10 (`03d2a17`).
- Условие: ширина 390 px, полный сайдбар и паспорт рядом с содержимым оставляли слишком мало места галерее; проверка обнаружила горизонтальное переполнение документа.
- Исправление: существующий компактный rail навигации для страниц отдельных тасок до 760 px; содержимое и паспорт в одну колонку до 1180 px, адаптивная сетка кадров и локальная прокрутка панели фильтров.
- Файлы: `frontend/src/components/mag/MagShell.tsx`, `frontend/src/styles/layout.css`.
- Проверка: браузерный тест без переполнения документа и галереи на 1366/1024/390 px, визуальная проверка скриншотов.

## BUG-004 — пустая таска в localStorage после прерванной загрузки

- Дата: 2026-11-10. Статус: открыт; механизм — гипотеза, исправления нет.
- Наблюдение: при быстрых reload/переходах в изолированном браузерном тесте сохранился `mag.cache.me:task:cut-task` с `task: {}`. При следующем входе страница упала на `task?.project.code` с `Cannot read properties of undefined (reading 'code')`. Повторялось до добавления ожидания готовности страницы в тесте.
- Предполагаемый путь: `frontend/src/auth/api.ts`, `asJson` заменяет ошибку чтения JSON на `{}` даже для успешного HTTP; `components/mag/tasks/useTaskPage.ts`, `loadMain` пишет ответ в кеш до проверки актуальности раунда в `load`. Обрыв чтения при навигации может записать неполную таску. Исходники этих мест просмотрены; причинность отдельно не доказана.
- Влияние: возможен сбой открытия таски из повреждённого локального кеша. На рабочем сервере дефект не воспроизводился и не проверялся.
- Следующий шаг: отдельный тест с контролируемым обрывом/задержкой тела ответа и переходом; затем исправление обработки JSON и/или записи устаревшего ответа в кеш с регрессионной проверкой. Ожидание готовности страницы в e2e не считать исправлением приложения.

## BUG-005 — все ролики и накопленные страницы кадров монтируются одновременно

- Дата: 2026-11-10. Статус: исправлен; выложен на VORAN-01 2026-11-10 (`03d2a17`). Проверка публикации — [выкладка](tasks/2026-11-10-release-voran.md).
- Свидетельства: `CutGroup` выводил `videos.map` без ограничения; `useFrames` объединял все подгруженные страницы в растущий массив. `VideoStrip` при монтировании запрашивает превью каждого ролика. При большой таске это даёт большой DOM и множество запросов превью.
- Исправление: по 50 роликов в каждой группе; не более 50 кадров суммарно в одной галерее, с заменой страниц вместо накопления. Фильтры охватывают весь список. Метаданные роликов в деталях таски по-прежнему приходят целиком.
- Файлы: `frontend/src/components/mag/tasks/Sources.tsx`, `CutFrames.tsx`, `frontend/src/auth/api.ts`, `backend/datasets_svc/task_routes.py`.
- Проверки: браузерная выборка 1000 нарезанных + 51 ненарезанный ролик и 1106 кадров, фильтры/переходы/уменьшение выборки, PostgreSQL-тест страниц 50/50/7, сборка. Подробности: [задача](tasks/2026-11-10-cut-pagination.md).

## BUG-006 — unbounded video rows in agent launch dialog

- Date: 2026-11-10. Status: committed `2b480a8`, deployed VORAN-01 on2026-11-11. Live context575videos/9tags, production-static1001-video browser fixture and health checks passed; [deployment evidence](tasks/2026-11-11-agent-picker-release.md).
- Evidence: `AgentRunDialog` mapped all eligible video rows without a limit; real-dialog browser regression reproduced1001 checkboxes (`Expected5, Received1001`). Scout/annotate video selection pushed subsequent settings below a very long list. Separate path from gallery BUG-005.
- Fix: shared `RunVideoPicker` preview5/expanded pages20, bounded scroll height, filename/tag filters, explicit full-filter bulk selection and hidden-selected count. Parent retains full eligible selection and existing scope constraints. Backend context includes authorized project tags and batched video tag links.
- Files: `frontend/src/components/agents/{AgentRunDialog,RunVideoPicker}.tsx`, `frontend/src/api/agents.ts`, `frontend/src/styles/graphed.css`, `backend/training_svc/agents.py`.
- Verification: build;1001-video actual-dialog regression including exact launch payload and preselected group scope;909/390px screenshot review;2 isolated PostgreSQL route tests for tags/links/foreign access. [Task and limitations](tasks/2026-11-10-agent-video-picker.md).

## REL-001 — restrictive static-file modes caused403 during deployment

- Date:2026-11-11. Status: fixed and successfully deployed; packaging issue, not application-source defect.
- Evidence: first agent-picker activation failed root HTTP403; new image index mode600/assets700 prevented nginx worker access. Automatic rollback restored previous image IDs; unrelated containers/data stayed unchanged.
- Fix: frontend overlay explicitly grants public-static read/directory search via `chmod -R a+rX /usr/share/nginx/html`; verified as user nginx before retry. Second activation exit0, HTTPS/root/health and production-static browser fixture passed.
- Prevention: preserve restrictive permissions for release configuration/backups, normalize permissions only for public web files when packaging static assets. [Full deployment evidence](tasks/2026-11-11-agent-picker-release.md).

## Уязвимости

Подтверждённых новых уязвимостей приложения не установлено; отдельный аудит безопасности не проводился. Проверки авторизации и ограничения тагов проектом для запроса кадров прошли.

### DEP-001 — npm сообщает об уязвимостях существующих зависимостей

- Дата: 2026-11-10. Статус: сообщение инструмента, применимость к приложению не проверена.
- Свидетельство: автоматический `npm install` задачи сборки сообщил `13 vulnerabilities (4 moderate, 7 high, 2 critical)`, установленные пакеты уже были актуальны согласно lockfile. Изменений package.json/package-lock.json в задаче нет.
- Влияние и конкретные затронутые пакеты/advisory не определены. Не считать сообщение подтверждением эксплуатации или уязвимости приложения.
- Следующий шаг: при отдельной работе с зависимостями разобрать `npm audit`, отделить dev/prod и оценить совместимое обновление с проверками. Автоматический `npm audit fix --force` не запускался.

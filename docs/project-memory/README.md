# Память проекта «Магистраль ML» / training-rzd

Обновлено: 2026-11-11. Основной checkout: `C:/Users/1/Documents/WebStorm/training-rzd`. Это отдельный проект от `RJD` и «Мост».

## Как пользоваться

На каждой задаче прочитай этот индекс и [найденные проблемы](findings.md), затем только относящиеся к запросу записи ниже. Рабочий процесс закреплён скиллом [training-rzd-project](C:/Users/1/.codex/skills/training-rzd-project/SKILL.md) и корневым `AGENTS.md`.

Пользователь поручил после каждой завершённой задачи сохранять результат в `tasks/YYYY-MM-DD-<topic>.md`, для крупных изменений — также структуру добавленного, а баги и уязвимости — в `findings.md`. Обновляй этот индекс и статусы проблем перед финальным ответом. Если установленный скилл недоступен, эта инструкция остаётся действующей.

Записи содержат свидетельства на указанную дату, а не гарантию текущего состояния сервера или Git. Проверяй изменчивые факты перед действиями. Секреты доступа здесь не хранить.

## Текущее состояние

- Agent launch dialog: compact scout/annotate video picker, preview5/expanded pages20, filename/tag filters and explicit bulk/hidden selection. Feature commit `2b480a8` deployed on VORAN-01 on2026-11-11 (training/training-worker/frontend); other services remain on `03d2a17`. Live context575videos/9tags, production-static1001-video browser fixture and health checks passed. Static-permissions403 caught, rolled back and fixed before successful activation (`REL-001`). No GitHub push. [Implementation](tasks/2026-11-10-agent-video-picker.md), [deployment/current operations](tasks/2026-11-11-agent-picker-release.md).

- Галерея/группы роликов закоммичены как `3fe6913`, пагинация по 50 — `03d2a17`; приложение успешно выложено на VORAN-01 из коммита `03d2a17`. Сборка, 26 frontend-тестов, 10 PostgreSQL-тестов и браузерная проверка 1000 роликов прошли; после выкладки проверены health API, HTTPS и новый frontend. [Пагинация](tasks/2026-11-10-cut-pagination.md), [выкладка и обслуживание](tasks/2026-11-10-release-voran.md). Push в GitHub не выполнялся.

- Общая серверная память проекта заполнена: структура, стек, стиль, решения, баги и отложенное. Подробная память репозитория остаётся основным источником; [синхронизация памяти](tasks/2026-11-10-memory-sync.md).

- Latest release: `/home/voran/releases/training-rzd-agent-picker-20261111-2b480a8/compose.runtime.json` controls updated training/training-worker/frontend; unchanged services retain prior release labels/images (`training-rzd-cut-pages-20261110-03d2a17`). Check actual container labels before future updates. Original `/home/voran/training-rzd` and its local edits remain preserved; do not run its old compose blindly.
- Локальная ветка `video-ranges`. В опубликованный код вошли также ранее созданные `97fa405` (прогресс загрузки видео), `8c19deb` (имя датасета) и `11c147f` (параллельные агенты). Для последнего применена миграция `f0a1b2c3d4e5`; перед переключением создана резервная копия БД. Подробная история галереи — в [записи задачи](tasks/2026-11-10-cut-video-groups.md).
- Открыта проблема `BUG-004`: во время браузерной проверки наблюдалось повреждение кеша таски при прерывании загрузки. Причина предполагаемая, исправления нет. См. [реестр](findings.md).
- Память проекта создана по прямому поручению пользователя; обязательное применение скилла закреплено в локальном `AGENTS.md`, который исключён из Git правилом `/AGENTS.md`.

## Записи задач

- [2026-11-11 — agent picker commit and successful VORAN-01 deployment](tasks/2026-11-11-agent-picker-release.md).
- [2026-11-10 — compact scout/annotate video picker and tag filters](tasks/2026-11-10-agent-video-picker.md).

- [2026-11-10 — коммиты по задачам и выкладка на Ворана](tasks/2026-11-10-release-voran.md).
- [2026-11-10 — пагинация роликов и кадров по 50](tasks/2026-11-10-cut-pagination.md).
- [2026-11-10 — синхронизация общей памяти](tasks/2026-11-10-memory-sync.md).
- [2026-11-10 — постоянная память проекта и скилл](tasks/2026-11-10-project-memory.md).
- [2026-11-10 — группы роликов на нарезку и общая галерея кадров](tasks/2026-11-10-cut-video-groups.md).

## Устойчивые решения

- Макеты и изменения UI опираются на реальные компоненты, шрифты и стили приложения; согласованный макет — основание для внедрения.
- Для текущей галереи подтверждённая разметка и фон — размеченные кадры. Кадр с `pending` разметкой модели остаётся неразмеченным до проверки человеком.
- Действия с исходниками, коммитом, push и выкладкой фиксируются отдельно. Поручение сохранять память само по себе не разрешает публикацию или перезапуск.

# 2026-11-10 — compact agent video picker

Request: limit the long video list in the scouting/annotation launch dialog, allow expansion and add filters including tags. Preserve the current product design.

## Result and structure

- Added `frontend/src/components/agents/RunVideoPicker.tsx`, used by the existing `AgentRunDialog` in both `scout` and `annotate` modes. The dialog still owns the selected IDs and constructs launch/capacity requests from the complete eligible selection. Its existing `initial.within`, mode restrictions and preselection remain authoritative.
- Picker owns display state only: filename search (case-insensitive), any-of project-tag filter, preview/expansion and page index. Preview mounts at most 5 video rows; expansion mounts at most 20 rows per page, with a 240px scroll area and existing `Pager`. Filter changes reset the page; bounds are clamped. Mode changes remount/reset picker display state.
- Bulk checkbox explicitly selects all matching videos across pages. Individual selection, filtering, paging and folding preserve selection; summary reports total selected and selected outside current filters. `Снять выбор` clears the whole selection; `Сбросить` resets filters only. Empty results explain how to recover.
- Reused existing `FilterTags`, `Input`, `Check`, `Button` and product tokens/fonts. Scoped `ar-video-*` rules in `frontend/src/styles/graphed.css`; narrow screens stack frame/mode metadata under truncated filenames.
- `backend/training_svc/agents.py::_context` now adds `tag_ids` to task video rows and project `tags` to task context. Existing `common.tags.of` loads links in one batch and `project_tags` scopes the dictionary to the authorized project. Video order uses created_at + unique ID. `frontend/src/api/agents.ts` describes additive optional fields for compatibility with older context fixtures/responses. No new endpoints, migrations or dependencies.

## Confirmed defect BUG-006

`AgentRunDialog` mapped every eligible video directly into checkboxes, so selecting scout/annotate could mount hundreds/thousands of rows and push remaining settings far below the list. Browser regression reproduced 1001 rows before the fix (`Expected: 5, Received: 1001`). This is a separate launch-dialog path from the previously fixed task gallery (BUG-005).

## Validation

- `frontend-build`: TypeScript + Vite build passed; existing large-bundle warning only, no package changes.
- `cut-gallery-e2e`: passed with real TaskPage/dialog components and isolated API routes. Added 1001 context videos, 5-row preview, 20-row expansion/height bound, page 25, search beyond first page/case normalization, tag filtering and bulk selection of 500, filter reset/page reset, empty result, hidden selection, exact 500-ID launch payload, annotate-only eligibility/zero-selection disable, and preserved 1000-ID initial group scope excluding the other 51 videos. Existing gallery/editor/read-only scenarios also passed.
- Screenshot review: collapsed dialog at 909×718 and 390×844, including a long camera filename, plus expanded picker at 1440×960. No horizontal dialog overflow; filenames truncate and the launch footer stays accessible. Images in ignored `tests/e2e/test-results/cut-video-groups/agent-picker-*.png`.
- `tests/unit/test_agent_run_context.py`: 2 tests passed against real Flask route and isolated temporary PostgreSQL 16 in existing `training-rzd-tests:latest`. Checked project tag dictionary, linked/untagged videos, frame totals and foreign-task denial. No production DB/model inference; temporary database container removed by trap.
- `git diff --check`: passed (Windows LF/CRLF notices only).

## Source/publication status and limitations

Implementation status on 2026-11-10: local changes only; own Vite stopped after verification and unrelated memory/experiment changes preserved. Follow-up 2026-11-11: committed as `2b480a8` and successfully deployed to VORAN-01 (training/training-worker/frontend), with live context and production-static browser checks; no GitHub push. See [deployment evidence and current operational reference](2026-11-11-agent-picker-release.md).

Metadata for all videos still comes in context JSON; mounted rows are bounded. Tag filtering on deployment needs the updated backend context together with the frontend. Actual production dialog/data were not exercised. No model runs or annotation writes were performed.

Graph query was used to locate the agent context; its saved source line numbers differ from current files. Current behavior was verified in source; graph not rebuilt.

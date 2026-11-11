# 2026-11-11 — agent video picker commit and VORAN-01 deployment

User request: commit the compact scouting/annotation video picker and deploy it to the server.

## Committed and deployed

- Feature commit: `2b480a8fb281e14866b409f87d0362ad37e09cc2` (`Агенты: ограничить список роликов и добавить фильтры`), branch `video-ranges`. Contains frontend picker/styles/API types, training context tag metadata, browser/PostgreSQL regressions and implementation task record. Existing unrelated ML memory/attachment changes were preserved.
- No GitHub push. Git bundle transferred from PC, checked on both ends with SHA256 and `git bundle verify`, fetched into the existing server repo without switching its HEAD/working tree. Detached worktree at `/home/voran/releases/training-rzd-agent-picker-20261111-2b480a8/source` points to the exact feature commit.
- Fresh `frontend-build` passed, same `index-Br51JPBF.js`/`index-DyBj1h-2.css` as implementation verification. Compiled static package SHA256 verified at upload; source frontend/backend/tests had no uncommitted changes relative to the feature commit.
- Deployment updates only `training`, `training-worker` and `frontend`, using images `training-rzd-training:agent-picker-2b480a8` and `training-rzd-frontend:agent-picker-2b480a8`. Training overlay replaces only `training_svc/agents.py` over the exact previous image ID; requirements hash matches. Frontend overlay replaces/adds public static files while retaining old hashed assets, nginx configuration and TLS.
- Other services remain on their prior images/containers (code `03d2a17`); DB/mail and old server checkout IDs/status verified unchanged. No dependencies or migrations changed; schema remains `f0a1b2c3d4e5`. Before activation, all background-work queues were idle and a database dump was saved server-side.

## Deployment issue and recovery (REL-001)

First activation failed the root HTTP check with403. New static files were mode600 and assets directory700 after restrictive release extraction; nginx worker could not read/traverse them. Automatic rollback restored the exact previous image IDs (verified).

Rebuilt frontend overlay with `RUN chmod -R a+rX /usr/share/nginx/html`. Verified public index/assets access as user `nginx`, refreshed the pre-activation container snapshot after checking rollback and unchanged other containers, then repeated activation. Second `activate.exit=0`, journal ends `DEPLOY COMPLETE`. First attempt journal/exit retained as `activate-attempt1.*`. This was a release-packaging problem, not a new application-source change.

Preparation also caught legacy compose labels on DB/mail: only the three updated services must use the expected prior release configuration; unchanged DB/mail legitimately retain earlier labels. Preparation stopped before changing running containers; corrected the guard and continued. Initial upload retried with `MSYS_NO_PATHCONV=1` because Git Bash rewrote a remote absolute path. No permissions/refusals were bypassed.

## Verification after deployment

- Root HTTPS, `/api/auth/health`, `/api/health`: successful200; nginx configuration valid, training worker healthy.
- Both training container source hashes match the committed `agents.py`; frontend index bytes match the packaged build. Other container IDs and original server Git working-tree status unchanged.
- Read-only `_context` check in the live training service on an existing in-progress task:9 project tags,575 videos, every video includes `tag_ids`, all linked IDs belong to the project, admin run permission valid. No sessions, annotations, model runs or project data created/changed.
- Actual production static bundle exercised in PC Chrome with the existing API-isolated TaskPage/browser fixture:1001-video picker, preview5/expanded20/bounded height, search/tag filters, bulk/hidden selection, exact500-ID launch payload, annotate eligibility,1000-ID initial group scope, responsive layouts, existing gallery/editor/empty/read-only paths all passed. Live health endpoints requested separately without fixture interception.
- The first browser run measured toolbar geometry before transition completion (8px difference, no page errors). Added waiting for existing finite animations to the ignored live-check adapter; unchanged assertions then passed. No application change or relaxed assertion.
- Viewed production-bundle screenshot at909×718. Screenshots and local deployment helpers are in ignored `design-mockups/2026-11-11-agent-picker/`; live fixture uses synthetic API data and must not be described as an authenticated production-user workflow.

## Operations and rollback reference

Release directory: `/home/voran/releases/training-rzd-agent-picker-20261111-2b480a8/`.

```bash
docker compose -p training-rzd -f /home/voran/releases/training-rzd-agent-picker-20261111-2b480a8/compose.runtime.json ps
```

The new runtime config retains the other service definitions/images, but only training/training-worker/frontend were recreated. Inspect actual container compose labels before future updates; unchanged services still reference the prior release configuration. Do not run the old root checkout compose blindly.

Server-only protected files include `compose.before.json`, `compose.runtime.json`, initial/before/after container snapshots, `database-before.dump`, build/activation logs and revision/time markers. They may contain configuration secrets and must not be copied into Git/memory. Previous image tags are `training-rzd-{training,frontend}:before-agent-picker-2b480a8`. No automatic DB restore is needed for this code-only release.

Final source status: feature commit deployed successfully; subsequent local memory-only commit records publication. No GitHub push. Unrelated pre-existing documentation/attachments remain outside this task's commits.

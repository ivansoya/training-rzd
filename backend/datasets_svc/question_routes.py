"""Вопросы в разметке (решения 29.10.2026): обсуждение спорного места таски.

Место — изображение таски или кадр ролика, по желанию объект на нём. Открытый вопрос
держит место в таске (`_accept` в task_routes) и не даёт закрыть таску. Пути — под
/api/tasks: nginx и прокси дева уже отдают их сервису данных.
"""
from flask import Blueprint, jsonify
from sqlalchemy import delete, func, select

from common import live, questions as qlib, task_rights
from common.auth import current_user, role_in
from common.db import SessionLocal
from common.models import (
    Annotation,
    Image,
    LabelClass,
    Project,
    QuestionInbox,
    QuestionMessage,
    Task,
    TaskQuestion,
    TaskVideo,
    User,
    VideoAnnotation,
    VideoTrack,
    utcnow,
)
from common.web import json_body
from datasets_svc.task_routes import _resolve_task, _team, _uuid_or_none

bp = Blueprint("questions", __name__)

CLOSED = ({"error": "Таска закрыта, вопросы только читаются.", "code": "task_closed"}, 409)


def _settle_ok(task, user, role, q):
    return task_rights.can_settle(task.status, role, user.id, _team(task), q.created_by)


def _alive(db, items):
    """Какие объекты вопросов ещё есть: рамку могли удалить, а вопрос остаётся с «объект удалён»."""
    want = {}
    for q in items:
        if q.object_id:
            want.setdefault(q.object_kind, set()).add(q.object_id)
    table = {"ann": Annotation, "track": VideoTrack, "box": VideoAnnotation}
    return {oid for kind, ids in want.items() if kind in table
            for oid in db.execute(select(table[kind].id).where(table[kind].id.in_(ids))).scalars()}


def _view(db, task, user, role, items):
    ids = [q.id for q in items]
    msgs = {}
    for m in db.execute(select(QuestionMessage).where(QuestionMessage.question_id.in_(ids))
                        .order_by(QuestionMessage.created_at)).scalars() if ids else []:
        msgs.setdefault(m.question_id, []).append(m)
    people = {q.created_by for q in items} | {q.resolved_by for q in items} | {
        m.author_id for ms in msgs.values() for m in ms}
    people.discard(None)
    # display_name — свойство, не колонка: людей читаем целиком
    names = {u.id: u.display_name for u in db.execute(select(User).where(User.id.in_(people))).scalars()} if people else {}
    cls = {q.class_id for q in items} - {None}
    classes = {c.id: c for c in db.execute(select(LabelClass).where(LabelClass.id.in_(cls))).scalars()} if cls else {}
    alive = _alive(db, items)
    open_ = task.status != "closed"
    out = []
    for q in items:
        c = classes.get(q.class_id)
        out.append({
            "id": str(q.id),
            "status": q.status,
            "place": q.place,
            "image_id": str(q.image_id) if q.image_id else None,
            "video_id": str(q.video_id) if q.video_id else None,
            "frame_no": q.frame_no,
            "time_ms": q.time_ms,
            "object_id": str(q.object_id) if q.object_id else None,
            "object_kind": q.object_kind,
            "object_gone": bool(q.object_id) and q.object_id not in alive,
            "class": {"id": str(c.id), "name": c.name, "color": c.color} if c else None,
            "author": names.get(q.created_by),
            "author_id": str(q.created_by) if q.created_by else None,
            "created_at": q.created_at.isoformat(),
            "last_at": q.last_at.isoformat(),
            "resolved_by": names.get(q.resolved_by),
            "resolved_at": q.resolved_at.isoformat() if q.resolved_at else None,
            "can_settle": _settle_ok(task, user, role, q),
            "messages": [{
                "id": str(m.id),
                "text": m.text,
                "author": names.get(m.author_id),
                "author_id": str(m.author_id) if m.author_id else None,
                "at": m.created_at.isoformat(),
                "edited": m.edited_at is not None,
                "can_edit": open_ and m.author_id == user.id,
            } for m in msgs.get(q.id, [])],
        })
    return out


def _question(db, task, qid):
    q = db.get(TaskQuestion, _uuid_or_none(qid)) if _uuid_or_none(qid) else None
    return q if q is not None and q.task_id == task.id else None


def _notify(db, task, user, q):
    live.notify(db, "question", task.id, task.project_id, u=str(user.id), q=str(q.id))


def _inbox(db, users, q, kind, message_id):
    """Строка колокольчика на вопрос — последнее событие: новое заменяет прежнее."""
    if not users:
        return
    db.execute(delete(QuestionInbox).where(QuestionInbox.question_id == q.id, QuestionInbox.user_id.in_(users)))
    now = utcnow()
    for uid in users:
        db.add(QuestionInbox(user_id=uid, question_id=q.id, kind=kind, message_id=message_id, at=now))


@bp.get("/api/tasks/<task_id>/questions")
def list_questions(task_id):
    """Все вопросы таски с обсуждениями: страница берёт открытые, «показать решённые» — остальные."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        items = db.execute(select(TaskQuestion).where(TaskQuestion.task_id == task.id)
                           .order_by(TaskQuestion.last_at.desc())).scalars().all()
        return jsonify({"questions": _view(db, task, user, role, items),
                        "can_ask": task_rights.can_ask(task.status, role)})
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/questions")
def ask(task_id):
    """Вопрос к изображению таски или к кадру ролика; объект — по желанию."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        if not task_rights.can_ask(task.status, role):
            body, code = CLOSED
            return jsonify(body), code
        data = json_body()
        text, bad = qlib.text_of(data.get("text"))
        if bad:
            return jsonify({"error": bad}), 400
        q = TaskQuestion(task_id=task.id, created_by=user.id)
        image_id, video_id = _uuid_or_none(data.get("image_id")), _uuid_or_none(data.get("video_id"))
        kind, oid = data.get("object_kind"), _uuid_or_none(data.get("object_id"))
        if image_id:
            image = db.get(Image, image_id)
            if image is None or image.task_id != task.id:
                return jsonify({"error": "Изображение не из этой таски."}), 400
            q.image_id, q.place = image.id, qlib.place(image.file_name)
            if oid:
                ann = db.get(Annotation, oid)
                if kind != "ann" or ann is None or ann.image_id != image.id:
                    return jsonify({"error": "Объект не найден — перечитайте кадр."}), 400
                q.object_id, q.object_kind, q.class_id = ann.id, "ann", ann.class_id
        elif video_id:
            video = db.get(TaskVideo, video_id)
            frame = data.get("frame_no")
            if video is None or video.task_id != task.id:
                return jsonify({"error": "Ролик не из этой таски."}), 400
            if not isinstance(frame, int) or isinstance(frame, bool) or frame < 0:
                return jsonify({"error": "frame_no: номер кадра ролика."}), 400
            q.video_id, q.frame_no = video.id, frame
            q.time_ms = round(frame * 1000 / video.fps) if video.fps else None
            q.place = qlib.place(video.file_name, q.time_ms if q.time_ms is not None else 0)
            if oid:
                if kind == "track":
                    obj = db.get(VideoTrack, oid)
                    ok = obj is not None and obj.video_id == video.id
                elif kind == "box":
                    obj = db.get(VideoAnnotation, oid)
                    ok = obj is not None and obj.video_id == video.id and obj.frame_no == frame
                else:
                    ok = False
                if not ok:
                    return jsonify({"error": "Объект не найден — перечитайте кадр."}), 400
                q.object_id, q.object_kind, q.class_id = obj.id, kind, obj.class_id
        else:
            return jsonify({"error": "Укажите изображение или кадр ролика."}), 400
        db.add(q)
        db.flush()
        msg = QuestionMessage(question_id=q.id, author_id=user.id, text=text)
        db.add(msg)
        db.flush()
        _inbox(db, qlib.to_new(_team(task), task.created_by, user.id), q, "new", msg.id)
        db.commit()
        _notify(db, task, user, q)
        return jsonify(_view(db, task, user, role, [q])[0]), 201
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/questions/<qid>/messages")
def reply(task_id, qid):
    """Ответ. В решённое тоже можно — и оно остаётся решённым: «спасибо, понял» не держит кадр снова."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        q = _question(db, task, qid)
        if q is None:
            return jsonify({"error": "Вопрос не найден."}), 404
        if not task_rights.can_ask(task.status, role):
            body, code = CLOSED
            return jsonify(body), code
        text, bad = qlib.text_of(json_body().get("text"))
        if bad:
            return jsonify({"error": bad}), 400
        authors = set(db.execute(select(QuestionMessage.author_id).where(QuestionMessage.question_id == q.id)).scalars())
        msg = QuestionMessage(question_id=q.id, author_id=user.id, text=text)
        db.add(msg)
        db.flush()
        q.last_at = msg.created_at
        _inbox(db, qlib.to_reply(q.created_by, authors, user.id), q, "reply", msg.id)
        db.commit()
        _notify(db, task, user, q)
        return jsonify(_view(db, task, user, role, [q])[0]), 201
    finally:
        db.close()


def _own_message(db, task, user, qid, mid):
    """(вопрос, сообщение, ошибка): править и удалять можно только своё и не в закрытой таске."""
    q = _question(db, task, qid)
    m = db.get(QuestionMessage, _uuid_or_none(mid)) if q and _uuid_or_none(mid) else None
    if q is None or m is None or m.question_id != q.id:
        return None, None, (jsonify({"error": "Сообщение не найдено."}), 404)
    if task.status == "closed":
        body, code = CLOSED
        return None, None, (jsonify(body), code)
    if m.author_id != user.id:
        return None, None, (jsonify({"error": "Править можно только своё сообщение."}), 403)
    return q, m, None


@bp.patch("/api/tasks/<task_id>/questions/<qid>/messages/<mid>")
def edit_message(task_id, qid, mid):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        q, m, err = _own_message(db, task, user, qid, mid)
        if err:
            return err
        text, bad = qlib.text_of(json_body().get("text"))
        if bad:
            return jsonify({"error": bad}), 400
        if text != m.text:
            m.text, m.edited_at = text, utcnow()
            db.commit()
            _notify(db, task, user, q)
        return jsonify(_view(db, task, user, role, [q])[0])
    finally:
        db.close()


@bp.delete("/api/tasks/<task_id>/questions/<qid>/messages/<mid>")
def delete_message(task_id, qid, mid):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        q, m, err = _own_message(db, task, user, qid, mid)
        if err:
            return err
        first = db.execute(select(QuestionMessage.id).where(QuestionMessage.question_id == q.id)
                           .order_by(QuestionMessage.created_at).limit(1)).scalar_one()
        if first == m.id:
            return jsonify({"error": "Это сам вопрос — его удаляют вместе с обсуждением.", "code": "first"}), 409
        db.delete(m)
        db.commit()
        _notify(db, task, user, q)
        return jsonify(_view(db, task, user, role, [q])[0])
    finally:
        db.close()


def _settle(task_id, qid, status):
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        q = _question(db, task, qid)
        if q is None:
            return jsonify({"error": "Вопрос не найден."}), 404
        if task.status == "closed":
            body, code = CLOSED
            return jsonify(body), code
        if not _settle_ok(task, user, role, q):
            return jsonify({"error": "Решают автор вопроса и те, кто правит таску."}), 403
        if q.status != status:
            q.status = status
            q.resolved_by, q.resolved_at = (user.id, utcnow()) if status == "resolved" else (None, None)
            if status == "resolved":
                # Решённое никого больше не ждёт — из колокольчиков уходит
                db.execute(delete(QuestionInbox).where(QuestionInbox.question_id == q.id))
            db.commit()
            _notify(db, task, user, q)
        return jsonify(_view(db, task, user, role, [q])[0])
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/questions/<qid>/resolve")
def resolve(task_id, qid):
    return _settle(task_id, qid, "resolved")


@bp.post("/api/tasks/<task_id>/questions/<qid>/reopen")
def reopen(task_id, qid):
    return _settle(task_id, qid, "open")


@bp.delete("/api/tasks/<task_id>/questions/<qid>")
def drop(task_id, qid):
    """Обсуждение целиком — для меток, поставленных по ошибке."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        q = _question(db, task, qid)
        if q is None:
            return jsonify({"error": "Вопрос не найден."}), 404
        if task.status == "closed":
            body, code = CLOSED
            return jsonify(body), code
        if not _settle_ok(task, user, role, q):
            return jsonify({"error": "Удаляют автор вопроса и те, кто правит таску."}), 403
        gone = q.id
        db.delete(q)
        db.commit()
        live.notify(db, "question", task.id, task.project_id, u=str(user.id), q=str(gone))
        return jsonify({"ok": True})
    finally:
        db.close()


@bp.post("/api/tasks/<task_id>/questions/<qid>/read")
def read(task_id, qid):
    """Обсуждение открыли — из колокольчика уходит."""
    db, task, project, user, role, err = _resolve_task(task_id)
    if err:
        return err
    try:
        db.execute(delete(QuestionInbox).where(QuestionInbox.user_id == user.id,
                                               QuestionInbox.question_id == _uuid_or_none(qid)))
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@bp.get("/api/tasks/questions-inbox")
def inbox():
    """Колокольчик: новые вопросы в ваших тасках и ответы там, где вы писали. Свежие сверху."""
    db = SessionLocal()
    try:
        user = current_user(db)
        if user is None:
            return jsonify({"error": "Не выполнен вход."}), 401
        rows = db.execute(
            select(QuestionInbox, TaskQuestion, Task, Project.code)
            .join(TaskQuestion, TaskQuestion.id == QuestionInbox.question_id)
            .join(Task, Task.id == TaskQuestion.task_id)
            .join(Project, Project.id == Task.project_id)
            .where(QuestionInbox.user_id == user.id)
            .order_by(QuestionInbox.at.desc()).limit(30)
        ).all()
        msgs = {m.id: m for m in db.execute(select(QuestionMessage).where(
            QuestionMessage.id.in_([r[0].message_id for r in rows if r[0].message_id]))).scalars()} if rows else {}
        people = {m.author_id for m in msgs.values()} - {None}
        names = {u.id: u.display_name for u in db.execute(select(User).where(User.id.in_(people))).scalars()} if people else {}
        out = []
        for row, q, task, code in rows:
            # Из проекта ушли — пункт молча пропускаем: ссылка всё равно не откроется
            if role_in(db, user, db.get(Project, task.project_id)) is None:
                continue
            m = msgs.get(row.message_id)
            out.append({
                "question_id": str(q.id), "kind": row.kind, "at": row.at.isoformat(),
                "task": {"id": str(task.id), "name": task.name, "project_code": code},
                "place": q.place, "image_id": str(q.image_id) if q.image_id else None,
                "video_id": str(q.video_id) if q.video_id else None, "frame_no": q.frame_no,
                "text": m.text[:200] if m else None, "author": names.get(m.author_id) if m else None,
            })
        return jsonify({"items": out, "total": db.execute(select(func.count()).select_from(QuestionInbox)
                                                         .where(QuestionInbox.user_id == user.id)).scalar_one()})
    finally:
        db.close()

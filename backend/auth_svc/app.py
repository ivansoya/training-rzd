"""Auth + core microservice: users, sessions, friends, projects, invitations.

Owns the database schema: the container entrypoint runs `alembic upgrade head`
before gunicorn starts (see Dockerfile).
"""
import click
from flask import Flask

from auth_svc.core import bp as core_bp
from auth_svc.routes import bp as auth_bp
from common import db, origin, web

db.wait_for_db()

app = Flask(__name__)
origin.guard(app)
web.register_json_errors(app)
web.served_by(app, "auth")
app.register_blueprint(auth_bp)
app.register_blueprint(core_bp)


@app.cli.command("grant-staff")
@click.argument("login")
@click.option("--level", type=click.Choice(["view", "manage", "none"]), default="manage",
              help="view — смотреть оборудование, manage — ещё настраивать и выдавать права.")
def grant_staff(login, level):
    """Права на оборудование — первому управляющему, без SQL руками:
    docker exec yolo-auth flask --app auth_svc.app grant-staff <логин>"""
    from sqlalchemy import select

    from common.models import User

    with db.SessionLocal() as session:
        user = session.execute(select(User).where(User.login == login)).scalar_one_or_none()
        if user is None:
            raise click.ClickException(f"Нет пользователя с логином «{login}».")
        user.hardware = None if level == "none" else level
        session.commit()
        click.echo(f"{login}: {level}")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

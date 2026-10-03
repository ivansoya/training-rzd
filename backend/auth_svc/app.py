"""Auth + core microservice: users, sessions, friends, projects, invitations.

Owns the database schema: the container entrypoint runs `alembic upgrade head`
before gunicorn starts (see Dockerfile).
"""
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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

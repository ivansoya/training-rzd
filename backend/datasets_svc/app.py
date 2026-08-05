"""Datasets microservice: the legacy file-based datasets of /tools, plus the
project data of the new site — importing YOLO archives into PostgreSQL and
serving the images behind them.

It is the only service holding both the yolo-data volume and a DB connection,
because an import needs the two at once: binaries on the volume, everything
queryable in the database.
"""
from flask import Flask
from flask_cors import CORS

from common import config, db, jobs
from datasets_svc.export_routes import bp as export_bp
from datasets_svc.project_routes import bp as project_bp
from datasets_svc.routes import bp
from datasets_svc.task_routes import bp as task_bp

config.ensure_dirs()
jobs.configure(config.JOBS_DIR)
db.wait_for_db()

app = Flask(__name__)
# No upload cap: real datasets are several GB; a cap aborts mid-transfer.
app.config["MAX_CONTENT_LENGTH"] = None
CORS(app, supports_credentials=True)
app.register_blueprint(bp)
app.register_blueprint(project_bp)
app.register_blueprint(task_bp)
app.register_blueprint(export_bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

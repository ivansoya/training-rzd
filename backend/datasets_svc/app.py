"""Datasets microservice: upload/validate/extract YOLO datasets, list them
(uploaded + augmented), serve stats, and serve background-job progress.
"""
from flask import Flask
from flask_cors import CORS

from common import config, jobs
from datasets_svc.routes import bp

config.ensure_dirs()
jobs.configure(config.JOBS_DIR)

app = Flask(__name__)
# No upload cap: real datasets are several GB; a cap aborts mid-transfer.
app.config["MAX_CONTENT_LENGTH"] = None
CORS(app)
app.register_blueprint(bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

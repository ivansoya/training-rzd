"""Training microservice: YOLO training (subprocess + SSE), model registry,
device discovery, inference over library videos, and the video library.
"""
from flask import Flask
from flask_cors import CORS

from common import config, jobs
from training_svc.routes import bp

config.ensure_dirs()
jobs.configure(config.JOBS_DIR)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = None
CORS(app)
app.register_blueprint(bp)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

from flask import Flask, Blueprint

bp = Blueprint("admin", __name__, url_prefix="/admin")

@bp.route("/stats", methods=["GET", "POST"])
def stats():
    return ""

app = Flask(__name__)
app.register_blueprint(bp)

@app.route("/ping")
def ping():
    return "pong"

import json
import os
import queue
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, render_template, request, stream_with_context
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError


load_dotenv()

app = Flask(__name__)

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "drone_rescue")

mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = mongo_client[MONGO_DB_NAME]
detections = db["detections"]

# event_id 중복 저장 방지
detections.create_index([("event_id", ASCENDING)], unique=True)
detections.create_index([("detected_at", DESCENDING)])

KST = ZoneInfo("Asia/Seoul")

ALLOWED_STATUSES = {
    "unverified",
    "checking",
    "confirmed",
    "false_positive",
    "resolved",
}


class DetectionBroadcaster:
    """새 탐지 기록을 구독 중인 SSE 클라이언트들에게 흘려보낸다."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue] = set()

    def subscribe(self) -> queue.Queue:
        client_queue: queue.Queue = queue.Queue()
        with self._lock:
            self._subscribers.add(client_queue)
        return client_queue

    def unsubscribe(self, client_queue: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(client_queue)

    def publish(self, detection: dict) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for client_queue in subscribers:
            client_queue.put(detection)


broadcaster = DetectionBroadcaster()


def parse_local_datetime(value: str) -> datetime:
    """브라우저의 datetime-local 값을 KST로 보고 UTC datetime으로 변환한다."""
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KST)
    return parsed.astimezone(timezone.utc)


def to_kst_iso(value: datetime | None) -> str | None:
    """MongoDB에서 읽은 UTC datetime을 KST ISO 문자열로 변환한다."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(KST).isoformat()


def serialize_detection(document: dict) -> dict:
    return {
        "event_id": document["event_id"],
        "detected_at": to_kst_iso(document.get("detected_at")),
        "location": document.get("location", {}),
        "person_count": document.get("person_count"),
        "confidence": document.get("confidence"),
        "status": document.get("status"),
        "received_at": to_kst_iso(document.get("received_at")),
        "updated_at": to_kst_iso(document.get("updated_at")),
    }


def validate_detection_payload(data: dict) -> tuple[dict | None, str | None]:
    try:
        detected_at_raw = str(data["detected_at"]).strip()
        location = data["location"]

        latitude = float(location["latitude"])
        longitude = float(location["longitude"])
        altitude_m = float(location["altitude_m"])
        person_count = int(data["person_count"])
        confidence = float(data["confidence"])
        detected_at = parse_local_datetime(detected_at_raw)
    except (KeyError, TypeError, ValueError):
        return None, "입력 데이터 형식이 올바르지 않습니다."

    if not -90 <= latitude <= 90:
        return None, "위도는 -90에서 90 사이여야 합니다."
    if not -180 <= longitude <= 180:
        return None, "경도는 -180에서 180 사이여야 합니다."
    if person_count < 1:
        return None, "탐지 인원은 1명 이상이어야 합니다."
    if not 0 <= confidence <= 1:
        return None, "신뢰도는 0에서 1 사이여야 합니다."

    return {
        "detected_at": detected_at,
        "location": {
            "latitude": latitude,
            "longitude": longitude,
            "altitude_m": altitude_m,
        },
        "person_count": person_count,
        "confidence": confidence,
    }, None


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/api/detections", methods=["GET"])
def get_detections():
    try:
        documents = detections.find().sort("detected_at", DESCENDING)
        return jsonify({
            "result": "success",
            "detections": [serialize_detection(doc) for doc in documents],
        })
    except PyMongoError:
        return jsonify({
            "result": "fail",
            "msg": "MongoDB에서 탐지 기록을 불러오지 못했습니다.",
        }), 500


@app.route("/api/detections", methods=["POST"])
def create_detection():
    data = request.get_json(silent=True) or {}
    validated, error = validate_detection_payload(data)

    if error:
        return jsonify({"result": "fail", "msg": error}), 400

    now = datetime.now(timezone.utc)

    document = {
        "event_id": f"DET-{now.astimezone(KST):%Y%m%d%H%M%S}-{uuid4().hex[:6].upper()}",
        **validated,
        "status": "unverified",
        "received_at": now,
        "updated_at": now,
    }

    try:
        detections.insert_one(document)
    except DuplicateKeyError:
        return jsonify({
            "result": "fail",
            "msg": "탐지 ID가 중복되었습니다. 다시 시도해 주세요.",
        }), 409
    except PyMongoError:
        return jsonify({
            "result": "fail",
            "msg": "MongoDB에 탐지 기록을 저장하지 못했습니다.",
        }), 500

    serialized = serialize_detection(document)
    broadcaster.publish(serialized)

    return jsonify({
        "result": "success",
        "msg": "탐지 기록이 저장되었습니다.",
        "detection": serialized,
    }), 201


@app.route("/api/detections/stream")
def stream_detections():
    def event_stream():
        client_queue = broadcaster.subscribe()
        try:
            while True:
                detection = client_queue.get()
                yield f"data: {json.dumps(detection)}\n\n"
        finally:
            broadcaster.unsubscribe(client_queue)

    return Response(
        stream_with_context(event_stream()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/detections/<event_id>/status", methods=["PATCH"])
def update_detection_status(event_id: str):
    data = request.get_json(silent=True) or {}
    status = data.get("status")

    if status not in ALLOWED_STATUSES:
        return jsonify({
            "result": "fail",
            "msg": "허용되지 않은 상태값입니다.",
        }), 400

    try:
        result = detections.update_one(
            {"event_id": event_id},
            {
                "$set": {
                    "status": status,
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )
    except PyMongoError:
        return jsonify({
            "result": "fail",
            "msg": "상태 변경 중 오류가 발생했습니다.",
        }), 500

    if result.matched_count == 0:
        return jsonify({
            "result": "fail",
            "msg": "해당 탐지 기록을 찾을 수 없습니다.",
        }), 404

    return jsonify({
        "result": "success",
        "msg": "상태가 변경되었습니다.",
    })


@app.route("/api/detections/<event_id>", methods=["DELETE"])
def delete_detection(event_id: str):
    try:
        result = detections.delete_one({"event_id": event_id})
    except PyMongoError:
        return jsonify({
            "result": "fail",
            "msg": "삭제 중 오류가 발생했습니다.",
        }), 500

    if result.deleted_count == 0:
        return jsonify({
            "result": "fail",
            "msg": "해당 탐지 기록을 찾을 수 없습니다.",
        }), 404

    return jsonify({
        "result": "success",
        "msg": "탐지 기록이 삭제되었습니다.",
    })


# if __name__ == "__main__":
#     # AWS 배포 시에는 debug=False로 두고 Gunicorn 등으로 실행한다.
#     app.run(host="0.0.0.0", port=5000, debug=True)
if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True,
        use_reloader=False,
        threaded=True,
    )

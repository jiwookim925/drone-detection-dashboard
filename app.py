import json
import os
import queue
import threading
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from uuid import uuid4

from dotenv import load_dotenv
from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    stream_with_context,
)
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import DuplicateKeyError, PyMongoError


load_dotenv()

app = Flask(__name__)

MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
MONGO_DB_NAME = os.getenv("MONGO_DB_NAME", "drone_rescue")

mongo_client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=5000,
)

db = mongo_client[MONGO_DB_NAME]
detections = db["detections"]

# event_id 중복 저장 방지
detections.create_index(
    [("event_id", ASCENDING)],
    unique=True,
)
detections.create_index(
    [("detected_at", DESCENDING)]
)

KST = ZoneInfo("Asia/Seoul")

ALLOWED_STATUSES = {
    "unverified",
    "checking",
    "confirmed",
    "false_positive",
    "resolved",
}


# =========================================================
# SSE Broadcaster
# =========================================================

class DetectionBroadcaster:
    """SSE 구독 클라이언트들에게 데이터를 전달한다."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers: set[queue.Queue] = set()

    def subscribe(self) -> queue.Queue:
        client_queue = queue.Queue()

        with self._lock:
            self._subscribers.add(client_queue)

        return client_queue

    def unsubscribe(
        self,
        client_queue: queue.Queue,
    ) -> None:

        with self._lock:
            self._subscribers.discard(client_queue)

    def publish(
        self,
        data: dict,
    ) -> None:

        with self._lock:
            subscribers = list(self._subscribers)

        for client_queue in subscribers:
            client_queue.put(data)


broadcaster = DetectionBroadcaster()


# =========================================================
# Datetime helpers
# =========================================================

def parse_local_datetime(value: str) -> datetime:
    """
    datetime-local 값을 KST로 보고
    UTC datetime으로 변환한다.
    """

    parsed = datetime.fromisoformat(value)

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KST)

    return parsed.astimezone(timezone.utc)


def to_kst_iso(
    value: datetime | None,
) -> str | None:

    if value is None:
        return None

    if value.tzinfo is None:
        value = value.replace(
            tzinfo=timezone.utc
        )

    return value.astimezone(KST).isoformat()


# =========================================================
# Track validation
# =========================================================

def validate_tracks_payload(
    raw_tracks,
) -> list[dict]:
    """
    Jetson server_gateway_node가 보내는
    ByteTrack tracks 배열을 검증한다.

    잘못된 track 하나 때문에 전체 요청을
    실패시키지 않고 해당 track만 제외한다.
    """

    validated_tracks = []

    if not isinstance(raw_tracks, list):
        return validated_tracks

    for raw_track in raw_tracks:

        if not isinstance(raw_track, dict):
            continue

        try:
            track_id = int(
                raw_track["track_id"]
            )

            confidence = float(
                raw_track["confidence"]
            )

        except (
            KeyError,
            TypeError,
            ValueError,
        ):
            continue

        # confidence는 0~1
        if not 0.0 <= confidence <= 1.0:
            continue

        distance_m = raw_track.get(
            "distance_m"
        )

        if distance_m is not None:

            try:
                distance_m = float(
                    distance_m
                )

            except (
                TypeError,
                ValueError,
            ):
                distance_m = None

        validated_tracks.append({
            "track_id": track_id,
            "confidence": confidence,
            "distance_m": distance_m,
        })

    return validated_tracks


# =========================================================
# Detection serialization
# =========================================================

def serialize_detection(
    document: dict,
) -> dict:

    return {
        "event_id":
            document["event_id"],

        "detected_at":
            to_kst_iso(
                document.get("detected_at")
            ),

        "location":
            document.get(
                "location",
                {},
            ),

        "person_count":
            document.get(
                "person_count"
            ),

        "confidence":
            document.get(
                "confidence"
            ),

        # ByteTrack 연동 이전의 과거 데이터는
        # tracks가 없으므로 [] 처리
        "tracks":
            document.get(
                "tracks",
                [],
            ),

        "status":
            document.get(
                "status"
            ),

        "received_at":
            to_kst_iso(
                document.get("received_at")
            ),

        "updated_at":
            to_kst_iso(
                document.get("updated_at")
            ),
    }


# =========================================================
# Detection payload validation
# =========================================================

def validate_detection_payload(
    data: dict,
) -> tuple[dict | None, str | None]:

    try:
        detected_at_raw = str(
            data["detected_at"]
        ).strip()

        person_count = int(
            data["person_count"]
        )

        confidence = float(
            data["confidence"]
        )

        detected_at = (
            parse_local_datetime(
                detected_at_raw
            )
        )

    except (
        KeyError,
        TypeError,
        ValueError,
    ):
        return (
            None,
            "입력 데이터 형식이 올바르지 않습니다.",
        )

    # ByteTrack 정보
    # optional
    validated_tracks = (
        validate_tracks_payload(
            data.get(
                "tracks",
                [],
            )
        )
    )

    # GPS는 아직 미연동
    # location이 없어도 0,0,0으로 처리
    location_raw = (
        data.get("location")
        or {}
    )

    try:
        latitude = float(
            location_raw.get(
                "latitude",
                0.0,
            )
        )

        longitude = float(
            location_raw.get(
                "longitude",
                0.0,
            )
        )

        altitude_m = float(
            location_raw.get(
                "altitude_m",
                0.0,
            )
        )

    except (
        TypeError,
        ValueError,
    ):
        return (
            None,
            "위치 데이터 형식이 올바르지 않습니다.",
        )

    if not -90 <= latitude <= 90:
        return (
            None,
            "위도는 -90에서 90 사이여야 합니다.",
        )

    if not -180 <= longitude <= 180:
        return (
            None,
            "경도는 -180에서 180 사이여야 합니다.",
        )

    if person_count < 1:
        return (
            None,
            "탐지 인원은 1명 이상이어야 합니다.",
        )

    if not 0 <= confidence <= 1:
        return (
            None,
            "신뢰도는 0에서 1 사이여야 합니다.",
        )

    return {
        "detected_at":
            detected_at,

        "location": {
            "latitude":
                latitude,

            "longitude":
                longitude,

            "altitude_m":
                altitude_m,
        },

        "person_count":
            person_count,

        "confidence":
            confidence,

        "tracks":
            validated_tracks,

    }, None


# =========================================================
# Home
# =========================================================

@app.route("/")
def home():
    return render_template(
        "index.html"
    )


# =========================================================
# Detection history GET
# =========================================================

@app.route(
    "/api/detections",
    methods=["GET"],
)
def get_detections():

    try:
        documents = (
            detections
            .find()
            .sort(
                "detected_at",
                DESCENDING,
            )
        )

        return jsonify({
            "result":
                "success",

            "detections": [
                serialize_detection(doc)
                for doc in documents
            ],
        })

    except PyMongoError:

        return jsonify({
            "result":
                "fail",

            "msg":
                "MongoDB에서 탐지 기록을 불러오지 못했습니다.",
        }), 500


# =========================================================
# New detection EVENT
# MongoDB 저장 O
# =========================================================

@app.route(
    "/api/detections",
    methods=["POST"],
)
def create_detection():

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    validated, error = (
        validate_detection_payload(
            data
        )
    )

    if error:
        return jsonify({
            "result":
                "fail",

            "msg":
                error,
        }), 400

    now = datetime.now(
        timezone.utc
    )

    document = {
        "event_id":
            (
                f"DET-"
                f"{now.astimezone(KST):%Y%m%d%H%M%S}-"
                f"{uuid4().hex[:6].upper()}"
            ),

        **validated,

        "status":
            "unverified",

        "received_at":
            now,

        "updated_at":
            now,
    }

    try:
        detections.insert_one(
            document
        )

    except DuplicateKeyError:

        return jsonify({
            "result":
                "fail",

            "msg":
                "탐지 ID가 중복되었습니다. 다시 시도해 주세요.",
        }), 409

    except PyMongoError:

        return jsonify({
            "result":
                "fail",

            "msg":
                "MongoDB에 탐지 기록을 저장하지 못했습니다.",
        }), 500

    serialized = (
        serialize_detection(
            document
        )
    )

    # SSE:
    # 새 탐지 이벤트임을 명확히 구분
    broadcaster.publish({
        "type":
            "event",

        "detection":
            serialized,
    })

    return jsonify({
        "result":
            "success",

        "msg":
            "탐지 기록이 저장되었습니다.",

        "detection":
            serialized,

    }), 201


# =========================================================
# LIVE tracking
# MongoDB 저장 X
# =========================================================

@app.route(
    "/api/live",
    methods=["POST"],
)
def update_live_detection():

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    tracks = (
        validate_tracks_payload(
            data.get(
                "tracks",
                [],
            )
        )
    )

    live_data = {
        "type":
            "live",

        # 실제 유효 track 개수 사용
        "person_count":
            len(tracks),

        "tracks":
            tracks,

        "received_at":
            datetime.now(
                timezone.utc
            ).isoformat(),
    }

    # MongoDB 저장하지 않음
    # 웹에 SSE로만 전송
    broadcaster.publish(
        live_data
    )

    return jsonify({
        "result":
            "success"
    }), 200


# =========================================================
# SSE Stream
# =========================================================

@app.route(
    "/api/detections/stream"
)
def stream_detections():

    def event_stream():

        client_queue = (
            broadcaster.subscribe()
        )

        print(
            "[SSE] client connected",
            flush=True,
        )

        try:

            # 연결 즉시 응답
            yield ": connected\n\n"

            while True:

                try:
                    data = (
                        client_queue.get(
                            timeout=15
                        )
                    )

                    print(
                        f"[SSE] sending "
                        f"type={data.get('type')}",
                        flush=True,
                    )

                    yield (
                        "data: "
                        + json.dumps(
                            data,
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )

                except queue.Empty:

                    # SSE 연결 유지
                    yield ": keep-alive\n\n"

        finally:

            broadcaster.unsubscribe(
                client_queue
            )

            print(
                "[SSE] client disconnected",
                flush=True,
            )

    return Response(
        stream_with_context(
            event_stream()
        ),

        content_type=
            "text/event-stream",

        headers={
            "Cache-Control":
                "no-cache",

            "X-Accel-Buffering":
                "no",
        },
    )


# =========================================================
# Status PATCH
# =========================================================

@app.route(
    "/api/detections/<event_id>/status",
    methods=["PATCH"],
)
def update_detection_status(
    event_id: str,
):

    data = (
        request.get_json(
            silent=True
        )
        or {}
    )

    status = data.get(
        "status"
    )

    if status not in ALLOWED_STATUSES:

        return jsonify({
            "result":
                "fail",

            "msg":
                "허용되지 않은 상태값입니다.",
        }), 400

    try:
        result = (
            detections.update_one(
                {
                    "event_id":
                        event_id
                },

                {
                    "$set": {
                        "status":
                            status,

                        "updated_at":
                            datetime.now(
                                timezone.utc
                            ),
                    }
                },
            )
        )

    except PyMongoError:

        return jsonify({
            "result":
                "fail",

            "msg":
                "상태 변경 중 오류가 발생했습니다.",
        }), 500

    if result.matched_count == 0:

        return jsonify({
            "result":
                "fail",

            "msg":
                "해당 탐지 기록을 찾을 수 없습니다.",
        }), 404

    return jsonify({
        "result":
            "success",

        "msg":
            "상태가 변경되었습니다.",
    })


# =========================================================
# Detection DELETE
# =========================================================

@app.route(
    "/api/detections/<event_id>",
    methods=["DELETE"],
)
def delete_detection(
    event_id: str,
):

    try:
        result = (
            detections.delete_one({
                "event_id":
                    event_id
            })
        )

    except PyMongoError:

        return jsonify({
            "result":
                "fail",

            "msg":
                "삭제 중 오류가 발생했습니다.",
        }), 500

    if result.deleted_count == 0:

        return jsonify({
            "result":
                "fail",

            "msg":
                "해당 탐지 기록을 찾을 수 없습니다.",
        }), 404

    return jsonify({
        "result":
            "success",

        "msg":
            "탐지 기록이 삭제되었습니다.",
    })


# =========================================================
# Run
# =========================================================

if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True,
        use_reloader=False,
        threaded=True,
    )
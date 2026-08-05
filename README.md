# 산악 구조 드론 탐지 기록 웹

현재는 웹 폼으로 탐지 기록을 등록하고, 추후 ROS2 `server_gateway_node`가
동일한 `/api/detections` API로 JSON을 전송하도록 확장하는 Flask + MongoDB 프로젝트입니다.

## 1. 폴더 준비

```bash
cd drone_detection_web
python -m venv venv
```

Windows:

```bash
venv\Scripts\activate
```

macOS/Linux:

```bash
source venv/bin/activate
```

## 2. 패키지 설치

```bash
pip install -r requirements.txt
```

## 3. 환경변수 파일 만들기

`.env.example`을 복사해 `.env` 파일을 만듭니다.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

## 4. MongoDB 실행

로컬 MongoDB 서비스가 실행 중이어야 합니다.

기본 연결 주소:

```text
mongodb://localhost:27017/
```

MongoDB Compass에서 위 주소로 접속하면 `drone_rescue` 데이터베이스와
`detections` 컬렉션을 확인할 수 있습니다.

## 5. Flask 실행

```bash
python app.py
```

브라우저에서 아래 주소를 엽니다.

```text
http://localhost:5000
```

## 현재 API

```text
GET    /api/detections
POST   /api/detections
PATCH  /api/detections/<event_id>/status
DELETE /api/detections/<event_id>
```

POST JSON 예시:

```json
{
  "detected_at": "2026-08-05T11:20",
  "location": {
    "latitude": 37.2991,
    "longitude": 127.0342,
    "altitude_m": 85.4
  },
  "person_count": 1,
  "confidence": 0.87
}
```

## 보안 주의

AWS에 배포할 때 MongoDB의 27017 포트를 인터넷 전체에 공개하지 마세요.
개발을 마친 뒤 Flask API만 외부에 공개하고, MongoDB는 서버 내부 또는
허용된 네트워크에서만 접근하도록 구성하는 것이 안전합니다.

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

## 배포 시나리오별 구조

### 1. 핫스팟 버전

```text
젯슨(드론) --[Wi-Fi 핫스팟]--> 지상 컴퓨터(Flask + MongoDB) --[Wi-Fi]--> 보는 사람(브라우저)
```

- 젯슨, 지상 컴퓨터, 보는 사람이 모두 같은 Wi-Fi 안에 있어야 함
- 지상 컴퓨터가 `host="0.0.0.0"`으로 Flask를 실행해야 같은 네트워크의 다른 기기가 접속 가능
- Wi-Fi 반경(수십~수백 m) 밖으로 나가면 연결 끊김

### 2. 텔레메트리(KOAFC 텔레메트리) 버전

```text
젯슨(드론) --[텔레메트리 라디오 RF]--> 지상 컴퓨터
                                            │
                                  브릿지 스크립트가 라디오 신호 수신
                                  → 같은 컴퓨터 안에서 POST /api/detections 호출
                                            │
                                            ▼
                                  Flask + MongoDB (지금 코드 그대로 재사용)
                                            │
                                  broadcaster.publish() → SSE
                                            │
                                            ▼
                                  보는 사람(브라우저)
```

- 젯슨 ↔ 지상 컴퓨터 구간은 Wi-Fi가 아니라 전용 무선 텔레메트리 링크로 통신 → Wi-Fi보다 먼 거리(수 km)까지 가능
- 텔레메트리 라디오는 HTTP를 실어 보내지 않으므로, 지상 컴퓨터에서 라디오 데이터를 받아
  `/api/detections` 형식(JSON)으로 변환해 넘겨주는 브릿지 스크립트가 하나 필요함
- 브릿지 이후(Flask, MongoDB, SSE, 브라우저 표시)는 핫스팟 버전과 완전히 동일한 구조

### 텔레메트리 수신 컴퓨터에서 직접 볼 때

젯슨이 텔레메트리 라디오로 보낸 데이터를 받는 컴퓨터에서 곧바로 웹 화면
(`localhost:5000`)을 열어서 보는 경우, Wi-Fi나 인터넷이 없어도 정상 동작합니다.
브라우저와 서버가 같은 컴퓨터 안에서만 통신하기 때문입니다. 이 경우
`app.py`의 `host`는 `0.0.0.0`으로 바꿀 필요 없이 기본값(`127.0.0.1`)을
그대로 두는 것이 더 안전합니다.

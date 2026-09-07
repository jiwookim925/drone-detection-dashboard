const STATUS_LABELS = {
    unverified: "미확인",
    checking: "확인 중",
    confirmed: "확인",
    false_positive: "오탐",
    resolved: "구조 완료",
};

const RECENT_EVENTS_LIMIT = 8;

const RISK_ORDER = {
    unknown: 0,
    stable: 1,
    warning: 2,
    critical: 3,
};

let allDetections = [];
let liveEventSource = null;

// 현재 실시간 추적 상태 전용
let currentLiveState = {
    person_count: 0,
    tracks: [],
    received_at: null,
};

// track_id 별 마지막 위험도
// (신규 진입 / 위험 등급 상승 판단용)
let trackRiskMemory = {};


$(document).ready(function () {
    setDefaultDetectedAt();
    loadDetections();
    connectLiveStream();

    $("#detection-form").on("submit", function (event) {
        event.preventDefault();
        createDetection();
    });

    $("#manual-toggle").on("click", function () {
        $("#manual-panel").prop("hidden", function (_, hidden) {
            return !hidden;
        });
    });

    $("#refresh-button").on("click", loadDetections);

    $("#search-input, #date-filter").on("input", applyHistoryFilters);
    $("#status-filter").on("change", applyHistoryFilters);

    $("#time-filter").on("input", function () {
        $(this).val(formatTimeInputValue($(this).val()));
        applyHistoryFilters();
    });

    $(".tab-button").on("click", function () {
        const tab = $(this).data("tab");

        $(".tab-button").removeClass("active");
        $(this).addClass("active");

        $(".tab-panel").attr("hidden", true);
        $(`.tab-panel[data-tab-panel="${tab}"]`).removeAttr("hidden");
    });

    // 상태 변경
    $("#history-table-body").on("change", ".status-select", function () {
        updateStatus($(this).data("event-id"), $(this).val());
    });

    // 삭제
    $("#history-table-body").on("click", ".delete-button", function () {
        deleteDetection($(this).data("event-id"));
    });
});


// ==========================================================
// SSE
// ==========================================================

function connectLiveStream() {
    if (liveEventSource) {
        return;
    }

    setSseStatus("connecting");

    liveEventSource = new EventSource("/api/detections/stream");

    liveEventSource.onopen = function () {
        setSseStatus("connected");
        setApiStatus(true);
    };

    liveEventSource.onerror = function () {
        setSseStatus("error");
    };

    liveEventSource.onmessage = function (event) {
        try {
            const data = JSON.parse(event.data);
            handleSseMessage(data);
        } catch (error) {
            console.error("SSE JSON parse error:", error);
        }
    };
}


function handleSseMessage(data) {
    setApiStatus(true);

    // ------------------------------------------------------
    // 1. 실시간 상태
    // /api/live -> SSE type=live
    // ------------------------------------------------------
    if (data.type === "live") {

        currentLiveState = {
            person_count: Number(data.person_count ?? 0),
            tracks: Array.isArray(data.tracks) ? data.tracks : [],
            received_at: data.received_at ?? null,
        };

        renderCurrentTracks();

        $("#status-last").text(
            currentLiveState.received_at
                ? formatTimeOnly(currentLiveState.received_at)
                : "-"
        );

        return;
    }

    // ------------------------------------------------------
    // 2. 새 탐지 이벤트
    // /api/detections -> SSE type=event
    // ------------------------------------------------------
    if (data.type === "event") {
        const detection = data.detection;

        if (!detection || !detection.event_id) {
            return;
        }

        // 같은 event_id 중복 방지
        const alreadyExists = allDetections.some(
            (item) => item.event_id === detection.event_id
        );

        if (!alreadyExists) {
            allDetections.unshift(detection);
        }

        updateSummary();
        renderRecentTable(detection.event_id);
        applyHistoryFilters();

        return;
    }

    // ------------------------------------------------------
    // 구버전 SSE 데이터 호환
    // ------------------------------------------------------
    if (data.event_id) {

        const alreadyExists = allDetections.some(
            (item) => item.event_id === data.event_id
        );

        if (!alreadyExists) {
            allDetections.unshift(data);
        }

        refreshAllViews(data.event_id);
    }
}


function setSseStatus(state) {
    const dot = $("#live-dot");

    dot.removeClass("dot-off dot-error");

    if (state === "connected") {
        $("#live-text").text("LIVE");
        $("#status-sse").text("연결됨");

    } else if (state === "error") {
        dot.addClass("dot-error");
        $("#live-text").text("OFFLINE");
        $("#status-sse").text("재연결 중...");

    } else if (state === "connecting") {
        dot.addClass("dot-off");
        $("#live-text").text("LIVE");
        $("#status-sse").text("연결 중...");

    } else {
        dot.addClass("dot-off");
        $("#live-text").text("OFFLINE");
        $("#status-sse").text("연결 안 함");
    }
}


function setApiStatus(ok) {
    const dot = $("#server-dot");

    dot.removeClass("dot-off dot-error");

    if (ok) {
        $("#status-api").text("연결됨");

    } else {
        dot.addClass("dot-error");
        $("#status-api").text("오류");
    }
}


// ==========================================================
// Data load / mutate
// ==========================================================

function setDefaultDetectedAt() {
    const now = new Date();

    now.setMinutes(
        now.getMinutes() - now.getTimezoneOffset()
    );

    $("#detected-at").val(
        now.toISOString().slice(0, 16)
    );
}


function createDetection() {
    const payload = {
        detected_at: $("#detected-at").val(),

        location: {
            latitude: Number($("#latitude").val()),
            longitude: Number($("#longitude").val()),
            altitude_m: Number($("#altitude").val()),
        },

        person_count: Number($("#person-count").val()),
        confidence: Number($("#confidence").val()),
    };

    setMessage("저장 중입니다.", false);

    $.ajax({
        type: "POST",
        url: "/api/detections",
        contentType: "application/json",
        data: JSON.stringify(payload),

        success: function (response) {
            setApiStatus(true);

            setMessage(
                response.msg,
                false
            );

            $("#detection-form")[0].reset();
            $("#person-count").val(1);

            setDefaultDetectedAt();

            loadDetections();
        },

        error: function (xhr) {
            handleAjaxError(xhr);

            const message =
                xhr.responseJSON?.msg
                || "탐지 기록 저장에 실패했습니다.";

            setMessage(
                message,
                true
            );
        },
    });
}


function loadDetections() {
    $.ajax({
        type: "GET",
        url: "/api/detections",

        success: function (response) {
            setApiStatus(true);

            allDetections = Array.isArray(response.detections)
                ? response.detections
                : [];

            refreshAllViews();
        },

        error: function (xhr) {
            handleAjaxError(xhr);

            const message =
                xhr.responseJSON?.msg
                || "탐지 기록을 불러오지 못했습니다.";

            $("#history-table-body").html(
                `<tr>
                    <td colspan="9" class="empty-row error">
                        ${escapeHtml(message)}
                    </td>
                </tr>`
            );
        },
    });
}


function updateStatus(eventId, status) {
    $.ajax({
        type: "PATCH",

        url:
            `/api/detections/`
            + `${encodeURIComponent(eventId)}`
            + `/status`,

        contentType: "application/json",

        data: JSON.stringify({
            status: status,
        }),

        success: function () {
            setApiStatus(true);
            loadDetections();
        },

        error: function (xhr) {
            handleAjaxError(xhr);

            alert(
                xhr.responseJSON?.msg
                || "상태 변경에 실패했습니다."
            );

            loadDetections();
        },
    });
}


function deleteDetection(eventId) {
    if (!confirm("이 탐지 기록을 삭제할까요?")) {
        return;
    }

    $.ajax({
        type: "DELETE",

        url:
            `/api/detections/`
            + `${encodeURIComponent(eventId)}`,

        success: function () {
            setApiStatus(true);
            loadDetections();
        },

        error: function (xhr) {
            handleAjaxError(xhr);

            alert(
                xhr.responseJSON?.msg
                || "삭제에 실패했습니다."
            );
        },
    });
}


function handleAjaxError(xhr) {
    // status 0:
    // 서버 자체에 도달하지 못함
    setApiStatus(
        xhr.status !== 0
    );
}


// ==========================================================
// Rendering
// ==========================================================

function refreshAllViews(newEventId) {
    renderCurrentTracks();
    updateSummary();
    renderRecentTable(newEventId);
    applyHistoryFilters();

    // live 상태를 아직 못 받은 경우에만
    // 마지막 DB 이벤트 시간을 보여준다.
    if (!currentLiveState.received_at) {
        const latest = allDetections[0];

        $("#status-last").text(
            latest
                ? formatTimeOnly(
                    latest.received_at
                    || latest.detected_at
                )
                : "-"
        );
    }
}


// ----------------------------------------------------------
// 현재 추적 객체
// 실시간 live 데이터만 사용
// ----------------------------------------------------------

function renderCurrentTracks() {
    const container = $("#current-tracks");

    const tracks =
        Array.isArray(currentLiveState.tracks)
            ? currentLiveState.tracks
            : [];

    const personCount =
        Number(currentLiveState.person_count ?? 0);

    $("#current-count").text(
        `${personCount}명`
    );

    if (tracks.length === 0) {
        container.html(
            '<p class="empty-row">현재 탐지 없음</p>'
        );

        // 모두 사라졌으므로 다음에 같은 ID가
        // 다시 나타나면 신규 진입으로 취급한다.
        trackRiskMemory = {};

        return;
    }

    const activeKeys = new Set();

    const rows = tracks.map(function (track) {
        const key = String(track.track_id);
        activeKeys.add(key);

        const risk = combinedRiskLevel(
            track.confidence
        );

        const previousRisk =
            trackRiskMemory[key] ?? "unknown";

        const isNewTrack =
            trackRiskMemory[key] === undefined;

        const isEscalation =
            RISK_ORDER[risk] > RISK_ORDER[previousRisk];

        trackRiskMemory[key] = risk;

        return buildTrackRow(
            track.track_id,
            track.confidence,
            track.distance_m,
            risk,
            isNewTrack,
            isEscalation
                && (risk === "critical" || risk === "warning")
        );
    });

    // 더 이상 존재하지 않는 track_id는 기억에서 제거
    Object.keys(trackRiskMemory).forEach(function (key) {
        if (!activeKeys.has(key)) {
            delete trackRiskMemory[key];
        }
    });

    container.empty();
    rows.forEach(function (row) {
        container.append(row);
    });
}


function buildTrackRow(
    trackId,
    confidence,
    distanceM,
    risk,
    isNewEntry,
    showRiskPulse
) {
    const classes = [
        "track-row",
        `risk-${risk}`,
    ];

    if (isNewEntry) {
        classes.push("track-row-enter");
    }

    if (showRiskPulse) {
        classes.push("risk-pulse");
    }

    return $(`
        <div class="${classes.join(" ")}">
            <span class="track-id">
                ID ${escapeHtml(String(trackId ?? "-"))}
            </span>

            <span class="track-metrics">

                <span class="track-confidence">
                    ${formatConfidencePct(confidence)}
                </span>

                <span class="track-distance">
                    ${formatDistance(distanceM)}
                </span>

            </span>
        </div>
    `);
}


// ----------------------------------------------------------
// 최근 탐지 이벤트
// DB 이벤트만 사용
// ----------------------------------------------------------

function renderRecentTable(newEventId) {
    const tbody = $("#recent-table-body");

    const items =
        allDetections.slice(
            0,
            RECENT_EVENTS_LIMIT
        );

    if (items.length === 0) {
        tbody.html(
            '<tr>'
            + '<td colspan="6" class="empty-row">'
            + '탐지 기록이 없습니다.'
            + '</td>'
            + '</tr>'
        );

        return;
    }

    tbody.html(
        items
            .map(buildRecentRowHtml)
            .join("")
    );

    if (newEventId) {
        tbody.find("tr").each(function () {

            if (
                $(this).data("event-id")
                === newEventId
            ) {
                $(this).addClass(
                    "row-flash"
                );
            }
        });
    }
}


function buildRecentRowHtml(item) {
    const tracks =
        Array.isArray(item.tracks) && item.tracks.length > 0
            ? item.tracks
            : [null];

    const rowSpan = tracks.length;
    const timeCell = `<td rowspan="${rowSpan}">${formatTimeOnly(item.detected_at)}</td>`;
    const countCell = `<td rowspan="${rowSpan}" class="col-count">${item.person_count ?? "-"}명</td>`;
    const statusCell = `<td rowspan="${rowSpan}">${statusBadgeHtml(item.status)}</td>`;

    return tracks
        .map(function (track, index) {
            const risk = track
                ? combinedRiskLevel(track.confidence)
                : combinedRiskLevel(item.confidence);

            const confidenceValue = track
                ? track.confidence
                : item.confidence;

            return `
                <tr
                    class="risk-${risk}"
                    data-event-id="${escapeHtml(item.event_id)}"
                >
                    ${index === 0 ? timeCell : ""}
                    ${index === 0 ? countCell : ""}

                    <td class="col-track">
                        ${track ? escapeHtml(String(track.track_id ?? "-")) : "-"}
                    </td>

                    <td class="col-confidence">
                        ${formatConfidencePct(confidenceValue)}
                    </td>

                    <td class="col-distance">
                        ${track ? formatDistance(track.distance_m) : "-"}
                    </td>

                    ${index === 0 ? statusCell : ""}
                </tr>
            `;
        })
        .join("");
}


// ==========================================================
// History filters
// ==========================================================

function applyHistoryFilters() {
    const keyword =
        $("#search-input")
            .val()
            .trim()
            .toLowerCase();

    const status =
        $("#status-filter").val();

    const dateFilter =
        $("#date-filter").val();

    const timeFilter =
        $("#time-filter").val();

    const filtered =
        allDetections.filter(function (item) {

            if (
                keyword
                && !String(item.event_id ?? "")
                    .toLowerCase()
                    .includes(keyword)
            ) {
                return false;
            }

            if (
                status
                && item.status !== status
            ) {
                return false;
            }

            if (
                dateFilter
                && item.detected_at?.slice(0, 10)
                    !== dateFilter
            ) {
                return false;
            }

            if (
                timeFilter
                && !item.detected_at
                    ?.slice(11, 19)
                    .startsWith(timeFilter)
            ) {
                return false;
            }

            return true;
        });

    renderHistoryTable(filtered);
}


function formatTimeInputValue(value) {
    const digits =
        value
            .replace(/\D/g, "")
            .slice(0, 6);

    if (digits.length <= 2) {
        return digits;
    }

    if (digits.length <= 4) {
        return (
            `${digits.slice(0, 2)}`
            + `:${digits.slice(2)}`
        );
    }

    return (
        `${digits.slice(0, 2)}`
        + `:${digits.slice(2, 4)}`
        + `:${digits.slice(4)}`
    );
}


// ==========================================================
// History table
// ==========================================================

function renderHistoryTable(items) {
    const tbody = $("#history-table-body");

    if (items.length === 0) {
        const message =
            allDetections.length === 0
                ? "아직 저장된 탐지 기록이 없습니다."
                : "검색 조건에 맞는 탐지 기록이 없습니다.";

        tbody.html(
            `<tr>
                <td colspan="9" class="empty-row">
                    ${message}
                </td>
            </tr>`
        );

        return;
    }

    // 브라우저 과부하 방지
    const visibleItems = items.slice(0, 200);

    tbody.html(
        visibleItems
            .map(buildHistoryRowHtml)
            .join("")
    );
}


function buildHistoryRowHtml(item) {
    const statusOptions =
        Object.entries(
            STATUS_LABELS
        )
            .map(([value, label]) => {

                const selected =
                    value === item.status
                        ? "selected"
                        : "";

                return (
                    `<option `
                    + `value="${value}" `
                    + `${selected}>`
                    + `${label}`
                    + `</option>`
                );
            })
            .join("");

    const tracks =
        Array.isArray(item.tracks) && item.tracks.length > 0
            ? item.tracks
            : [null];

    const rowSpan = tracks.length;

    const timeCell = `<td rowspan="${rowSpan}">${formatTimeOnly(item.detected_at)}</td>`;
    const eventIdCell = `<td rowspan="${rowSpan}">${escapeHtml(item.event_id)}</td>`;
    const countCell = `<td rowspan="${rowSpan}" class="col-count">${item.person_count ?? "-"}명</td>`;
    const locationCell = `<td rowspan="${rowSpan}" class="hide-narrow">${locationText(item.location)}</td>`;

    const statusCell = `
        <td rowspan="${rowSpan}">
            <select
                class="status-select"
                data-event-id="${escapeHtml(item.event_id)}"
            >
                ${statusOptions}
            </select>
        </td>
    `;

    const deleteCell = `
        <td rowspan="${rowSpan}">
            <button
                class="delete-button"
                data-event-id="${escapeHtml(item.event_id)}"
                type="button"
            >
                삭제
            </button>
        </td>
    `;

    return tracks
        .map(function (track, index) {
            const risk = track
                ? combinedRiskLevel(track.confidence)
                : combinedRiskLevel(item.confidence);

            const confidenceValue = track
                ? track.confidence
                : item.confidence;

            return `
                <tr class="risk-${risk}">
                    ${index === 0 ? timeCell : ""}
                    ${index === 0 ? eventIdCell : ""}
                    ${index === 0 ? countCell : ""}

                    <td class="col-track">
                        ${track ? escapeHtml(String(track.track_id ?? "-")) : "-"}
                    </td>

                    <td class="col-confidence">
                        ${formatConfidencePct(confidenceValue)}
                    </td>

                    <td class="col-distance">
                        ${track ? formatDistance(track.distance_m) : "-"}
                    </td>

                    ${index === 0 ? locationCell : ""}
                    ${index === 0 ? statusCell : ""}
                    ${index === 0 ? deleteCell : ""}
                </tr>
            `;
        })
        .join("");
}


// ==========================================================
// Summary
// ==========================================================

function updateSummary() {
    $("#total-count").text(
        allDetections.length
    );

    $("#unverified-count").text(
        allDetections.filter(
            (item) =>
                item.status === "unverified"
        ).length
    );

    $("#confirmed-count").text(
        allDetections.filter(
            (item) =>
                item.status === "confirmed"
        ).length
    );

    $("#false-positive-count").text(
        allDetections.filter(
            (item) =>
                item.status === "false_positive"
        ).length
    );
}


// ==========================================================
// Form message
// ==========================================================

function setMessage(message, isError) {
    $("#form-message")
        .text(message)
        .toggleClass(
            "error",
            isError
        );
}


// ==========================================================
// Format helpers
// ==========================================================

function formatTimeOnly(isoValue) {
    if (
        !isoValue
        || isoValue.length < 19
    ) {
        return "-";
    }

    return isoValue.slice(
        11,
        19
    );
}


function formatConfidencePct(value) {
    if (
        value === null
        || value === undefined
        || Number.isNaN(Number(value))
    ) {
        return "-";
    }

    return (
        `${(
            Number(value) * 100
        ).toFixed(1)}%`
    );
}


function formatDistance(value) {
    if (
        value === null
        || value === undefined
        || Number.isNaN(Number(value))
    ) {
        return "-";
    }

    return (
        `${Number(value).toFixed(1)} m`
    );
}


// ==========================================================
// Risk classification
// 거리는 색상 등급에 반영하지 않는다.
// 신뢰도가 높을수록 위험(레드), 낮을수록 안정(그린)
// (신뢰도 80% 이상 -> 위험, 50~80% -> 주의, 50% 미만 -> 안정)
// ==========================================================

function confidenceRiskLevel(confidence) {
    const value = Number(confidence);

    if (
        confidence === null
        || confidence === undefined
        || Number.isNaN(value)
    ) {
        return null;
    }

    if (value >= 0.8) {
        return "critical";
    }

    if (value >= 0.5) {
        return "warning";
    }

    return "stable";
}


function combinedRiskLevel(confidence) {
    const level = confidenceRiskLevel(confidence);

    return level ?? "unknown";
}


function isGpsUnset(location) {
    if (!location) {
        return true;
    }

    const lat =
        Number(location.latitude);

    const lng =
        Number(location.longitude);

    return !lat && !lng;
}


function locationText(location) {
    if (isGpsUnset(location)) {
        return "GPS 미연동";
    }

    return (
        `${Number(location.latitude).toFixed(4)}, `
        + `${Number(location.longitude).toFixed(4)}`
    );
}


function statusBadgeHtml(status) {
    const label =
        STATUS_LABELS[status]
        || status
        || "-";

    const cls =
        status
        || "unverified";

    return (
        `<span class="status-badge `
        + `${escapeHtml(cls)}">`
        + `${escapeHtml(label)}`
        + `</span>`
    );
}


function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
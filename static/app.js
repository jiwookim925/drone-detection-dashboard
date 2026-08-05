const STATUS_LABELS = {
    unverified: "미확인",
    checking: "확인 중",
    confirmed: "실제 사람",
    false_positive: "오탐",
    resolved: "구조 완료",
};

let allDetections = [];
let liveEventSource = null;

$(document).ready(function () {
    setDefaultDetectedAt();
    loadDetections();
    connectLiveStream();

    $("#detection-form").on("submit", function (event) {
        event.preventDefault();
        createDetection();
    });

    $("#refresh-button").on("click", loadDetections);

    $("#search-input, #date-filter").on("input", applyFilters);
    $("#status-filter").on("change", applyFilters);

    $("#time-filter").on("input", function () {
        $(this).val(formatTimeInputValue($(this).val()));
        applyFilters();
    });

    $(".tab-button").on("click", function () {
        const tab = $(this).data("tab");

        $(".tab-button").removeClass("active");
        $(this).addClass("active");

        $(".tab-panel").attr("hidden", true);
        $(`.tab-panel[data-tab-panel="${tab}"]`).removeAttr("hidden");

        if (tab === "live") {
            connectLiveStream();
        } else {
            disconnectLiveStream();
        }
    });
});


function connectLiveStream() {
    if (liveEventSource) {
        return;
    }

    setConnectionStatus("connecting");
    liveEventSource = new EventSource("/api/detections/stream");

    liveEventSource.onopen = function () {
        setConnectionStatus("connected");
    };

    liveEventSource.onerror = function () {
        setConnectionStatus("error");
    };

    liveEventSource.onmessage = function (event) {
        handleLiveDetection(JSON.parse(event.data));
    };
}


function disconnectLiveStream() {
    if (liveEventSource) {
        liveEventSource.close();
        liveEventSource = null;
    }
    setConnectionStatus("off");
}


function setConnectionStatus(state) {
    const dot = $("#connection-badge .status-dot");
    const label = $("#connection-label");

    dot.removeClass("dot-off dot-error");

    if (state === "connected") {
        label.text("연결됨");
    } else if (state === "error") {
        dot.addClass("dot-error");
        label.text("재연결 중...");
    } else {
        dot.addClass("dot-off");
        label.text(state === "connecting" ? "연결 중..." : "연결 안 함");
    }
}


function handleLiveDetection(item) {
    allDetections.unshift(item);
    updateSummary(allDetections);
    applyFilters();

    const feed = $("#live-feed");
    feed.find(".empty-message").remove();

    const card = buildDetectionCard(item);
    card.addClass("live-item");
    feed.prepend(card);
    feed.find(".detection-card").slice(5).remove();
}


function setDefaultDetectedAt() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    $("#detected-at").val(now.toISOString().slice(0, 16));
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
            setMessage(response.msg, false);
            $("#detection-form")[0].reset();
            $("#person-count").val(1);
            setDefaultDetectedAt();
            loadDetections();
        },

        error: function (xhr) {
            const message = xhr.responseJSON?.msg || "탐지 기록 저장에 실패했습니다.";
            setMessage(message, true);
        },
    });
}


function loadDetections() {
    $.ajax({
        type: "GET",
        url: "/api/detections",

        success: function (response) {
            allDetections = response.detections;
            updateSummary(allDetections);
            applyFilters();
        },

        error: function (xhr) {
            const message = xhr.responseJSON?.msg || "탐지 기록을 불러오지 못했습니다.";
            $("#detection-list").html(`<p class="empty-message error">${escapeHtml(message)}</p>`);
        },
    });
}


function applyFilters() {
    const keyword = $("#search-input").val().trim().toLowerCase();
    const status = $("#status-filter").val();
    const dateFilter = $("#date-filter").val();
    const timeFilter = $("#time-filter").val();

    const hasActiveFilter = Boolean(keyword || status || dateFilter || timeFilter);

    if (!hasActiveFilter) {
        renderDetections([], false);
        return;
    }

    const filtered = allDetections.filter(function (item) {
        if (keyword && !item.event_id.toLowerCase().includes(keyword)) {
            return false;
        }
        if (status && item.status !== status) {
            return false;
        }
        if (dateFilter && item.detected_at?.slice(0, 10) !== dateFilter) {
            return false;
        }
        if (timeFilter && !item.detected_at?.slice(11, 19).startsWith(timeFilter)) {
            return false;
        }
        return true;
    });

    renderDetections(filtered, true);
}


function formatTimeInputValue(value) {
    const digits = value.replace(/\D/g, "").slice(0, 6);

    if (digits.length <= 2) {
        return digits;
    }
    if (digits.length <= 4) {
        return `${digits.slice(0, 2)}:${digits.slice(2)}`;
    }
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4)}`;
}


function renderDetections(detections, hasActiveFilter) {
    const list = $("#detection-list");
    list.empty();

    if (detections.length === 0) {
        let message = "검색 조건을 입력하면 해당하는 탐지 기록이 표시됩니다.";
        if (allDetections.length === 0) {
            message = "아직 저장된 탐지 기록이 없습니다.";
        } else if (hasActiveFilter) {
            message = "검색 조건에 맞는 탐지 기록이 없습니다.";
        }
        list.html(`<p class="empty-message">${message}</p>`);
        return;
    }

    detections.forEach(function (item) {
        list.append(buildDetectionCard(item));
    });
}


function buildDetectionCard(item) {
    const detectedAt = formatDateTime(item.detected_at);
    const confidencePercent = Math.round(item.confidence * 100);
    const statusOptions = Object.entries(STATUS_LABELS)
        .map(([value, label]) => {
            const selected = value === item.status ? "selected" : "";
            return `<option value="${value}" ${selected}>${label}</option>`;
        })
        .join("");

    const card = $(`
        <article class="detection-card">
            <div class="card-top">
                <div>
                    <span class="event-id">${escapeHtml(item.event_id)}</span>
                    <h3>${escapeHtml(detectedAt)}</h3>
                </div>
                <span class="confidence-badge">${confidencePercent}%</span>
            </div>

            <div class="data-grid">
                <div>
                    <span>위도</span>
                    <strong>${item.location.latitude}</strong>
                </div>
                <div>
                    <span>경도</span>
                    <strong>${item.location.longitude}</strong>
                </div>
                <div>
                    <span>고도</span>
                    <strong>${item.location.altitude_m} m</strong>
                </div>
                <div>
                    <span>탐지 인원</span>
                    <strong>${item.person_count}명</strong>
                </div>
            </div>

            <div class="card-actions">
                <label>
                    확인 상태
                    <select class="status-select">${statusOptions}</select>
                </label>
                <button class="delete-button" type="button">삭제</button>
            </div>
        </article>
    `);

    card.find(".status-select").on("change", function () {
        updateStatus(item.event_id, $(this).val());
    });

    card.find(".delete-button").on("click", function () {
        deleteDetection(item.event_id);
    });

    return card;
}


function updateStatus(eventId, status) {
    $.ajax({
        type: "PATCH",
        url: `/api/detections/${encodeURIComponent(eventId)}/status`,
        contentType: "application/json",
        data: JSON.stringify({ status }),

        success: function () {
            loadDetections();
        },

        error: function (xhr) {
            alert(xhr.responseJSON?.msg || "상태 변경에 실패했습니다.");
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
        url: `/api/detections/${encodeURIComponent(eventId)}`,

        success: function () {
            loadDetections();
        },

        error: function (xhr) {
            alert(xhr.responseJSON?.msg || "삭제에 실패했습니다.");
        },
    });
}


function updateSummary(detections) {
    $("#total-count").text(detections.length);
    $("#unverified-count").text(
        detections.filter((item) => item.status === "unverified").length
    );
    $("#confirmed-count").text(
        detections.filter((item) => item.status === "confirmed").length
    );
    $("#false-positive-count").text(
        detections.filter((item) => item.status === "false_positive").length
    );
}


function setMessage(message, isError) {
    $("#form-message")
        .text(message)
        .toggleClass("error", isError);
}


function formatDateTime(value) {
    if (!value) {
        return "-";
    }

    return new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(new Date(value));
}


function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

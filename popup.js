const previewBtn = document.getElementById("previewBtn");
const sendBtn = document.getElementById("sendBtn");
const copyBtn = document.getElementById("copyBtn");
const resultEl = document.getElementById("result");

let lastCollectedPayload = null;

function setLoading(isLoading) {
  previewBtn.disabled = isLoading;
  sendBtn.disabled = isLoading;
  copyBtn.disabled = isLoading;
}

function print(message, data) {
  if (data !== undefined) {
    resultEl.textContent = `${message}\n\n${JSON.stringify(data, null, 2)}`;
  } else {
    resultEl.textContent = message;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !tab.id) {
    throw new Error("활성 탭을 찾지 못했습니다.");
  }

  return tab;
}

async function collectFromPage() {
  const tab = await getActiveTab();

  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "COLLECT_ATTENDANCE_ROWS",
    options: {
      expectedTotalCount: CONFIG.EXPECTED_TOTAL_COUNT,
      scrollStepPx: CONFIG.SCROLL_STEP_PX,
      scrollDelayMs: CONFIG.SCROLL_DELAY_MS,
      maxScrollRounds: CONFIG.MAX_SCROLL_ROUNDS,
      stableRoundLimit: CONFIG.STABLE_ROUND_LIMIT,
      debug: CONFIG.DEBUG
    }
  });

  if (!response) {
    throw new Error("페이지로부터 응답을 받지 못했습니다. 백오피스 페이지에서 실행 중인지 확인해주세요.");
  }

  if (!response.ok) {
    throw new Error(response.error || "수집 중 오류가 발생했습니다.");
  }

  const payload = {
    source: "backoffice-dom",
    collectedAt: new Date().toISOString(),
    pageUrl: response.pageUrl,
    date: response.date,
    totalCount: response.rows.length,
    summary: response.summary,
    rows: response.rows
  };

  lastCollectedPayload = payload;

  return payload;
}

async function postToWebApp(payload) {
  if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.includes("여기에_구글_웹앱_URL")) {
    throw new Error("config.js의 WEB_APP_URL을 실제 Google Apps Script Web App URL로 교체해주세요.");
  }

  const res = await fetch(CONFIG.WEB_APP_URL, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = {
      raw: text
    };
  }

  if (!res.ok) {
    throw new Error(`Web App 전송 실패: ${res.status} / ${text}`);
  }

  return parsed;
}

previewBtn.addEventListener("click", async () => {
  try {
    setLoading(true);
    print("출결 데이터를 수집 중입니다...");

    const payload = await collectFromPage();

    print(`수집 완료: ${payload.totalCount}명`, {
      date: payload.date,
      totalCount: payload.totalCount,
      summary: payload.summary,
      sample: payload.rows.slice(0, 10)
    });
  } catch (error) {
    print(`오류 발생\n${error.message}`);
  } finally {
    setLoading(false);
  }
});

sendBtn.addEventListener("click", async () => {
  try {
    setLoading(true);
    print("출결 데이터를 수집 중입니다...");

    const payload = await collectFromPage();

    print(`수집 완료: ${payload.totalCount}명\nWeb App으로 전송 중...`, {
      summary: payload.summary
    });

    const webAppResult = await postToWebApp(payload);

    print("전송 완료", {
      sentCount: payload.totalCount,
      summary: payload.summary,
      webAppResult
    });
  } catch (error) {
    print(`오류 발생\n${error.message}`);
  } finally {
    setLoading(false);
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    if (!lastCollectedPayload) {
      setLoading(true);
      print("아직 수집된 데이터가 없어 먼저 수집합니다...");

      lastCollectedPayload = await collectFromPage();
    }

    await navigator.clipboard.writeText(JSON.stringify(lastCollectedPayload, null, 2));

    print("수집 결과 JSON을 클립보드에 복사했습니다.", {
      totalCount: lastCollectedPayload.totalCount,
      summary: lastCollectedPayload.summary,
      sample: lastCollectedPayload.rows.slice(0, 5)
    });
  } catch (error) {
    print(`오류 발생\n${error.message}`);
  } finally {
    setLoading(false);
  }
});

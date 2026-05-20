const previewBtn = document.getElementById("previewBtn");
const sendBtn    = document.getElementById("sendBtn");
const copyBtn    = document.getElementById("copyBtn");
const resultEl   = document.getElementById("result");

let lastPayload = null;

// ─── 유틸 ───────────────────────────────────────────

function setLoading(flag) {
  previewBtn.disabled = flag;
  sendBtn.disabled    = flag;
  copyBtn.disabled    = flag;
}

function print(msg, data) {
  resultEl.textContent = data !== undefined
    ? `${msg}\n\n${JSON.stringify(data, null, 2)}`
    : msg;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("활성 탭을 찾지 못했습니다.");
  return tab;
}

// ─── content.js 를 현재 탭에 직접 주입 후 실행 ──────

async function runCollector() {
  const tab = await getActiveTab();

  // 1) content.js 파일 주입
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });

  // 2) 설정값과 함께 수집 함수 실행
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (cfg) => {
      // content.js 에 정의된 collectAttendanceRows 를 호출
      return await window.__attendanceCollect(cfg);
    },
    args: [{
      autoDetectCount : CONFIG.AUTO_DETECT_COUNT,
      fixedCount      : CONFIG.FIXED_COUNT,
      scrollStepPx    : CONFIG.SCROLL_STEP_PX,
      scrollDelayMs   : CONFIG.SCROLL_DELAY_MS,
      maxScrollRounds : CONFIG.MAX_SCROLL_ROUNDS,
      stableRoundLimit: CONFIG.STABLE_ROUND_LIMIT,
      debug           : CONFIG.DEBUG
    }]
  });

  const result = results?.[0]?.result;

  if (!result) throw new Error("수집 결과가 없습니다. 백오피스 출결 페이지인지 확인해주세요.");
  if (!result.ok) throw new Error(result.error || "수집 중 오류가 발생했습니다.");

  return result;
}

async function collectPayload() {
  const result = await runCollector();

  const payload = {
    source      : "backoffice-dom",
    collectedAt : new Date().toISOString(),
    pageUrl     : result.pageUrl,
    date        : result.date,
    totalCount  : result.rows.length,
    summary     : result.summary,
    rows        : result.rows
  };

  lastPayload = payload;
  return payload;
}

async function postToWebApp(payload) {
  if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.includes("여기에_구글_웹앱_URL")) {
    throw new Error("config.js 의 WEB_APP_URL 을 실제 Google Apps Script Web App URL 로 교체해주세요.");
  }

  const res = await fetch(CONFIG.WEB_APP_URL, {
    method : "POST",
    mode   : "cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body   : JSON.stringify(payload)
  });

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

  if (!res.ok) throw new Error(`Web App 전송 실패: ${res.status} / ${text}`);
  return parsed;
}

// ─── 버튼 이벤트 ─────────────────────────────────────

previewBtn.addEventListener("click", async () => {
  try {
    setLoading(true);
    print("출결 데이터를 수집 중입니다...\n(페이지 끝까지 스크롤하며 인원을 파악합니다)");

    const payload = await collectPayload();

    print(`수집 완료: ${payload.totalCount}명`, {
      date       : payload.date,
      totalCount : payload.totalCount,
      summary    : payload.summary,
      sample     : payload.rows.slice(0, 10)
    });
  } catch (e) {
    print(`오류 발생\n${e.message}`);
  } finally {
    setLoading(false);
  }
});

sendBtn.addEventListener("click", async () => {
  try {
    setLoading(true);
    print("수집 중...");

    const payload = await collectPayload();
    print(`수집 완료: ${payload.totalCount}명\nWeb App 전송 중...`);

    const webResult = await postToWebApp(payload);
    print("전송 완료", {
      sentCount  : payload.totalCount,
      summary    : payload.summary,
      webResult
    });
  } catch (e) {
    print(`오류 발생\n${e.message}`);
  } finally {
    setLoading(false);
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    setLoading(true);

    if (!lastPayload) {
      print("수집된 데이터가 없어 먼저 수집합니다...");
      lastPayload = await collectPayload();
    }

    await navigator.clipboard.writeText(JSON.stringify(lastPayload, null, 2));

    print("클립보드에 복사 완료", {
      totalCount : lastPayload.totalCount,
      summary    : lastPayload.summary,
      sample     : lastPayload.rows.slice(0, 5)
    });
  } catch (e) {
    print(`오류 발생\n${e.message}`);
  } finally {
    setLoading(false);
  }
});

// ─────────────────────────────────────────────────────
// 중복 주입 방지: 이미 로드된 경우 재실행 안 함
// ─────────────────────────────────────────────────────
if (typeof window.__attendanceCollectLoaded === "undefined") {
  window.__attendanceCollectLoaded = true;

// ─────────────────────────────────────────────────────
// popup.js 의 executeScript 에서 호출합니다.
// ─────────────────────────────────────────────────────
window.__attendanceCollect = async function(options) {
  try {
    return await collectAttendanceRows(options || {});
  } catch (e) {
    return { ok: false, error: e.message, stack: e.stack };
  }
};

// ─────────────────────────────────────────────────────
// 메인 수집 함수
// ─────────────────────────────────────────────────────

async function collectAttendanceRows(options) {
  const cfg = {
    autoDetectCount : options.autoDetectCount !== false,
    fixedCount      : Number(options.fixedCount       || 129),
    scrollStepPx    : Number(options.scrollStepPx     || 600),
    scrollDelayMs   : Number(options.scrollDelayMs    || 600),
    maxScrollRounds : Number(options.maxScrollRounds  || 150),
    stableRoundLimit: Number(options.stableRoundLimit || 8),
    debug           : Boolean(options.debug)
  };

  const scrollContainer = findBestScrollContainer();
  dbg(cfg.debug, "스크롤 컨테이너", descEl(scrollContainer));

  // 1단계: 끝까지 스크롤하며 전체 인원 수 파악
  let detectedTotal = cfg.fixedCount;
  if (cfg.autoDetectCount) {
    detectedTotal = await detectTotalCount(scrollContainer, cfg);
    dbg(cfg.debug, "자동 감지된 총 인원", detectedTotal);
  }

  // 2단계: 처음으로 돌아가 데이터 수집
  scrollContainer.scrollTop = 0;
  await sleep(900);

  const map = new Map();
  let prevCount    = 0;
  let stableRounds = 0;

  for (let round = 0; round < cfg.maxScrollRounds; round++) {
    const visible = extractVisibleAttendanceRows(cfg.debug);

    for (const row of visible) {
      const norm = normalizeRow(row);
      const key  = norm.name;
      if (!key) continue;
      map.set(key, map.has(key) ? mergeRow(map.get(key), norm) : norm);
    }

    const cur = map.size;
    dbg(cfg.debug, `round ${round + 1}`, {
      visible: visible.length, collected: cur,
      scrollTop: scrollContainer.scrollTop
    });

    if (cur >= detectedTotal) { dbg(cfg.debug, "목표 인원 달성", cur); break; }

    if (cur === prevCount) stableRounds++;
    else stableRounds = 0;

    if (stableRounds >= cfg.stableRoundLimit) {
      dbg(cfg.debug, "새 데이터 없음으로 종료", { stableRounds, cur });
      break;
    }

    prevCount = cur;

    const before = scrollContainer.scrollTop;
    scrollContainer.scrollTop = before + cfg.scrollStepPx;
    await sleep(cfg.scrollDelayMs);

    if (isBottom(scrollContainer) || scrollContainer.scrollTop === before) {
      await sleep(cfg.scrollDelayMs);
      const last = extractVisibleAttendanceRows(cfg.debug);
      for (const row of last) {
        const norm = normalizeRow(row);
        const key  = norm.name;
        if (!key) continue;
        map.set(key, map.has(key) ? mergeRow(map.get(key), norm) : norm);
      }
      if (map.size === cur) stableRounds++;
      if (stableRounds >= 2) break;
    }
  }

  const rows = Array.from(map.values())
    .filter(r => r.name)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return {
    ok     : true,
    pageUrl: location.href,
    date   : todayKST(),
    count  : rows.length,
    summary: makeSummary(rows),
    rows
  };
}

// ─────────────────────────────────────────────────────
// 총 인원 자동 감지
// ─────────────────────────────────────────────────────

async function detectTotalCount(scrollContainer, cfg) {
  scrollContainer.scrollTop = 0;
  await sleep(700);

  const nameSet = new Set();
  let prevSize = 0;
  let stable   = 0;

  for (let i = 0; i < cfg.maxScrollRounds; i++) {
    const visible = extractVisibleAttendanceRows(false);
    for (const row of visible) {
      const norm = normalizeRow(row);
      if (norm.name) nameSet.add(norm.name);
    }

    if (nameSet.size === prevSize) stable++;
    else stable = 0;

    if (stable >= cfg.stableRoundLimit) break;

    prevSize = nameSet.size;

    const before = scrollContainer.scrollTop;
    scrollContainer.scrollTop = before + cfg.scrollStepPx;
    await sleep(cfg.scrollDelayMs);

    if (isBottom(scrollContainer) || scrollContainer.scrollTop === before) {
      await sleep(cfg.scrollDelayMs);
      const last = extractVisibleAttendanceRows(false);
      for (const row of last) {
        const norm = normalizeRow(row);
        if (norm.name) nameSet.add(norm.name);
      }
      break;
    }
  }

  return nameSet.size > 10 ? nameSet.size : cfg.fixedCount;
}

// ─────────────────────────────────────────────────────
// 스크롤 컨테이너 탐색
// ─────────────────────────────────────────────────────

function findBestScrollContainer() {
  const candidates = Array.from(
    document.querySelectorAll("div, main, section, article, body, html")
  );
  const scrollable = candidates
    .map(el => {
      const style = window.getComputedStyle(el);
      const diff  = el.scrollHeight - el.clientHeight;
      const ov    = style.overflowY;
      const can   = diff > 100 && (ov === "auto" || ov === "scroll");
      return { el, diff, can };
    })
    .filter(x => x.can || x.diff > 300)
    .sort((a, b) => b.diff - a.diff);

  return scrollable[0]?.el
    || document.scrollingElement
    || document.documentElement
    || document.body;
}

// ─────────────────────────────────────────────────────
// 출결 행 추출 (4가지 전략)
// ─────────────────────────────────────────────────────

function extractVisibleAttendanceRows(debug) {
  const strategies = [
    { name: "tableRows",  fn: fromTableRows  },
    { name: "roleRows",   fn: fromRoleRows   },
    { name: "gridDivs",   fn: fromGridDivs   },
    { name: "textBlocks", fn: fromTextBlocks }
  ];

  let best = { name: "", rows: [] };

  for (const s of strategies) {
    const parsed = s.fn()
      .map(parseAttendanceCells)
      .filter(isValidRow);

    dbg(debug, `strategy:${s.name}`, { raw: s.fn().length, parsed: parsed.length });

    if (parsed.length > best.rows.length) best = { name: s.name, rows: parsed };
    if (parsed.length >= 10) return parsed;
  }

  return best.rows;
}

function fromTableRows() {
  return Array.from(document.querySelectorAll("tr"))
    .map(tr =>
      Array.from(tr.querySelectorAll("th, td"))
        .map(c => clean(c.innerText)).filter(Boolean)
    )
    .filter(cells => cells.length >= 2);
}

function fromRoleRows() {
  return Array.from(document.querySelectorAll('[role="row"]'))
    .map(row => {
      const cells = row.querySelectorAll('[role="cell"], [role="gridcell"]');
      if (cells.length > 0) {
        return Array.from(cells).map(c => clean(c.innerText)).filter(Boolean);
      }
      return Array.from(row.children).map(c => clean(c.innerText)).filter(Boolean);
    })
    .filter(cells => cells.length >= 2);
}

function fromGridDivs() {
  return Array.from(document.querySelectorAll("div"))
    .filter(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 500 || rect.height < 28 || rect.height > 180) return false;
      const text = clean(el.innerText);
      if (!text || isHeaderText(text)) return false;
      const hasName   = /[가-힣]{2,5}\s?[A-Za-z]?/.test(text);
      const hasTime   = /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(text);
      const hasPhone  = /010[-\s]?\d{3,4}[-\s]?\d{4}/.test(text);
      const hasStatus = /(입실|퇴실|지각|외출|조퇴|결석|미입실|출석)/.test(text);
      const hasRate   = /\d{1,3}\s?%/.test(text);
      return hasName && (hasTime || hasPhone || hasStatus || hasRate);
    })
    .map(el => {
      const children = Array.from(el.children)
        .map(c => clean(c.innerText)).filter(Boolean);
      return children.length >= 3 ? dedupe(children) : splitCells(clean(el.innerText));
    })
    .filter(cells => cells.length >= 2);
}

function fromTextBlocks() {
  const lines = (document.body.innerText || "")
    .split("\n").map(clean).filter(Boolean);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const block  = lines.slice(i, i + 12);
    const joined = block.join(" ");
    if (isHeaderText(joined)) continue;
    const hasName   = /[가-힣]{2,5}\s?[A-Za-z]?/.test(joined);
    const hasTime   = /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(joined);
    const hasPhone  = /010[-\s]?\d{3,4}[-\s]?\d{4}/.test(joined);
    const hasStatus = /(입실|퇴실|지각|외출|조퇴|결석|미입실|출석)/.test(joined);
    const hasRate   = /\d{1,3}\s?%/.test(joined);
    if (hasName && (hasTime || hasPhone || hasStatus || hasRate)) {
      rows.push(block);
      i += 5;
    }
  }
  return rows;
}

// ─────────────────────────────────────────────────────
// 셀 파싱
// ─────────────────────────────────────────────────────

function parseAttendanceCells(cells) {
  const cleaned = cells.map(clean).filter(Boolean);
  const raw     = cleaned.join(" ");
  const times   = extractTimes(raw);
  return {
    name           : extractName(cleaned),
    phone          : extractPhone(raw),
    birth          : extractBirth(raw),
    checkInTime    : times[0] || "",
    checkOutTime   : times[1] || "",
    todayStatus    : extractStatus(raw),
    attendanceRate : extractRate(raw, "attendance"),
    absenceRate    : extractRate(raw, "absence"),
    rawText        : raw,
    rawCells       : cleaned
  };
}

// ─────────────────────────────────────────────────────
// 추출 함수들
// ─────────────────────────────────────────────────────

const EXCLUDED_WORDS_SET = new Set([
  "이름","전화번호","생년월일","입실시간","퇴실시간",
  "오늘 상태","오늘상태","온도 평균","태그","최근 코멘트",
  "연락 요청","출석률","결석률","단위기간","훈련기간",
  "입실 완료","퇴실 완료","미입실","지각","외출","조퇴","결석","출석"
]);

function extractName(cells) {
  for (const cell of cells) {
    const v = clean(cell);
    if (!v || v.length > 12) continue;
    if (EXCLUDED_WORDS_SET.has(v)) continue;
    if (/010/.test(v)) continue;
    if (/\b\d{1,2}:\d{2}/.test(v)) continue;
    if (/%/.test(v)) continue;
    if (/^\d/.test(v)) continue;
    if (/(입실|퇴실|지각|외출|조퇴|결석|미입실|출석|상태|요청|코멘트|태그)/.test(v)) continue;
    if (/^[가-힣]{2,5}[A-Za-z]?$/.test(v)) return v;
  }
  const joined = cells.join(" ");
  const m = joined.match(/\b[가-힣]{2,5}[A-Za-z]?\b/);
  if (m && !EXCLUDED_WORDS_SET.has(m[0])) return m[0];
  return "";
}

function extractPhone(text) {
  const m = text.match(/010[-\s]?\d{3,4}[-\s]?\d{4}/);
  return m ? m[0].replace(/\s/g, "-") : "";
}

function extractBirth(text) {
  const m = text.match(/\b\d{2}\.\d{2}\.\d{2}\b|\b\d{6}\b/);
  return m ? m[0] : "";
}

function extractTimes(text) {
  const m = text.match(/\b\d{1,2}:\d{2}(:\d{2})?\b/g);
  return m ? m.map(normTime) : [];
}

function extractStatus(text) {
  const list = ["입실 완료","퇴실 완료","미입실","외출","복귀","조퇴","지각","결석","출석"];
  for (const s of list) if (text.includes(s)) return s;
  return "";
}

function extractRate(text, type) {
  const all = text.match(/\d{1,3}\s?%(\s?\(\d+\/\d+일\))?/g) || [];
  if (!all.length) return "";
  const keyword = type === "attendance" ? "출석률" : "결석률";
  const idx = text.indexOf(keyword);
  if (idx >= 0) {
    const near = text.slice(idx, idx + 120);
    const m = near.match(/\d{1,3}\s?%(\s?\(\d+\/\d+일\))?/);
    if (m) return m[0];
  }
  return type === "attendance" ? (all[0] || "") : (all[1] || "");
}

// ─────────────────────────────────────────────────────
// 정규화 / 판정 / 병합
// ─────────────────────────────────────────────────────

function normalizeRow(row) {
  return {
    name           : row.name           || "",
    phone          : row.phone          || "",
    birth          : row.birth          || "",
    checkInTime    : row.checkInTime    || "",
    checkOutTime   : row.checkOutTime   || "",
    todayStatus    : row.todayStatus    || "",
    autoStatus     : judgeStatus(row),
    attendanceRate : row.attendanceRate || "",
    absenceRate    : row.absenceRate    || "",
    rawText        : row.rawText        || ""
  };
}

function judgeStatus(row) {
  const s = row.todayStatus || "";
  if (s.includes("결석"))   return "결석";
  if (s.includes("외출"))   return "외출";
  if (s.includes("조퇴"))   return "조퇴";
  if (s.includes("미입실")) return "미입실";
  if (!row.checkInTime)     return "미입실";
  if (isAfter(row.checkInTime, "09:10:00"))  return "지각";
  if (row.checkOutTime && isBefore(row.checkOutTime, "20:50:00")) return "조퇴";
  return "정상입실";
}

function mergeRow(old, next) {
  return {
    ...old, ...next,
    phone          : next.phone          || old.phone,
    birth          : next.birth          || old.birth,
    checkInTime    : next.checkInTime    || old.checkInTime,
    checkOutTime   : next.checkOutTime   || old.checkOutTime,
    todayStatus    : next.todayStatus    || old.todayStatus,
    autoStatus     : next.autoStatus     || old.autoStatus,
    attendanceRate : next.attendanceRate || old.attendanceRate,
    absenceRate    : next.absenceRate    || old.absenceRate
  };
}

function isValidRow(row) {
  if (!row?.name) return false;
  if (EXCLUDED_WORDS_SET.has(row.name)) return false;
  return !!(
    row.phone || row.birth ||
    row.checkInTime || row.checkOutTime ||
    row.todayStatus || row.attendanceRate || row.absenceRate
  );
}

// ─────────────────────────────────────────────────────
// 요약
// ─────────────────────────────────────────────────────

function makeSummary(rows) {
  const s = { total: rows.length, normal:0, late:0, notCheckedIn:0, outing:0, earlyLeave:0, absent:0, unknown:0 };
  for (const r of rows) {
    if      (r.autoStatus === "정상입실") s.normal++;
    else if (r.autoStatus === "지각")     s.late++;
    else if (r.autoStatus === "미입실")   s.notCheckedIn++;
    else if (r.autoStatus === "외출")     s.outing++;
    else if (r.autoStatus === "조퇴")     s.earlyLeave++;
    else if (r.autoStatus === "결석")     s.absent++;
    else                                   s.unknown++;
  }
  return s;
}

// ─────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────

function clean(v) {
  return String(v || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
function dedupe(arr) { return arr.filter((v, i) => arr[i - 1] !== v); }
function splitCells(text) { return clean(text).split(/\s{2,}|\n/).map(clean).filter(Boolean); }
function isHeaderText(text) {
  const words = ["이름","전화번호","입실시간","퇴실시간","오늘 상태","출석률","결석률"];
  return words.filter(w => text.includes(w)).length >= 4;
}
function normTime(t) {
  const p = String(t).split(":");
  return [
    String(p[0]||"00").padStart(2,"0"),
    String(p[1]||"00").padStart(2,"0"),
    String(p[2]||"00").padStart(2,"0")
  ].join(":");
}
function toSec(t) {
  const [h,m,s] = normTime(t).split(":").map(Number);
  return h*3600 + m*60 + s;
}
function isAfter(t, target)  { return toSec(t) > toSec(target); }
function isBefore(t, target) { return toSec(t) < toSec(target); }
function isBottom(el) { return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 10; }
function todayKST() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul", year:"numeric", month:"2-digit", day:"2-digit"
  }).format(new Date());
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function dbg(enabled, msg, data) {
  if (!enabled) return;
  data !== undefined
    ? console.log(`[AttendanceSync] ${msg}`, data)
    : console.log(`[AttendanceSync] ${msg}`);
}
function descEl(el) {
  if (!el) return null;
  return { tag: el.tagName, id: el.id, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
}

} // ← if (!window.__attendanceCollectLoaded) 닫기
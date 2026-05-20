chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "COLLECT_ATTENDANCE_ROWS") {
    collectAttendanceRows(message.options || {})
      .then(result => sendResponse(result))
      .catch(error => {
        sendResponse({
          ok: false,
          error: error.message,
          stack: error.stack
        });
      });

    return true;
  }
});

async function collectAttendanceRows(options) {
  const config = {
    expectedTotalCount: Number(options.expectedTotalCount || 129),
    scrollStepPx: Number(options.scrollStepPx || 700),
    scrollDelayMs: Number(options.scrollDelayMs || 600),
    maxScrollRounds: Number(options.maxScrollRounds || 100),
    stableRoundLimit: Number(options.stableRoundLimit || 8),
    debug: Boolean(options.debug)
  };

  const scrollContainer = findBestScrollContainer();

  if (!scrollContainer) {
    throw new Error("스크롤 컨테이너를 찾지 못했습니다.");
  }

  debugLog(config.debug, "선택된 스크롤 컨테이너", describeElement(scrollContainer));

  const collectedMap = new Map();

  let previousCount = 0;
  let stableRounds = 0;

  scrollContainer.scrollTop = 0;
  await sleep(900);

  for (let round = 0; round < config.maxScrollRounds; round++) {
    const visibleRows = extractVisibleAttendanceRows(config.debug);

    for (const row of visibleRows) {
      const normalized = normalizeAttendanceRow(row);
      const key = makeUniqueKey(normalized);

      if (!key) continue;

      const existing = collectedMap.get(key);

      if (existing) {
        collectedMap.set(key, mergeRow(existing, normalized));
      } else {
        collectedMap.set(key, normalized);
      }
    }

    const currentCount = collectedMap.size;

    debugLog(config.debug, `round ${round + 1}`, {
      visibleRows: visibleRows.length,
      collectedCount: currentCount,
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight
    });

    if (currentCount >= config.expectedTotalCount) {
      debugLog(config.debug, "예상 인원 수집 완료", currentCount);
      break;
    }

    if (currentCount === previousCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= config.stableRoundLimit) {
      debugLog(config.debug, "새 데이터 없음으로 종료", {
        stableRounds,
        currentCount
      });
      break;
    }

    previousCount = currentCount;

    const beforeScrollTop = scrollContainer.scrollTop;

    scrollContainer.scrollTop = beforeScrollTop + config.scrollStepPx;
    await sleep(config.scrollDelayMs);

    const afterScrollTop = scrollContainer.scrollTop;

    const reachedBottom = isReachedBottom(scrollContainer);

    if (afterScrollTop === beforeScrollTop || reachedBottom) {
      debugLog(config.debug, "하단 도달 감지", {
        beforeScrollTop,
        afterScrollTop,
        reachedBottom
      });

      await sleep(config.scrollDelayMs);

      const finalVisibleRows = extractVisibleAttendanceRows(config.debug);

      for (const row of finalVisibleRows) {
        const normalized = normalizeAttendanceRow(row);
        const key = makeUniqueKey(normalized);

        if (!key) continue;

        const existing = collectedMap.get(key);

        if (existing) {
          collectedMap.set(key, mergeRow(existing, normalized));
        } else {
          collectedMap.set(key, normalized);
        }
      }

      if (collectedMap.size === currentCount) {
        stableRounds += 1;
      }

      if (stableRounds >= 2) {
        break;
      }
    }
  }

  const rows = Array.from(collectedMap.values())
    .filter(row => row.name)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  const summary = summarizeRows(rows);

  return {
    ok: true,
    pageUrl: location.href,
    date: getTodayKoreanDateString(),
    count: rows.length,
    summary,
    rows
  };
}

function findBestScrollContainer() {
  const candidates = Array.from(document.querySelectorAll("div, main, section, article, body, html"));

  const scrollables = candidates
    .map(el => {
      const style = window.getComputedStyle(el);

      const overflowY = style.overflowY;
      const diff = el.scrollHeight - el.clientHeight;

      const canScroll =
        diff > 100 &&
        (
          overflowY === "auto" ||
          overflowY === "scroll" ||
          el === document.body ||
          el === document.documentElement
        );

      return {
        el,
        diff,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY
      };
    })
    .filter(item => item.canScroll || item.diff > 300)
    .sort((a, b) => b.diff - a.diff);

  if (scrollables.length > 0) {
    return scrollables[0].el;
  }

  return document.scrollingElement || document.documentElement || document.body;
}

function extractVisibleAttendanceRows(debug = false) {
  const strategies = [
    {
      name: "tableRows",
      fn: extractFromTableRows
    },
    {
      name: "roleRows",
      fn: extractFromRoleRows
    },
    {
      name: "gridLikeDivs",
      fn: extractFromGridLikeDivs
    },
    {
      name: "textBlocks",
      fn: extractFromTextBlocks
    }
  ];

  let best = {
    name: "",
    rows: []
  };

  for (const strategy of strategies) {
    const rawRows = strategy.fn();

    const parsedRows = rawRows
      .map(cells => parseAttendanceCells(cells))
      .filter(isValidAttendanceRow);

    debugLog(debug, `strategy ${strategy.name}`, {
      raw: rawRows.length,
      parsed: parsedRows.length,
      sample: parsedRows.slice(0, 3)
    });

    if (parsedRows.length > best.rows.length) {
      best = {
        name: strategy.name,
        rows: parsedRows
      };
    }

    if (parsedRows.length >= 10) {
      return parsedRows;
    }
  }

  debugLog(debug, "best strategy selected", {
    name: best.name,
    count: best.rows.length
  });

  return best.rows;
}

function extractFromTableRows() {
  const trs = Array.from(document.querySelectorAll("tr"));

  return trs.map(tr => {
    const cells = Array.from(tr.querySelectorAll("th, td"))
      .map(cell => cleanText(cell.innerText))
      .filter(Boolean);

    return cells;
  }).filter(cells => cells.length >= 2);
}

function extractFromRoleRows() {
  const rows = Array.from(document.querySelectorAll('[role="row"]'));

  return rows.map(row => {
    const directCells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"]'));

    if (directCells.length > 0) {
      return directCells
        .map(cell => cleanText(cell.innerText))
        .filter(Boolean);
    }

    return Array.from(row.children)
      .map(child => cleanText(child.innerText))
      .filter(Boolean);
  }).filter(cells => cells.length >= 2);
}

function extractFromGridLikeDivs() {
  const all = Array.from(document.querySelectorAll("div"));

  const candidates = all.filter(el => {
    const rect = el.getBoundingClientRect();

    if (rect.width < 500) return false;
    if (rect.height < 28 || rect.height > 180) return false;

    const text = cleanText(el.innerText);
    if (!text) return false;

    if (isHeaderLikeText(text)) return false;

    const hasName = /[가-힣]{2,5}\s?[A-Za-z]?/.test(text);
    const hasTime = /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(text);
    const hasPhone = /010[-\s]?\d{3,4}[-\s]?\d{4}/.test(text);
    const hasStatus = /(입실|퇴실|지각|외출|조퇴|결석|미입실|출석)/.test(text);
    const hasRate = /\d{1,3}\s?%/.test(text);

    return hasName && (hasTime || hasPhone || hasStatus || hasRate);
  });

  return candidates.map(el => {
    const children = Array.from(el.children)
      .map(child => cleanText(child.innerText))
      .filter(Boolean);

    if (children.length >= 3) {
      return dedupeAdjacent(children);
    }

    return splitTextToCells(cleanText(el.innerText));
  }).filter(cells => cells.length >= 2);
}

function extractFromTextBlocks() {
  const text = document.body.innerText || "";

  const lines = text
    .split("\n")
    .map(cleanText)
    .filter(Boolean);

  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const block = lines.slice(i, i + 12);
    const joined = block.join(" ");

    if (isHeaderLikeText(joined)) continue;

    const hasName = /[가-힣]{2,5}\s?[A-Za-z]?/.test(joined);
    const hasTime = /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(joined);
    const hasPhone = /010[-\s]?\d{3,4}[-\s]?\d{4}/.test(joined);
    const hasStatus = /(입실|퇴실|지각|외출|조퇴|결석|미입실|출석)/.test(joined);
    const hasRate = /\d{1,3}\s?%/.test(joined);

    if (hasName && (hasTime || hasPhone || hasStatus || hasRate)) {
      rows.push(block);
      i += 5;
    }
  }

  return rows;
}

function parseAttendanceCells(cells) {
  const cleanedCells = cells
    .map(cleanText)
    .filter(Boolean);

  const rawText = cleanedCells.join(" ");

  const name = extractName(cleanedCells);
  const phone = extractPhone(rawText);
  const birth = extractBirth(rawText);
  const times = extractTimes(rawText);

  const checkInTime = guessCheckInTime(cleanedCells, times);
  const checkOutTime = guessCheckOutTime(cleanedCells, times);
  const todayStatus = extractTodayStatus(rawText);

  const attendanceRate = extractRate(rawText, "attendance");
  const absenceRate = extractRate(rawText, "absence");

  return {
    name,
    phone,
    birth,
    checkInTime,
    checkOutTime,
    todayStatus,
    attendanceRate,
    absenceRate,
    rawText,
    rawCells: cleanedCells
  };
}

function extractName(cells) {
  const excludedWords = new Set([
    "이름",
    "전화번호",
    "생년월일",
    "입실시간",
    "퇴실시간",
    "오늘 상태",
    "오늘상태",
    "온도 평균",
    "태그",
    "최근 코멘트",
    "연락 요청",
    "출석률",
    "결석률",
    "단위기간",
    "훈련기간",
    "입실 완료",
    "퇴실 완료",
    "미입실",
    "지각",
    "외출",
    "조퇴",
    "결석",
    "출석"
  ]);

  for (const cell of cells) {
    const value = cleanText(cell);

    if (!value) continue;
    if (excludedWords.has(value)) continue;
    if (value.length > 12) continue;

    if (/010[-\s]?\d{3,4}[-\s]?\d{4}/.test(value)) continue;
    if (/\b\d{1,2}:\d{2}(:\d{2})?\b/.test(value)) continue;
    if (/\d{1,3}\s?%/.test(value)) continue;
    if (/^\d/.test(value)) continue;
    if (/(입실|퇴실|지각|외출|조퇴|결석|미입실|출석|상태|요청|코멘트|태그)/.test(value)) continue;

    if (/^[가-힣]{2,5}\s?[A-Za-z]?$/.test(value)) {
      return value.replace(/\s+/g, "");
    }

    if (/^[가-힣]{2,5}[A-Za-z]$/.test(value)) {
      return value;
    }
  }

  const joined = cells.join(" ");
  const match = joined.match(/\b[가-힣]{2,5}\s?[A-Za-z]?\b/);

  if (match) {
    const candidate = match[0].replace(/\s+/g, "");

    if (!excludedWords.has(candidate)) {
      return candidate;
    }
  }

  return "";
}

function extractPhone(text) {
  const match = text.match(/010[-\s]?\d{3,4}[-\s]?\d{4}/);
  return match ? match[0].replace(/\s+/g, "-") : "";
}

function extractBirth(text) {
  const match = text.match(/\b\d{2}\.\d{2}\.\d{2}\b|\b\d{6}\b/);
  return match ? match[0] : "";
}

function extractTimes(text) {
  const matches = text.match(/\b\d{1,2}:\d{2}(:\d{2})?\b/g);
  return matches ? matches.map(normalizeTime) : [];
}

function guessCheckInTime(cells, times) {
  if (times.length >= 1) return times[0];
  return "";
}

function guessCheckOutTime(cells, times) {
  if (times.length >= 2) return times[1];
  return "";
}

function extractTodayStatus(text) {
  const statuses = [
    "입실 완료",
    "퇴실 완료",
    "미입실",
    "외출",
    "복귀",
    "조퇴",
    "지각",
    "결석",
    "출석"
  ];

  for (const status of statuses) {
    if (text.includes(status)) return status;
  }

  return "";
}

function extractRate(text, type) {
  const rateMatches = text.match(/\d{1,3}\s?%(\s?\(\d+\/\d+일\))?/g) || [];

  if (rateMatches.length === 0) return "";

  if (type === "attendance") {
    const idx = text.indexOf("출석률");
    if (idx >= 0) {
      const near = text.slice(idx, idx + 120);
      const nearMatch = near.match(/\d{1,3}\s?%(\s?\(\d+\/\d+일\))?/);
      if (nearMatch) return nearMatch[0];
    }

    return rateMatches[0] || "";
  }

  if (type === "absence") {
    const idx = text.indexOf("결석률");
    if (idx >= 0) {
      const near = text.slice(idx, idx + 120);
      const nearMatch = near.match(/\d{1,3}\s?%(\s?\(\d+\/\d+일\))?/);
      if (nearMatch) return nearMatch[0];
    }

    return rateMatches[1] || "";
  }

  return "";
}

function normalizeAttendanceRow(row) {
  const autoStatus = judgeAutoStatus(row);

  return {
    name: row.name || "",
    phone: row.phone || "",
    birth: row.birth || "",
    checkInTime: row.checkInTime || "",
    checkOutTime: row.checkOutTime || "",
    todayStatus: row.todayStatus || "",
    autoStatus,
    attendanceRate: row.attendanceRate || "",
    absenceRate: row.absenceRate || "",
    rawText: row.rawText || ""
  };
}

function judgeAutoStatus(row) {
  const todayStatus = row.todayStatus || "";

  if (todayStatus.includes("결석")) return "결석";
  if (todayStatus.includes("외출")) return "외출";
  if (todayStatus.includes("조퇴")) return "조퇴";
  if (todayStatus.includes("미입실")) return "미입실";

  if (!row.checkInTime) return "미입실";

  if (isAfterTime(row.checkInTime, "09:10:00")) {
    return "지각";
  }

  if (row.checkOutTime && isBeforeTime(row.checkOutTime, "20:50:00")) {
    return "조퇴";
  }

  return "정상입실";
}

function isValidAttendanceRow(row) {
  if (!row) return false;
  if (!row.name) return false;

  const invalidNames = new Set([
    "이름",
    "출결",
    "전화번호",
    "입실시간",
    "퇴실시간",
    "오늘상태",
    "오늘",
    "상태",
    "출석률",
    "결석률"
  ]);

  if (invalidNames.has(row.name)) return false;

  const hasSignal =
    row.phone ||
    row.birth ||
    row.checkInTime ||
    row.checkOutTime ||
    row.todayStatus ||
    row.attendanceRate ||
    row.absenceRate;

  return Boolean(hasSignal);
}

function makeUniqueKey(row) {
  if (!row || !row.name) return "";
  return row.name;
}

function mergeRow(oldRow, newRow) {
  return {
    ...oldRow,
    ...newRow,
    name: newRow.name || oldRow.name,
    phone: newRow.phone || oldRow.phone,
    birth: newRow.birth || oldRow.birth,
    checkInTime: newRow.checkInTime || oldRow.checkInTime,
    checkOutTime: newRow.checkOutTime || oldRow.checkOutTime,
    todayStatus: newRow.todayStatus || oldRow.todayStatus,
    autoStatus: newRow.autoStatus || oldRow.autoStatus,
    attendanceRate: newRow.attendanceRate || oldRow.attendanceRate,
    absenceRate: newRow.absenceRate || oldRow.absenceRate,
    rawText: newRow.rawText || oldRow.rawText
  };
}

function summarizeRows(rows) {
  const summary = {
    total: rows.length,
    normal: 0,
    late: 0,
    notCheckedIn: 0,
    outing: 0,
    earlyLeave: 0,
    absent: 0,
    unknown: 0
  };

  for (const row of rows) {
    switch (row.autoStatus) {
      case "정상입실":
        summary.normal += 1;
        break;
      case "지각":
        summary.late += 1;
        break;
      case "미입실":
        summary.notCheckedIn += 1;
        break;
      case "외출":
        summary.outing += 1;
        break;
      case "조퇴":
        summary.earlyLeave += 1;
        break;
      case "결석":
        summary.absent += 1;
        break;
      default:
        summary.unknown += 1;
    }
  }

  return summary;
}

function isReachedBottom(el) {
  return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 10;
}

function normalizeTime(time) {
  if (!time) return "";

  const parts = String(time).split(":");

  const hour = String(parts[0] || "00").padStart(2, "0");
  const minute = String(parts[1] || "00").padStart(2, "0");
  const second = String(parts[2] || "00").padStart(2, "0");

  return `${hour}:${minute}:${second}`;
}

function timeToSeconds(time) {
  const normalized = normalizeTime(time);
  const [h, m, s] = normalized.split(":").map(Number);

  return h * 3600 + m * 60 + s;
}

function isAfterTime(time, target) {
  return timeToSeconds(time) > timeToSeconds(target);
}

function isBeforeTime(time, target) {
  return timeToSeconds(time) < timeToSeconds(target);
}

function getTodayKoreanDateString() {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  return formatter.format(new Date());
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeAdjacent(values) {
  const result = [];

  for (const value of values) {
    if (result[result.length - 1] !== value) {
      result.push(value);
    }
  }

  return result;
}

function splitTextToCells(text) {
  return cleanText(text)
    .split(/\s{2,}|\n/)
    .map(cleanText)
    .filter(Boolean);
}

function isHeaderLikeText(text) {
  const headerWords = [
    "이름",
    "전화번호",
    "생년월일",
    "입실시간",
    "퇴실시간",
    "오늘 상태",
    "온도 평균",
    "태그",
    "최근 코멘트",
    "연락 요청",
    "출석률",
    "결석률"
  ];

  let count = 0;

  for (const word of headerWords) {
    if (text.includes(word)) count += 1;
  }

  return count >= 4;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debugLog(enabled, message, data) {
  if (!enabled) return;

  if (data !== undefined) {
    console.log(`[Attendance Sync] ${message}`, data);
  } else {
    console.log(`[Attendance Sync] ${message}`);
  }
}

function describeElement(el) {
  if (!el) return null;

  return {
    tagName: el.tagName,
    className: el.className,
    id: el.id,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop
  };
}

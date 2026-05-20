const CONFIG = {
  // Google Apps Script Web App 배포 URL (나중에 교체)
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbzZkx30CUBJ3sU5cP0r4ObDnCzLIYbl2-9HNjyddxiX6butxq3F2s0ScjUwjj7Y-B0i/exec",

  // 인원 자동 감지 사용 (true 권장)
  // false로 하면 FIXED_COUNT를 사용
  AUTO_DETECT_COUNT: true,

  // AUTO_DETECT_COUNT가 false일 때만 사용
  FIXED_COUNT: 129,

  // 스크롤 설정
  SCROLL_STEP_PX: 600,
  SCROLL_DELAY_MS: 600,
  MAX_SCROLL_ROUNDS: 150,

  // 이 라운드 수 동안 새 데이터가 없으면 종료
  STABLE_ROUND_LIMIT: 8,

  // 콘솔 디버그 로그 출력 여부
  DEBUG: true
};

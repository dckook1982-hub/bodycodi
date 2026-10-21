// ================================================
// BodyCodi → Google Calendar Sync
// bc-watch.js  (⭐ v1.18.4 예약 변경 감지)
//
// 이 PC의 바디코디 화면에서 직원이 예약을 저장·등록·수정·삭제·취소하거나
// 스케줄표에서 예약을 끌어 옮기면, 확장에 "변경됨"만 알린다 → 1분 30초 뒤 한 번 동기화.
// 버튼 글자(최대 20자)만 보고, 회원 이름·연락처 같은 화면 내용은 읽거나 보내지 않는다.
// ================================================
(() => {
  if (window.__bcWatchInstalled) return;
  window.__bcWatchInstalled = true;

  const ACTION_RE = /(저장|등록|예약|수정|변경|삭제|취소|이동|출석|결석|노쇼)/;
  let lastSent = 0;
  const notify = (label) => {
    const now = Date.now();
    if (now - lastSent < 5000) return;   // 같은 동작의 연속 클릭은 한 번만
    lastSent = now;
    try {
      chrome.runtime.sendMessage({ __bcWatch: 'change', label: String(label || '').slice(0, 20) }).catch(() => {});
    } catch (e) { /* 확장이 다시 불러와지는 중 등 — 무시 */ }
  };

  // ① 버튼 클릭 (저장·예약·삭제·취소 …)
  document.addEventListener('click', (e) => {
    try {
      const el = e.target && e.target.closest &&
        e.target.closest('button, a, input[type="button"], input[type="submit"], [role="button"], .btn');
      if (!el) return;
      // 다른 화면으로 가는 메뉴 링크(예: "예약관리")는 변경이 아님
      const href = el.tagName === 'A' ? String(el.getAttribute('href') || '') : '';
      if (href && !/^(#|javascript:)/i.test(href)) return;
      const text = String(el.innerText || el.value || el.textContent || '').trim().slice(0, 20);
      if (text && ACTION_RE.test(text)) notify(text);
    } catch (err) { /* 무시 */ }
  }, true);

  // ② 스케줄표에서 예약을 끌어 다른 시간으로 옮김 (예약 블록을 누른 채 8px 넘게 움직였다 놓음)
  let down = null;
  document.addEventListener('mousedown', (e) => {
    const block = e.target && e.target.closest && e.target.closest('[event_id], [data-event-id]');
    down = block ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  document.addEventListener('mouseup', (e) => {
    if (!down) return;
    const moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 8;
    down = null;
    if (moved) notify('예약 끌어 옮김');
  }, true);
})();

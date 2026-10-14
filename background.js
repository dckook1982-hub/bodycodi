// ================================================
// BodyCodi → Google Calendar Sync
// background.js
// - v1.15.0: 4주(이번 주 일요일 ~ 3주 뒤 토요일) 전체 동기화 (SYNC_WEEKS 상수로 조절)
// - 제목 포맷: "회원번호 성함 연락처 프로그램이름" (회원번호 없으면 생략)
// - 설명 자동 라인(v1.13.0): "프로그램명 / 유효기간 / 총횟수 / 잔여횟수" (사용자 메모는 보존)
// - v1.14.0: 예약이 옮겨지면 회원번호로 캘린더의 옛 일정을 찾아 새 시각으로 이동, 짝이 없으면 새로 생성
// - v1.9.0: 평가 프로그램(담당쌤 동작기능평가/대표원장 관절기능평가)은 "N회차"를 제목 끝에 보존
// - popup.js의 __bcPopup 메시지 구조에 맞춤
// ================================================

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ⭐ v1.15.0: 동기화 주 수 (이번 주 포함). 바디코디 화면을 이 수만큼 주 단위로 넘기며 예약을 읽는다
const SYNC_WEEKS = 4;

// ---------- 유틸 ----------
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 동기화 범위: 이번 주 일요일 00:00 ~ (SYNC_WEEKS주 뒤) 토요일 23:59:59.999 (총 SYNC_WEEKS×7일)
function getSyncRange(date, weeks = SYNC_WEEKS) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일, 6=토
  const start = new Date(d);
  start.setDate(d.getDate() - day);     // 이번 주 일요일
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + weeks * 7 - 1);   // 일요일 + (7×주 − 1)일 = 마지막 주 토요일
  end.setHours(23, 59, 59, 999);
  return { rangeStart: start, rangeEnd: end };
}

// 날짜/시간 문자열 → epoch ms (파싱 실패 시 null)
function tsOf(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// 로그용 짧은 시각 표기 (예: 7/28 17:30)
function hhmm(v) {
  const t = tsOf(v);
  if (t === null) return '(시각없음)';
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function appendLog(msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift(line);
  if (logs.length > 500) logs.length = 500;
  await chrome.storage.local.set({ logs });
}

// 팝업으로 진행률 알림 (팝업이 닫혀있으면 조용히 실패)
function reportProgress(percent, label) {
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  try {
    chrome.runtime.sendMessage({
      __bcProgress: true,
      percent: pct,
      label: label || ''
    }).catch(() => { /* 팝업 닫힘 등 — 무시 */ });
  } catch (e) { /* fire-and-forget */ }
}

// ---------- OAuth ----------
function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'no token'));
      } else {
        resolve(token);
      }
    });
  });
}

// ---------- Google Calendar API ----------
async function gcalFetch(token, path, options = {}) {
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GCal ${res.status}: ${text}`);
  }
  return res.json();
}

async function listEventsInRange(token, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
    // extendedProperties는 fields 미지정 시 기본 응답에 포함됨 — 명시적으로 보장
    fields: 'items(id,summary,description,start,end,extendedProperties,colorId,transparency,created)'
  });
  const data = await gcalFetch(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  );
  return data.items || [];
}

async function patchEvent(token, calendarId, eventId, body) {
  return gcalFetch(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
}

// ⭐ v1.18.0: 일정 삭제 — 바디코디에서 취소·삭제된 예약, 같은 예약의 중복 일정만 지운다
//   (구글 캘린더 휴지통에 30일간 남아 복구 가능). 이미 지워진 일정(404/410)은 성공으로 본다.
async function deleteEvent(token, calendarId, eventId) {
  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.ok || res.status === 404 || res.status === 410) return true;
  const text = await res.text();
  throw new Error(`GCal ${res.status}: ${text}`);
}

// ⭐ v1.14.0: 캘린더 일정 생성
async function insertEvent(token, calendarId, body) {
  return gcalFetch(
    token,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

// ⭐ v1.16.0: 담당 강사가 바뀐 예약의 일정을 다른 캘린더로 옮긴다 (삭제·재생성 아님)
async function moveEventToCalendar(token, fromCalendarId, eventId, toCalendarId) {
  return gcalFetch(
    token,
    `/calendars/${encodeURIComponent(fromCalendarId)}/events/${encodeURIComponent(eventId)}/move?destination=${encodeURIComponent(toCalendarId)}`,
    { method: 'POST' }
  );
}

// v1.16.0~1.17.0의 [취소] 표시 — v1.18.0부터는 삭제로 바뀌었고, 예전 표시를 알아보거나 복구할 때만 쓴다
function stripCancelPrefix(title) {
  return String(title || '').replace(/^\s*\[취소\]\s*/, '');
}
function isCancelMarked(g) {
  return g?.extendedProperties?.private?.bcCancelled === '1' || /^\s*\[취소\]/.test(g?.summary || '');
}

// ---------- ⭐ v1.14.0: 회원 식별 (캘린더 제목 ↔ 바디코디 예약) ----------
// 제목에서 회원번호(예: 26-073) 추출 — 전화번호 일부가 걸리지 않도록 경계 조건
function memberNoInTitle(title) {
  const m = String(title || '').match(/(?<![\d-])(\d{2}-\d{3})(?!\d)/);
  return m ? m[1] : '';
}
function phoneDigits(s) {
  const m = String(s || '').match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
  return m ? m[0].replace(/\D/g, '') : '';
}
// 회원 키: 회원번호가 있으면 "no:26-073", 없으면 "np:이름|01012345678"
function memberKeyOfBc(bc) {
  if (bc.memberNo) return `no:${bc.memberNo}`;
  const ph = phoneDigits(bc.phone);
  if (bc.memberName && ph) return `np:${bc.memberName}|${ph}`;
  return '';
}
function memberKeyOfGcal(g) {
  const title = g.summary || '';
  const no = memberNoInTitle(title);
  if (no) return `no:${no}`;
  const ph = phoneDigits(title);
  const nm = title.match(/([가-힣]{2,12})/);
  if (nm && ph) return `np:${nm[1]}|${ph}`;
  return '';
}
// 캘린더 일정이 "고객 예약"으로 보이는지 (마커가 있거나 제목에 회원번호/이름+연락처)
function isCustomerGcalEvent(g) {
  return !!(g.extendedProperties?.private?.bcSyncId) || !!memberKeyOfGcal(g);
}
// ⭐ v1.18.0: 프로그램명 핵심어 — "02 집중관절관리 3회 12개월" → "집중관절관리"
//   (바디코디 자체 연동은 회원 정보 없이 "02 집중관절관리 3회차" 같은 제목으로 일정을 만들기도 한다)
function programCore(program) {
  return String(program || '')
    .replace(/^\s*\d+\s*/, '')
    .replace(/\s*\d+\s*회.*$/, '')
    .replace(/\s+/g, '')
    .trim();
}
// 삭제 판단용(더 엄격): 회원키가 같거나 회원번호가 제목에 있거나, 회원 정보 없는 제목에 같은 프로그램명
//   — 성함만 같은 메모(예: "김혜정님대기")는 지우지 않는다
function sameBookingForDelete(g, bc) {
  const title = String(g.summary || '');
  const key = memberKeyOfBc(bc);
  const gk = memberKeyOfGcal(g);
  if (gk) return gk === key || !!(bc.memberNo && title.includes(bc.memberNo));
  if (bc.memberNo && title.includes(bc.memberNo)) return true;
  const core = programCore(bc.program);
  return core.length >= 3 && title.replace(/\s+/g, '').includes(core);
}
// 같은 예약을 가리키는 일정인지 (회원키가 같거나, 회원번호·성함이 제목에 있거나,
//   회원 정보가 없는 제목에 같은 프로그램명이 들어 있음)
function sameBookingTitle(g, bc) {
  const title = String(g.summary || '');
  const key = memberKeyOfBc(bc);
  const gk = memberKeyOfGcal(g);
  if (key && gk) {
    return gk === key || !!(bc.memberNo && title.includes(bc.memberNo)) ||
      !!(bc.memberName && bc.memberName.length >= 2 && title.includes(bc.memberName));
  }
  if (bc.memberNo && title.includes(bc.memberNo)) return true;
  if (!gk && bc.memberName && bc.memberName.length >= 2 && title.includes(bc.memberName)) return true;
  if (!gk) {
    const core = programCore(bc.program);
    if (core.length >= 3 && title.replace(/\s+/g, '').includes(core)) return true;
  }
  return false;
}

// ---------- ⭐ v1.16.0: 최신 데이터를 읽기 위한 "동기화 전용 탭" ----------
// 원인: 이미 열려 있는 바디코디 탭의 scheduler 데이터는 그 탭을 연 시점(몇 시간 전일 수 있음)의 것이다.
//       다른 직원·다른 PC·회원 앱에서 생긴 예약/취소/이동은 그 탭을 새로고침하기 전까지 보이지 않는다.
// 해결: 동기화할 때마다 바디코디 스케줄 화면을 백그라운드 새 탭으로 열어(로그인 세션 공유)
//       서버에서 막 받은 데이터를 읽고, 끝나면 탭을 닫는다. 사용자가 보고 있는 탭은 건드리지 않는다.
const BODYCODI_SCHEDULE_URL = 'https://crm.bodycodi.com/manager/schedule/promise';
const BC_SCHEDULE_PATTERN = 'https://crm.bodycodi.com/manager/schedule/*';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findBodyCodiTab() {
  const tabs = await chrome.tabs.query({ url: BC_SCHEDULE_PATTERN });
  return tabs[0] || null;
}

// 새 탭을 열고 scheduler가 준비될 때까지 기다린다. 실패하면 탭을 닫고 이유를 던진다.
async function openFreshBodyCodiTab(baseTab) {
  let url = BODYCODI_SCHEDULE_URL;
  if (baseTab?.url && baseTab.url.startsWith('https://crm.bodycodi.com/manager/schedule/')) {
    url = baseTab.url.split('#')[0];
  }
  let tab;
  try {
    tab = await chrome.tabs.create({
      url, active: false,
      ...(baseTab ? { windowId: baseTab.windowId, index: baseTab.index + 1 } : {})
    });
  } catch (e) {
    // 일반 창이 하나도 없을 때 (크롬이 백그라운드로만 실행 중)
    const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    tab = win.tabs[0];
  }

  const deadline = Date.now() + 40000;
  let readyAt = 0;
  try {
    while (Date.now() < deadline) {
      await sleep(700);
      let r = null;
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: () => {
            const ready = typeof scheduler !== 'undefined' && typeof scheduler.getEvents === 'function' &&
                          !!(scheduler.getState && scheduler.getState().date);
            // 최근 15초 안에 시작된 요청만 본다 (오래 열려 있는 알림 요청 등은 무시)
            const a = typeof window.__bcNetActivity === 'function' ? window.__bcNetActivity(Date.now() - 15000) : null;
            return { href: location.href, ready, busy: a ? a.busy : -1, quietMs: a ? Date.now() - (a.lastEnd || 0) : -1 };
          }
        });
        r = res?.[0]?.result;
      } catch (e) { /* 아직 로딩 중 */ }
      if (!r) continue;
      if (!/\/manager\/schedule\//.test(r.href)) {
        throw new Error('바디코디 스케줄 화면이 열리지 않음 (로그인이 필요할 수 있음)');
      }
      // 준비 조건: scheduler 생성 + 첫 데이터 요청까지 끝남 (요청 추적이 안 되거나 8초가 지나면 그냥 진행)
      if (r.ready) {
        readyAt ||= Date.now();
        if (r.busy === -1 || (r.busy === 0 && r.quietMs >= 800) || Date.now() - readyAt > 8000) {
          return tab.id;
        }
      }
    }
    throw new Error('바디코디 스케줄 화면 로딩 시간 초과 (40초)');
  } catch (e) {
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    throw e;
  }
}

// ---------- BodyCodi 탭에서 스케줄 추출 ----------
//   tabId: 읽을 탭, rangeStart/rangeEnd: 동기화 범위, restoreView: 사용자 탭이면 화면을 원래대로 돌려놓음
async function extractSchedulesFromBodyCodi(tabId, { rangeStart, rangeEnd, restoreView = false }) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [SYNC_WEEKS, rangeStart.getTime(), rangeEnd.getTime(), !!restoreView],
    func: async (SYNC_WEEKS_ARG, RANGE_START_MS, RANGE_END_MS, RESTORE_VIEW) => {
      try {
        if (typeof scheduler === 'undefined' || typeof scheduler.getEvents !== 'function') {
          return { ok: false, error: 'scheduler 객체 없음' };
        }
        const WEEKS = Math.max(1, Number(SYNC_WEEKS_ARG) || 2);

        // 강사명 매핑 (select 옵션에서 파싱)
        const coachNameMap = {};
        const allSelects = document.querySelectorAll('select');
        for (const sel of allSelects) {
          const opts = Array.from(sel.options).filter(o =>
            o.value && String(parseInt(o.value)) === o.value && parseInt(o.value) > 1000
          );
          if (opts.length > 2) {
            opts.forEach(o => { coachNameMap[o.value] = o.text.trim(); });
            break;
          }
        }

        // ⭐ v1.9.0: 강사 이름 집합 (평가 이벤트 이름 fallback에서 강사명 오인 방지)
        const coachNames = new Set();
        for (const n of Object.values(coachNameMap)) {
          const clean = String(n).replace(/\s+/g, '');
          coachNames.add(clean);
          coachNames.add(clean.replace(/(쌤|강사|선생님?)$/, ''));
        }

        // === ⭐ v1.16.0: 범위 전체를 화면 단위로 차례로 읽기 ===
        //   - 동기화 범위 첫날부터 시작해, 화면이 보여 주는 구간(state.min_date ~ max_date) 단위로 넘어간다.
        //     (주 시작이 일요일이든 월요일이든, 일/주/월 보기든 빈틈없이 덮인다)
        //   - 화면을 넘길 때마다 바디코디의 데이터 요청이 끝날 때까지 기다린다 (bc-netlog 요청 카운터).
        //     카운터가 없으면 예전처럼 2.5초 고정 대기.
        //   - 각 화면에서는 그 화면 구간에 시작하는 예약만 취한다 → 다른 주의 묵은 캐시가 섞이지 않음.
        const DAY = 86400000;
        // navStart: 화면을 넘기기 직전 시각. 그 뒤에 시작된 요청만 기다린다.
        //   ⭐ v1.18.1: 최대 15초(예전 10초). 시간초과면 끝나지 않은 요청 경로를 기록해 둔다(원인 진단용).
        const timeoutPaths = new Set();
        const settle = async (navStart) => {
          await new Promise(r => setTimeout(r, 450));
          if (typeof window.__bcNetActivity !== 'function') {
            await new Promise(r => setTimeout(r, 2050));
            return 'fixed';
          }
          let a = null;
          while (Date.now() - navStart < 15000) {
            a = window.__bcNetActivity(navStart);
            if (a.busy === 0) {
              // 요청이 하나도 없었으면(캐시로 그림) 0.9초, 있었으면 마지막 완료 후 0.5초 더 기다림
              if (a.started === 0 ? Date.now() - navStart >= 900 : Date.now() - a.lastEnd >= 500) return 'net';
            }
            await new Promise(r => setTimeout(r, 150));
          }
          for (const p of (a && a.pending) || []) if (timeoutPaths.size < 5) timeoutPaths.add(String(p));
          return 'timeout';
        };
        const evStartMs = (ev) => {
          const t = ev.start_date instanceof Date ? ev.start_date.getTime() : new Date(ev.start_date).getTime();
          return Number.isFinite(t) ? t : null;
        };
        const renderedIds = () => {
          const ids = new Set();
          document.querySelectorAll('[event_id],[data-event-id]').forEach(el => {
            const v = el.getAttribute('event_id') || el.getAttribute('data-event-id');
            if (v) ids.add(String(v));
          });
          return ids;
        };

        const fetchRangeEvents = async () => {
          let origDate = null, origMode = 'week';
          try {
            const state = (scheduler.getState && scheduler.getState()) || {};
            origDate = state.date ? new Date(state.date) : null;
            origMode = state.mode || 'week';
          } catch (e) { /* state 접근 실패 */ }

          if (!origDate || typeof scheduler.setCurrentView !== 'function') {
            const evs = scheduler.getEvents();
            return { events: evs, prefetched: false, complete: false, views: [], hiddenCount: 0, hiddenCancelCount: 0, waitModes: [], hiddenIds: new Set(), hiddenCancelIds: new Set(), timeoutPaths: [] };
          }

          // 사용자 탭에서 읽는 경우: 지금 보고 있는 주를 다시 받아오게 하려고 먼저 범위 밖으로 한 번 이동
          if (RESTORE_VIEW) {
            try {
              const t = Date.now();
              scheduler.setCurrentView(new Date(RANGE_END_MS + 7 * DAY), origMode);
              await settle(t);
            } catch (e) {}
          }

          const byId = new Map();
          const views = [];
          const waitModes = [];
          let hiddenCount = 0, hiddenCancelCount = 0, domSeen = false;
          // 페이지의 예약 객체는 건드리지 않고 id로만 기록 (사용자 탭에서 읽을 때 흔적이 남지 않도록)
          const hiddenIds = new Set(), hiddenCancelIds = new Set();
          // dhtmlx 화면에 그려지는 시간대 (이 밖의 예약은 원래 안 그려지므로 "숨김" 판정에서 제외)
          const FIRST_H = Number(scheduler.config && scheduler.config.first_hour) || 0;
          const LAST_H  = Number(scheduler.config && scheduler.config.last_hour) || 24;
          const coachOf = (ev) => String(ev.section_id || ev.coach_id || '');
          const drawableTime = (ev) => {
            const s = ev.start_date instanceof Date ? ev.start_date : new Date(ev.start_date);
            const e = ev.end_date instanceof Date ? ev.end_date : new Date(ev.end_date);
            if (isNaN(s) || isNaN(e) || e - s >= DAY) return false;
            const sh = s.getHours() + s.getMinutes() / 60;
            const eh = (e.getDate() !== s.getDate()) ? 24 : e.getHours() + e.getMinutes() / 60;
            return sh >= FIRST_H && eh <= LAST_H;
          };
          let cursor = RANGE_START_MS;
          let complete = false;
          for (let guard = 0; guard < 45; guard++) {
            if (cursor > RANGE_END_MS) { complete = true; break; }
            let vmin = null, vmax = null, got = [], wait = '';
            try {
              const navStart = Date.now();
              scheduler.setCurrentView(new Date(cursor), origMode);
              wait = await settle(navStart);
              waitModes.push(wait);
              const st = scheduler.getState() || {};
              vmin = st.min_date ? new Date(st.min_date).getTime() : null;
              vmax = st.max_date ? new Date(st.max_date).getTime() : null;
              if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmax <= vmin || vmin > cursor || vmax <= cursor) {
                const d = new Date(cursor); d.setHours(0, 0, 0, 0);
                vmin = d.getTime(); vmax = vmin + 7 * DAY;
              }
              try { got = scheduler.getEvents(new Date(vmin), new Date(vmax)) || []; }
              catch (e) { got = scheduler.getEvents() || []; }
            } catch (e) {
              views.push({ from: cursor, to: cursor, count: 0, error: String(e && e.message || e) });
              break;   // 화면 이동 실패 → 범위 불완전
            }
            const shown = renderedIds();
            const inView = [];
            for (const ev of got) {
              const t = evStartMs(ev);
              if (t === null || t < vmin || t >= vmax) continue;
              const id = String(ev.id || ev.seq_schedule || '');
              if (!id) continue;
              inView.push(ev);
              byId.set(id, ev);
            }
            // ⭐ v1.17.0: "데이터엔 있지만 화면에 안 그려진 예약" = 바디코디에서 지웠거나 취소한 예약일 가능성
            //   단, 아래 경우는 판정하지 않는다 (오판 방지)
            //   - 이 화면에 그려진 예약이 하나도 없을 때 (화면 그리기를 확인할 수 없음)
            //   - 그 강사의 예약이 이 화면에 하나도 안 그려졌을 때 (강사 필터로 숨겨진 것)
            //   - 그 강사 예약 중 1/3 넘게 숨겨졌을 때 (OT 숨기기 같은 보기 설정일 가능성)
            //   - 화면 표시 시간대 밖이거나 하루를 넘는 일정
            //   - 0.4초 뒤 다시 봤을 때 그려져 있으면 (그리기가 늦었던 것)
            let renderedInView = 0;
            const perCoach = {};
            for (const ev of inView) {
              const c = coachOf(ev);
              const pc = perCoach[c] || (perCoach[c] = { total: 0, shown: 0, hiddenDrawable: [] });
              pc.total++;
              if (shown.has(String(ev.id))) { pc.shown++; renderedInView++; }
              else if (drawableTime(ev)) pc.hiddenDrawable.push(ev);
            }
            const domWorks = renderedInView > 0;
            if (domWorks) {
              domSeen = true;
              for (const ev of inView) if (!shown.has(String(ev.id))) { hiddenIds.add(String(ev.id)); hiddenCount++; }
              const cands = [];
              for (const c of Object.keys(perCoach)) {
                const pc = perCoach[c];
                if (!pc.shown || !pc.hiddenDrawable.length) continue;
                if (pc.hiddenDrawable.length > 1 && pc.hiddenDrawable.length / pc.total > 1 / 3) continue;
                cands.push(...pc.hiddenDrawable);
              }
              if (cands.length) {
                await new Promise(r => setTimeout(r, 400));
                const shown2 = renderedIds();
                for (const ev of cands) {
                  if (shown2.has(String(ev.id))) continue;
                  hiddenCancelIds.add(String(ev.id)); hiddenCancelCount++;
                }
              }
            }
            views.push({ from: vmin, to: vmax, count: inView.length, rendered: renderedInView, reliable: domWorks, wait });
            cursor = vmax;
          }

          if (RESTORE_VIEW) {
            try {
              scheduler.setCurrentView(origDate, origMode);
              await new Promise(r => setTimeout(r, 800));
            } catch (e) {}
          }
          return {
            events: Array.from(byId.values()), prefetched: true, complete, views,
            hiddenCount: domSeen ? hiddenCount : null, hiddenCancelCount, waitModes, hiddenIds, hiddenCancelIds,
            timeoutPaths: [...timeoutPaths]
          };
        };

        const _prefetch = await fetchRangeEvents();
        // 로그용: 동기화 주(일요일 시작)별 건수
        const weekCounts = Array.from({ length: WEEKS }, () => 0);
        for (const ev of _prefetch.events) {
          const t = evStartMs(ev);
          if (t === null || t < RANGE_START_MS || t > RANGE_END_MS) continue;
          const w = Math.floor((t - RANGE_START_MS) / (7 * DAY));
          if (w >= 0 && w < WEEKS) weekCounts[w]++;
        }
        const events = _prefetch.events;
        const toIso = (d) => {
          if (!d || !(d instanceof Date)) return String(d || '');
          const p = n => String(n).padStart(2, '0');
          const tz = -d.getTimezoneOffset();
          const sign = tz >= 0 ? '+' : '-';
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}:${p(Math.abs(tz) % 60)}`;
        };

        // 총횟수/잔여횟수 추출 헬퍼
        const getCountField = (ev, candidates) => {
          for (const k of candidates) {
            const v = ev[k];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
            if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
          }
          return null;
        };
        const TOTAL_KEYS  = ['tot_count','total_count','tot_cnt','total_cnt','tot_use_cnt','total_use_count','totalCount','totCount','totCnt','totalCnt','useTotalCount','contractTotalCount','tot_service_cnt','service_total_count','reservation_total_count'];
        // ⭐ BodyCodi 실제 필드: remainNumber (잔여), useNumber (사용)
        const REMAIN_KEYS = ['remainNumber','remain_count','rest_count','remain_cnt','rest_cnt','remain_use_cnt','rest_use_cnt','remainCount','remainCnt','restCount','restCnt','remainUseCount','avail_count','available_count','availableCount','left_count','leftCount'];
        const USE_KEYS    = ['useNumber','use_count','used_count','useCount','usedCount','use_cnt','used_cnt'];

        // ⭐ v1.13.0: 이용권 유효기간(만료일/시작일) 후보 필드명
        //   start_date / end_date 는 "예약 시각"이므로 반드시 제외한다
        const EXPIRE_KEYS = [
          'useEndDate','use_end_date','expireDate','expire_date','expiryDate','expiry_date',
          'validEndDate','valid_end_date','endDay','end_day','limitDate','limit_date',
          'serviceEndDate','service_end_date','membershipEndDate','membership_end_date',
          'periodEndDate','period_end_date','useLimitDate','use_limit_date','deadline','endDt','end_dt'
        ];
        const VALID_START_KEYS = [
          'useStartDate','use_start_date','validStartDate','valid_start_date','startDay','start_day',
          'serviceStartDate','service_start_date','membershipStartDate','membership_start_date',
          'periodStartDate','period_start_date','startDt','start_dt'
        ];
        // 예약 시각 자체를 뜻하는 키 (start_date/end_date는 dhtmlx 표준, 나머지는 BodyCodi 원본일 가능성 대비)
        const EVENT_TIME_KEYS = new Set(['start_date','end_date','start','end','startTime','endTime','start_time','end_time']);

        // 날짜형 값 → "YYYY-MM-DD"
        //   허용: Date 객체, "2026-12-31", "2026.12.31", "20261231", "2026-12-31 23:59:59", epoch(ms/초) 숫자
        const toYmd = (v) => {
          if (v === null || v === undefined || v === '') return null;
          const p = n => String(n).padStart(2, '0');
          const fromDate = (d) => isNaN(d.getTime()) ? null : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
          if (v instanceof Date) return fromDate(v);
          if (typeof v === 'number') {
            if (v > 1e12 && v < 4e12) return fromDate(new Date(v));          // epoch ms
            if (v > 1e9  && v < 4e9)  return fromDate(new Date(v * 1000));   // epoch 초
            return null;
          }
          const s = String(v).trim();
          const m = s.match(/^(\d{4})[-.\/]?(\d{2})[-.\/]?(\d{2})(?:[T\s].*)?$/);
          if (!m) return null;
          const y = +m[1], mo = +m[2], d = +m[3];
          if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
          return `${m[1]}-${m[2]}-${m[3]}`;
        };

        // 객체 1단계 중첩까지 평탄화: { a:1, svc:{ endDate:'..' } } → [['a',1], ['svc.endDate','..']]
        //   배열이면 첫 원소(객체)만 본다 (예: services[0])
        const flatEntries = (ev) => {
          const out = [];
          for (const k of Object.keys(ev)) {
            const v = ev[k];
            out.push([k, v]);
            const inner = Array.isArray(v) ? v[0] : v;
            if (inner && typeof inner === 'object' && !(inner instanceof Date)) {
              for (const ik of Object.keys(inner)) out.push([`${k}.${ik}`, inner[ik]]);
            }
          }
          return out;
        };
        const lastSeg = (k) => k.split('.').pop();

        // 1) 알려진 후보 키 → 2) 키 이름에 end/expire/limit/valid 등이 들어가고 값이 날짜형인 필드(휴리스틱)
        //   excludeYmd: 예약 당일과 같은 날짜는 예약 시각 필드의 변형으로 보고 제외 (오인 방지)
        const getDateField = (ev, candidates, heuristicRe, excludeYmd) => {
          const entries = flatEntries(ev);
          const ok = (k, v) => {
            if (EVENT_TIME_KEYS.has(lastSeg(k))) return null;
            const ymdv = toYmd(v);
            if (!ymdv || excludeYmd.has(ymdv)) return null;
            return ymdv;
          };
          const candSet = new Set(candidates);
          for (const [k, v] of entries) {
            if (!candSet.has(lastSeg(k))) continue;
            const ymdv = ok(k, v);
            if (ymdv) return { value: ymdv, key: k };
          }
          if (heuristicRe) {
            for (const [k, v] of entries) {
              if (!heuristicRe.test(lastSeg(k))) continue;
              const ymdv = ok(k, v);
              if (ymdv) return { value: ymdv, key: k };
            }
          }
          return { value: null, key: null };
        };

        // 진단용
        let _firstEventKeys = null;
        let _firstEventNumericFields = null;
        let _firstEventDateLikeFields = null;
        let _countDiscovery = { withTotal: 0, withRemain: 0, withBoth: 0, total: 0 };
        let _expireDiscovery = { withExpire: 0, withStart: 0, total: 0, expireKey: null, startKey: null };
        let _assessDiscovery = { count: 0, withMember: 0, withRound: 0, sampleText: null, sampleFields: null };
        const _statusDist = {};      // ⭐ v1.16.0: 상태값 분포 (취소 표기 방식 파악용)
        const _hiddenSamples = [];   // ⭐ v1.16.0: 데이터엔 있으나 화면에 안 그려진 예약 예시

        const result = events.map((ev, idx) => {
          const raw = String(ev.text || '').trim();

          // 회원번호 + 성함
          let memberNo = '', memberName = '';
          const m = /^(\d{2}-\d{3})\s+([^\s\/]+)/.exec(raw);
          if (m) {
            memberNo = m[1];
            memberName = m[2];
          } else {
            // 회원번호 없이 성함만 있는 경우 (상담예약/OT 등)
            const nm = /^([가-힣]{2,4})(?:\s|\/|$)/.exec(raw);
            if (nm) memberName = nm[1];
          }

          // 연락처
          let phone = '';
          const pm = raw.match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
          if (pm) phone = pm[0];

          // ⭐ v1.9.0: 평가 프로그램 감지 (담당쌤 동작기능평가 / 대표원장 관절기능평가)
          const isAssessment = /동작기능평가|관절기능평가/.test(raw);

          // 회차: 텍스트의 "N회차" (예: "대표원장 관절기능평가 3회차")
          let round = null;
          const rdm = raw.match(/(\d+)\s*회차/);
          if (rdm) round = parseInt(rdm[1], 10);

          // 평가 이벤트는 텍스트 포맷이 기존과 달라 파싱 실패 가능 → 회원정보 추출 fallback
          if (isAssessment) {
            const NOT_A_NAME = (t) =>
              /^(담당쌤|대표원장|출석|결석|예약|취소|노쇼|미출석|대기)$/.test(t) ||
              /평가|회차|횟수/.test(t) || coachNames.has(t);

            // 텍스트가 "담당쌤 동작기능평가..."처럼 프로그램명으로 시작하면
            // 기존 이름 정규식이 "담당쌤/대표원장"을 이름으로 오인함 → 무효화
            if (memberName && NOT_A_NAME(memberName)) memberName = '';

            if (!memberNo) {
              // 전화번호(010-0000-0000) 내부의 숫자열을 회원번호로 오인하지 않도록 경계 조건 부여
              const anyNo = raw.match(/(?<![\d-])(\d{2}-\d{3})(?!\d)/);
              if (anyNo) memberNo = anyNo[1];
            }
            if (!memberNo) {
              memberNo = String(ev.mem_no || ev.member_no || ev.memNo || ev.memberNo2 || ev.cust_no || ev.customer_no || '').trim();
            }
            if (!memberName) {
              memberName = String(ev.member_name || ev.memberName || ev.user_name || ev.userName || ev.cust_name || ev.customerName || '').trim();
            }
            if (!memberName) {
              // ⭐ v1.9.1: 실사용 이름이 "원장개인업무용"처럼 4자를 넘는 라벨일 수 있어 길이 상한을 넉넉히 둠
              for (const t of raw.split(/[\s\/\-,()]+/).filter(Boolean)) {
                if (/^[가-힣]{2,12}$/.test(t) && !NOT_A_NAME(t)) {
                  memberName = t;
                  break;
                }
              }
            }
            if (!phone) {
              const pf = ev.phone || ev.hp || ev.mobile || ev.tel || ev.cust_phone || ev.customerPhone || ev.mem_phone || ev.memberPhone || '';
              const pfm = String(pf).match(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/);
              if (pfm) phone = pfm[0];
            }
          }

          // 프로그램명: " / "로 나눈 마지막 의미 있는 파트
          let program = '';
          const parts = raw.split('/').map(s => s.trim()).filter(Boolean);
          for (let i = parts.length - 1; i >= 1; i--) {
            const p = parts[i];
            if (/^01[016789]/.test(p)) continue;
            if (/^(출석|결석|예약|취소|노쇼|미출석|대기)$/.test(p)) continue;
            program = p;
            break;
          }
          // fallback: ev 자체에 serviceName이 있다면 사용
          if (!program) {
            program = String(ev.serviceName || ev.service_name || '').trim();
          }
          // ⭐ v1.9.1: 평가 프로그램은 뒤에 "10회 12회기말" 같은 숫자/집계 문구가 붙어
          // program이 지저분해질 수 있어, 알려진 두 프로그램명으로 항상 덮어씀(우선순위 최상위)
          if (isAssessment) {
            const am = raw.match(/(담당쌤\s*동작기능평가|대표원장\s*관절기능평가)/);
            if (am) program = am[0].trim();
            else if (!program) {
              const am2 = raw.match(/[가-힣]*기능평가/);
              if (am2) program = am2[0].trim();
            }
          }

          const coachId = String(ev.section_id || ev.coach_id || '');

          // ⭐ v1.16.0: 예약 상태 — 취소 여부 판정
          //   ① 상태 관련 필드(state/status/cancel/del 이 이름에 들어간 단순 값)에 "취소/cancel" 이 있거나
          //      취소 플래그(cancel_yn=Y, is_cancel=true 등)가 켜져 있으면 취소
          //   ② 화면 글자에 "취소" 가 단독 항목으로 들어 있으면 취소 (예: ".../ 취소", "[취소]")
          //   노쇼·결석은 수업 횟수가 차감되는 "진행된 예약" 이므로 취소로 보지 않는다.
          const statusPairs = [];
          let cancelled = false;
          for (const k of Object.keys(ev)) {
            if (!/(state|status|cancel|del_?yn|is_?del)/i.test(k)) continue;
            const v = ev[k];
            if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') continue;
            const sv = String(v).trim();
            if (sv.length > 20) continue;
            statusPairs.push(`${k}=${sv}`);
            // 상태 필드의 값이 "취소/CANCEL..." 이면 취소 (cancel_reason 같은 설명 필드는 제외)
            if (/(state|status)/i.test(k) && /취소|cancel/i.test(sv)) cancelled = true;
            // 취소·삭제 여부 플래그 (cancel_yn, is_cancel, cancelled, del_yn, is_deleted ...)
            //   cancelable / cancel_reason 같은 이름은 해당 없음
            if (/^(is_?)?(cancel|cancell?ed|del|deleted)(_?(yn|flag))?$/i.test(k) && /^(y|true|1)$/i.test(sv)) cancelled = true;
          }
          if (parts.some(p => /^\[?\(?취소(됨)?\]?\)?$/.test(p)) || /\[취소\]|\(취소\)|예약\s*취소|취소된\s*예약/.test(raw)) {
            cancelled = true;
          }
          let cancelReason = cancelled ? 'status' : '';
          // ⭐ v1.17.0: 상태값으로는 모르지만 화면에서 사라진 예약 (위의 안전 조건을 통과한 것만)
          if (!cancelled && _prefetch.hiddenCancelIds.has(String(ev.id))) { cancelled = true; cancelReason = 'hidden'; }
          statusPairs.forEach(sp => { _statusDist[sp] = (_statusDist[sp] || 0) + 1; });
          if (_prefetch.hiddenIds.has(String(ev.id))) {
            _hiddenSamples.length < 3 && _hiddenSamples.push({ text: raw.slice(0, 24), status: statusPairs.join(',') });
          }

          // 잔여횟수: BodyCodi의 remainNumber 필드
          const remainCount = getCountField(ev, REMAIN_KEYS);
          // 사용횟수: BodyCodi의 useNumber 필드 (총횟수 계산용)
          const useCount    = getCountField(ev, USE_KEYS);

          // 총횟수 우선순위:
          //   1) 직접 필드 (TOTAL_KEYS 중 하나)
          //   2) remainNumber + useNumber 계산
          //   3) 프로그램 텍스트의 "N회" regex 폴백
          let totalCount = getCountField(ev, TOTAL_KEYS);
          if (totalCount === null && remainCount !== null && useCount !== null) {
            totalCount = remainCount + useCount;
          }
          if (totalCount === null) {
            const tm = (program || raw).match(/(\d+)\s*회(?!원|차)/);  // "회원", "회차"는 제외
            if (tm) totalCount = parseInt(tm[1], 10);
          }

          // ⭐ v1.9.0: 회차 계산 fallback — 사용횟수 + 1 (이번 회차)
          if (isAssessment && round === null && useCount !== null) {
            round = useCount + 1;
          }

          // ⭐ v1.13.0: 이용권 유효기간 (만료일 필수, 시작일은 있으면 "시작 ~ 만료"로 표기)
          //   예약 당일 날짜는 후보에서 제외 (예약 시각 필드가 다른 이름으로 중복 실려 오는 경우 오인 방지)
          const eventDays = new Set([toYmd(ev.start_date), toYmd(ev.end_date)].filter(Boolean));
          const expire = getDateField(ev, EXPIRE_KEYS, /(end|expir|limit|valid|deadline|만료|종료)/i, eventDays);
          const vstart = expire.value
            ? getDateField(ev, VALID_START_KEYS, /(start|begin|시작)/i, eventDays)
            : { value: null, key: null };
          let validPeriod = null;
          if (expire.value) {
            validPeriod = vstart.value ? `${vstart.value} ~ ${expire.value}` : expire.value;
          }

          // 진단: 첫 이벤트의 모든 키 + 숫자 필드 + 날짜형 필드(중첩 1단계 포함) dump
          if (idx === 0) {
            _firstEventKeys = Object.keys(ev).sort();
            _firstEventNumericFields = {};
            _firstEventDateLikeFields = {};
            for (const k of _firstEventKeys) {
              const v = ev[k];
              if (typeof v === 'number' && Number.isFinite(v)) _firstEventNumericFields[k] = v;
              else if (typeof v === 'string' && /^-?\d+$/.test(v.trim()) && v.length < 12) _firstEventNumericFields[k] = '"'+v+'"';
            }
            for (const [k, v] of flatEntries(ev)) {
              if (EVENT_TIME_KEYS.has(lastSeg(k))) continue;
              const ymdv = toYmd(v);
              if (ymdv) _firstEventDateLikeFields[k] = ymdv;
            }
          }
          _countDiscovery.total++;
          if (totalCount  !== null) _countDiscovery.withTotal++;
          if (remainCount !== null) _countDiscovery.withRemain++;
          if (totalCount !== null && remainCount !== null) _countDiscovery.withBoth++;
          _expireDiscovery.total++;
          if (expire.value) { _expireDiscovery.withExpire++; _expireDiscovery.expireKey ||= expire.key; }
          if (vstart.value) { _expireDiscovery.withStart++;  _expireDiscovery.startKey  ||= vstart.key; }

          // ⭐ v1.9.0: 평가 이벤트 진단 (포맷이 다를 경우 원인 파악용)
          if (isAssessment) {
            _assessDiscovery.count++;
            if (memberName || memberNo) _assessDiscovery.withMember++;
            if (round !== null) _assessDiscovery.withRound++;
            if (_assessDiscovery.sampleText === null) _assessDiscovery.sampleText = raw;
            // ⭐ v1.9.1: 첫 평가 이벤트는 항상 원본 ev의 전체 필드를 덤프
            //   → 실제 회원명/번호/연락처가 어느 필드에 들어있는지 로그로 검증 가능 (추출 성공 여부 무관)
            if (_assessDiscovery.sampleFields === null) {
              const dump = {};
              for (const k of Object.keys(ev)) {
                const v = ev[k];
                if (v === null || v === undefined) continue;
                if (typeof v === 'object') continue; // Date 등 복합객체는 스킵
                const s = String(v);
                dump[k] = s.length > 40 ? s.slice(0, 40) + '…' : s;
              }
              _assessDiscovery.sampleFields = dump;
            }
          }

          return {
            id:          String(ev.id || ev.seq_schedule || ''),
            text:        raw,
            start:       toIso(ev.start_date),
            end:         toIso(ev.end_date),
            coachId,
            coachName:   coachNameMap[coachId] || coachId,
            memberNo,
            memberName,
            phone,
            program,
            status:      String(ev.now_state || ev.status || ''),
            totalCount,
            remainCount,
            validPeriod,
            isAssessment,
            round,
            cancelled,
            cancelReason,
            hidden:      _prefetch.hiddenIds.has(String(ev.id))
          };
        });

        return {
          ok: true,
          payload: {
            count: result.length,
            events: result,
            _diagnostics: {
              firstEventKeys: _firstEventKeys,
              firstEventNumericFields: _firstEventNumericFields,
              firstEventDateLikeFields: _firstEventDateLikeFields,
              countDiscovery: _countDiscovery,
              expireDiscovery: _expireDiscovery,
              assessDiscovery: _assessDiscovery,
              prefetch: {
                attempted: _prefetch.prefetched,
                complete: _prefetch.complete,
                weeks: WEEKS,
                weekCounts,
                views: _prefetch.views,
                waitModes: _prefetch.waitModes,
                timeoutPaths: _prefetch.timeoutPaths || []
              },
              statusDist: _statusDist,
              hiddenCount: _prefetch.hiddenCount,
              hiddenCancelCount: _prefetch.hiddenCancelCount || 0,
              hiddenSamples: _hiddenSamples
            }
          }
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  });

  const result = results?.[0]?.result;
  if (!result || !result.ok) {
    throw new Error(result?.error || 'extract failed');
  }
  return result.payload;
}

// ⭐ v1.13.1: bc-netlog.js 가 모아둔 "이용권 정보로 보이는 서버 응답" 목록 읽기
//   (예약 데이터에 유효기간이 없을 때, 어느 요청이 유효기간을 주는지 로그로 파악하기 위함)
async function readNetLogFromBodyCodi() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://crm.bodycodi.com/*' });
    if (!tabs.length) return [];
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: 'MAIN',
      func: () => {
        const log = window.__bcNetLog;
        if (!Array.isArray(log)) return null;   // 탐지기 미설치 (페이지가 확장 설치 전에 열림)
        // URL 기준 중복 제거 후 최신 8건만
        const seen = new Set(); const out = [];
        for (const e of log) {
          const key = `${e.method} ${e.url}`;
          if (seen.has(key)) continue;
          seen.add(key); out.push(e);
          if (out.length >= 8) break;
        }
        return out;
      }
    });
    return results?.[0]?.result;
  } catch (e) {
    return [];
  }
}

// 고객 예약이 아닌 항목 필터 (기타스케줄 등)
function isCustomerBooking(ev) {
  const t = ev.text || '';
  if (!t) return false;
  // ⭐ v1.9.1: 평가 프로그램(동작기능평가/관절기능평가)은 항상 고객 예약으로 취급 (최우선 체크)
  //   "원장개인업무용" 같은 이름 안에 "개인업무"가 우연히 포함될 수 있어,
  //   아래 제외 키워드 체크보다 반드시 먼저 판정해야 함
  if (ev.isAssessment) return true;
  if (/기타스케줄|개인업무|휴무|점심|회의/.test(t)) return false;
  // 이름과 회원번호가 둘 다 없으면 스킵
  if (!ev.memberName && !ev.memberNo) return false;
  return true;
}

// 새 제목: "회원번호 성함 연락처 프로그램이름" (회원번호 없으면 생략)
function buildTitle(ev) {
  const parts = [];
  if (ev.memberNo) parts.push(ev.memberNo);
  if (ev.memberName) parts.push(ev.memberName);
  if (ev.phone) parts.push(ev.phone);
  if (ev.program) parts.push(ev.program);
  return parts.join(' ');
}

// 기존 description에서 우리가 관리하는 라인만 골라서 제거 → 사용자 콘텐츠만 남김
// 관리 라인:
//   - "[bc-sync:ID]" (구버전 호환 — extendedProperties 이전 시대)
//   - "프로그램명 : ..."     (⭐ v1.13.0, 이 접두어로 시작하는 라인)
//   - "유효기간 : 날짜[ ~ 날짜]" (⭐ v1.13.0, 단독 라인일 때만)
//   - "총횟수 : N회"        (단독 라인일 때만)
//   - "잔여횟수 : N회"      (단독 라인일 때만)
// "총횟수 : 20회 (중요)" 같이 뒤에 다른 글자가 붙으면 보존됩니다.
function stripManagedLines(description) {
  if (!description) return '';
  let s = String(description);

  // 1) 구버전 [bc-sync:ID] 태그 제거
  s = s.replace(/\[bc-sync:[^\]]*\]/g, '');

  // 2) 관리 라인(프로그램명/유효기간/총횟수/잔여횟수) 제거 — 라인 단위로 정확히 일치하는 것만
  s = s.split('\n').filter(line => {
    const t = line.trim();
    if (/^프로그램명\s*:/.test(t)) return false;
    if (/^유효기간\s*:\s*[\d\-.\/]+(\s*~\s*[\d\-.\/]+)?\s*$/.test(t)) return false;
    if (/^총횟수\s*:\s*\d+\s*회\s*$/.test(t)) return false;
    if (/^잔여횟수\s*:\s*\d+\s*회\s*$/.test(t)) return false;
    return true;
  }).join('\n');

  // 3) 3줄 이상 연속 공백을 2줄로 압축 (라인 제거로 생긴 빈 공간 정리)
  s = s.replace(/\n{3,}/g, '\n\n');

  return s.trim();
}

// ⭐ v1.13.0: 자동 라인 목록 (값이 있는 항목만, 고정 순서)
//   프로그램명 → 유효기간 → 총횟수 → 잔여횟수
function buildAutoLines(ev) {
  const auto = [];
  if (ev.program) auto.push(`프로그램명 : ${ev.program}`);
  if (ev.validPeriod) auto.push(`유효기간 : ${ev.validPeriod}`);
  if (ev.totalCount  !== null && ev.totalCount  !== undefined) auto.push(`총횟수 : ${ev.totalCount}회`);
  if (ev.remainCount !== null && ev.remainCount !== undefined) auto.push(`잔여횟수 : ${ev.remainCount}회`);
  return auto;
}

// 새 description = 사용자 콘텐츠 + (선택적) 빈 줄 + 자동 라인
// ev: { program, validPeriod, totalCount, remainCount, ... }
// existingDescription: GCal에 이미 들어 있던 description
function buildDescription(ev, existingDescription) {
  const userContent = stripManagedLines(existingDescription);
  const auto = buildAutoLines(ev);

  if (auto.length === 0) return userContent;            // 자동 정보 없으면 사용자 콘텐츠만
  if (!userContent)      return auto.join('\n');        // 사용자 콘텐츠 없으면 자동 정보만
  return `${userContent}\n\n${auto.join('\n')}`;         // 둘 다 있으면 사용자 + 빈줄 + 자동
}

// ---------- 메인 동기화 ----------
async function runSync({ trigger = 'manual', dryRun = false } = {}) {
  const version = chrome.runtime.getManifest().version;
  // ⭐ v1.16.0: 동시 실행 방지 — 자동 동기화와 수동 실행이 겹치면 같은 예약이 두 번 생성될 수 있다
  if (isSyncing) {
    throw new Error('이미 동기화가 진행 중입니다. 끝난 뒤 다시 눌러 주세요.');
  }
  isSyncing = true;   // 동기화 도중 자동 리로드가 끼어들지 않도록 잠금
  try {
  await appendLog(`▶ sync start v${version} (trigger=${trigger}, dryRun=${dryRun})`);
  reportProgress(0, `v${version} 동기화 시작`);

  const { coachCalendarMap = {} } = await chrome.storage.local.get('coachCalendarMap');
  if (!Object.keys(coachCalendarMap).length) {
    throw new Error('강사-캘린더 매핑이 없습니다. 먼저 "강사 목록 불러오기" → 매핑 저장을 해주세요.');
  }
  reportProgress(5, '매핑 확인');

  // 비대화형 우선 시도, 실패하면 대화형
  let token;
  try {
    token = await getAuthToken(false);
  } catch {
    token = await getAuthToken(true);
  }
  reportProgress(10, 'Google 인증 완료');

  // ⭐ v1.16.0: 최신 데이터 확보 — 동기화 전용 새 탭에서 읽는다 (실패 시 수동 실행만 열린 탭으로 대체)
  const { rangeStart, rangeEnd } = getSyncRange(new Date());
  reportProgress(12, 'BodyCodi 최신 화면 여는 중');
  const userTab = await findBodyCodiTab();
  let freshTabId = null, readTabId = null;
  try {
    freshTabId = await openFreshBodyCodiTab(userTab);
    readTabId = freshTabId;
  } catch (e) {
    await appendLog(`⚠️ 동기화용 새 탭을 열지 못함: ${e.message}`);
    const isAuto = String(trigger).startsWith('alarm');
    if (!userTab) {
      throw new Error('바디코디 스케줄 화면을 열 수 없습니다. 크롬에서 바디코디에 로그인한 뒤 다시 시도해 주세요.');
    }
    if (isAuto) {
      // 오래된 탭 데이터로 자동 동기화하면 다른 PC가 맞춰 둔 일정을 되돌릴 수 있어 건너뜀
      throw new Error('자동 동기화 보류 — 최신 데이터를 읽을 수 없어 이번 회차는 건너뜁니다');
    }
    readTabId = userTab.id;
  }
  const freshOk = !!freshTabId;

  reportProgress(15, 'BodyCodi 일정 읽는 중');
  let extracted;
  try {
    extracted = await extractSchedulesFromBodyCodi(readTabId, { rangeStart, rangeEnd, restoreView: !freshOk });
  } finally {
    if (freshTabId) { try { await chrome.tabs.remove(freshTabId); } catch (_) {} }
  }
  const { events, _diagnostics } = extracted;
  await appendLog(`📥 BodyCodi 전체 이벤트: ${events.length} (출처: ${freshOk ? '새로 연 화면 — 최신' : '열려 있던 탭 — 최신이 아닐 수 있음'})`);

  // 진단 로그
  const pf = _diagnostics?.prefetch || {};
  if (_diagnostics) {
    if (pf.attempted) {
      const perWeek = (pf.weekCounts || []).map((n, i) => `${i + 1}주차=${n}건`).join(', ');
      const waits = (pf.waitModes || []);
      const waitTxt = waits.includes('net') ? '요청완료 확인' : (waits.includes('fixed') ? '고정대기' : '-');
      const toTxt = waits.filter(w => w === 'timeout').length;
      await appendLog(`🔁 ${SYNC_WEEKS}주 프리페치: ${perWeek} (병합 후 ${events.length}건, 화면 ${(pf.views || []).length}개, 로딩=${waitTxt}${toTxt ? `, 시간초과 ${toTxt}회` : ''}${pf.complete ? '' : ', ⚠️범위 일부 못 읽음'})`);
      if (toTxt && (pf.timeoutPaths || []).length) {
        await appendLog(`⏳ 시간초과 때 끝나지 않은 바디코디 요청: ${pf.timeoutPaths.join(', ')}`);
      }
    } else {
      await appendLog(`⚠️ ${SYNC_WEEKS}주 프리페치 미시도 — scheduler.setCurrentView 사용 불가. 현재 보이는 주만 동기화됩니다.`);
    }
    const sd = Object.entries(_diagnostics.statusDist || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sd.length) await appendLog(`📊 예약 상태값: ${sd.map(([k, n]) => `${k}×${n}`).join(', ')}`);
    if (_diagnostics.hiddenCount) {
      await appendLog(`👁 데이터에는 있으나 화면에 안 그려진 예약 ${_diagnostics.hiddenCount}건 — 예: ${JSON.stringify(_diagnostics.hiddenSamples || [])}`);
    }
    const d = _diagnostics.countDiscovery || {};
    await appendLog(`🔬 횟수 추출: 총횟수발견=${d.withTotal||0}/${d.total||0}, 잔여횟수발견=${d.withRemain||0}/${d.total||0}`);
    // ⭐ v1.13.0: 유효기간 추출 결과 — 어떤 필드에서 읽었는지 함께 기록 (오인 시 관리자가 확인 가능)
    const x = _diagnostics.expireDiscovery || {};
    if ((x.withExpire || 0) > 0) {
      await appendLog(`📆 유효기간 추출: 만료일=${x.withExpire}/${x.total} (필드=${x.expireKey})` +
        ((x.withStart || 0) > 0 ? `, 시작일=${x.withStart}/${x.total} (필드=${x.startKey})` : ''));
    } else {
      await appendLog(`📆 유효기간 추출: 0/${x.total || 0} — 날짜형 필드 후보: ${JSON.stringify(_diagnostics.firstEventDateLikeFields || {})}`);
      const net = await readNetLogFromBodyCodi();
      if (net === null) {
        await appendLog(`📡 이용권 응답 탐지기 미작동 — 바디코디 탭을 새로고침한 뒤 회원 상세(이용권) 화면을 한 번 열고 다시 동기화해 주세요`);
      } else if (!net.length) {
        await appendLog(`📡 이용권 정보로 보이는 서버 응답 없음 — 바디코디에서 회원 상세(이용권) 화면을 한 번 연 뒤 다시 동기화하면 기록됩니다`);
      } else {
        for (const e of net) {
          const hits = Object.fromEntries(e.hits.slice(0, 12));
          await appendLog(`📡 ${e.method} ${e.url} → ${JSON.stringify(hits)}`);
        }
      }
    }
    const a = _diagnostics.assessDiscovery || {};
    if (a.count > 0) {
      await appendLog(`🩺 평가 프로그램: ${a.count}건 (회원정보 추출 ${a.withMember}건, 회차 파악 ${a.withRound}건) 예시="${a.sampleText}"`);
      if (a.sampleFields) {
        await appendLog(`🩺 회원정보 미발견 이벤트 전체필드: ${JSON.stringify(a.sampleFields)}`);
      }
    }
    if (((_diagnostics.countDiscovery || {}).withRemain || 0) === 0 && _diagnostics.firstEventNumericFields) {
      await appendLog(`🔬 첫 이벤트 숫자필드(잔여횟수 찾기용): ${JSON.stringify(_diagnostics.firstEventNumericFields)}`);
    }
  }

  await appendLog(`📅 동기화 범위 (${SYNC_WEEKS}주): ${ymd(rangeStart)} ~ ${ymd(rangeEnd)}`);

  // 바디코디에 존재하는 모든 예약번호 (범위·종류 무관) — "사라진 예약" 판정용
  const allBcIds = new Set(events.map(e => e.id).filter(Boolean));

  // 동기화 범위 + 고객 예약만, 진행(active) / 취소(cancelled) 분리
  const rangeEvents = events.filter(ev => {
    if (!ev.start) return false;
    const t = new Date(ev.start).getTime();
    if (t < rangeStart.getTime() || t > rangeEnd.getTime()) return false;
    return isCustomerBooking(ev);
  });
  const activeEvents    = rangeEvents.filter(ev => !ev.cancelled);
  const cancelledEvents = rangeEvents.filter(ev => ev.cancelled);
  const activeIds = new Set(activeEvents.map(e => e.id).filter(Boolean));
  await appendLog(`📅 ${SYNC_WEEKS}주 고객 예약: ${activeEvents.length}건` + (cancelledEvents.length ? ` (+ 취소 ${cancelledEvents.length}건)` : ''));

  const summary = {
    matched: 0,
    updated: 0,
    timeMoved: 0,     // ⭐ v1.12.0: 시간이 이동된 일정 수
    created: 0,       // ⭐ v1.14.0: 새로 만든 캘린더 일정 수
    cancelled: 0,     // ⭐ v1.16.0: [취소] 표시한 일정 수
    restored: 0,      // ⭐ v1.16.0: [취소] 표시를 되돌린 일정 수
    calMoved: 0,      // ⭐ v1.16.0: 담당 강사 변경으로 다른 캘린더로 옮긴 일정 수
    dedup: 0,         // ⭐ v1.18.0: 지운 중복 일정 수 (cancelled = 취소·삭제 반영으로 지운 일정 수)
    skipped: 0,
    failed: 0,
    details: [],
    orphans: []       // ⭐ v1.14.0: 바디코디에 없는 캘린더 고객 일정 (보고용)
  };

  // ⭐ v1.14.0: 설정 — 짝 없는 예약을 캘린더에 새로 만들지 (기본 켬)
  const { createMissing = true } = await chrome.storage.local.get('createMissing');
  const coverageOk = !!(pf.attempted && pf.complete);

  // ---------- 1단계: 캘린더별로 묶고, 모든 캘린더를 먼저 조회 ----------
  //   (강사 변경으로 예약이 다른 캘린더로 옮겨진 경우를 찾으려면 전체를 한 번에 봐야 한다.
  //    두 강사가 같은 캘린더를 쓰는 경우에도 한 묶음으로 처리되어 서로의 일정을 오판하지 않는다)
  const byCal = new Map();   // calId → { active: [], cancelled: [], label }
  for (const ev of rangeEvents) {
    if (!ev.coachId) continue;
    const calId = coachCalendarMap[ev.coachId];
    if (!calId) {
      if (!ev.cancelled) summary.skipped++;
      continue;
    }
    if (!byCal.has(calId)) byCal.set(calId, { active: [], cancelled: [], label: ev.coachName || `coach=${ev.coachId}` });
    byCal.get(calId)[ev.cancelled ? 'cancelled' : 'active'].push(ev);
  }
  const unmappedCoaches = [...new Set(activeEvents.filter(ev => ev.coachId && !coachCalendarMap[ev.coachId]).map(ev => ev.coachId))];
  for (const cid of unmappedCoaches) {
    await appendLog(`⏭️ 매핑 없음: coachId=${cid} (${activeEvents.filter(e => e.coachId === cid).length}건)`);
  }
  // 예약이 하나도 없는 매핑 캘린더도 조회해야 취소·사라짐을 반영할 수 있다
  for (const calId of new Set(Object.values(coachCalendarMap))) {
    if (!byCal.has(calId)) byCal.set(calId, { active: [], cancelled: [], label: calId });
  }

  reportProgress(22, '구글 캘린더 조회 중');
  const gcalByCal = new Map();
  for (const [calId, grp] of byCal) {
    try {
      const list = await listEventsInRange(token, calId, rangeStart, rangeEnd);
      gcalByCal.set(calId, list);
      await appendLog(`📖 ${grp.label} → ${calId}: GCal ${list.length}건`);
    } catch (err) {
      await appendLog(`❌ 캘린더 조회 실패 (${calId}): ${err.message}`);
      summary.failed += grp.active.length;
      byCal.delete(calId);
    }
  }

  // ---------- 2단계: 매칭 계획 (모든 캘린더) ----------
  const claimed = new Set();                  // `${calId}|${eventId}`
  const ck = (calId, g) => `${calId}|${g.id}`;
  const matchOf = new Map();                  // bc 객체 → { g, calId(원래 있던 캘린더) }
  const markerIndex = new Map();              // bcSyncId → [{ calId, g }]
  for (const [calId, list] of gcalByCal) {
    for (const g of list) {
      const sid = g.extendedProperties?.private?.bcSyncId;
      if (sid) (markerIndex.get(sid) || markerIndex.set(sid, []).get(sid)).push({ calId, g });
    }
  }
  const take = (bc, calId, g) => { matchOf.set(bc, { g, calId }); claimed.add(ck(calId, g)); };

  // ⭐ v1.18.0: 바디코디 데이터에 같은 캘린더·같은 시각(±3분)·같은 회원 예약이 2건 이상이면 1건만 반영
  //   (취소 후 다시 잡은 예약의 옛 기록이 상태값 없이 남아 있는 경우 등 — 일정이 2개 생기는 원인)
  //   캘린더에 이미 예약번호가 연결된 쪽을 남긴다.
  for (const [calId, grp] of byCal) {
    const kept = [];
    for (const bc of grp.active) {
      const t = tsOf(bc.start), key = memberKeyOfBc(bc);
      const twin = (t !== null && key) ? kept.find(k => memberKeyOfBc(k) === key && Math.abs((tsOf(k.start) ?? 0) - t) <= 3 * 60 * 1000) : null;
      if (!twin) { kept.push(bc); continue; }
      const hasMarker = (x) => (markerIndex.get(x.id) || []).some(h => h.calId === calId);
      const keep = (!hasMarker(twin) && hasMarker(bc)) ? bc : twin;
      const drop = keep === bc ? twin : bc;
      if (keep === bc) kept[kept.indexOf(twin)] = bc;
      activeIds.delete(drop.id);
      await appendLog(`⚠️ 바디코디에 같은 회원·같은 시각 예약이 2건 (${(drop.memberNo || '')} ${drop.memberName || ''} ${hhmm(drop.start)}, 예약번호 ${keep.id}·${drop.id}) — 1건만 캘린더에 반영`);
    }
    grp.active = kept;
  }

  // 1차) 같은 캘린더의 예약번호 마커 / 레거시 태그
  for (const [calId, grp] of byCal) {
    const list = gcalByCal.get(calId) || [];
    for (const bc of grp.active) {
      if (!bc.id) continue;
      const syncTag = `[bc-sync:${bc.id}]`;
      const m =
        list.find(g => !claimed.has(ck(calId, g)) && g.extendedProperties?.private?.bcSyncId === bc.id) ||
        list.find(g => !claimed.has(ck(calId, g)) && (g.description || '').includes(syncTag));
      if (m) take(bc, calId, m);
    }
  }
  // 1-2차) ⭐ v1.16.0: 다른 캘린더에 같은 예약번호 마커가 있으면 → 담당 강사가 바뀐 것 → 그 일정을 옮긴다
  for (const [calId, grp] of byCal) {
    for (const bc of grp.active) {
      if (matchOf.has(bc) || !bc.id) continue;
      const hit = (markerIndex.get(bc.id) || []).find(h => h.calId !== calId && !claimed.has(ck(h.calId, h.g)));
      if (hit) take(bc, hit.calId, hit.g);
    }
  }
  // 2차) 시간 ±3분 (같은 캘린더, 다른 회원번호가 박힌 일정은 제외)
  for (const [calId, grp] of byCal) {
    const list = gcalByCal.get(calId) || [];
    for (const bc of grp.active) {
      if (matchOf.has(bc)) continue;
      const bcStart = tsOf(bc.start);
      if (bcStart === null) continue;
      const m = list.find(g => {
        if (claimed.has(ck(calId, g))) return false;
        const gs = tsOf(g.start?.dateTime || g.start?.date);
        if (gs === null || Math.abs(gs - bcStart) > 3 * 60 * 1000) return false;
        // ⭐ v1.18.0: 같은 예약으로 보이는 일정만 (회원번호·성함·프로그램명) — "가족일정" 같은 개인 일정은 제외
        const gNo = memberNoInTitle(g.summary);
        if (gNo && bc.memberNo && gNo !== bc.memberNo) return false;
        return sameBookingTitle(g, bc);
      });
      if (m) take(bc, calId, m);
    }
  }
  // 3차) 회원번호(또는 이름+연락처)로 같은 캘린더의 짝 잃은 일정 재사용 → 시간 이동 (시간순 1:1)
  for (const [calId, grp] of byCal) {
    const list = gcalByCal.get(calId) || [];
    const unmatchedByKey = {};
    for (const bc of grp.active) {
      if (matchOf.has(bc)) continue;
      const key = memberKeyOfBc(bc);
      if (key) (unmatchedByKey[key] ||= []).push(bc);
    }
    for (const [key, bcs] of Object.entries(unmatchedByKey)) {
      const cands = list
        .filter(g => !claimed.has(ck(calId, g)) && g.start?.dateTime && memberKeyOfGcal(g) === key &&
          // 아직 바디코디에 살아 있는 다른 예약의 일정은 빼앗지 않는다
          !activeIds.has(g.extendedProperties?.private?.bcSyncId))
        .sort((a, b) => (tsOf(a.start?.dateTime) || 0) - (tsOf(b.start?.dateTime) || 0));
      if (!cands.length) continue;
      bcs.sort((a, b) => (tsOf(a.start) || 0) - (tsOf(b.start) || 0));
      for (let k = 0; k < bcs.length && k < cands.length; k++) {
        take(bcs[k], calId, cands[k]);
        await appendLog(`🔁 ${key.replace(/^(no|np):/, '').replace(/\|.*/, '')}: 캘린더의 짝 잃은 일정(${hhmm(cands[k].start?.dateTime)})을 바디코디 예약(${hhmm(bcs[k].start)})에 연결`);
      }
    }
  }

  // 4차) ⭐ v1.16.0: 취소 표시 대상
  //   (가) 바디코디에서 "취소" 상태인 예약의 일정 — 예약번호 마커, 없으면 같은 시각·같은 회원번호
  //   (나) 예약번호 마커가 있는데 바디코디 어디에도 그 예약이 없는 일정 (삭제됐거나 4주 밖으로 옮겨짐)
  //        → 최신 데이터로 범위 전체를 빠짐없이 읽었을 때만, 그리고 한꺼번에 너무 많으면 보류
  const cancelPlan = [];   // { calId, g, reason, bc? }  — ⭐ v1.18.0: 실행 시 삭제
  const dupPlan = [];      // ⭐ v1.18.0: { calId, g, bc } — 같은 예약의 중복 일정 (1개만 남기고 삭제)
  const CANCEL_REASON = { status: '바디코디에서 취소됨', hidden: '바디코디 화면에서 사라짐(삭제·취소)' };
  const WIN = 3 * 60 * 1000;
  // 다른 (살아 있는) 예약의 예약번호가 박힌 일정은 건드리지 않는다
  const ownedByOtherActive = (g, bcId) => {
    const sid = g.extendedProperties?.private?.bcSyncId;
    return !!(sid && sid !== bcId && activeIds.has(sid));
  };
  const slotTwins = (list, calId, bc) => {
    const bcStart = tsOf(bc.start);
    if (bcStart === null) return [];
    return list.filter(g => {
      if (claimed.has(ck(calId, g)) || ownedByOtherActive(g, bc.id)) return false;
      const gs = tsOf(g.start?.dateTime);
      return gs !== null && Math.abs(gs - bcStart) <= WIN && sameBookingForDelete(g, bc);
    });
  };
  for (const [calId, grp] of byCal) {
    const list = gcalByCal.get(calId) || [];
    for (const bc of grp.cancelled) {
      // 예약번호 마커로 연결된 일정 + 같은 시각·같은 회원(또는 같은 프로그램)의 일정 전부
      const hits = list.filter(g => !claimed.has(ck(calId, g)) && bc.id && g.extendedProperties?.private?.bcSyncId === bc.id);
      for (const g of slotTwins(list, calId, bc)) if (!hits.includes(g)) hits.push(g);
      for (const m of hits) {
        claimed.add(ck(calId, m));
        cancelPlan.push({ calId, g: m, reason: CANCEL_REASON[bc.cancelReason] || CANCEL_REASON.status, bc });
      }
    }
  }

  // ⭐ v1.17.0: "바디코디에서 사라진 일정" 판정 — 캘린더마다 따로 본다
  //   대상: 예약번호 마커가 있는데 그 예약이 바디코디 데이터 어디에도 없음
  //   (마커 없는 일정 = 확장이 만든 적 없는 일정은 표시하지 않고 📍로 보고만 — 사유를 함께 적는다)
  //   보류: 최신 데이터가 아님 / 그 캘린더의 강사 예약이 이번 데이터에 하나도 없음(강사 필터 등) /
  //         그 캘린더 고객 일정의 절반 넘게 사라짐
  //   ⭐ v1.18.1: 화면 로딩 시간초과·못 읽은 주는 "그 주의 일정만" 보류 (예전: 한 번만 시간초과여도 4주 전체 보류
  //         → 바디코디에서 지운 예약 일정이 계속 남는 원인이 될 수 있었음)
  const pfViews = pf.views || [];
  const coveredUntil = pf.complete ? Infinity
    : pfViews.filter(v => !v.error && v.to > v.from).reduce((m, v) => Math.max(m, v.to), -Infinity);
  const viewHoldOf = (g) => {
    const t = tsOf(g.start?.dateTime);
    if (t === null) return '시각 없음';
    if (pfViews.some(v => v.wait === 'timeout' && t >= v.from && t < v.to)) return '그 주 화면 로딩 시간초과';
    if (t >= coveredUntil) return '그 주 화면을 읽지 못함';
    return '';
  };
  const viewHeld = {};   // 사유 → 건수
  const loadedCoaches = new Set(events.map(e => e.coachId).filter(Boolean).map(String));
  const coachesOfCal = {};
  for (const [cid, cal] of Object.entries(coachCalendarMap)) (coachesOfCal[cal] ||= []).push(String(cid));
  // 바디코디 예약(상태·강사 무관)의 시각 색인 — 📍 보고 사유 판정용
  //   같은 시각(±3분)에 회원키가 같거나, 회원번호·성함이 제목에 들어 있는 예약이 있으면 "있음"
  const bcByMinute = new Map();
  for (const ev of events) {
    const t = tsOf(ev.start);
    if (t === null) continue;
    const m = Math.round(t / 60000);
    (bcByMinute.get(m) || bcByMinute.set(m, []).get(m)).push(ev);
  }
  const bcExistsFor = (g) => {
    const t = tsOf(g.start?.dateTime), key = memberKeyOfGcal(g);
    if (t === null || !key) return true;   // 판단 불가 → 있는 것으로 (건드리지 않음)
    const title = String(g.summary || '');
    const m = Math.round(t / 60000);
    for (let d = -3; d <= 3; d++) {
      for (const ev of bcByMinute.get(m + d) || []) {
        if (memberKeyOfBc(ev) === key) return true;
        if (ev.memberNo && title.includes(ev.memberNo)) return true;
        if (ev.memberName && title.includes(ev.memberName)) return true;
      }
    }
    return false;
  };

  // 예약이 0건으로 읽힌 화면(주) — 연휴일 수도 있지만 로딩 실패일 수도 있어 그 구간은 사라짐 판정 보류
  const emptyViews = (pf.views || []).filter(v => !v.error && v.count === 0 && v.to > v.from);
  const inEmptyView = (g) => {
    const t = tsOf(g.start?.dateTime);
    return t !== null && emptyViews.some(v => t >= v.from && t < v.to);
  };
  let emptyHeld = 0;

  const goneByCal = new Map();   // calId → { plan: [], customerTotal }
  for (const [calId, list] of gcalByCal) {
    const plan = [];
    let customerTotal = 0;
    for (const g of list) {
      if (!g.start?.dateTime || !isCustomerGcalEvent(g)) continue;
      customerTotal++;
      if (claimed.has(ck(calId, g))) continue;
      const sid = g.extendedProperties?.private?.bcSyncId;
      if (!sid || allBcIds.has(sid)) continue;
      const p = { calId, g, reason: '바디코디에서 사라짐' };
      if (inEmptyView(g)) { emptyHeld++; claimed.add(ck(calId, g)); continue; }
      const vh = viewHoldOf(g);
      if (vh) { viewHeld[vh] = (viewHeld[vh] || 0) + 1; continue; }   // 📍에 보류 사유와 함께 보고
      plan.push(p);
    }
    goneByCal.set(calId, { plan, customerTotal });
  }

  let goneHeld = 0;
  const globalHold = !freshOk ? '최신 데이터가 아님'
    : !pf.attempted ? '범위를 빠짐없이 읽지 못함'
    : '';
  for (const [calId, { plan, customerTotal }] of goneByCal) {
    if (!plan.length) continue;
    // ⭐ v1.18.0: 예전 버전이 [취소] 표시만 해 둔 일정도 이번에 함께 삭제 (보류 조건은 동일)
    const fresh = plan.filter(p => !isCancelMarked(p.g));
    const label = byCal.get(calId)?.label || calId;
    const calCoaches = coachesOfCal[calId] || [];
    const coachLoaded = calCoaches.some(c => loadedCoaches.has(c));
    const limit = Math.max(5, Math.ceil(customerTotal * 0.5));
    let hold = globalHold;
    if (!hold && !coachLoaded) hold = '이 캘린더 강사의 예약이 바디코디 데이터에 하나도 없음 — 강사 필터가 걸려 있을 수 있음';
    if (!hold && fresh.length > limit) hold = `한꺼번에 ${fresh.length}건(기준 ${limit}건)이라 오판일 수 있음`;
    if (hold) {
      goneHeld += plan.length;
      await appendLog(`⏸️ ${label}: 바디코디에서 사라진 일정 ${plan.length}건 삭제 보류 — ${hold}`);
      continue;
    }
    for (const p of plan) { claimed.add(ck(p.calId, p.g)); cancelPlan.push(p); }
  }
  for (const [why, n] of Object.entries(viewHeld)) {
    goneHeld += n;
    await appendLog(`⏸️ 바디코디에서 사라진 일정 ${n}건 삭제 보류 — ${why} (나머지 주는 정상 반영, 다음 동기화 때 다시 확인)`);
  }
  if (emptyHeld) {
    goneHeld += emptyHeld;
    await appendLog(`⏸️ 예약이 0건으로 읽힌 주의 일정 ${emptyHeld}건은 삭제 보류 — 연휴가 아니라면 화면 로딩 실패일 수 있음`);
  }
  summary.goneHeld = goneHeld;
  if (_diagnostics?.hiddenCancelCount) {
    await appendLog(`👁 화면에서 사라진(삭제·취소로 보이는) 예약 ${_diagnostics.hiddenCancelCount}건 → 취소로 처리`);
  }
  const missingCoaches = Object.keys(coachCalendarMap).filter(c => !loadedCoaches.has(String(c)));
  if (missingCoaches.length && loadedCoaches.size) {
    await appendLog(`ℹ️ 이번 데이터에 예약이 없는 매핑 강사: ${missingCoaches.join(', ')} (휴무가 아니라면 바디코디 화면의 강사 필터를 '전체'로 두세요)`);
  }

  // ⭐ v1.18.0: 중복 정리 — 살아 있는 예약 1건에 캘린더 일정이 여러 개면 연결된 1개만 남기고 나머지 삭제
  //   주 원인: 확장이 먼저 일정을 만든 뒤 바디코디 자체 구글 캘린더 연동이 몇 분 늦게 같은 예약 일정을 또 만듦
  //   (연동 일정 제목 예: "23-027 장우성_010-…_기본관절관리 - 기본관절관리", "02 집중관절관리 3회차")
  for (const [calId, grp] of byCal) {
    const list = gcalByCal.get(calId) || [];
    for (const bc of grp.active) {
      const kept = matchOf.get(bc);
      if (!kept) continue;
      for (const g of slotTwins(list, calId, bc)) {
        if (g === kept.g) continue;
        claimed.add(ck(calId, g));
        dupPlan.push({ calId, g, bc, keptTitle: kept.g.summary || '' });
      }
    }
  }

  // 📍 보고: 짝도 없고 취소 표시 대상도 아닌 고객 일정
  if (coverageOk) {
    for (const [calId, list] of gcalByCal) {
      const label = byCal.get(calId)?.label || calId;
      for (const g of list) {
        if (claimed.has(ck(calId, g)) || !g.start?.dateTime) continue;
        if (!isCustomerGcalEvent(g) || isCancelMarked(g)) continue;
        // ⭐ v1.17.0: 왜 연결되지 않았는지 함께 보고
        const 사유 = g.extendedProperties?.private?.bcSyncId
          ? '바디코디에서 사라진 예약 — 이번엔 삭제 보류 (로그의 ⏸️ 줄 확인)'
          : bcExistsFor(g)
          ? '확장이 만든 적 없는 일정 — 같은 시각에 다른(또는 매핑 안 된) 강사의 예약이 있음'
          : '확장이 만든 적 없는 일정 — 바디코디에 이 시각·회원의 예약이 없음 (지운 예약이면 직접 정리)';
        summary.orphans.push({ 캘린더: label, 시작: g.start.dateTime, 제목: g.summary || '(제목 없음)', 사유 });
      }
    }
  }

  // ---------- 3단계: 실행 ----------
  const totalToProcess = activeEvents.length + cancelPlan.length + dupPlan.length;
  let processed = 0;
  const bumpProgress = (label) => {
    if (totalToProcess === 0) return;
    reportProgress(25 + (processed / totalToProcess) * 70, label);
  };

  for (const [calId, grp] of byCal) {
    for (const bc of grp.active) {
      processed++;
      const memberLabel = (`${bc.memberNo || ''} ${bc.memberName || ''}`).trim() || '(이름없음)';
      bumpProgress(`${processed}/${totalToProcess} ${memberLabel}`);

      const newTitle = buildTitle(bc);
      if (!newTitle) { summary.skipped++; continue; }

      const plan = matchOf.get(bc);
      let match = plan?.g || null;
      let calMoveInfo = null;

      // ⭐ v1.16.0: 담당 강사가 바뀌어 다른 캘린더에 있는 일정 → 이 캘린더로 옮긴다 (삭제 아님)
      if (match && plan.calId !== calId) {
        const fromLabel = byCal.get(plan.calId)?.label || plan.calId;
        if (dryRun) {
          summary.details.push({ 시작: bc.start, 회원: memberLabel, 프로그램: bc.program, 매칭: true, 변경예정: true,
            강사이동: `${fromLabel} → ${grp.label}`, 새제목: newTitle });
          continue;
        }
        try {
          match = await moveEventToCalendar(token, plan.calId, match.id, calId);
          summary.calMoved++;
          calMoveInfo = `${fromLabel} → ${grp.label}`;
          await appendLog(`🔀 ${memberLabel}: 담당 변경 — 일정을 ${fromLabel} → ${grp.label} 캘린더로 옮김`);
        } catch (err) {
          await appendLog(`❌ 캘린더 이동 실패 (${memberLabel}): ${err.message} — 새 일정으로 만듭니다`);
          match = null;
        }
      }

      if (!match) {
        // ⭐ v1.14.0: 짝이 없으면 캘린더에 새로 만든다 (설정으로 끌 수 있음)
        if (!createMissing) {
          summary.skipped++;
          summary.details.push({ 시작: bc.start, 회원: `${bc.memberNo} ${bc.memberName}`.trim(), 프로그램: bc.program, 매칭: false, 변경예정: false });
          continue;
        }
        let createTitle = newTitle;
        if (bc.isAssessment && !/회차/.test(createTitle) && bc.round !== null && bc.round !== undefined) {
          createTitle = `${createTitle} ${bc.round}회차`;
        }
        const startTs = tsOf(bc.start);
        let endIso = bc.end;
        if (startTs === null) { summary.skipped++; continue; }
        if (tsOf(endIso) === null || tsOf(endIso) <= startTs) {
          endIso = new Date(startTs + 60 * 60 * 1000).toISOString();   // 종료 없으면 1시간
        }
        const det = { 시작: bc.start, 회원: `${bc.memberNo} ${bc.memberName}`.trim(), 프로그램: bc.program, 매칭: false, 변경예정: true, 생성: true, 새제목: createTitle };
        if (dryRun) { summary.details.push(det); continue; }
        // ⭐ v1.18.0: 만들기 직전에 그 시각을 다시 확인 — 다른 PC나 바디코디 자체 연동이 방금 만든 일정이 있으면 그걸 쓴다
        try {
          const fresh = await listEventsInRange(token, calId, new Date(startTs - WIN), new Date(startTs + WIN));
          const twin = fresh.find(g => {
            const gs = tsOf(g.start?.dateTime);
            return gs !== null && Math.abs(gs - startTs) <= WIN && !ownedByOtherActive(g, bc.id) && sameBookingTitle(g, bc);
          });
          if (twin) {
            await patchEvent(token, calId, twin.id, {
              summary: createTitle,
              description: buildDescription(bc, twin.description),
              extendedProperties: { private: { bcSyncId: bc.id } }
            });
            summary.matched++; summary.updated++;
            summary.details.push({ 시작: bc.start, 회원: `${bc.memberNo} ${bc.memberName}`.trim(), 프로그램: bc.program, 매칭: true, 변경예정: true, 완료: true, 기존제목: twin.summary, 새제목: createTitle });
            await appendLog(`🔗 ${memberLabel}: 방금 생긴 같은 예약 일정("${twin.summary}")을 연결 — 새로 만들지 않음`);
            continue;
          }
        } catch (e) { /* 재확인 실패 시 그대로 생성 (다음 동기화의 중복 정리가 처리) */ }
        try {
          await insertEvent(token, calId, {
            summary: createTitle,
            description: buildDescription(bc, ''),
            start: { dateTime: bc.start, timeZone: 'Asia/Seoul' },
            end:   { dateTime: endIso,   timeZone: 'Asia/Seoul' },
            extendedProperties: { private: { bcSyncId: bc.id, bcCreated: '1' } }
          });
          summary.created++;
          summary.details.push({ ...det, 완료: true });
          await appendLog(`🆕 ${memberLabel}: 캘린더 일정 생성 ${hhmm(bc.start)} "${createTitle}"`);
        } catch (err) {
          summary.failed++;
          await appendLog(`❌ 생성 실패: ${err.message}`);
          summary.details.push({ 시작: bc.start, 회원: `${bc.memberNo} ${bc.memberName}`.trim(), 프로그램: bc.program, 매칭: false, 실패: err.message });
        }
        continue;
      }

      summary.matched++;
      const wasCancelled = isCancelMarked(match);

      // ⭐ v1.9.0: 평가 프로그램은 "N회차"를 제목 끝에 보존
      let finalTitle = newTitle;
      if (bc.isAssessment && !/회차/.test(finalTitle)) {
        const gm = stripCancelPrefix(match.summary || '').match(/(\d+)\s*회차/);
        const round = gm ? parseInt(gm[1], 10) : bc.round;
        if (round !== null && round !== undefined) finalTitle = `${finalTitle} ${round}회차`;
      }

      // ⭐ v1.12.0: 시간 변경 → 캘린더 일정 이동 (종일 일정 제외, 시작/종료 모두 확정될 때만)
      const TIME_TOL_MS = 60 * 1000;
      let timeChanged = false;
      let newStartIso = null, newEndIso = null;
      if (match.start?.dateTime) {
        const bStartTs = tsOf(bc.start);
        const bEndTs   = tsOf(bc.end);
        const gStartTs = tsOf(match.start.dateTime);
        const gEndTs   = tsOf(match.end?.dateTime);
        if (bStartTs !== null && gStartTs !== null) {
          const startDiff = Math.abs(bStartTs - gStartTs);
          const endDiff   = (bEndTs !== null && gEndTs !== null) ? Math.abs(bEndTs - gEndTs) : 0;
          if (startDiff > TIME_TOL_MS || endDiff > TIME_TOL_MS) {
            newStartIso = bc.start;
            if (bEndTs !== null && bEndTs > bStartTs) newEndIso = bc.end;
            else if (gEndTs !== null && gEndTs > gStartTs) newEndIso = new Date(bStartTs + (gEndTs - gStartTs)).toISOString();
            timeChanged = !!newEndIso;
          }
        }
      }

      const newDesc = buildDescription(bc, match.description);
      const hasNewAuto    = buildAutoLines(bc).length > 0;
      const hadLegacyTag  = /\[bc-sync:[^\]]*\]/.test(match.description || '');
      const shouldUpdateDesc = hasNewAuto || hadLegacyTag;

      const normalize = s => String(s || '').replace(/\r\n/g, '\n').trim();
      const hasBcSyncMarker = match.extendedProperties?.private?.bcSyncId === bc.id;
      const descAlreadyOk = !shouldUpdateDesc || normalize(match.description) === normalize(newDesc);
      const alreadyOk = match.summary === finalTitle && descAlreadyOk && hasBcSyncMarker && !timeChanged && !wasCancelled && !calMoveInfo;

      const base = { 시작: bc.start, 회원: `${bc.memberNo} ${bc.memberName}`.trim(), 프로그램: bc.program, 매칭: true };
      if (alreadyOk) {
        summary.details.push({ ...base, 변경예정: false, 사유: '이미 동기화됨' });
        continue;
      }
      const changeInfo = {
        기존제목: match.summary, 새제목: finalTitle,
        새설명: shouldUpdateDesc ? (newDesc || '(빈 설명)') : '(기존 유지)',
        ...(timeChanged ? { 시간이동: `${hhmm(match.start?.dateTime)} → ${hhmm(newStartIso)}` } : {}),
        ...(wasCancelled ? { 복구: true } : {}),
        ...(calMoveInfo ? { 강사이동: calMoveInfo } : {})
      };
      if (dryRun) {
        summary.details.push({ ...base, 변경예정: true, ...changeInfo });
        continue;
      }

      try {
        const oldDescPreview = (match.description || '').replace(/\n/g, ' ⏎ ').slice(0, 80);
        const newDescPreview = shouldUpdateDesc ? ((newDesc || '').replace(/\n/g, ' ⏎ ').slice(0, 80) || '(빈 설명)') : '(유지)';
        const priv = { bcSyncId: bc.id };
        const patchBody = { summary: finalTitle, extendedProperties: { private: priv } };
        if (shouldUpdateDesc) patchBody.description = newDesc;
        if (timeChanged) {
          const tzStart = match.start?.timeZone;
          const tzEnd   = match.end?.timeZone || tzStart;
          patchBody.start = { dateTime: newStartIso, ...(tzStart ? { timeZone: tzStart } : {}) };
          patchBody.end   = { dateTime: newEndIso,   ...(tzEnd   ? { timeZone: tzEnd   } : {}) };
        }
        if (wasCancelled) {
          // ⭐ v1.16.0: 다시 살아난 예약 → [취소] 표시 해제, 원래 색·바쁨 표시 복구
          const prev = match.extendedProperties?.private?.bcPrevColor;
          patchBody.colorId = prev ? prev : null;
          patchBody.transparency = 'opaque';
          priv.bcCancelled = '0';
        }
        const oldStartLabel = hhmm(match.start?.dateTime);
        try {
          await patchEvent(token, calId, match.id, patchBody);
        } catch (e) {
          // 색 지우기(null)를 거부하는 경우 대비: 색 없이 한 번 더
          if (!(wasCancelled && /GCal 400/.test(e.message))) throw e;
          delete patchBody.colorId;
          await patchEvent(token, calId, match.id, patchBody);
        }
        summary.updated++;
        if (timeChanged) summary.timeMoved++;
        if (wasCancelled) summary.restored++;
        summary.details.push({ ...base, 변경예정: true, 완료: true, ...changeInfo });
        if (wasCancelled) await appendLog(`♻️ ${memberLabel}: 예약이 다시 살아나 [취소] 표시 해제 ${hhmm(bc.start)}`);
        if (timeChanged) await appendLog(`🕒 ${memberLabel}: 일정 시간 이동 ${oldStartLabel} → ${hhmm(newStartIso)}`);
        await appendLog(`✏️ ${memberLabel}: 제목 "${match.summary}" → "${finalTitle}" / 설명 "${oldDescPreview}" → "${newDescPreview}"`);
      } catch (err) {
        summary.failed++;
        await appendLog(`❌ patch 실패: ${err.message}`);
        summary.details.push({ ...base, 실패: err.message });
      }
    }
  }

  // ⭐ v1.18.0: 삭제 실행 — 바디코디에서 취소·삭제된 예약의 일정, 같은 예약의 중복 일정
  //   최신 데이터(동기화 전용 새 탭)로 읽었을 때만 지운다. 지운 일정은 구글 캘린더 휴지통에서 30일간 복구 가능.
  const deletions = [
    ...cancelPlan.map(p => ({ ...p, kind: 'cancel' })),
    ...dupPlan.map(p => ({ ...p, kind: 'dup', reason: '같은 예약의 중복 일정' }))
  ];
  if (deletions.length && !freshOk) {
    summary.goneHeld = (summary.goneHeld || 0) + deletions.length;
    await appendLog(`⏸️ 삭제 ${deletions.length}건 보류 — 최신 데이터가 아님 (바디코디 로그인 확인 후 다시 동기화하세요)`);
  }
  for (const p of (freshOk ? deletions : [])) {
    processed++;
    const g = p.g;
    const label = byCal.get(p.calId)?.label || p.calId;
    bumpProgress(`${processed}/${totalToProcess} ${p.kind === 'dup' ? '중복 정리' : '취소 반영'}`);
    const name = stripCancelPrefix(g.summary || '');
    const det = p.kind === 'dup'
      ? { 시작: g.start?.dateTime, 회원: name, 캘린더: label, 중복: p.keptTitle ? `남긴 일정: ${p.keptTitle}` : '같은 예약의 다른 일정을 남김', 변경예정: true }
      : { 시작: g.start?.dateTime, 회원: name, 캘린더: label, 취소: p.reason, 변경예정: true };
    if (dryRun) { summary.details.push(det); continue; }
    try {
      await deleteEvent(token, p.calId, g.id);
      if (p.kind === 'dup') summary.dedup = (summary.dedup || 0) + 1;
      else summary.cancelled++;
      summary.details.push({ ...det, 완료: true });
      await appendLog(p.kind === 'dup'
        ? `🧹 ${name}: 같은 예약의 중복 일정 삭제 (${hhmm(g.start?.dateTime)}, ${label})`
        : `🗑️ ${name}: ${p.reason} → 캘린더 일정 삭제 (${hhmm(g.start?.dateTime)}, ${label})`);
    } catch (err) {
      summary.failed++;
      await appendLog(`❌ 삭제 실패: ${err.message}`);
      summary.details.push({ ...det, 실패: err.message });
    }
  }

  const alreadyOkCount = (summary.details || []).filter(d => d.사유 === '이미 동기화됨').length;
  if (summary.orphans.length) {
    await appendLog(`📍 바디코디 예약과 연결되지 않은 캘린더 고객 일정 ${summary.orphans.length}건 (그대로 둠, 팝업 결과에서 사유 확인)`);
  }
  await appendLog(
    `✅ 완료 v${version} trig=${trigger} dry=${dryRun} ` +
    `matched=${summary.matched} updated=${summary.updated} 시간이동=${summary.timeMoved} 생성=${summary.created} 취소삭제=${summary.cancelled} 중복삭제=${summary.dedup || 0} 복구=${summary.restored} 강사이동=${summary.calMoved} 이미동기화=${alreadyOkCount} skipped=${summary.skipped} failed=${summary.failed}`
  );
  reportProgress(100, dryRun ? '미리보기 완료' : '동기화 완료');
  return { summary };
  } finally {
    isSyncing = false;   // 성공/실패와 무관하게 반드시 잠금 해제
  }
}

// ---------- 메시지 핸들러 (popup.js의 __bcPopup) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const cmd = msg.__bcPopup || msg.type || msg.action;

      if (cmd === 'getToken') {
        const token = await getAuthToken(msg.interactive ?? true);
        sendResponse({ ok: true, token });
        return;
      }

      if (cmd === 'runSync') {
        const result = await runSync({
          trigger: msg.trigger || 'manual',
          dryRun: !!msg.dryRun
        });
        sendResponse({ ok: true, result });
        return;
      }

      if (cmd === 'getLogs') {
        const { logs = [] } = await chrome.storage.local.get('logs');
        sendResponse({ ok: true, logs });
        return;
      }

      if (cmd === 'appendLog') {
        await appendLog(msg.text);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `unknown message: ${cmd}` });
    } catch (err) {
      await appendLog(`❌ ${msg.__bcPopup || msg.type} 실패: ${err.message}`);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // 비동기 응답 유지
});

// ================================================
// ⭐ v1.12.0: 자동 업데이트 (디스크 파일 변경 감지 → 확장 자동 리로드)
//
// 원리: unpacked 확장은 fetch()로 자기 자신의 "디스크상" 파일을 읽을 수 있다.
//   - chrome.runtime.getManifest().version  → 현재 크롬에 로드되어 실행 중인 버전(메모리)
//   - fetch('manifest.json')의 version      → 폴더에 실제로 저장된 버전(디스크)
//   둘이 다르면 = 파일이 갱신됨 → chrome.runtime.reload()로 새 코드 적용
//
// manifest.json의 version만 감시하는 이유: 여러 파일을 수정하는 도중에 리로드되면
// 반쪽만 갱신된 상태로 실행될 수 있다. version은 릴리스 시 마지막에 올리므로 안전한 신호가 된다.
// ================================================
const AUTO_RELOAD_ALARM = 'auto-reload-check';
const AUTO_RELOAD_INTERVAL_MIN = 1;

let isSyncing = false;   // 동기화 도중에는 리로드를 미룬다

async function readDiskVersion() {
  // 캐시 우회: 쿼리스트링 + no-store (반드시 디스크의 현재 내용을 읽어야 함)
  const url = chrome.runtime.getURL('manifest.json') + '?t=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
  const m = await res.json();
  return String(m.version || '');
}

async function checkForUpdate() {
  const running = chrome.runtime.getManifest().version;

  let disk;
  try {
    disk = await readDiskVersion();
  } catch (e) {
    // 이 크롬 버전에서 자기 manifest를 못 읽는 경우 — 1회만 안내하고 조용히 비활성
    const { autoReloadWarned } = await chrome.storage.local.get('autoReloadWarned');
    if (!autoReloadWarned) {
      await appendLog(`ℹ️ 자동 업데이트 감지 불가 (${e.message}) — chrome://extensions에서 수동 새로고침이 필요합니다`);
      await chrome.storage.local.set({ autoReloadWarned: true });
    }
    return;
  }

  if (!disk || disk === running) return;

  // 무한 리로드 방지: 같은 디스크 버전으로 이미 리로드를 시도했는데도 버전이 그대로면 중단
  const { autoReloadTried } = await chrome.storage.local.get('autoReloadTried');
  if (autoReloadTried === disk) {
    await appendLog(`⚠️ 자동 업데이트 보류: v${disk} 적용을 시도했지만 여전히 v${running} 실행 중 — 수동 새로고침 필요`);
    return;
  }

  if (isSyncing) {
    await appendLog(`⏳ 동기화 진행 중이라 자동 업데이트 대기 (v${running} → v${disk})`);
    return;
  }

  await chrome.storage.local.set({ autoReloadTried: disk });
  await appendLog(`🔄 새 버전 감지: v${running} → v${disk} — 확장을 자동으로 다시 불러옵니다`);
  chrome.runtime.reload();   // unpacked 확장은 디스크에서 파일을 다시 읽어 재시작됨
}

async function initAutoReload() {
  const running = chrome.runtime.getManifest().version;

  // 리로드가 실제로 성공했는지 확인 (성공 시 시도 기록 정리)
  const { autoReloadTried } = await chrome.storage.local.get('autoReloadTried');
  if (autoReloadTried && autoReloadTried === running) {
    await chrome.storage.local.remove(['autoReloadTried', 'autoReloadWarned']);
    await appendLog(`✅ 자동 업데이트 완료 — v${running} 적용됨`);
  }

  // 알람은 이미 있으면 그대로 둔다 (서비스워커가 깰 때마다 타이머가 초기화되는 것 방지)
  const existing = await chrome.alarms.get(AUTO_RELOAD_ALARM);
  if (!existing) {
    chrome.alarms.create(AUTO_RELOAD_ALARM, {
      delayInMinutes: AUTO_RELOAD_INTERVAL_MIN,
      periodInMinutes: AUTO_RELOAD_INTERVAL_MIN
    });
  }
}

initAutoReload();

// ---------- 알람: 사용자가 고른 주기로 자동 동기화 (평일 09:00 ~ 21:00) ----------
// ⭐ v1.16.0: 팝업 드롭다운에서 15분 ~ 24시간 중 선택 (기본 1시간 = 이전 버전과 동일)
//   - 하루 시간표: 09:00부터 N분 간격, 21:00까지 (예: 6시간 → 09·15·21시, 24시간 → 09시)
//   - 다음 실행 시각 하나만 'sync-next' 알람으로 걸고, 울리면 그다음 시각을 다시 건다.
//   - 1분마다 도는 업데이트 확인 알람이 'sync-next'가 사라졌는지도 점검한다 (자가 복구).
const SYNC_START_HOUR = 9;
const SYNC_END_HOUR = 21;   // 포함
const SYNC_ALARM = 'sync-next';
const SYNC_INTERVAL_CHOICES = [15, 30, 45, 60, 120, 180, 360, 720, 1440];
const DEFAULT_SYNC_INTERVAL = 60;

function normalizeInterval(v) {
  const n = Number(v);
  return SYNC_INTERVAL_CHOICES.includes(n) ? n : DEFAULT_SYNC_INTERVAL;
}

// now 이후의 첫 실행 시각 (평일, 09:00 + k*interval ≤ 21:00)
function nextSyncSlot(now, intervalMin) {
  const interval = normalizeInterval(intervalMin);
  const nowMs = now.getTime();
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const day = new Date(now);
    day.setDate(day.getDate() + dayOffset);
    day.setHours(SYNC_START_HOUR, 0, 0, 0);
    const wd = day.getDay();
    if (wd === 0 || wd === 6) continue;   // 주말 제외
    const last = new Date(day); last.setHours(SYNC_END_HOUR, 0, 0, 0);
    for (let t = day.getTime(); t <= last.getTime(); t += interval * 60000) {
      if (t > nowMs + 1000) return t;
    }
  }
  return nowMs + interval * 60000;   // 도달하지 않음 (안전장치)
}

async function scheduleNextSync({ force = false } = {}) {
  const { syncIntervalMin } = await chrome.storage.local.get('syncIntervalMin');
  const interval = normalizeInterval(syncIntervalMin);
  if (!force) {
    const existing = await chrome.alarms.get(SYNC_ALARM);
    if (existing) return existing.scheduledTime;
  }
  const when = nextSyncSlot(new Date(), interval);
  await chrome.alarms.create(SYNC_ALARM, { when });
  return when;
}

async function ensureAlarms() {
  // 이전 버전의 매시 정각 알람(sync-0900 ~ sync-2100) 정리
  const existing = await chrome.alarms.getAll();
  for (const alarm of existing) {
    if (alarm.name.startsWith('sync-') && alarm.name !== SYNC_ALARM) {
      await chrome.alarms.clear(alarm.name);
    }
  }
  await scheduleNextSync();
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); });

// 팝업에서 주기를 바꾸면 즉시 다음 실행 시각을 다시 계산
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.syncIntervalMin) {
    scheduleNextSync({ force: true }).then(when => {
      const p = n => String(n).padStart(2, '0');
      const d = new Date(when);
      appendLog(`⏱️ 자동 동기화 주기 변경: ${normalizeInterval(changes.syncIntervalMin.newValue)}분 — 다음 실행 ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`);
    });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // ⭐ v1.12.0: 자동 업데이트 확인 (동기화와 무관하게 주말에도 동작)
  if (alarm.name === AUTO_RELOAD_ALARM) {
    try {
      await checkForUpdate();
    } catch (err) {
      await appendLog(`❌ 자동 업데이트 확인 실패: ${err.message}`);
    }
    // 자가 복구: 다음 동기화 알람이 사라졌으면 다시 건다
    try { await scheduleNextSync(); } catch (e) { /* ignore */ }
    return;
  }

  if (alarm.name !== SYNC_ALARM) {
    // 이전 버전에서 남은 알람 — 정리만 한다
    if (alarm.name.startsWith('sync-')) await chrome.alarms.clear(alarm.name);
    return;
  }

  // 다음 실행 시각부터 먼저 건다 (동기화가 실패해도 일정이 끊기지 않도록)
  try { await scheduleNextSync({ force: true }); } catch (e) { /* ignore */ }

  // 크롬이 꺼져 있다가 주말에 켜져서 밀린 알람이 울린 경우 건너뜀
  const day = new Date().getDay(); // 0=일, 6=토
  if (day === 0 || day === 6) {
    await appendLog(`⏸️ ${day === 0 ? '일요일' : '토요일'} — 자동 동기화 스킵`);
    return;
  }

  // ⭐ v1.18.0: 여러 PC가 같은 시각에 동시에 돌면 같은 예약을 서로 만들 수 있어 0~20초 흩어서 시작
  await sleep(Math.floor(Math.random() * 20000));
  try {
    await runSync({ trigger: `alarm:${alarm.name}`, dryRun: false });
  } catch (err) {
    await appendLog(`❌ alarm sync 실패: ${err.message}`);
  }
});

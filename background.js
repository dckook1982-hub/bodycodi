// ================================================
// BodyCodi → Google Calendar Sync
// background.js
// - 2주(이번 주 일요일 ~ 다음 주 토요일) 전체 동기화
// - 제목 포맷: "회원번호 성함 연락처 프로그램이름" (회원번호 없으면 생략)
// - 설명 자동 라인(v1.13.0): "프로그램명 / 유효기간 / 총횟수 / 잔여횟수" (사용자 메모는 보존)
// - v1.9.0: 평가 프로그램(담당쌤 동작기능평가/대표원장 관절기능평가)은 "N회차"를 제목 끝에 보존
// - popup.js의 __bcPopup 메시지 구조에 맞춤
// ================================================

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ---------- 유틸 ----------
function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 동기화 범위: 이번 주 일요일 00:00 ~ 다음 주 토요일 23:59:59.999 (총 14일)
function getSyncRange(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=일, 6=토
  const start = new Date(d);
  start.setDate(d.getDate() - day);     // 이번 주 일요일
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 13);    // 일요일 + 13일 = 다음 주 토요일
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
    fields: 'items(id,summary,description,start,end,extendedProperties)'
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

// ---------- BodyCodi 탭에서 스케줄 추출 ----------
async function extractSchedulesFromBodyCodi() {
  const tabs = await chrome.tabs.query({
    url: 'https://crm.bodycodi.com/manager/schedule/*',
  });
  if (!tabs.length) {
    throw new Error('BodyCodi 스케줄 탭이 열려있지 않습니다.');
  }
  const tab = tabs[0];

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      try {
        if (typeof scheduler === 'undefined' || typeof scheduler.getEvents !== 'function') {
          return { ok: false, error: 'scheduler 객체 없음' };
        }

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

        // === 2주 프리페치: 다음 주로 이동 → 데이터 로드 → 원위치 복원 → 두 주 이벤트 병합 ===
        const fetchTwoWeeksEvents = async () => {
          const WAIT_MS = 2500;
          let origDate = null, origMode = 'week';

          try {
            const state = (scheduler.getState && scheduler.getState()) || {};
            origDate = state.date ? new Date(state.date) : null;
            origMode = state.mode || 'week';
          } catch (e) { /* state 접근 실패 - 현재 이벤트만 사용 */ }

          // setCurrentView 없으면 prefetch 불가 — 그냥 현재 이벤트 리턴
          if (!origDate || typeof scheduler.setCurrentView !== 'function') {
            return { events: scheduler.getEvents(), prefetched: false };
          }

          // 현재 주의 이벤트 수집
          const week1Events = scheduler.getEvents().slice();

          // 다음 주로 이동
          let week2Events = [];
          try {
            const nextWeek = new Date(origDate);
            nextWeek.setDate(nextWeek.getDate() + 7);
            scheduler.setCurrentView(nextWeek, origMode);
            await new Promise(r => setTimeout(r, WAIT_MS));
            week2Events = scheduler.getEvents().slice();
          } catch (e) { /* navigation 실패 */ }

          // 원위치 복원
          try {
            scheduler.setCurrentView(origDate, origMode);
            await new Promise(r => setTimeout(r, 800));   // 짧게: 사용자 view 복원만
          } catch (e) {}

          // id 기준 dedup 병합
          const seen = new Set();
          const merged = [];
          for (const ev of week1Events.concat(week2Events)) {
            const id = String(ev.id || ev.seq_schedule || '');
            if (id && !seen.has(id)) { seen.add(id); merged.push(ev); }
          }
          return { events: merged, prefetched: true, week1: week1Events.length, week2: week2Events.length };
        };

        const _prefetch = await fetchTwoWeeksEvents();
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
        const EVENT_TIME_KEYS = new Set(['start_date','end_date','start','end']);

        // 날짜형 값 → "YYYY-MM-DD" (Date 객체, "2026-12-31", "2026.12.31", "20261231", "2026-12-31 23:59:59" 허용)
        const toYmd = (v) => {
          if (v === null || v === undefined || v === '') return null;
          if (v instanceof Date) {
            if (isNaN(v.getTime())) return null;
            const p = n => String(n).padStart(2, '0');
            return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
          }
          const s = String(v).trim();
          const m = s.match(/^(\d{4})[-.\/]?(\d{2})[-.\/]?(\d{2})(?:[T\s].*)?$/);
          if (!m) return null;
          const y = +m[1], mo = +m[2], d = +m[3];
          if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
          return `${m[1]}-${m[2]}-${m[3]}`;
        };
        // 1) 알려진 후보 키 → 2) 키 이름에 end/expire/limit/valid 등이 들어가고 값이 날짜형인 필드(휴리스틱)
        const getDateField = (ev, candidates, heuristicRe) => {
          for (const k of candidates) {
            if (!(k in ev)) continue;
            const ymdv = toYmd(ev[k]);
            if (ymdv) return { value: ymdv, key: k };
          }
          if (heuristicRe) {
            for (const k of Object.keys(ev)) {
              if (EVENT_TIME_KEYS.has(k) || !heuristicRe.test(k)) continue;
              const ymdv = toYmd(ev[k]);
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
          const expire = getDateField(ev, EXPIRE_KEYS, /(end|expir|limit|valid|deadline|만료|종료)/i);
          const vstart = expire.value
            ? getDateField(ev, VALID_START_KEYS, /(start|begin|시작)/i)
            : { value: null, key: null };
          let validPeriod = null;
          if (expire.value) {
            validPeriod = vstart.value ? `${vstart.value} ~ ${expire.value}` : expire.value;
          }

          // 진단: 첫 이벤트의 모든 키 + 숫자 필드 + 날짜형 필드 dump
          if (idx === 0) {
            _firstEventKeys = Object.keys(ev).sort();
            _firstEventNumericFields = {};
            _firstEventDateLikeFields = {};
            for (const k of _firstEventKeys) {
              const v = ev[k];
              if (typeof v === 'number' && Number.isFinite(v)) _firstEventNumericFields[k] = v;
              else if (typeof v === 'string' && /^-?\d+$/.test(v.trim()) && v.length < 12) _firstEventNumericFields[k] = '"'+v+'"';
              if (!EVENT_TIME_KEYS.has(k) && toYmd(v)) _firstEventDateLikeFields[k] = toYmd(v);
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
            round
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
                week1Count: _prefetch.week1 || 0,
                week2Count: _prefetch.week2 || 0
              }
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

  reportProgress(15, 'BodyCodi 일정 읽는 중');
  const { events, _diagnostics } = await extractSchedulesFromBodyCodi();
  await appendLog(`📥 BodyCodi 전체 이벤트: ${events.length}`);

  // 진단 로그
  if (_diagnostics) {
    const pf = _diagnostics.prefetch || {};
    if (pf.attempted) {
      await appendLog(`🔁 2주 프리페치: 1주차=${pf.week1Count}건, 2주차=${pf.week2Count}건 (병합 후 ${events.length}건)`);
    } else {
      await appendLog(`⚠️ 2주 프리페치 미시도 — scheduler.setCurrentView 사용 불가. 현재 보이는 주만 동기화됩니다.`);
    }
    const d = _diagnostics.countDiscovery || {};
    await appendLog(`🔬 횟수 추출: 총횟수발견=${d.withTotal||0}/${d.total||0}, 잔여횟수발견=${d.withRemain||0}/${d.total||0}`);
    // ⭐ v1.13.0: 유효기간 추출 결과 — 어떤 필드에서 읽었는지 함께 기록 (오인 시 관리자가 확인 가능)
    const x = _diagnostics.expireDiscovery || {};
    if ((x.withExpire || 0) > 0) {
      await appendLog(`📆 유효기간 추출: 만료일=${x.withExpire}/${x.total} (필드=${x.expireKey})` +
        ((x.withStart || 0) > 0 ? `, 시작일=${x.withStart}/${x.total} (필드=${x.startKey})` : ''));
    } else {
      // 못 찾았을 때 첫 이벤트의 날짜형 필드를 모두 출력 → 실제 필드명 파악용
      await appendLog(`📆 유효기간 추출: 0/${x.total || 0} — 날짜형 필드 후보: ${JSON.stringify(_diagnostics.firstEventDateLikeFields || {})}`);
    }
    const a = _diagnostics.assessDiscovery || {};
    if (a.count > 0) {
      await appendLog(`🩺 평가 프로그램: ${a.count}건 (회원정보 추출 ${a.withMember}건, 회차 파악 ${a.withRound}건) 예시="${a.sampleText}"`);
      if (a.sampleFields) {
        await appendLog(`🩺 회원정보 미발견 이벤트 전체필드: ${JSON.stringify(a.sampleFields)}`);
      }
    }
    if ((_diagnostics.countDiscovery.withRemain || 0) === 0 && _diagnostics.firstEventNumericFields) {
      // 잔여횟수 못 찾았을 때 첫 이벤트 숫자 필드 출력 → 필드명 파악용
      await appendLog(`🔬 첫 이벤트 숫자필드(잔여횟수 찾기용): ${JSON.stringify(_diagnostics.firstEventNumericFields)}`);
    }
  }

  const { rangeStart, rangeEnd } = getSyncRange(new Date());
  await appendLog(`📅 동기화 범위 (2주): ${ymd(rangeStart)} ~ ${ymd(rangeEnd)}`);

  // 동기화 범위 + 고객 예약만
  const rangeEvents = events.filter(ev => {
    if (!ev.start) return false;
    const t = new Date(ev.start).getTime();
    if (t < rangeStart.getTime() || t > rangeEnd.getTime()) return false;
    return isCustomerBooking(ev);
  });
  await appendLog(`📅 2주 고객 예약: ${rangeEvents.length}건`);

  // coachId 별 그룹
  const byCoach = {};
  for (const ev of rangeEvents) {
    if (!ev.coachId) continue;
    (byCoach[ev.coachId] ||= []).push(ev);
  }

  reportProgress(25, `${rangeEvents.length}건 동기화 시작`);

  const summary = {
    matched: 0,
    updated: 0,
    timeMoved: 0,     // ⭐ v1.12.0: 시간이 이동된 일정 수
    skipped: 0,
    failed: 0,
    details: []
  };

  // 진행률 계산: 25% ~ 95% 구간(70%)을 이벤트 처리 진척으로 나눔
  const totalToProcess = rangeEvents.length;
  let processed = 0;
  const progressBase = 25;
  const progressSpan = 70;
  const bumpProgress = (label) => {
    if (totalToProcess === 0) return;
    const pct = progressBase + (processed / totalToProcess) * progressSpan;
    reportProgress(pct, label);
  };

  for (const [coachId, evs] of Object.entries(byCoach)) {
    const calendarId = coachCalendarMap[coachId];
    const coachName = evs[0]?.coachName || `coach=${coachId}`;
    if (!calendarId) {
      await appendLog(`⏭️ 매핑 없음: coachId=${coachId} (${evs.length}건)`);
      summary.skipped += evs.length;
      processed += evs.length;
      bumpProgress(`매핑 없음 강사 ${evs.length}건 스킵`);
      continue;
    }

    bumpProgress(`${coachName} 캘린더 조회`);
    let gcalEvents;
    try {
      gcalEvents = await listEventsInRange(token, calendarId, rangeStart, rangeEnd);
    } catch (err) {
      await appendLog(`❌ 캘린더 조회 실패 (${calendarId}): ${err.message}`);
      summary.failed += evs.length;
      processed += evs.length;
      bumpProgress(`${coachName} 조회 실패`);
      continue;
    }
    await appendLog(`📖 coach=${coachId} → ${calendarId}: GCal ${gcalEvents.length}건`);

    // ⭐ v1.12.0: 매칭을 2단계로 분리 + 이미 매칭된 캘린더 일정은 재사용 금지(claimed)
    //   1차) bcSyncId 마커/레거시 태그 — 시간이 바뀌어도 "같은 예약"으로 추적됨 (시간 이동의 핵심)
    //   2차) 시간 ±3분 — 아직 마커가 없는 최초 동기화 건
    //   2단계로 나누는 이유: 시간매칭이 먼저 캘린더 일정을 선점해버리면,
    //   정작 마커로 확정 매칭돼야 할 예약이 짝을 잃고 시간 이동에 실패함
    const matchByIdx = new Map();
    const claimed = new Set();

    evs.forEach((bc, i) => {
      if (!bc.id) return;
      const syncTag = `[bc-sync:${bc.id}]`;
      const m =
        gcalEvents.find(g => !claimed.has(g.id) && g.extendedProperties?.private?.bcSyncId === bc.id) ||
        gcalEvents.find(g => !claimed.has(g.id) && (g.description || '').includes(syncTag));
      if (m) { matchByIdx.set(i, m); claimed.add(m.id); }
    });

    evs.forEach((bc, i) => {
      if (matchByIdx.has(i)) return;
      const bcStart = tsOf(bc.start);
      if (bcStart === null) return;
      const m = gcalEvents.find(g => {
        if (claimed.has(g.id)) return false;
        const gs = tsOf(g.start?.dateTime || g.start?.date);
        return gs !== null && Math.abs(gs - bcStart) <= 3 * 60 * 1000;
      });
      if (m) { matchByIdx.set(i, m); claimed.add(m.id); }
    });

    for (const [idx, bc] of evs.entries()) {
      // 진행률: 매 이벤트 시작 시 카운터 증가 (어떤 분기로 빠지든 진행 보장)
      processed++;
      const memberLabel = (`${bc.memberNo || ''} ${bc.memberName || ''}`).trim() || '(이름없음)';
      bumpProgress(`${processed}/${totalToProcess} ${memberLabel}`);

      const newTitle = buildTitle(bc);
      if (!newTitle) { summary.skipped++; continue; }

      // 매칭 결과는 위의 2단계 패스에서 이미 확정됨
      const match = matchByIdx.get(idx);

      if (!match) {
        summary.skipped++;
        summary.details.push({
          시작: bc.start,
          회원: `${bc.memberNo} ${bc.memberName}`.trim(),
          프로그램: bc.program,
          매칭: false,
          변경예정: false
        });
        continue;
      }

      summary.matched++;

      // ⭐ v1.9.0: 평가 프로그램은 "N회차"를 제목 끝에 보존
      //   회차 우선순위: 앱이 만든 기존 GCal 제목의 "N회차" > BodyCodi 텍스트/계산값
      let finalTitle = newTitle;
      if (bc.isAssessment && !/회차/.test(finalTitle)) {
        const gm = (match.summary || '').match(/(\d+)\s*회차/);
        const round = gm ? parseInt(gm[1], 10) : bc.round;
        if (round !== null && round !== undefined) finalTitle = `${finalTitle} ${round}회차`;
      }

      // ⭐ v1.12.0: 바디코디에서 일정 시간이 수정된 경우 캘린더 일정도 이동
      //   종일(all-day) 일정은 대상에서 제외하고, 시작/종료를 둘 다 확정할 수 있을 때만 이동한다
      //   (Google Calendar는 start만 보내면 end < start가 되어 거부될 수 있음)
      const TIME_TOL_MS = 60 * 1000;   // 1분 이내 오차는 동일한 시각으로 간주
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
            if (bEndTs !== null && bEndTs > bStartTs) {
              newEndIso = bc.end;
            } else if (gEndTs !== null && gEndTs > gStartTs) {
              // 바디코디 종료시각이 없으면 기존 캘린더 일정의 소요시간을 그대로 유지
              newEndIso = new Date(bStartTs + (gEndTs - gStartTs)).toISOString();
            }
            timeChanged = !!newEndIso;   // 종료시각을 정할 수 없으면 이동 보류(안전)
          }
        }
      }

      // 사용자 콘텐츠 보존: 기존 description에서 관리 라인만 제거한 뒤 새 자동 라인 추가
      const newDesc = buildDescription(bc, match.description);

      // description 필드를 PATCH에 포함할지 결정 (보수적 정책):
      //   - 추가할 자동 정보(프로그램명/유효기간/총횟수/잔여횟수)가 있거나
      //   - 정리할 레거시 [bc-sync:ID] 태그가 있을 때만 description 수정
      //   - 그 외(자동정보가 전혀 없는 이벤트)에는 description 자체를 건드리지 않음 → 사용자 메모 100% 보존
      const hasNewAuto    = buildAutoLines(bc).length > 0;
      const hadLegacyTag  = /\[bc-sync:[^\]]*\]/.test(match.description || '');
      const shouldUpdateDesc = hasNewAuto || hadLegacyTag;

      // alreadyOk: 제목 + (description 변경할 필요 없거나 이미 일치) + 숨겨진 매핑 마커 있을 때만
      const normalize = s => String(s || '').replace(/\r\n/g, '\n').trim();
      const hasBcSyncMarker = match.extendedProperties?.private?.bcSyncId === bc.id;
      const descAlreadyOk = !shouldUpdateDesc || normalize(match.description) === normalize(newDesc);
      const alreadyOk =
        match.summary === finalTitle &&
        descAlreadyOk &&
        hasBcSyncMarker &&
        !timeChanged;

      if (alreadyOk) {
        summary.details.push({
          시작: bc.start,
          회원: `${bc.memberNo} ${bc.memberName}`.trim(),
          프로그램: bc.program,
          매칭: true,
          변경예정: false,
          사유: '이미 동기화됨'
        });
        continue;
      }

      if (dryRun) {
        summary.details.push({
          시작: bc.start,
          회원: `${bc.memberNo} ${bc.memberName}`.trim(),
          프로그램: bc.program,
          매칭: true,
          변경예정: true,
          기존제목: match.summary,
          새제목: finalTitle,
          새설명: shouldUpdateDesc ? (newDesc || '(빈 설명)') : '(기존 유지)',
          ...(timeChanged ? { 시간이동: `${hhmm(match.start?.dateTime)} → ${hhmm(newStartIso)}` } : {})
        });
        continue;
      }

      try {
        // 진단: PATCH 직전에 변경 내역 로그
        const oldDescPreview = (match.description || '').replace(/\n/g, ' ⏎ ').slice(0, 80);
        const newDescPreview = shouldUpdateDesc
          ? ((newDesc || '').replace(/\n/g, ' ⏎ ').slice(0, 80) || '(빈 설명)')
          : '(유지)';

        // 조건부 PATCH body 구성: description 필드는 필요할 때만 포함
        const patchBody = {
          summary: finalTitle,
          extendedProperties: {
            private: { bcSyncId: bc.id }          // 숨겨진 매칭 마커
          }
        };
        if (shouldUpdateDesc) {
          patchBody.description = newDesc;        // 정리/갱신 필요할 때만 명시
        }
        if (timeChanged) {
          // 기존 일정의 timeZone 설정을 그대로 계승 (캘린더별 시간대 차이로 인한 틀어짐 방지)
          const tzStart = match.start?.timeZone;
          const tzEnd   = match.end?.timeZone || tzStart;
          patchBody.start = { dateTime: newStartIso, ...(tzStart ? { timeZone: tzStart } : {}) };
          patchBody.end   = { dateTime: newEndIso,   ...(tzEnd   ? { timeZone: tzEnd   } : {}) };
        }
        // description 필드가 patchBody에 없으면 Google Calendar API는 기존 값을 그대로 유지

        const oldStartLabel = hhmm(match.start?.dateTime);

        await patchEvent(token, calendarId, match.id, patchBody);
        summary.updated++;
        if (timeChanged) summary.timeMoved++;
        summary.details.push({
          시작: bc.start,
          회원: `${bc.memberNo} ${bc.memberName}`.trim(),
          프로그램: bc.program,
          매칭: true,
          변경예정: true,
          완료: true,
          기존제목: match.summary,
          새제목: finalTitle,
          새설명: shouldUpdateDesc ? (newDesc || '(빈 설명)') : '(기존 유지)',
          ...(timeChanged ? { 시간이동: `${oldStartLabel} → ${hhmm(newStartIso)}` } : {})
        });
        if (timeChanged) {
          await appendLog(`🕒 ${memberLabel}: 일정 시간 이동 ${oldStartLabel} → ${hhmm(newStartIso)}`);
        }
        await appendLog(`✏️ ${memberLabel}: 제목 "${match.summary}" → "${finalTitle}" / 설명 "${oldDescPreview}" → "${newDescPreview}"`);
      } catch (err) {
        summary.failed++;
        await appendLog(`❌ patch 실패: ${err.message}`);
        summary.details.push({
          시작: bc.start,
          회원: `${bc.memberNo} ${bc.memberName}`.trim(),
          프로그램: bc.program,
          매칭: true,
          실패: err.message
        });
      }
    }
  }

  const alreadyOkCount = (summary.details || []).filter(d => d.사유 === '이미 동기화됨').length;
  await appendLog(
    `✅ 완료 v${version} trig=${trigger} dry=${dryRun} ` +
    `matched=${summary.matched} updated=${summary.updated} 시간이동=${summary.timeMoved} 이미동기화=${alreadyOkCount} skipped=${summary.skipped} failed=${summary.failed}`
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

// ---------- 알람 (평일 09:00 ~ 21:00 매시 정각) ----------
const SYNC_START_HOUR = 9;
const SYNC_END_HOUR = 21;   // 포함 (09,10,...,21시 = 13회)

function nextTimeToday(hour, minute) {
  const now = new Date();
  const t = new Date();
  t.setHours(hour, minute, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

async function ensureAlarms() {
  // 평일 09~21시 매시 정각 (주말은 onAlarm 핸들러에서 스킵)
  const desired = [];
  for (let h = SYNC_START_HOUR; h <= SYNC_END_HOUR; h++) {
    desired.push({ name: `sync-${String(h).padStart(2, '0')}00`, hour: h, minute: 0 });
  }
  const desiredNames = new Set(desired.map(d => d.name));
  const existing = await chrome.alarms.getAll();

  // 더 이상 원하지 않는 sync-* 알람 정리 (예: 이전 버전의 sync-2200 등 범위 밖 알람)
  for (const alarm of existing) {
    if (alarm.name.startsWith('sync-') && !desiredNames.has(alarm.name)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // 신규 알람 등록 (이미 존재하는 건 그대로)
  const existingNames = new Set(existing.map(a => a.name));
  for (const d of desired) {
    if (!existingNames.has(d.name)) {
      chrome.alarms.create(d.name, {
        when: nextTimeToday(d.hour, d.minute),
        periodInMinutes: 24 * 60
      });
    }
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarms(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // ⭐ v1.12.0: 자동 업데이트 확인 (동기화와 무관하게 주말에도 동작)
  if (alarm.name === AUTO_RELOAD_ALARM) {
    try {
      await checkForUpdate();
    } catch (err) {
      await appendLog(`❌ 자동 업데이트 확인 실패: ${err.message}`);
    }
    return;
  }

  // sync-* 알람은 평일만 실행 (월~금)
  if (alarm.name.startsWith('sync-')) {
    const day = new Date().getDay(); // 0=일, 1=월, ..., 6=토
    if (day === 0 || day === 6) {
      const dayName = day === 0 ? '일요일' : '토요일';
      await appendLog(`⏸️ ${dayName} — 자동 동기화 스킵 (alarm=${alarm.name})`);
      return;
    }
  }

  try {
    await runSync({ trigger: `alarm:${alarm.name}`, dryRun: false });
  } catch (err) {
    await appendLog(`❌ alarm sync 실패: ${err.message}`);
  }
});
// ================================================
// BodyCodi → Google Calendar Sync
// popup.js
// ================================================

const BODYCODI_URL = 'https://crm.bodycodi.com/manager/schedule/promise';

document.addEventListener('DOMContentLoaded', async () => {
  // 버전 표시 (어떤 코드가 도는지 즉시 확인 가능)
  try {
    const v = chrome.runtime.getManifest().version;
    const badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = `(v${v})`;
  } catch (e) { /* ignore */ }

  await refreshOnboarding();
  loadLogsAndResult();
});

// ---------- 강사 ↔ 캘린더 자동 추천 ----------
// 정규화: 괄호 부분 / 흔한 접미사 / 공백 제거
function normalizeName(name) {
  return String(name || '')
    .replace(/\(.*?\)/g, '')               // (CRM), (개인) 등 제거
    .replace(/\s+/g, '')                   // 공백 제거
    .replace(/(쌤|선생님|선생|코치|강사|T)+$/g, '') // 접미사 제거
    .trim();
}

// 점수: 100=완전일치, 80=한쪽이 다른 한쪽을 포함(2자 이상), 0=매칭 안 됨
function scoreMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length >  b.length ? a : b;
  if (shorter.length >= 2 && longer.includes(shorter)) return 80;
  return 0;
}

// 한 강사명에 대해 가장 매칭 점수 높은 캘린더 추천
// 동점이 여럿이면(애매) null 반환 → 사용자에게 선택 위임
function suggestCalendar(coachName, calendars) {
  const coachNorm = normalizeName(coachName);
  if (!coachNorm) return null;

  const scored = calendars
    .map(cal => ({ cal, score: scoreMatch(coachNorm, normalizeName(cal.summary)) }))
    .filter(x => x.score >= 80);

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);

  const topScore = scored[0].score;
  const topCount = scored.filter(x => x.score === topScore).length;
  if (topCount > 1) return null; // 동점 여러 개면 애매하므로 자동선택 안 함

  return { calendarId: scored[0].cal.id, score: topScore, calName: scored[0].cal.summary };
}

// ---------- 온보딩 표시/감춤 ----------
async function refreshOnboarding() {
  const { coachCalendarMap = {} } = await chrome.storage.local.get('coachCalendarMap');
  const onboarding = document.getElementById('onboarding');
  const hasMapping = Object.keys(coachCalendarMap).length > 0;

  if (hasMapping) {
    onboarding.classList.add('hidden');
    return;
  }

  onboarding.classList.remove('hidden');

  // step1: 바디코디 탭이 열려 있는지
  const tabs = await chrome.tabs.query({ url: 'https://crm.bodycodi.com/manager/schedule/*' });
  const step1 = document.getElementById('step1');
  if (tabs.length > 0) step1.classList.add('done');
  else step1.classList.remove('done');

  // 동기화 버튼은 매핑이 없으면 비활성화
  document.getElementById('syncNow').disabled = true;
  document.getElementById('dryRun').disabled = true;
  document.getElementById('syncNow').title = '먼저 강사-캘린더 매핑을 저장해주세요';
  document.getElementById('dryRun').title = '먼저 강사-캘린더 매핑을 저장해주세요';
}

// 바디코디 페이지 새 탭으로 열기
document.getElementById('openBodyCodiBtn').addEventListener('click', async () => {
  await chrome.tabs.create({ url: BODYCODI_URL });
  // 잠깐 후 step1 상태 갱신
  setTimeout(refreshOnboarding, 800);
});

// ---------- 동기화 버튼 ----------
document.getElementById('syncNow').addEventListener('click', () => {
  runSync(false);
});
document.getElementById('dryRun').addEventListener('click', () => {
  runSync(true);
});

// ---------- 진행률 막대 ----------
function showProgress(percent, label) {
  const container = document.getElementById('progressContainer');
  const bar = document.getElementById('progressBar');
  const labelEl = document.getElementById('progressLabel');
  container.classList.remove('hidden');
  const pct = Math.min(100, Math.max(0, Math.round(percent)));
  bar.style.width = pct + '%';
  bar.textContent = pct + '%';
  if (labelEl) labelEl.textContent = label || '';
}

function hideProgress() {
  document.getElementById('progressContainer').classList.add('hidden');
  const bar = document.getElementById('progressBar');
  bar.style.width = '0%';
  bar.textContent = '0%';
  document.getElementById('progressLabel').textContent = '';
}

// background.js → popup 진행률 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.__bcProgress) {
    showProgress(msg.percent, msg.label);
  }
});

// ---------- 결과 표시 (사람이 읽기 쉬운 형태) ----------
// 원본 details는 244건까지 나오는 JSON이라 눈으로 훑기 어렵다.
// "이미 동기화됨"은 조치가 필요 없으므로 감추고, 실제로 바뀐 것만 분류해서 보여준다.
function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const W = ['일', '월', '화', '수', '목', '금', '토'];
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}(${W[d.getDay()]}) ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderResult(details, dryRun) {
  const list = details || [];

  const failed  = list.filter(d => d.실패);
  const moved   = list.filter(d => d.시간이동 && !d.실패);
  const updated = list.filter(d => !d.시간이동 && !d.실패 && (d.완료 || (dryRun && d.변경예정)));
  const skipped = list.filter(d => d.매칭 === false);

  const alreadyOk = list.length - failed.length - moved.length - updated.length - skipped.length;

  if (!failed.length && !moved.length && !updated.length && !skipped.length) {
    return `✅ 조치가 필요한 항목이 없습니다.\n   (${alreadyOk}건 모두 이미 동기화된 상태)`;
  }

  const out = [];
  const addSection = (icon, title, items, fmt) => {
    if (!items.length) return;
    out.push(`${icon} ${title} — ${items.length}건`);
    items.forEach(d => out.push(fmt(d)));
    out.push('');
  };

  addSection('❌', '실패', failed, d =>
    `   · ${fmtWhen(d.시작)}  ${(d.회원 || '').trim()}\n     ${d.실패}`);

  addSection('🕒', dryRun ? '시간 이동 예정' : '시간 이동됨', moved, d =>
    `   · ${(d.회원 || '').trim()}  ${d.프로그램 || ''}\n     ${d.시간이동}`);

  addSection('✏️', dryRun ? '제목/설명 변경 예정' : '제목/설명 업데이트됨', updated, d =>
    `   · ${fmtWhen(d.시작)}  ${(d.회원 || '').trim()}\n     ${d.새제목 || ''}`);

  addSection('⏭️', '캘린더에 짝이 되는 일정이 없어 건너뜀', skipped, d =>
    `   · ${fmtWhen(d.시작)}  ${(d.회원 || '').trim()}  /  ${d.프로그램 || ''}`);

  if (alreadyOk > 0) out.push(`✅ 이미 동기화됨 — ${alreadyOk}건 (표시 생략)`);

  return out.join('\n').trim();
}

function runSync(dryRun) {
  setStatus(dryRun ? '🔍 미리보기 실행 중... (2주: 이번 주+다음 주)' : '🔄 동기화 중... (2주: 이번 주+다음 주)');
  document.getElementById('resultBox').textContent = '';
  showProgress(0, '시작 중...');

  chrome.runtime.sendMessage({ __bcPopup: 'runSync', dryRun }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus('❌ 오류: ' + chrome.runtime.lastError.message);
      hideProgress();
      return;
    }
    if (!resp || !resp.ok) {
      setStatus('❌ 오류: ' + (resp?.error || '알 수 없음'));
      hideProgress();
      return;
    }

    const s = resp.result.summary;
    const changedCount = (s.details || []).filter(d => d.변경예정).length;
    // 시간 이동: 미리보기는 details에서, 실제 동기화는 summary 카운터에서
    const movedCount = dryRun
      ? (s.details || []).filter(d => d.시간이동).length
      : (s.timeMoved || 0);
    const movedText = movedCount > 0 ? ` · 🕒시간이동=${movedCount}` : '';

    setStatus(
      dryRun
        ? `🔍 미리보기 완료 | 매칭=${s.matched} · 변경예정=${changedCount}${movedText}`
        : `✅ 완료 | 매칭=${s.matched} · 업데이트=${s.updated}${movedText} · 스킵=${s.skipped} · 실패=${s.failed}`
    );

    // 100% 잠깐 보여주고 자연스럽게 숨김
    showProgress(100, dryRun ? '미리보기 완료' : '동기화 완료');
    setTimeout(hideProgress, 1500);

    document.getElementById('resultBox').textContent = renderResult(s.details, dryRun);

    loadLogsAndResult();
  });
}

// ---------- 강사 목록 불러오기 ----------
document.getElementById('refreshCoaches').addEventListener('click', async () => {
  setStatus('⏳ 바디코디 스케줄 읽는 중... (최대 15초)');
  try {
    // 1. 바디코디 탭 확인
    const tabs = await chrome.tabs.query({
      url: 'https://crm.bodycodi.com/manager/schedule/promise*'
    });
    if (tabs.length === 0) {
      const open = confirm('바디코디 개인레슨 스케줄 페이지가 열려있지 않습니다.\n지금 새 탭으로 열까요?');
      if (open) {
        await chrome.tabs.create({ url: BODYCODI_URL });
        setStatus('🌐 바디코디 페이지를 열었습니다. 로그인 후 스케줄이 보이면 다시 "강사 목록 불러오기"를 눌러주세요.');
      } else {
        setStatus('');
      }
      return;
    }

    // 2. scripting으로 직접 스케줄 추출 (2주 prefetch 포함)
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: 'MAIN',
      func: async () => {
        try {
          if (typeof scheduler === 'undefined' || typeof scheduler.getEvents !== 'function') {
            return { ok: false, error: 'scheduler 객체 없음 (스케줄 페이지가 아직 로딩 중일 수 있음)' };
          }

          // 2주 프리페치
          const fetchTwoWeeksEvents = async () => {
            const WAIT_MS = 2500;
            let origDate = null, origMode = 'week';
            try {
              const state = (scheduler.getState && scheduler.getState()) || {};
              origDate = state.date ? new Date(state.date) : null;
              origMode = state.mode || 'week';
            } catch (e) {}
            if (!origDate || typeof scheduler.setCurrentView !== 'function') {
              return scheduler.getEvents();
            }
            const week1 = scheduler.getEvents().slice();
            let week2 = [];
            try {
              const nw = new Date(origDate); nw.setDate(nw.getDate() + 7);
              scheduler.setCurrentView(nw, origMode);
              await new Promise(r => setTimeout(r, WAIT_MS));
              week2 = scheduler.getEvents().slice();
            } catch (e) {}
            try {
              scheduler.setCurrentView(origDate, origMode);
              await new Promise(r => setTimeout(r, 800));
            } catch (e) {}
            const seen = new Set(); const out = [];
            for (const ev of week1.concat(week2)) {
              const id = String(ev.id || ev.seq_schedule || '');
              if (id && !seen.has(id)) { seen.add(id); out.push(ev); }
            }
            return out;
          };

          // 페이지 내 모든 <select> 옵션을 union으로 수집 → 일정 유무와 무관하게 등록 강사 전체 확보
          const coachNameMap = {};
          const SKIP_KEYWORDS = ['전체', '선택', '전부', 'all', 'All'];
          const allSelects = document.querySelectorAll('select');
          for (const sel of allSelects) {
            for (const opt of sel.options) {
              const val = String(opt.value || '');
              const text = String(opt.text || '').trim();
              if (!val || !text) continue;
              if (!/^\d+$/.test(val)) continue;          // 숫자 ID만
              if (parseInt(val) <= 1000) continue;       // 강사 ID는 보통 1000 초과
              if (text.length > 20) continue;            // 너무 긴 텍스트는 제외
              if (SKIP_KEYWORDS.some(k => text.includes(k))) continue;
              // 더 긴 이름이 발견되면 갱신 (예: 다른 select에서 풀네임 발견)
              if (!coachNameMap[val] || text.length > coachNameMap[val].length) {
                coachNameMap[val] = text;
              }
            }
          }

          const events = await fetchTwoWeeksEvents();
          // 일정에서 발견된 강사 ID 보충 (select에 누락된 강사 대비)
          for (const ev of events) {
            const cid = String(ev.section_id || ev.coach_id || '');
            if (cid && !coachNameMap[cid]) {
              coachNameMap[cid] = `(ID:${cid})`;
            }
          }

          // 총횟수/잔여횟수 추출 헬퍼 — 다양한 필드명 패턴 시도
          function getCountField(ev, candidates) {
            for (const k of candidates) {
              const v = ev[k];
              if (typeof v === 'number' && Number.isFinite(v)) return v;
              if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v, 10);
            }
            return null;
          }
          const TOTAL_KEYS = [
            'tot_count','total_count','tot_cnt','total_cnt','tot_use_cnt','total_use_count',
            'totalCount','totCount','totCnt','totalCnt','useTotalCount','contractTotalCount',
            'tot_service_cnt','service_total_count','reservation_total_count'
          ];
          // ⭐ BodyCodi 실제 필드: remainNumber (잔여), useNumber (사용)
          const REMAIN_KEYS = [
            'remainNumber',
            'remain_count','rest_count','remain_cnt','rest_cnt','remain_use_cnt','rest_use_cnt',
            'remainCount','remainCnt','restCount','restCnt','remainUseCount',
            'avail_count','available_count','availableCount','left_count','leftCount'
          ];
          const USE_KEYS = ['useNumber','use_count','used_count','useCount','usedCount','use_cnt','used_cnt'];

          // 진단 데이터 수집
          let _firstEventKeys = null;
          let _firstEventNumericFields = null;
          let _countDiscovery = { withTotal: 0, withRemain: 0, withBoth: 0, total: 0 };
          const toIso = (d) => {
            if (!d || !(d instanceof Date)) return String(d || '');
            const p = n => String(n).padStart(2, '0');
            const tz = -d.getTimezoneOffset();
            const sign = tz >= 0 ? '+' : '-';
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}:${p(Math.abs(tz) % 60)}`;
          };

          const result = events.map((ev, idx) => {
            let memberNo = '', memberName = '';
            const m = /^(\d{2}-\d{3})\s+([^\s\/]+)/.exec((ev.text || '').trim());
            if (m) { memberNo = m[1]; memberName = m[2]; }
            const coachId = String(ev.section_id || ev.coach_id || '');

            // 총횟수/잔여횟수 추출 (background.js와 동일 로직)
            const remainCount = getCountField(ev, REMAIN_KEYS);
            const useCount    = getCountField(ev, USE_KEYS);
            let totalCount    = getCountField(ev, TOTAL_KEYS);
            if (totalCount === null && remainCount !== null && useCount !== null) {
              totalCount = remainCount + useCount;
            }

            // 진단: 첫 이벤트의 모든 키 + 숫자형 필드 dump
            if (idx === 0) {
              _firstEventKeys = Object.keys(ev).sort();
              _firstEventNumericFields = {};
              for (const k of _firstEventKeys) {
                const v = ev[k];
                if (typeof v === 'number' && Number.isFinite(v)) {
                  _firstEventNumericFields[k] = v;
                } else if (typeof v === 'string' && /^-?\d+$/.test(v.trim()) && v.length < 12) {
                  _firstEventNumericFields[k] = '"' + v + '"';
                }
              }
            }
            _countDiscovery.total++;
            if (totalCount  !== null) _countDiscovery.withTotal++;
            if (remainCount !== null) _countDiscovery.withRemain++;
            if (totalCount !== null && remainCount !== null) _countDiscovery.withBoth++;

            return {
              id:          String(ev.id || ev.seq_schedule || ''),
              text:        String(ev.text || ''),
              start:       toIso(ev.start_date),
              end:         toIso(ev.end_date),
              coachId,
              coachName:   coachNameMap[coachId] || coachId,
              memberNo,
              memberName,
              memberId:    String(ev.seq_member || ''),
              serviceName: String(ev.serviceName || ev.service_name || ''),
              status:      String(ev.now_state || ev.status || ''),
              totalCount,
              remainCount
            };
          });

          return {
            ok: true,
            payload: {
              count: result.length,
              events: result,
              coachNameMap,
              _diagnostics: {
                firstEventKeys: _firstEventKeys,
                firstEventNumericFields: _firstEventNumericFields,
                countDiscovery: _countDiscovery
              }
            }
          };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
    });

    const extract = results && results[0] && results[0].result;
    if (!extract || !extract.ok) {
      alert('스케줄 추출 실패: ' + (extract?.error || '알 수 없음'));
      setStatus('');
      return;
    }

    // 3. 강사 목록 추출 — payload.coachNameMap을 우선 사용 (등록된 모든 강사)
    const coachMap = new Map();
    const fullCoachMap = extract.payload.coachNameMap || {};
    for (const [id, name] of Object.entries(fullCoachMap)) {
      if (id && name) coachMap.set(id, name);
    }
    // 보충: 일정 데이터에서 발견된 강사도 추가 (select에 없는 케이스 대비)
    for (const ev of (extract.payload.events || [])) {
      if (ev.coachId && ev.coachName && !coachMap.has(ev.coachId)) {
        coachMap.set(ev.coachId, ev.coachName);
      }
    }
    if (coachMap.size === 0) {
      alert('강사 정보를 찾을 수 없습니다.');
      setStatus('');
      return;
    }

    // 4. 구글 OAuth 토큰
    setStatus('🔑 Google 로그인 중...');
    const tokenResp = await new Promise(resolve =>
      chrome.runtime.sendMessage({ __bcPopup: 'getToken' }, resolve)
    );
    if (!tokenResp || !tokenResp.ok) {
      alert(
        'Google 로그인 실패: ' + (tokenResp?.error || '알 수 없음') +
        '\n\n[해결 방법]\n' +
        '관리자에게 문의해 주세요. (Extension ID 또는 OAuth 설정 문제일 수 있습니다)'
      );
      setStatus('');
      return;
    }
    const token = tokenResp.token;

    // 5. 구글캘린더 목록
    setStatus('📅 캘린더 목록 불러오는 중...');
    const calRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const calData = await calRes.json();
    const calendars = calData.items || [];

    // 6. 저장된 매핑 불러오기
    const { coachCalendarMap = {} } = await chrome.storage.local.get('coachCalendarMap');

    // 7. UI 렌더링
    const area = document.getElementById('mappingRows');
    area.innerHTML = '';

    const sortedCoaches = Array.from(coachMap.entries()).sort((a, b) =>
      a[1].localeCompare(b[1], 'ko')
    );

    let suggestedCount = 0;
    for (const [coachId, coachName] of sortedCoaches) {
      const row = document.createElement('div');
      row.className = 'mapping-row';

      // 우선순위: 저장된 매핑 > 자동 추천 > 미선택
      let preselectedCalId = coachCalendarMap[coachId] || '';
      let isSuggested = false;
      if (!preselectedCalId) {
        const sug = suggestCalendar(coachName, calendars);
        if (sug) {
          preselectedCalId = sug.calendarId;
          isSuggested = true;
          suggestedCount++;
        }
      }

      const label = document.createElement('span');
      label.className = 'coach-label';
      label.textContent = (isSuggested ? '💡 ' : '') + coachName;
      if (isSuggested) {
        label.title = '자동 추천된 매핑입니다. 맞으면 그대로 두고, 다르면 드롭다운에서 변경하세요.';
      }

      const select = document.createElement('select');
      select.dataset.coachId = coachId;

      const optNone = document.createElement('option');
      optNone.value = '';
      optNone.textContent = '-- 캘린더 선택 --';
      select.appendChild(optNone);

      for (const cal of calendars) {
        const opt = document.createElement('option');
        opt.value = cal.id;
        opt.textContent = cal.summary;
        if (preselectedCalId === cal.id) opt.selected = true;
        select.appendChild(opt);
      }

      // 사용자가 수동 변경하면 추천 표시 제거
      if (isSuggested) {
        select.addEventListener('change', () => {
          label.textContent = coachName;
          label.title = '';
        });
      }

      row.appendChild(label);
      row.appendChild(select);
      area.appendChild(row);
    }

    document.getElementById('saveMapping').style.display = 'inline-block';
    setStatus(
      `✅ 강사 ${coachMap.size}명 로드 완료` +
      (suggestedCount > 0 ? ` (💡 ${suggestedCount}명 자동 추천)` : '') +
      '. 확인 후 저장하세요.'
    );

    // 온보딩 step2 완료 표시
    document.getElementById('step2').classList.add('done');
  } catch (e) {
    alert('오류: ' + e.message);
    setStatus('');
  }
});

// ---------- 매핑 저장 ----------
document.getElementById('saveMapping').addEventListener('click', async () => {
  const map = {};
  document.querySelectorAll('#mappingRows select').forEach(sel => {
    if (sel.value) map[sel.dataset.coachId] = sel.value;
  });

  if (Object.keys(map).length === 0) {
    alert('저장할 매핑이 없습니다. 강사별 캘린더를 선택해주세요.');
    return;
  }

  await chrome.storage.local.set({ coachCalendarMap: map });
  setStatus('✅ 매핑 저장 완료! 이제 "지금 동기화"를 눌러보세요.');
  document.getElementById('saveMapping').style.display = 'none';

  // 온보딩 종료 - 동기화 버튼 활성화
  document.getElementById('step3').classList.add('done');
  document.getElementById('syncNow').disabled = false;
  document.getElementById('dryRun').disabled = false;
  document.getElementById('syncNow').title = '';
  document.getElementById('dryRun').title = '';
  setTimeout(() => {
    document.getElementById('onboarding').classList.add('hidden');
  }, 1500);
});

// ---------- 로그 접기/펼치기 (기본: 접힘) ----------
document.getElementById('toggleLogs').addEventListener('click', () => {
  const logs = document.getElementById('logs');
  const btn = document.getElementById('toggleLogs');
  const willShow = logs.classList.contains('hidden');
  logs.classList.toggle('hidden', !willShow);
  btn.textContent = willShow ? '▼ 접기' : '▶ 펼치기';
});

// ---------- 로그 갱신 ----------
function loadLogsAndResult() {
  chrome.runtime.sendMessage({ __bcPopup: 'getLogs' }, (resp) => {
    if (!resp || !resp.ok) return;
    // 50줄까지 표시 (prefetch/진단 로그가 PATCH 로그에 밀리지 않도록)
    document.getElementById('logs').textContent =
      (resp.logs || []).slice(0, 50).join('\n') || '(아직 실행 기록 없음)';
  });
}

// ---------- 상태 표시 ----------
function setStatus(msg) {
  document.getElementById('statusMsg').textContent = msg;
}

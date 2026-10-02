// ================================================
// BodyCodi → Google Calendar Sync
// bc-netlog.js  (⭐ v1.13.1 유효기간 필드 탐지기)
//
// crm.bodycodi.com 페이지가 서버에서 받는 JSON 응답 중, 이용권 정보로 보이는 것
// (잔여/만료/유효/기간 등의 키를 가진 응답)의 "URL + 키 이름 + 날짜/숫자 값"만 기록한다.
// 회원 이름·연락처 같은 문자열 값은 기록하지 않는다.
//
// 목적: 예약 데이터(scheduler 이벤트)에 유효기간이 없을 때, 바디코디의 어느 요청이
//       유효기간을 내려주는지 로그만 보고 알아내기 위함 (개발자도구 없이 확인 가능).
// 동작: fetch / XMLHttpRequest 응답을 가로채 window.__bcNetLog 에 최근 60건을 보관.
//       background.js 가 동기화 때 이 목록을 읽어 📡 로그로 남긴다.
// 주의: 페이지 동작 자체는 바꾸지 않는다 (응답은 그대로 통과).
// ================================================
(() => {
  if (window.__bcNetLog) return;

  const LOG = [];
  const MAX_ENTRIES = 60;
  const MAX_HITS = 40;
  const KEY_RE  = /(remain|expir|valid|limit|deadline|period|만료|유효|종료|잔여)/i;
  const DATE_RE = /^(\d{4})[-.\/]?(\d{2})[-.\/]?(\d{2})(?:[T\s].*)?$/;

  const isDateLike = (v) =>
    (typeof v === 'string' && DATE_RE.test(v.trim())) ||
    (typeof v === 'number' && ((v > 1e12 && v < 4e12) || (v > 1e9 && v < 4e9)));

  // 객체를 깊이 3까지 훑어 KEY_RE에 걸리는 키의 (키경로, 값) 수집 — 값은 날짜형/숫자/불리언만
  function scan(node, depth, prefix, out) {
    if (!node || typeof node !== 'object' || out.length >= MAX_HITS || depth > 3) return;
    if (Array.isArray(node)) { scan(node[0], depth + 1, prefix + '[0]', out); return; }
    for (const k of Object.keys(node)) {
      const v = node[k];
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') { scan(v, depth + 1, path, out); continue; }
      if (!KEY_RE.test(k)) continue;
      if (isDateLike(v) || typeof v === 'number' || typeof v === 'boolean' || v === null) {
        out.push([path, v]);
      } else if (typeof v === 'string' && v.length <= 12 && /^[\d\-.:\/\s~]*$/.test(v)) {
        out.push([path, v]);   // "12", "2026.12.31~" 같은 숫자/날짜 조합만
      }
      if (out.length >= MAX_HITS) return;
    }
  }

  function record(url, method, text) {
    try {
      const t = String(text || '').trim();
      if (!t || !/^[\[{]/.test(t)) return;
      const json = JSON.parse(t);
      const hits = [];
      scan(json, 0, '', hits);
      // 날짜형 값이 하나도 없으면 이용권 정보가 아닐 가능성이 높아 기록 안 함
      if (!hits.some(([, v]) => isDateLike(v))) return;
      let path = String(url || '');
      try { path = new URL(path, location.href).pathname + (new URL(path, location.href).search ? '?…' : ''); } catch (e) {}
      LOG.unshift({ t: Date.now(), method: String(method || 'GET').toUpperCase(), url: path, hits });
      if (LOG.length > MAX_ENTRIES) LOG.length = MAX_ENTRIES;
    } catch (e) { /* JSON 아님 등 — 무시 */ }
  }

  // fetch 가로채기
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      p.then(res => {
        try {
          const ct = res.headers.get('content-type') || '';
          if (!/json|text/i.test(ct)) return;
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const method = (init && init.method) || (input && input.method) || 'GET';
          res.clone().text().then(txt => record(url, method, txt)).catch(() => {});
        } catch (e) {}
      }).catch(() => {});
      return p;
    };
  }

  // XMLHttpRequest 가로채기 (jQuery.ajax 포함)
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open, origSend = XP.send;
  XP.open = function (method, url) {
    this.__bcMethod = method; this.__bcUrl = url;
    return origOpen.apply(this, arguments);
  };
  XP.send = function () {
    this.addEventListener('load', () => {
      try {
        let body = null;
        if (this.responseType === '' || this.responseType === 'text') body = this.responseText;
        else if (this.responseType === 'json' && this.response) body = JSON.stringify(this.response);
        if (body) record(this.__bcUrl, this.__bcMethod, body);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  window.__bcNetLog = LOG;
})();

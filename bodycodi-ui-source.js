'use strict';

// Rendered-UI contract observed 2026-10-14. No scheduler objects, requests,
// cookies, hidden inputs, form writes or save actions. Browser tools must bind
// the semantic driver methods below using their supported UI APIs.
(function (root) {
  const REVISION = 'bodycodi-rendered-pass-2026-10-14';
  const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);
  const compact = text => String(text).replace(/\s+/g, '');
  const visible = el => !!el && el.getClientRects().length > 0;
  const one = (items, reason) => { if (items.length !== 1) throw new Error(reason); return items[0]; };
  const countPattern = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)';
  function count(text) {
    if (!new RegExp(`^${countPattern}(?:회)?$`).test(compact(text))) throw new Error('unsupported-ui-count');
    const n = Number(compact(text).replace(/회$/, '').replace(/,/g, ''));
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('unsupported-ui-count');
    return n;
  }
  function selection(observation) {
    const option = one(observation.selectedOptions, 'ambiguous-selected-pass');
    if (!positiveId(option.value) || option.value !== observation.value) throw new Error('unsupported-selected-pass');
    const usage = {};
    for (const label of ['이용', '잔여', '예약']) {
      const hits = [...String(option.text).matchAll(new RegExp(`${label}\\s*:\\s*(${countPattern})(?:\\s*회)?(?=\\s|/|$|\\))`, 'g'))];
      usage[label] = count(one(hits, 'ambiguous-option-counts')[1]);
    }
    if (!observation.memberName?.trim()) throw new Error('missing-form-member');
    return { passId: option.value, memberName: observation.memberName.trim(), used: usage.이용,
      remaining: usage.잔여, reserved: usage.예약 };
  }
  function memberRoute(url, kind, expectedMemberId, expectedPassId) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://crm.bodycodi.com') throw new Error('unexpected-source-origin');
    const match = parsed.pathname.match(/^\/member\/([1-9]\d*)\/(home|pass)(?:\/([1-9]\d*))?\/?$/);
    if (!match || (kind === 'home' ? match[2] !== 'home' || match[3] :
      kind === 'passes' ? match[2] !== 'pass' || match[3] : match[2] !== 'pass' || !match[3])) throw new Error('unexpected-member-route');
    if (expectedMemberId && match[1] !== expectedMemberId) throw new Error('member-id-mismatch');
    if (expectedPassId && match[3] !== expectedPassId) throw new Error('pass-id-mismatch');
    return { memberId: match[1], passId: match[3] };
  }
  function detail(observation, memberId, passId, program) {
    memberRoute(observation.url, 'detail', memberId, passId);
    const cell = label => one(observation.rows.filter(r => compact(r.label) === label), 'ambiguous-pass-detail').value;
    const total = count(cell('전체횟수'));
    const pair = compact(cell('사용횟수(잔여횟수)')).match(new RegExp(`^(${countPattern})(?:회)?\\((${countPattern})(?:회)?\\)$`));
    if (!pair) throw new Error('unsupported-ui-count');
    const used = count(pair[1]), remaining = count(pair[2]);
    if (used + remaining !== total) throw new Error('inconsistent-ui-counts');
    if (!program?.trim()) throw new Error('missing-pass-program');
    return { id: passId, memberId, program: program.trim(), total, used, remaining, unlimited: false,
      semantics: 'explicit-total-used-remaining-v1' };
  }

  // Optional DOM capture helpers for a binding permitted to read visible DOM.
  // They return only the fields needed for the contract, never whole documents.
  function captureEditForm(doc) {
    const form = one([...doc.querySelectorAll('form#scheduleForm')].filter(visible), 'ambiguous-visible-form');
    const select = one([...form.querySelectorAll('select#productList')].filter(visible), 'ambiguous-product-select');
    const input = one([...form.querySelectorAll('input#member_name')].filter(visible), 'ambiguous-member-input');
    return { value: select.value, memberName: input.value,
      selectedOptions: [...select.selectedOptions].map(o => ({ value: o.value, text: o.text })) };
  }
  function capturePassCards(doc) {
    return [...doc.querySelectorAll('.ticket')].filter(visible).map(card => {
      const ids = [...card.innerText.matchAll(/\bNo\.\s*([1-9]\d*)\b/g)];
      const passId = one(ids, 'ambiguous-card-id')[1];
      const heading = one([...card.querySelectorAll('h4')].filter(visible), 'ambiguous-card-program');
      return { passId, program: heading.innerText.trim() };
    });
  }
  function capturePassDetail(doc, url) {
    const rows = [...doc.querySelectorAll('th')].filter(visible)
      .filter(th => ['전체횟수', '사용횟수(잔여횟수)'].includes(compact(th.innerText)))
      .map(th => {
        const td = th.nextElementSibling;
        if (td?.tagName !== 'TD' || !visible(td)) throw new Error('missing-visible-count-cell');
        return { label: th.innerText, value: td.innerText };
      });
    return { url, rows };
  }
  function validateBooking(observed, expected) {
    if (observed.id !== expected.id || observed.memberName !== expected.memberName ||
        observed.start !== expected.start || observed.end !== expected.end ||
        observed.timeSource !== 'grid-detail') throw new Error('opened-booking-mismatch');
  }

  async function readLinkedPass(driver, expected, { now = Date.now, maxAgeMs = 60000 } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) throw new Error('invalid-source-freshness-bound');
    if (!positiveId(expected.id) || expected.kind !== 'member-reservation' || expected.status !== 'active' ||
        !expected.memberName || !expected.phone || !Number.isFinite(Date.parse(expected.start)) ||
        !(Date.parse(expected.end) > Date.parse(expected.start))) throw new Error('ineligible-booking');
    const captures = [];
    const observed = value => {
      if (value?.authenticated !== true || value.complete !== true || !Number.isFinite(value.capturedAt) ||
          value.capturedAt > now() || now() - value.capturedAt > maxAgeMs) throw new Error('ui-not-fresh-complete');
      captures.push(value.capturedAt); return value;
    };
    validateBooking(observed(await driver.openTimeHeader(expected.id)), expected);
    let selected;
    // Closing is the only permitted form action, including on failed inspection.
    try {
      await driver.openContextAction('예약 내역 수정');
      const form = observed(await driver.observeEditForm());
      if (form.heading !== '개인레슨 이용권 수정하기') throw new Error('unexpected-booking-form');
      // Binding supplies grid/detail identity, NOT the edit form's time controls.
      validateBooking(form.booking, expected);
      selected = selection(form);
      if (selected.memberName !== expected.memberName) throw new Error('form-member-mismatch');
    } finally { await driver.closePopupUnsaved('팝업 닫기'); }
    validateBooking(observed(await driver.openTimeHeader(expected.id)), expected);
    await driver.openContextAction('회원 정보 보기');
    const home = observed(await driver.observeMemberHome());
    const { memberId } = memberRoute(home.url, 'home', expected.memberId);
    if (home.memberName !== expected.memberName) throw new Error('member-page-mismatch');
    await driver.followVisibleLink('이용권');
    const list = observed(await driver.observePassCards());
    memberRoute(list.url, 'passes', memberId);
    const card = one(list.cards.filter(c => c.passId === selected.passId), 'ambiguous-booked-pass-card');
    await driver.openPassDetails(card.passId, '이용권 상세');
    const info = observed(await driver.observePassDetail());
    const pass = detail(info, memberId, selected.passId, card.program);
    if (pass.used !== selected.used || pass.remaining !== selected.remaining) throw new Error('pass-counts-changed-during-read');
    const readAt = Math.min(...captures); // Never relabel older UI observations as fresh.
    if (now() - readAt > maxAgeMs) throw new Error('ui-chain-expired');
    return { schema: 'bodycodi-linked-pass-v1', mappingRevision: REVISION, authenticated: true,
      complete: true, readAt, appointments: [{ ...expected, memberId, memberVerified: true,
        linkedPassId: pass.id, program: pass.program }], passes: [pass] };
  }
  const api = { REVISION, selection, detail, memberRoute, captureEditForm, capturePassCards, capturePassDetail, readLinkedPass };
  if (typeof module !== 'undefined') module.exports = api;
  root.BodyCodiUiSource = api;
})(globalThis);

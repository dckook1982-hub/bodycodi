const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../bodycodi-ui-source');
const E = require('../reservation-enrichment');
const { runEnrichment } = require('../cloud/enrich');
const NOW = Date.parse('2026-10-14T00:00:00Z');
// All identifiers, names and contact details below are synthetic.
const booking = () => ({ id: '900001', memberName: '합성회원', phone: '010-0000-0000',
  kind: 'member-reservation', status: 'active', calendarId: 'test-calendar', googleEventId: 'test-event',
  start: '2026-10-15T05:00:00Z', end: '2026-10-15T06:00:00Z' });
const form = () => ({ value: '900003', memberName: '합성회원',
  selectedOptions: [{ value: '900003', text: '합성 프로그램 (이용:26 / 잔여:13 / 예약:1)' }] });
const info = () => ({ url: 'https://crm.bodycodi.com/member/900002/pass/900003',
  rows: [{ label: '전체횟수', value: '39' }, { label: '사용횟수(잔여횟수)', value: '26(13)' }] });
function harness() {
  let clock = NOW;
  const calls = [];
  const state = { booking: { ...booking(), timeSource: 'grid-detail' },
    form: { ...form(), heading: '개인레슨 이용권 수정하기', booking: { ...booking(), timeSource: 'grid-detail' },
      // Actual UI hazard: editing controls can report a different end; never read these.
      event_etime_hour: '23', event_etime_minute: '00' },
    home: { url: 'https://crm.bodycodi.com/member/900002/home', memberName: '합성회원' },
    cards: { url: 'https://crm.bodycodi.com/member/900002/pass', cards: [
      { passId: '900004', program: '다른 합성 프로그램', total: 7, remaining: 5 },
      { passId: '900003', program: '선택한 합성 프로그램 전체 이름' }] }, detail: info() };
  const observe = key => ({ authenticated: true, complete: true, capturedAt: clock, ...structuredClone(state[key]) });
  const record = (action, fn = () => undefined) => async (...args) => { calls.push([action, ...args]); return fn(...args); };
  const driver = {
    openTimeHeader: record('header', () => observe('booking')),
    openContextAction: record('action'), observeEditForm: record('form', () => observe('form')),
    closePopupUnsaved: record('close'), observeMemberHome: record('home', () => observe('home')),
    followVisibleLink: record('link'), observePassCards: record('cards', () => observe('cards')),
    openPassDetails: record('details'), observePassDetail: record('detail', () => observe('detail'))
  };
  return { state, calls, driver, options: { now: () => clock }, advance: ms => { clock += ms; } };
}
test('rendered source maps selected pass to explicit 39/26/13 and preserves grid times', async () => {
  const h = harness(), s = await U.readLinkedPass(h.driver, booking(), h.options);
  assert.equal(s.mappingRevision, U.REVISION);
  assert.equal(s.appointments[0].end, booking().end);
  assert.equal(s.appointments[0].memberId, '900002');
  assert.equal(s.appointments[0].linkedPassId, '900003');
  const a = E.resolve(s.appointments[0], s.passes);
  assert.equal(a.totalCount, 39); assert.equal(a.usedCount, 26); assert.equal(a.remainCount, 13);
  assert.equal(a.program, '선택한 합성 프로그램 전체 이름');
  assert.deepEqual(h.calls, [['header', '900001'], ['action', '예약 내역 수정'], ['form'],
    ['close', '팝업 닫기'], ['header', '900001'], ['action', '회원 정보 보기'], ['home'],
    ['link', '이용권'], ['cards'], ['details', '900003', '이용권 상세'], ['detail']]);
});
test('two-pass rendered source uses selected 10/6, ignoring first card and aggregate 17/11', async () => {
  const h = harness();
  h.state.booking.aggregateTotal = 17; h.state.booking.aggregateRemaining = 11;
  h.state.form.selectedOptions[0].text = '합성 이용권 (이용:4 / 잔여:6 / 예약:2)';
  h.state.detail.rows[0].value = '10'; h.state.detail.rows[1].value = '4(6)';
  const s = await U.readLinkedPass(h.driver, booking(), h.options), a = E.resolve(s.appointments[0], s.passes);
  assert.equal(a.totalCount, 10); assert.equal(a.remainCount, 6);
});
test('UI normalized snapshot integrates with cloud planning without any writes', async () => {
  const h = harness(), s = await U.readLinkedPass(h.driver, booking(), h.options);
  const report = await runEnrichment({
    source: { readSnapshot: async () => s, readAppointment: async id => {
      assert.equal(id, booking().id); return U.readLinkedPass(h.driver, booking(), h.options);
    } },
    calendar: { get: async () => ({ id: 'test-event', etag: 'synthetic-etag', summary: 'old',
      description: '수동 메모\n총횟수 : 52회\n잔여횟수 : 13회', status: 'confirmed',
      start: { dateTime: booking().start }, end: { dateTime: booking().end },
      extendedProperties: { private: { bcSyncId: booking().id } } }),
      patch: async () => assert.fail('dry-run must never mutate') },
    calendarIds: ['test-calendar'], now: h.options.now, dryRun: true
  });
  assert.equal(report.wouldUpdate, 1); assert.equal(report.updated, 0); assert.equal(report.countUnverified, 0);
});
test('finite zero is supported; unlimited and inferred totals are rejected by UI contract', () => {
  const d = info(); d.rows[0].value = '0회'; d.rows[1].value = '0회 (0회)';
  assert.equal(U.detail(d, '900002', '900003', '합성').total, 0);
  d.rows[0].value = '무제한'; assert.throws(() => U.detail(d, '900002', '900003', '합성'), /unsupported/);
  d.rows.shift(); assert.throws(() => U.detail(d, '900002', '900003', '합성'), /ambiguous/);
});
test('remaining 14 keeps explicit total 39; malformed grouping and inconsistent counts fail', () => {
  const d = info(); d.rows[1].value = '25(14)';
  assert.equal(U.detail(d, '900002', '900003', '합성').total, 39);
  d.rows[0].value = '3,9'; assert.throws(() => U.detail(d, '900002', '900003', '합성'), /unsupported/);
  d.rows[0].value = '40'; assert.throws(() => U.detail(d, '900002', '900003', '합성'), /inconsistent/);
  d.rows[0].value = '1,000'; d.rows[1].value = '600(400)';
  assert.equal(U.detail(d, '900002', '900003', '합성').total, 1000);
});
for (const value of ['-100', '-999', '0', '', '9.1']) test(`selected sentinel/invalid pass ${value} rejected`, () => {
  const f = form(); f.value = value; f.selectedOptions[0].value = value;
  assert.throws(() => U.selection(f), /unsupported-selected-pass/);
});
test('selected pass must be singular and identical to select value; all labeled counts required', () => {
  const f = form(); f.selectedOptions.push({ ...f.selectedOptions[0] });
  assert.throws(() => U.selection(f), /ambiguous-selected-pass/);
  f.selectedOptions.pop(); f.value = '900004'; assert.throws(() => U.selection(f), /unsupported/);
  f.value = '900003'; f.selectedOptions[0].text = '합성 이용:26 / 잔여:13';
  assert.throws(() => U.selection(f), /ambiguous-option-counts/);
});
for (const [name, change, error] of [
  ['overlap opens other booking', h => { h.state.booking.id = '900099'; }, /opened-booking/],
  ['form identity differs', h => { h.state.form.booking.end = '2026-10-15T23:00:00Z'; }, /opened-booking/],
  ['form name differs', h => { h.state.form.memberName = '다른 합성회원'; }, /form-member/],
  ['home name differs', h => { h.state.home.memberName = '다른 합성회원'; }, /member-page/],
  ['wrong list member', h => { h.state.cards.url = 'https://crm.bodycodi.com/member/900099/pass'; }, /member-id/],
  ['wrong detail pass', h => { h.state.detail.url = 'https://crm.bodycodi.com/member/900002/pass/900099'; }, /pass-id/],
  ['wrong detail member', h => { h.state.detail.url = 'https://crm.bodycodi.com/member/900099/pass/900003'; }, /member-id/],
  ['duplicate selected card', h => { h.state.cards.cards.push(h.state.cards.cards[1]); }, /ambiguous-booked-pass-card/],
  ['missing selected card', h => { h.state.cards.cards.pop(); }, /ambiguous-booked-pass-card/],
  ['duplicate count label', h => { h.state.detail.rows.push(h.state.detail.rows[0]); }, /ambiguous-pass-detail/],
  ['session expired', h => { h.state.home.authenticated = false; }, /ui-not-fresh-complete/],
  ['partial cards', h => { h.state.cards.complete = false; }, /ui-not-fresh-complete/],
  ['stale UI', h => { h.state.detail.capturedAt = NOW - 60001; }, /ui-not-fresh-complete/],
  ['counts changed during navigation', h => { h.state.detail.rows[1].value = '25(14)'; }, /pass-counts-changed/]
]) test(`${name}: no normalized writable snapshot`, async () => {
  const h = harness(); change(h);
  await assert.rejects(U.readLinkedPass(h.driver, booking(), h.options), error);
  if (name !== 'overlap opens other booking') assert.equal(h.calls.filter(c => c[0] === 'close').length, 1);
});
test('whole UI chain may not relabel older observations as fresh', async () => {
  const h = harness(), read = h.driver.observePassDetail;
  h.driver.observePassDetail = async () => { h.advance(60001); return read(); };
  await assert.rejects(U.readLinkedPass(h.driver, booking(), h.options), /ui-chain-expired/);
});
test('nonmember and nonpositive duration excluded before any navigation', async () => {
  const h = harness();
  await assert.rejects(U.readLinkedPass(h.driver, { ...booking(), kind: 'notice' }, h.options), /ineligible/);
  await assert.rejects(U.readLinkedPass(h.driver, { ...booking(), end: booking().start }, h.options), /ineligible/);
  assert.deepEqual(h.calls, []);
});
test('origin and complete member route validated; no same-name member substitution', async () => {
  assert.throws(() => U.memberRoute('https://example.invalid/member/900002/home', 'home'), /origin/);
  assert.throws(() => U.memberRoute('https://crm.bodycodi.com/member/900002/home/900003', 'home'), /route/);
  const h = harness();
  await assert.rejects(U.readLinkedPass(h.driver, { ...booking(), memberId: '900099' }, h.options), /member-id/);
});
function element(fields = {}, selectors = {}, shown = true) {
  return { getClientRects: () => shown ? [{}] : [], ...fields,
    querySelectorAll: selector => {
      assert.ok(Object.hasOwn(selectors, selector), `unapproved selector: ${selector}`);
      return selectors[selector];
    } };
}
test('visible DOM captures disabled selected pass and skips hidden duplicate form; no time reads', () => {
  const f = form();
  const select = element({ disabled: true, value: f.value, selectedOptions: f.selectedOptions });
  const input = element({ disabled: true, readOnly: true, value: f.memberName });
  const visibleForm = element({}, { 'select#productList': [select], 'input#member_name': [input] });
  const doc = element({}, { 'form#scheduleForm': [element({}, {}, false), visibleForm] });
  assert.deepEqual(U.captureEditForm(doc), f);
  assert.equal(U.selection(U.captureEditForm(doc)).passId, '900003');
});
test('pass cards and adjacent visible detail cells are captured by documented labels only', () => {
  const card = element({ innerText: '합성 No. 900003 이용권 상세' }, { h4: [element({ innerText: '합성 프로그램' })] });
  assert.deepEqual(U.capturePassCards(element({}, { '.ticket': [card] })), [{ passId: '900003', program: '합성 프로그램' }]);
  const ths = info().rows.map(row => element({ innerText: row.label, nextElementSibling: element({ tagName: 'TD', innerText: row.value }) }));
  const captured = U.capturePassDetail(element({}, { th: ths }), info().url);
  assert.deepEqual(captured, info());
  ths[0].nextElementSibling = element({ tagName: 'TD', innerText: '99' }, {}, false);
  assert.throws(() => U.capturePassDetail(element({}, { th: ths }), info().url), /missing-visible/);
});

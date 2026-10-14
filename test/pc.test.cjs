const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const E = require('../reservation-enrichment');
const W = require('../shared-writer');
const root = path.join(__dirname, '..');
function pcContext(config = {}) {
  const storage = { coachCalendarMap: { coach: 'cal' }, createMissing: false,
    coordinationEvent: { calendarId: 'coord', eventId: 'lock' }, ...config };
  const noop = { addListener() {} };
  const ctx = vm.createContext({ console, Date, URLSearchParams, setTimeout, clearTimeout,
    crypto: { randomUUID }, ReservationEnrichment: E, BodyCodiWriter: W, importScripts() {},
    fetch: async () => { throw new Error('unexpected-fetch'); },
    chrome: { runtime: { getManifest: () => ({ version: '1.18.0' }), onMessage: noop,
      onInstalled: noop, onStartup: noop, sendMessage: async () => {} },
      storage: { onChanged: noop, local: { get: async () => storage, set: async v => Object.assign(storage, v) } },
      tabs: { remove: async () => {} }, alarms: { get: async () => ({ scheduledTime: 1 }), onAlarm: noop },
      scripting: { executeScript: async () => [] } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  return { ctx, storage };
}
test('actual scheduler extraction never interprets useNumber or aggregate badge counts', async () => {
  const { ctx } = pcContext();
  const page = vm.createContext({ Date, document: { querySelectorAll: () => [] },
    scheduler: { getEvents: () => [{ id: 'test', text: '99-001 합성회원 / 010-0000-0000 / 합성 프로그램 39회',
      useNumber: 39, remainNumber: 13, totalCount: 17, section_id: 'coach',
      start_date: new Date('2026-10-15T01:00:00Z'), end_date: new Date('2026-10-15T02:00:00Z') }] } });
  ctx.chrome.scripting.executeScript = async ({ func, args }) => {
    page.args = args; return [{ result: await vm.runInContext(`(${func.toString()})(...args)`, page) }];
  };
  const extracted = await ctx.extractSchedulesFromBodyCodi(1, {
    rangeStart: new Date('2026-10-11'), rangeEnd: new Date('2026-11-08') });
  assert.equal(extracted.events[0].totalCount, null); assert.equal(extracted.events[0].remainCount, null);
  assert.equal(extracted.events[0].countStatus, 'unverified-scheduler-pass-mapping');
});
test('actual PC runSync after cloud enrichment preserves counts and manual notes', async () => {
  const { ctx } = pcContext();
  let lock = { id: 'lock', etag: '1', description: JSON.stringify({ schema: 'bodycodi-writer-v1', owner: '' }) };
  let g = { id: 'event', etag: '1', summary: 'old-title', description: '수동 메모\n총횟수 : 39회\n잔여횟수 : 13회',
    start: { dateTime: '2026-10-15T01:00:00Z' }, end: { dateTime: '2026-10-15T02:00:00Z' },
    extendedProperties: { private: { bcSyncId: 'booking' } } };
  const memberWrites = [];
  ctx.fetch = async (url, options = {}) => {
    const isLock = url.includes('/coord/events/lock');
    const current = isLock ? lock : g;
    if (options.method === 'PATCH') {
      assert.equal(options.headers['If-Match'], current.etag);
      const body = JSON.parse(options.body);
      if (isLock) lock = { ...lock, ...body, etag: String(Number(lock.etag) + 1) };
      else { memberWrites.push(body); g = { ...g, ...body, etag: String(Number(g.etag) + 1) }; }
      return { ok: true, json: async () => structuredClone(isLock ? lock : g) };
    }
    assert.equal(options.method, undefined);
    return { ok: true, json: async () => isLock ? structuredClone(lock) : { items: [structuredClone(g)] } };
  };
  ctx.synthetic = { events: [{ id: 'booking', text: '99-001 합성회원 / 010-0000-0000 / 합성 프로그램',
    memberNo: '99-001', memberName: '합성회원', phone: '010-0000-0000', program: '합성 프로그램',
    start: g.start.dateTime, end: g.end.dateTime, coachId: 'coach', coachName: '합성강사',
    totalCount: null, remainCount: null, countStatus: 'unverified-scheduler-pass-mapping' }],
    _diagnostics: { prefetch: { attempted: true, complete: true, waitModes: ['net'], weekCounts: [1, 1, 1, 1] } } };
  vm.runInContext(`getAuthToken = async () => 'synthetic-token';
    findBodyCodiTab = async () => ({ id: 1 }); openFreshBodyCodiTab = async () => 2;
    extractSchedulesFromBodyCodi = async () => synthetic;
    readNetLogFromBodyCodi = async () => [];
    getSyncRange = () => ({ rangeStart: new Date('2026-10-11'), rangeEnd: new Date('2026-11-08') });`, ctx);
  const first = await ctx.runSync(); assert.equal(first.summary.updated, 1);
  assert.match(g.description, /총횟수 : 39회\n잔여횟수 : 13회/); assert.match(g.description, /^수동 메모/);
  assert.equal(memberWrites.length, 1);
  assert.deepEqual(Object.keys(memberWrites[0]).sort(), ['description', 'extendedProperties', 'summary']);
  assert.equal((await ctx.runSync()).summary.updated, 0);
  assert.equal(memberWrites.length, 1);
  assert.equal(JSON.parse(lock.description).owner, '');
  ctx.synthetic._diagnostics.prefetch.complete = false;
  await assert.rejects(ctx.runSync(), /source-not-fresh-complete/);
  assert.equal(memberWrites.length, 1);
});
test('PC refuses mutations without configured shared coordination', async () => {
  const { ctx } = pcContext({ coordinationEvent: undefined });
  vm.runInContext("getAuthToken = async () => 'synthetic-token';", ctx);
  await assert.rejects(ctx.runSync(), /coordination-not-configured/);
});
test('PC excludes director holds, notices and assessment label without member identifiers', () => {
  const { ctx } = pcContext();
  for (const text of ['원장 센터업무', '공지', '대표원장 동작기능평가']) {
    assert.equal(ctx.isCustomerBooking({ text, isAssessment: true, memberName: '합성' }), false);
  }
});

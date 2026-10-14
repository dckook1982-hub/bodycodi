const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../reservation-enrichment');
const { WriterLock, calendarApi } = require('../shared-writer');
const { runEnrichment } = require('../cloud/enrich');
const copy = v => structuredClone(v);
const NOW = Date.parse('2026-10-14T00:00:00Z');
const appointment = () => ({ id: 'synthetic-booking', memberId: 'synthetic-member', memberNo: '99-001',
  memberName: '합성회원', phone: '010-0000-0000', kind: 'member-reservation', memberVerified: true,
  program: '합성 프로그램', linkedPassId: 'pass-a', calendarId: 'test-calendar', googleEventId: 'test-event',
  status: 'active', start: '2026-10-15T01:00:00Z', end: '2026-10-15T02:00:00Z' });
const pass = (changes = {}) => ({ id: 'pass-a', memberId: 'synthetic-member', program: '합성 프로그램',
  semantics: 'explicit-total-used-remaining-v1', unlimited: false, total: 39, used: 26, remaining: 13, ...changes });
const snapshot = (a = appointment(), passes = [pass()]) => ({ schema: 'bodycodi-linked-pass-v1',
  mappingRevision: 'synthetic-test-only', authenticated: true, complete: true, readAt: NOW, appointments: [a], passes });
const event = () => ({ id: 'test-event', etag: '1', status: 'confirmed', summary: 'old',
  description: '수동 메모\n총횟수 : 52회\n잔여횟수 : 13회\n총횟수 : 20회 (확정)',
  start: { dateTime: appointment().start }, end: { dateTime: appointment().end },
  extendedProperties: { private: { bcSyncId: 'synthetic-booking', other: 'keep' } },
  attendees: [{ email: 'synthetic@example.invalid' }], colorId: '3', location: 'keep' });
function setup(s = snapshot()) {
  const data = new Map([['coord/lock', { id: 'lock', etag: '1', description: JSON.stringify({ schema: 'bodycodi-writer-v1', owner: '' }) }],
    ['test-calendar/test-event', event()]]);
  const writes = [];
  const api = {
    get: async (cal, id) => copy(data.get(`${cal}/${id}`)),
    patch: async (cal, id, body, etag) => {
      const key = `${cal}/${id}`, old = data.get(key);
      if (old.etag !== etag) throw Object.assign(new Error('conflict'), { status: 412 });
      assert.deepEqual(Object.keys(body).filter(k => !['summary', 'description'].includes(k)), []);
      const next = { ...old, ...copy(body), etag: String(Number(old.etag) + 1) };
      data.set(key, next); writes.push({ cal, id, body: copy(body) }); return copy(next);
    }
  };
  const options = { source: { readSnapshot: async () => copy(s), readAppointment: async () => copy(s) },
    calendar: api, coordination: { calendarId: 'coord', eventId: 'lock' }, owner: 'cloud-unique',
    calendarIds: ['test-calendar'], now: () => NOW, dryRun: false };
  return { data, writes, api, options, memberWrites: () => writes.filter(w => w.id === 'test-event') };
}

test('39 total / 26 used / 13 remaining never becomes 52', () => {
  const a = E.resolve(appointment(), [pass()]);
  assert.equal(a.totalCount, 39); assert.equal(a.remainCount, 13); assert.equal(a.usedCount, 26);
});
test('remaining 14 leaves explicit total 39 unchanged', () => {
  assert.equal(E.resolve(appointment(), [pass({ used: 25, remaining: 14 })]).totalCount, 39);
  assert.equal(E.resolve(appointment(), [pass({ remaining: 14 })]).countStatus, 'inconsistent-counts');
});
test('exact linked pass selects 10/6; ignores 7/5 and aggregate 17/11', () => {
  const a = E.resolve({ ...appointment(), totalCount: 17, remainCount: 11 },
    [pass({ total: 10, used: 4, remaining: 6 }), pass({ id: 'pass-b', total: 7, used: 2, remaining: 5 })]);
  assert.equal(a.totalCount, 10); assert.equal(a.remainCount, 6);
});
for (const [label, a, passes] of [
  ['missing link', { ...appointment(), linkedPassId: '' }, [pass()]],
  ['duplicate pass', appointment(), [pass(), pass()]],
  ['wrong member', appointment(), [pass({ memberId: 'other' })]],
  ['unknown semantics', appointment(), [pass({ semantics: 'useNumber-means-unknown' })]],
  ['negative convention', appointment(), [pass({ total: -1 })]]
]) test(`${label}: count no-op`, () => {
  const r = E.resolve(a, passes); assert.equal(r.totalCount, null);
  assert.match(E.description(r, '총횟수 : 52회\n잔여횟수 : 13회'), /총횟수 : 52회\n잔여횟수 : 13회/);
});
test('zero and explicit unlimited have separate conventions', () => {
  assert.equal(E.resolve(appointment(), [pass({ total: 0, used: 0, remaining: 0 })]).totalCount, 0);
  assert.equal(E.resolve(appointment(), [pass({ unlimited: true, total: null, remaining: null })]).totalCount, '무제한');
  assert.equal(E.resolve(appointment(), [pass({ unlimited: true, total: 0, remaining: 0 })]).totalCount, null);
});
test('assessment uses actual used count only for verified next-unconsumed appointment', () => {
  const a = { ...appointment(), isAssessment: true, usagePosition: 'next-unconsumed' };
  assert.equal(E.resolve(a, [pass()]).round, 27);
  assert.equal(E.resolve({ ...a, usagePosition: 'unknown' }, [pass()]).round, null);
  assert.equal(E.resolve({ ...a, explicitRound: 3 }, [pass()]).round, 3);
});
test('preserves annotated notes, marker, whitespace, and unknown values', () => {
  const notes = '  메모\n\n\n[bc-sync:synthetic-booking]\n총횟수 : 20회 (확정)\n총횟수 : 52회';
  const d = E.description(E.resolve(appointment(), [pass()]), notes);
  assert.ok(d.startsWith('  메모\n\n\n[bc-sync:synthetic-booking]\n총횟수 : 20회 (확정)\n총횟수 : 39회'));
  assert.equal(E.description({ totalCount: null }, notes), notes);
});
test('duplicate canonical count lines are left untouched', () => {
  assert.equal(E.description({ totalCount: 39 }, '총횟수 : 52회\n총횟수 : 10회'), '총횟수 : 52회\n총횟수 : 10회');
});
test('cloud writes only summary/description, keeps unrelated fields, retry is idempotent', async () => {
  const h = setup(), before = copy(h.data.get('test-calendar/test-event'));
  const first = await runEnrichment(h.options); assert.equal(first.updated, 1); assert.equal(first.lockReleased, true);
  const after = h.data.get('test-calendar/test-event');
  for (const key of ['id', 'start', 'end', 'attendees', 'extendedProperties', 'location', 'colorId']) assert.deepEqual(after[key], before[key]);
  assert.match(after.description, /총횟수 : 39회/);
  assert.equal((await runEnrichment(h.options)).updated, 0); assert.equal(h.memberWrites().length, 1);
});
test('dry run writes neither member event nor lock', async () => {
  const h = setup(); h.options.dryRun = true;
  assert.equal((await runEnrichment(h.options)).wouldUpdate, 1); assert.equal(h.writes.length, 0);
});
for (const [label, edit] of [
  ['expired session', s => { s.authenticated = false; }],
  ['partial source', s => { s.complete = false; }],
  ['stale source', s => { s.readAt -= 60001; }],
  ['future source', s => { s.readAt += 1; }],
  ['duplicated reservation', s => { s.appointments.push(copy(s.appointments[0])); }]
]) test(`${label}: no member writes`, async () => {
  const s = snapshot(); edit(s); const h = setup(s);
  await assert.rejects(runEnrichment(h.options)); assert.equal(h.memberWrites().length, 0);
});
test('source read exception and appointment re-read failure make no member changes', async () => {
  for (const key of ['readSnapshot', 'readAppointment']) {
    const h = setup(); h.options.source[key] = async () => { throw new Error('session-expired'); };
    await assert.rejects(runEnrichment(h.options)); assert.equal(h.memberWrites().length, 0);
  }
});
test('director hold and notice, even labelled assessment, are excluded positively', async () => {
  const s = snapshot({ ...appointment(), kind: 'notice', isAssessment: true }); const h = setup(s);
  assert.equal((await runEnrichment(h.options)).skipped, 1); assert.equal(h.memberWrites().length, 0);
});
test('same name/time without exact link is never guessed', async () => {
  const h = setup(); delete h.data.get('test-calendar/test-event').extendedProperties;
  h.data.get('test-calendar/test-event').id = 'different-id';
  assert.equal((await runEnrichment(h.options)).conflicts, 1); assert.equal(h.memberWrites().length, 0);
});
test('changed appointment time, calendar, or member blocks mutation', async () => {
  for (const field of ['start', 'calendarId', 'memberId']) {
    const h = setup(); h.options.source.readAppointment = async () => snapshot({ ...appointment(), [field]: 'changed' });
    assert.equal((await runEnrichment(h.options)).conflicts, 1); assert.equal(h.memberWrites().length, 0);
  }
});
test('manual edit between reread and patch is rejected by ETag without retry', async () => {
  const h = setup(), original = h.api.patch;
  h.api.patch = async (cal, id, body, etag) => {
    if (id === 'test-event') { h.data.get(`${cal}/${id}`).etag = '99'; h.data.get(`${cal}/${id}`).description = 'new manual note'; }
    return original(cal, id, body, etag);
  };
  assert.equal((await runEnrichment(h.options)).conflicts, 1);
  assert.equal(h.data.get('test-calendar/test-event').description, 'new manual note');
});
test('simultaneous PC/cloud acquire has exactly one winner', async () => {
  const h = setup();
  const pc = new WriterLock(h.api, h.options.coordination, 'pc', () => NOW);
  const cloud = new WriterLock(h.api, h.options.coordination, 'cloud', () => NOW);
  const results = await Promise.allSettled([pc.acquire(), cloud.acquire()]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await (pc.held ? pc : cloud).release();
});
test('PC lock blocks cloud run even with ancient heartbeat', async () => {
  const h = setup(), pc = new WriterLock(h.api, h.options.coordination, 'pc', () => 1);
  await pc.acquire(); await assert.rejects(runEnrichment(h.options), /writer-busy/);
  assert.equal(h.memberWrites().length, 0); await pc.release();
});
test('uncertain write retains ownership, stops subsequent writes and cloud takeover', async () => {
  const h = setup(), pc = new WriterLock(h.api, h.options.coordination, 'pc'); await pc.acquire();
  await assert.rejects(pc.execute(async () => { throw new Error('network-lost'); }));
  assert.equal(await pc.release(), false);
  await assert.rejects(pc.execute(async () => assert.fail('must not write')), /writer-not-safe/);
  await assert.rejects(runEnrichment(h.options), /writer-busy/);
});
test('HTTP adapter enforces ETag and field allowlist, 401 is explicit', async () => {
  const calls = [];
  const api = calendarApi(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; }, async () => 'synthetic-token');
  await api.patch('c', 'e', { summary: 'x' }, 'etag');
  assert.equal(calls[0].options.headers['If-Match'], 'etag');
  assert.throws(() => api.patch('c', 'e', { start: {} }, 'etag'), /forbidden/);
  assert.throws(() => api.patch('c', 'e', {}, ''), /etag/);
  const expired = calendarApi(async () => ({ ok: false, status: 401 }), async () => 'synthetic-token');
  await assert.rejects(expired.get('c', 'e'), e => e.status === 401);
});
test('source aging during calendar reread prevents write', async () => {
  const h = setup(), get = h.api.get; let now = NOW;
  h.options.now = () => now;
  h.api.get = async (cal, id) => { const e = await get(cal, id); if (id === 'test-event') now += 60001; return e; };
  await assert.rejects(runEnrichment(h.options), /source-not-fresh-complete/);
  assert.equal(h.memberWrites().length, 0);
});
test('lock owner changes before write: no callback and no release of another owner', async () => {
  const h = setup(), pc = new WriterLock(h.api, h.options.coordination, 'pc'); await pc.acquire();
  h.data.get('coord/lock').description = JSON.stringify({ schema: 'bodycodi-writer-v1', owner: 'other' });
  await assert.rejects(pc.execute(async () => assert.fail('must not write')), /writer-lost/);
  assert.equal(await pc.release(), false);
});
test('uncertain acquire is never followed by member write or blind release', async () => {
  const h = setup(), original = h.api.patch;
  h.api.patch = async (...args) => { await original(...args); throw new Error('lost-response'); };
  await assert.rejects(runEnrichment(h.options), /lost-response/);
  assert.equal(h.memberWrites().length, 0);
  assert.equal(JSON.parse(h.data.get('coord/lock').description).owner, 'cloud-unique');
});
test('ambiguous pass still flags count preservation during cloud execution', async () => {
  const h = setup(snapshot(appointment(), [pass(), pass()]));
  const report = await runEnrichment(h.options);
  assert.equal(report.countUnverified, 1);
  assert.match(h.data.get('test-calendar/test-event').description, /총횟수 : 52회/);
});
test('failed run reports confirmed progress without member content', async () => {
  const h = setup(); h.options.source.readAppointment = async () => { throw new Error('read-failed'); };
  await assert.rejects(runEnrichment(h.options), error => {
    assert.equal(error.report.updated, 0); assert.equal(error.report.lockReleased, true);
    assert.ok(!JSON.stringify(error.report).includes('합성회원')); return true;
  });
});

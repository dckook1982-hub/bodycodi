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
  const data = new Map([['coord/lock', { id: 'lock', etag: '1', description: JSON.stringify({ schema: 'bodycodi-writer-v1', owner: '', cloudEnabled: true, activationId: 'synthetic-rollout' }) }],
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
    calendarIds: ['test-calendar'], cloudActivationId: 'synthetic-rollout', now: () => NOW, dryRun: false };
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
  await assert.rejects(runEnrichment(h.options), e => /source-not-fresh-complete/.test(e.message) && e.report.lockReleased === true);
  assert.equal(h.memberWrites().length, 0);
  assert.equal(JSON.parse(h.data.get('coord/lock').description).owner, '');
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
test('differing legacy program line may be a manual note and is preserved', () => {
  const old = '프로그램명 : 과거 프로그램 (원장 확인 필요)\n메모';
  assert.equal(E.description({ program: '새 프로그램' }, old), old);
});
test('leading blank line and CRLF notes survive rendering', () => {
  const old = '\r\n프로그램명 : 합성 프로그램\r\n총횟수 : 52회\r\n수동 메모\r\n';
  assert.equal(E.description({ program: '합성 프로그램', totalCount: 39 }, old),
    '\r\n프로그램명 : 합성 프로그램\r\n총횟수 : 39회\r\n수동 메모\r\n');
});
test('wrong event ID is rejected even when its reservation marker matches', async () => {
  const h = setup(); h.data.get('test-calendar/test-event').id = 'different-event';
  assert.equal((await runEnrichment(h.options)).conflicts, 1);
  assert.equal(h.memberWrites().length, 0);
});
test('invalid, zero and negative duration never match', () => {
  for (const end of ['invalid', appointment().start, '2026-10-14T01:00:00Z']) {
    const a = { ...appointment(), end }, g = event(); g.end.dateTime = end;
    assert.equal(E.matches(a, g), false);
  }
  assert.equal(E.matches(appointment(), null), false);
});
test('NaN/infinite/disabled freshness cannot enable stale data writes', async () => {
  for (const maxAgeMs of [NaN, Infinity, 0, -1, 60001]) {
    const h = setup(); h.options.maxAgeMs = maxAgeMs;
    await assert.rejects(runEnrichment(h.options), /invalid-source-freshness-bound/);
    assert.equal(h.writes.length, 0);
  }
});
test('later source failure retains confirmed progress and retry does not repeat first write', async () => {
  const first = appointment(); const second = { ...appointment(), id: 'booking-two', googleEventId: 'event-two' };
  const s = snapshot(); s.appointments = [first, second]; const h = setup(s);
  const secondEvent = event(); secondEvent.id = 'event-two'; secondEvent.extendedProperties.private.bcSyncId = 'booking-two';
  h.data.set('test-calendar/event-two', secondEvent);
  let failSecond = true;
  h.options.source.readAppointment = async id => {
    if (id === second.id && failSecond) throw new Error('source-lost-mid-run');
    return snapshot(id === second.id ? second : first);
  };
  await assert.rejects(runEnrichment(h.options), error => error.report.updated === 1 && error.report.lockReleased === true);
  assert.equal(h.memberWrites().length, 1);
  failSecond = false;
  const retry = await runEnrichment(h.options); assert.equal(retry.unchanged, 1); assert.equal(retry.updated, 1);
  assert.equal(h.memberWrites().length, 1);
});
test('network error after committed member patch retains lock and prevents unsafe retry', async () => {
  const h = setup(), patch = h.api.patch;
  h.api.patch = async (...args) => {
    const result = await patch(...args);
    if (args[1] === 'test-event') throw new Error('response-lost-after-commit');
    return result;
  };
  await assert.rejects(runEnrichment(h.options), error => error.report.lockReleased === false);
  assert.equal(h.memberWrites().length, 1);
  await assert.rejects(runEnrichment(h.options), /writer-busy/);
  assert.equal(h.memberWrites().length, 1);
});
test('cloud cannot write before explicit remote rollout activation', async () => {
  for (const state of [{}, { cloudEnabled: false }, { cloudEnabled: true, activationId: 'wrong-rollout' }]) {
    const h = setup(); h.data.get('coord/lock').description = JSON.stringify({ schema: 'bodycodi-writer-v1', owner: '', ...state });
    await assert.rejects(runEnrichment(h.options), /cloud-not-activated/); assert.equal(h.writes.length, 0);
  }
  const h = setup(); delete h.options.cloudActivationId;
  await assert.rejects(runEnrichment(h.options), /cloud-not-activated/); assert.equal(h.writes.length, 0);
});
test('read-only cloud planning does not require provisioning or activation', async () => {
  const h = setup(); h.options.dryRun = true;
  delete h.options.cloudActivationId; delete h.options.coordination; delete h.options.owner;
  assert.equal((await runEnrichment(h.options)).wouldUpdate, 1); assert.equal(h.writes.length, 0);
});
test('Calendar GET failure releases lock because no member mutation started', async () => {
  const h = setup(), get = h.api.get;
  h.api.get = async (cal, id) => { if (id === 'test-event') throw new Error('get-network-error'); return get(cal, id); };
  await assert.rejects(runEnrichment(h.options), e => e.report.lockReleased === true);
  assert.equal(h.memberWrites().length, 0);
  h.api.get = get;
  assert.equal((await runEnrichment(h.options)).updated, 1);
});
test('freshness expires during heartbeat: release without attempting mutation', async () => {
  const h = setup(), patch = h.api.patch; let now = NOW; let lockWrites = 0;
  h.options.now = () => now;
  h.api.patch = async (...args) => {
    const result = await patch(...args);
    if (args[1] === 'lock' && ++lockWrites === 2) now += 60001;
    return result;
  };
  await assert.rejects(runEnrichment(h.options), e => e.report.lockReleased === true);
  assert.equal(h.memberWrites().length, 0);
});
test('credential-provider rejection before fetch does not poison member writer', async () => {
  const h = setup(), lock = new WriterLock(h.api, h.options.coordination, 'pc'); await lock.acquire();
  const api = calendarApi(async () => assert.fail('fetch must not start'), async () => { throw new Error('auth-expired'); });
  await assert.rejects(lock.execute(() => api.patch('cal', 'event', { summary: 'x' }, 'etag')), /auth-expired/);
  assert.equal(lock.uncertain, false); assert.equal(await lock.release(), true);
});
test('release uncertainty still reports confirmed member progress', async () => {
  const h = setup(), patch = h.api.patch;
  h.api.patch = async (...args) => {
    if (args[1] === 'lock' && JSON.parse(args[2].description).owner === '') throw new Error('release-network-error');
    return patch(...args);
  };
  await assert.rejects(runEnrichment(h.options), error => error.report.updated === 1 && error.report.lockReleased === false);
  assert.equal(JSON.parse(h.data.get('coord/lock').description).owner, 'cloud-unique');
});
function slowUiSetup() {
  const rows = [1, 2, 3].map(n => ({ ...appointment(), id: `booking-${n}`, googleEventId: `event-${n}` }));
  const h = setup(); let clock = NOW, snapshots = 0; const reads = [];
  for (const a of rows) {
    const g = event(); g.id = a.googleEventId; g.extendedProperties.private.bcSyncId = a.id;
    h.data.set(`test-calendar/${g.id}`, g);
  }
  h.options.now = () => clock;
  h.options.source.readSnapshot = async () => {
    snapshots++; return { ...snapshot(), readAt: clock, appointments: copy(rows) };
  };
  h.options.source.readAppointment = async id => {
    clock += 31000; reads.push(id);
    return { ...snapshot(copy(rows.find(a => a.id === id))), readAt: clock };
  };
  return { ...h, rows, reads, clock: () => clock, snapshots: () => snapshots };
}
test('slow 31-second UI reads reach third appointment; retries do not starve the tail', async () => {
  const h = slowUiSetup();
  assert.equal((await runEnrichment(h.options)).updated, 3);
  assert.equal(h.snapshots(), 2);
  assert.deepEqual(h.reads, ['booking-1', 'booking-2', 'booking-3']);
  const again = await runEnrichment(h.options);
  assert.equal(again.unchanged, 3); assert.equal(again.updated, 0);
  assert.deepEqual(h.reads.slice(3), ['booking-1', 'booking-2', 'booking-3']);
});
test('candidate refresh uses changed tail and excludes newly cancelled reservation', async () => {
  for (const status of ['active', 'cancelled']) {
    const h = slowUiSetup(), read = h.options.source.readSnapshot;
    h.options.source.readSnapshot = async () => {
      if (h.snapshots() === 1) { h.rows[2].memberName = '변경합성회원'; h.rows[2].status = status; }
      return read();
    };
    const result = await runEnrichment(h.options);
    const third = h.data.get('test-calendar/event-3');
    if (status === 'active') { assert.equal(result.updated, 3); assert.match(third.summary, /변경합성회원/); }
    else { assert.equal(result.updated, 2); assert.equal(third.summary, 'old'); assert.equal(result.skipped, 1); }
  }
});
test('next run rechecks earlier changed/cancelled records; no persistent cursor skips them', async () => {
  const h = slowUiSetup(); await runEnrichment(h.options);
  h.rows[0].memberName = '새합성회원'; h.rows[1].status = 'cancelled';
  const secondBefore = copy(h.data.get('test-calendar/event-2'));
  const result = await runEnrichment(h.options);
  assert.equal(result.updated, 1); assert.equal(result.skipped, 1);
  assert.match(h.data.get('test-calendar/event-1').summary, /새합성회원/);
  assert.deepEqual(h.data.get('test-calendar/event-2'), secondBefore);
});
test('refresh never excuses stale detail or partial candidate data', async () => {
  for (const failure of ['detail', 'candidates']) {
    const h = slowUiSetup();
    if (failure === 'detail') {
      const read = h.options.source.readAppointment;
      h.options.source.readAppointment = async id => { const s = await read(id); if (id === 'booking-3') s.readAt -= 60001; return s; };
    } else {
      const read = h.options.source.readSnapshot;
      h.options.source.readSnapshot = async () => { const s = await read(); if (h.snapshots() > 1) s.complete = false; return s; };
    }
    await assert.rejects(runEnrichment(h.options), e => /source-not-fresh-complete/.test(e.message) && e.report.updated === 2 && e.report.lockReleased === true);
    assert.equal(h.data.get('test-calendar/event-3').summary, 'old');
  }
});

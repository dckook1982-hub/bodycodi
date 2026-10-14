'use strict';
const enrichment = require('../reservation-enrichment');
const { WriterLock } = require('../shared-writer');

function assertSnapshot(s, now, maxAgeMs) {
  if (s?.schema !== 'bodycodi-linked-pass-v1' || !s.mappingRevision || s.authenticated !== true ||
      s.complete !== true || !Array.isArray(s.appointments) || !Array.isArray(s.passes) ||
      !Number.isFinite(s.readAt) || s.readAt > now || now - s.readAt > maxAgeMs) throw new Error('source-not-fresh-complete');
  if (new Set(s.appointments.map(a => a.id)).size !== s.appointments.length) throw new Error('duplicate-source-id');
}

// source.readSnapshot/readAppointment must use an approved live off-PC connection.
// No filesystem/browser-profile fallback, source cache, credential provisioning,
// scheduling, event creation/movement/deletion, or full runSync in this runner.
async function runEnrichment({ source, calendar, coordination, owner, calendarIds, cloudActivationId, now = Date.now,
  maxAgeMs = 60000, dryRun = true }) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 60000) throw new Error('invalid-source-freshness-bound');
  if (!Array.isArray(calendarIds) || !calendarIds.length) throw new Error('calendar-allowlist-required');
  if (calendarIds.includes(coordination?.calendarId)) throw new Error('coordination-calendar-must-be-separate');
  if (!dryRun && (typeof cloudActivationId !== 'string' || !cloudActivationId.trim())) throw new Error('cloud-not-activated');
  const lock = dryRun ? null : new WriterLock(calendar, coordination, owner, now, cloudActivationId);
  const report = { updated: 0, unchanged: 0, skipped: 0, conflicts: 0, countUnverified: 0, wouldUpdate: 0 };
  if (!dryRun) await lock.acquire();
  try {
    let snapshot = await source.readSnapshot();
    assertSnapshot(snapshot, now(), maxAgeMs);
    const mappingRevision = snapshot.mappingRevision;
    const processed = new Set(), excluded = new Set();
    const candidatesFrom = s => {
      const targets = new Set(), candidates = [];
      for (const a of s.appointments) {
        if (!enrichment.member(a) || !calendarIds.includes(a.calendarId) || !a.googleEventId) {
          if (!excluded.has(a.id)) { excluded.add(a.id); report.skipped++; }
          continue;
        }
        const key = JSON.stringify([a.calendarId, a.googleEventId]);
        if (targets.has(key)) throw new Error('duplicate-event-link');
        targets.add(key); candidates.push(a);
      }
      return candidates;
    };
    let candidates = candidatesFrom(snapshot);
    while (candidates.some(a => !processed.has(a.id))) {
      // UI detail reads may take tens of seconds. Refresh the candidate list
      // without restarting its prefix; never persist a cursor across runs.
      if (now() - snapshot.readAt > maxAgeMs) {
        snapshot = await source.readSnapshot();
        assertSnapshot(snapshot, now(), maxAgeMs);
        if (snapshot.mappingRevision !== mappingRevision) throw new Error('source-mapping-changed');
        candidates = candidatesFrom(snapshot);
      }
      assertSnapshot(snapshot, now(), maxAgeMs);
      const original = candidates.find(a => !processed.has(a.id));
      if (!original) break;
      processed.add(original.id);
      // A fresh exact appointment read, including its linked pass, before EVERY write.
      const fresh = await source.readAppointment(original.id);
      assertSnapshot(fresh, now(), maxAgeMs);
      if (fresh.mappingRevision !== snapshot.mappingRevision || fresh.appointments.length !== 1) throw new Error('source-mapping-changed');
      const a = fresh.appointments[0];
      if (!enrichment.member(a)) { report.skipped++; continue; }
      if (a.id !== original.id || a.memberId !== original.memberId || a.calendarId !== original.calendarId ||
          a.googleEventId !== original.googleEventId || a.start !== original.start || a.end !== original.end) { report.conflicts++; continue; }
      const resolved = enrichment.resolve(a, fresh.passes);
      if (resolved.countStatus !== 'verified') report.countUnverified++;
      const apply = async () => {
        assertSnapshot(fresh, now(), maxAgeMs);
        const event = await calendar.get(a.calendarId, a.googleEventId);
        if (!event.etag || !enrichment.matches(a, event)) { report.conflicts++; return; }
        const body = enrichment.patch(resolved, event);
        if (!body) { report.unchanged++; return; }
        assertSnapshot(fresh, now(), maxAgeMs);
        if (dryRun) { report.wouldUpdate++; return; }
        try {
          await lock.execute(() => calendar.patch(a.calendarId, event.id, body, event.etag),
            () => assertSnapshot(fresh, now(), maxAgeMs));
          report.updated++;
        }
        catch (e) { if (e.status === 412) { report.conflicts++; return; } throw e; }
      };
      await apply();
    }
    return report;
  } catch (error) {
    // Counts only: no names, phone numbers, source payloads, or event text in reports.
    error.report = report;
    throw error;
  } finally {
    if (!dryRun) {
      try { report.lockReleased = await lock.release(); }
      catch (error) {
        report.lockReleased = false;
        error.report = report;
        throw error;
      }
    }
  }
}
module.exports = { runEnrichment, assertSnapshot };

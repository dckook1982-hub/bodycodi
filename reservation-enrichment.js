'use strict';

// Shared by the extension and the off-PC runner. This is an adapter contract,
// NOT a claim that BodyCodi's scheduler exposes these field names.
(function (root) {
  const integer = v => Number.isSafeInteger(v) && v >= 0;
  const nonempty = v => typeof v === 'string' && v.trim().length > 0;
  function linkedPass(appointment, passes) {
    if (!nonempty(appointment.linkedPassId)) return { ok: false, reason: 'missing-linked-pass' };
    const matches = passes.filter(p => p.id === appointment.linkedPassId && p.memberId === appointment.memberId);
    if (matches.length !== 1) return { ok: false, reason: 'ambiguous-linked-pass' };
    const pass = matches[0];
    if (pass.semantics !== 'explicit-total-used-remaining-v1') return { ok: false, reason: 'unverified-count-semantics' };
    if (pass.unlimited === true) {
      if (pass.total !== null || pass.remaining !== null || !integer(pass.used)) return { ok: false, reason: 'invalid-unlimited-counts' };
    } else if (pass.unlimited !== false || ![pass.total, pass.used, pass.remaining].every(integer) ||
               pass.used + pass.remaining !== pass.total) {
      return { ok: false, reason: 'inconsistent-counts' };
    }
    return { ok: true, pass };
  }

  function resolve(appointment, passes) {
    const selected = linkedPass(appointment, passes);
    const result = { ...appointment, totalCount: null, remainCount: null, usedCount: null,
      validPeriod: null, round: null, countStatus: selected.ok ? 'verified' : selected.reason };
    if (!selected.ok) return result;
    const p = selected.pass;
    result.totalCount = p.unlimited ? '무제한' : p.total;
    result.remainCount = p.unlimited ? '무제한' : p.remaining;
    result.usedCount = p.used;
    if (nonempty(p.program)) result.program = p.program;
    // A used counter alone does not establish whether the appointment is already charged.
    if (appointment.isAssessment && appointment.usagePosition === 'next-unconsumed') result.round = p.used + 1;
    if (appointment.isAssessment && integer(appointment.explicitRound) && appointment.explicitRound > 0) result.round = appointment.explicitRound;
    return result;
  }

  function title(a, existing = '') {
    const base = [a.memberNo, a.memberName, a.phone, a.program].filter(Boolean).join(' ');
    if (!a.isAssessment || /\d+\s*회차/.test(base)) return base;
    const round = a.round ?? existing.match(/(\d+)\s*회차/)?.[1];
    return round == null ? base : `${base} ${round}회차`;
  }

  const countText = v => v === '무제한' ? v : `${v}회`;
  function autoLines(a) {
    return [a.program ? `프로그램명 : ${a.program}` : null,
      a.validPeriod ? `유효기간 : ${a.validPeriod}` : null,
      a.totalCount != null ? `총횟수 : ${countText(a.totalCount)}` : null,
      a.remainCount != null ? `잔여횟수 : ${countText(a.remainCount)}` : null].filter(Boolean);
  }

  // Replace only canonical machine lines for fields we actually know. Unknown
  // counts preserve existing values; annotated/manual lines and whitespace survive.
  function description(a, existing = '') {
    const lines = String(existing).split('\n');
    const specs = [
      [a.program, /^프로그램명\s*:\s*.+$/, v => `프로그램명 : ${v}`],
      [a.validPeriod, /^유효기간\s*:\s*[\d\-./]+(?:\s*~\s*[\d\-./]+)?\s*$/, v => `유효기간 : ${v}`],
      [a.totalCount, /^총횟수\s*:\s*(?:\d+\s*회|무제한)\s*$/, v => `총횟수 : ${countText(v)}`],
      [a.remainCount, /^잔여횟수\s*:\s*(?:\d+\s*회|무제한)\s*$/, v => `잔여횟수 : ${countText(v)}`]
    ];
    for (const [value, re, render] of specs) {
      if (value == null || value === '') continue;
      const indices = lines.flatMap((line, i) => re.test(line.trim()) ? [i] : []);
      // Multiple candidate lines can include manual notes: do not guess ownership.
      if (indices.length > 1) continue;
      if (indices.length === 1) lines[indices[0]] = render(value);
      else lines.push(render(value));
    }
    return lines.join('\n').replace(/^\n(?=프로그램명|유효기간|총횟수|잔여횟수)/, '');
  }

  function member(a) {
    return a.kind === 'member-reservation' && a.memberVerified === true &&
      nonempty(a.memberId) && nonempty(a.id) && nonempty(a.memberName) &&
      nonempty(a.phone) && nonempty(a.program) && a.status === 'active';
  }
  function matches(a, g) {
    const marker = g?.extendedProperties?.private?.bcSyncId;
    // No same-name, same-slot or program-title guesses. Unmarked events need a
    // source-proven Google event ID (adapter must verify the source link).
    const identity = marker === a.id || (!marker && a.googleEventId && a.googleEventId === g?.id);
    const time = v => typeof v === 'string' ? Date.parse(v) : NaN;
    return identity && g.status !== 'cancelled' && !g.recurringEventId &&
      time(a.start) === time(g.start?.dateTime) && time(a.end) === time(g.end?.dateTime);
  }
  function patch(a, g) {
    if (!member(a) || !matches(a, g)) return null;
    const next = { summary: title(a, g.summary), description: description(a, g.description) };
    return next.summary === g.summary && next.description === (g.description || '') ? null : next;
  }
  const api = { linkedPass, resolve, title, autoLines, description, member, matches, patch };
  if (typeof module !== 'undefined') module.exports = api;
  root.ReservationEnrichment = api;
})(globalThis);

'use strict';
(function (root) {
  // One explicitly provisioned, nonmember coordination event shared by ALL
  // writers. Never auto-steal on timeout: a paused request may still commit.
  const SCHEMA = 'bodycodi-writer-v1';
  class WriterLock {
    constructor(api, resource, owner, now = Date.now) {
      if (!resource?.calendarId || !resource?.eventId || !owner) throw new Error('coordination-not-configured');
      Object.assign(this, { api, resource, owner, now, held: false, uncertain: false, inFlight: false });
    }
    async read() {
      const event = await this.api.get(this.resource.calendarId, this.resource.eventId);
      const state = JSON.parse(event.description || '{}');
      if (!event.etag || state.schema !== SCHEMA || typeof state.owner !== 'string' ||
          event.status === 'cancelled') throw new Error('invalid-coordination-resource');
      return { event, state };
    }
    async acquire() {
      const { event, state } = await this.read();
      if (state.owner) throw new Error('writer-busy');
      // An uncertain acquire leaves the remote owner set. No blind retry/release.
      await this.api.patch(this.resource.calendarId, this.resource.eventId,
        { description: JSON.stringify({ schema: SCHEMA, owner: this.owner, heartbeat: this.now() }) }, event.etag);
      this.held = true;
    }
    async heartbeat() {
      if (!this.held || this.uncertain) throw new Error('writer-not-safe');
      const { event, state } = await this.read();
      if (state.owner !== this.owner) { this.held = false; throw new Error('writer-lost'); }
      await this.api.patch(this.resource.calendarId, this.resource.eventId,
        { description: JSON.stringify({ ...state, heartbeat: this.now() }) }, event.etag);
    }
    async execute(write) {
      if (this.inFlight) throw new Error('parallel-write-rejected');
      this.inFlight = true;
      try {
        await this.heartbeat();
        try { return await write(); }
        catch (e) {
          // Only an explicit 4xx rejection proves the member write did not commit.
          if (!(e.status >= 400 && e.status < 500)) this.uncertain = true;
          throw e;
        }
      } finally { this.inFlight = false; }
    }
    async release() {
      if (!this.held || this.uncertain || this.inFlight) return false;
      const { event, state } = await this.read();
      if (state.owner !== this.owner) throw new Error('writer-lost');
      await this.api.patch(this.resource.calendarId, this.resource.eventId,
        { description: JSON.stringify({ schema: SCHEMA, owner: '', heartbeat: this.now() }) }, event.etag);
      this.held = false;
      return true;
    }
  }

  function calendarApi(fetchImpl, getToken) {
    async function request(cal, id, options = {}) {
      const token = await getToken();
      const response = await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`, {
        ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
      if (!response.ok) { const error = new Error(`calendar-http-${response.status}`); error.status = response.status; throw error; }
      return response.json();
    }
    return {
      get: (cal, id) => request(cal, id),
      patch: (cal, id, body, etag) => {
        if (!etag) throw new Error('missing-etag');
        if (Object.keys(body).some(k => !['summary', 'description'].includes(k))) throw new Error('forbidden-calendar-field');
        return request(cal, id, { method: 'PATCH', headers: { 'If-Match': etag }, body: JSON.stringify(body) });
      }
    };
  }
  const api = { WriterLock, calendarApi };
  if (typeof module !== 'undefined') module.exports = api;
  root.BodyCodiWriter = api;
})(globalThis);

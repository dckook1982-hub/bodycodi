# Reservation enrichment: draft implementation and rollout gates

## Status (2026-10-14)

Based on main `0fd0704e53691ad0ce5c8460daa361bdefd764f3` (v1.18.0, PR #12).
No open PR or unmerged competing implementation was found before starting.
This branch is **not a deployable release**. Manifest version stays 1.18.0 to
avoid triggering the existing automatic PC updater. Do not merge/install this
draft as a way to activate unattended operation.

Implemented and tested with synthetic fixtures:

- Shared explicit linked-pass selection and count semantics, description/title
  rendering, and an existing-event-only cloud runner.
- Unknown pass mapping preserves existing counts, with a reason code. It never
  adds `useNumber` to `remainNumber`, uses the member aggregate badge, derives
  a total from a program's advertised package size, or chooses a pass by name.
- PC extraction stops guessing counts. PC/cloud use the same description renderer.
- An explicitly opted-in PC and the cloud runner can participate in a shared
  exclusive writer protocol; this is tested with a mock API only. Existing PC
  installations remain in legacy mode. Cloud member enrichment PATCHes only
  `summary`/`description` with `If-Match`.
- Partial/stale/unauthenticated source reads fail closed. No same-name matching.

**Not implemented/verified:** a live BodyCodi source adapter, authoritative
appointment-to-pass field mapping, a live off-PC Calendar adapter using an
approved connection, provisioned coordination event, fleet rollout, scheduled
execution, cloud deployment, or an end-to-end live run. The supplied PC scheduler
does not expose a verified linked-pass ID. Its raw numeric field names do not
establish semantics. No actual customer data is included in this branch.

## Source adapter contract

`cloud/enrich.js` exports `runEnrichment(options)` (default `dryRun: true`). It
accepts `source.readSnapshot()` and `source.readAppointment(exactReservationId)`.
Both return:

```js
{
  schema: 'bodycodi-linked-pass-v1',
  mappingRevision: 'reviewed-adapter-revision',
  authenticated: true, complete: true, readAt: /* epoch milliseconds */,
  appointments: [], passes: []
}
```

These are OUR normalized names, not claimed BodyCodi API fields. The exact read
must return exactly one appointment and its relevant pass details. Completeness
includes pagination, all requested dates/coaches, and completed UI loading.
`readAt` means completion of a fresh source read, never cache-read time. Default
freshness is 60 seconds, checked again before each write. A login page, missing
field, timeout, or partially loaded page must not be marked complete.

When slow detail reads age the candidate list beyond this bound, the runner reads
a new complete candidate snapshot with the same mapping revision. It retains an
in-memory set of already attempted reservation IDs for that run, so refreshing
does not restart the prefix. Candidate removals/cancellations and changed pending
records are taken from the refreshed list. Every write still requires a fresh
exact detail read and fresh Calendar ETag. No cursor is persisted across runs:
the next run rechecks earlier records too, including subsequent changes/cancellations.
Items already attempted in a run are reconsidered on the next run, not silently
excluded forever. A partial refresh or stale detail stops writes rather than
relaxing freshness. Synthetic 31-second-per-detail tests cover progress to the
third item, repeat-run idempotency and changed/cancelled/stale source cases.

Each appointment needs exact stable `id`, `memberId`, `linkedPassId`,
`calendarId`, `googleEventId`, `start`, `end`, `memberName`, `phone`, `program`,
and `kind: 'member-reservation'`, `memberVerified: true`, `status: 'active'`.
`memberNo` is optional for normalized data. Director center-work holds and notices
must be classified as nonmember even if their text resembles an assessment.
Calendar links must be derived from an exact reservation marker (`bcSyncId`) or
an authoritative source event link, never a name/time/program similarity.
If exact event identity cannot be established, skip it.

Pass records require exact `id`, `memberId`, explicit `total`, `used`,
`remaining`, boolean `unlimited`, and
`semantics: 'explicit-total-used-remaining-v1'`. Finite counts are nonnegative
integers and must satisfy `used + remaining === total`. For unlimited passes,
`total` and `remaining` are null; `used` is still explicit. Zero is finite zero,
not an unlimited sentinel. Convert source sentinels only after verification.
Inconsistent data is flagged and counts are preserved, not repaired by arithmetic.
An assessment round can be explicit or `used + 1` only when the source verifies
`usagePosition: 'next-unconsumed'`; a scheduled visit is not automatically the
next unconsumed visit.

Before writing the adapter, verify in the authenticated cloud UI, read-only:

1. One appointment -> exactly the pass it booked. Record stable field/visible
   identity locations and meaning without retaining member data in GitHub.
2. Synthetic counterpart: 39 total, 26 used, 13 remaining. Changing remaining to
   14 must not turn total into 53; the actual explicit used field must be 25 for
   a consistent 39/25/14 record.
3. Two passes: booked 10/6 plus unrelated 7/5; the member badge's 17/11 is not
   acceptable as appointment counts.
4. Zero/unlimited, assessment charge timing, inactive/cancelled states, and
   nonmember holds. Verify completeness and session-expiry behavior.

The PC raw scheduler extraction deliberately returns null counts until this
adapter is available. This is a safe guardrail, not completed automatic count
correction. A future PC source adapter must call the same `resolve()` function.

## Coordination and conflicts

`shared-writer.js` uses one **separate nonmember coordination event**, explicitly
provisioned by an operator after approval. All PC instances and cloud executions
must point to the SAME `{calendarId, eventId}`. Initial description is:

```json
{"schema":"bodycodi-writer-v1","owner":"","heartbeat":0,"cloudEnabled":false,"activationId":""}
```

No provisioning operation is supplied or executed by this draft. Its ID is stored
as the PC's `coordinationEvent` setting and passed to the cloud runner. PCs opt in
with `coordinationMode: 'coordinated'`; missing settings retain legacy behavior.
After an approved, verified migration of every writer, an operator may set
`cloudEnabled: true` and a unique rollout `activationId`. The cloud runner requires
the same nonempty `cloudActivationId` and checks the remote value before acquiring
ownership and before every mutation. These settings are an activation gate, NOT
proof that a fleet migration actually occurred; retain the fleet verification
record separately. No settings have been changed by this work. This
resource must be excluded from the member calendars/allowlist. Its only changing
field is `description`; member events get only summary/description in cloud mode.
Existing extension OAuth access is sufficient in principle if the user already
has write access to that calendar; no new grant is assumed or requested here.

In the tested adapter, acquisition and heartbeats use ETag compare-and-swap. Each run uses a unique
owner ID. A second contender gets busy or HTTP 412. Every mutation is preceded
by an ownership check/heartbeat, and there is at most one in-flight mutation per
owner. The lock **does not expire or auto-steal**: PC disconnection and an old
heartbeat cannot prove an HTTP request will never commit. A network error/5xx
during member mutation retains ownership and blocks subsequent writers. A
definitive 4xx rejection permits release. Read or pre-write validation failures
also permit release because no member mutation was attempted. Unknown acquisition/release outcomes
are never blindly retried. The next run must read current lock/event state.

Recovery is intentionally manual and requires proving the old writer is stopped
and outstanding requests have settled, then inspecting affected event state
before releasing the lock with an ETag. Merely waiting a fixed timeout is unsafe.
There is no automated recovery/delete-lock action. A crashed client may therefore
block later runs until operator recovery; this is the explicit safety/availability
tradeoff. Do not deploy without an operational recovery procedure.

This protocol only coordinates participating writers. The native BodyCodi Google
sync, old extension builds, and other automations do not participate. Before
activation, inventory them and verify their behavior; they can invalidate this
design if they overwrite the enriched fields. Do not silently disable an integration
or alter permissions. Upgrade/disable every old extension writer only with rollout
approval. An explicitly coordinated `runSync` refuses mutations if its lock is
missing; it never falls back to legacy. Existing installations default to legacy
and remain usable, so cloud MUST remain disabled until every writer is accounted
for. Missing/default legacy settings cannot establish cloud eligibility.

The cloud runner rereads the exact source appointment, then the target event,
matches identity/calendar/time again, and conditionally patches the current ETag.
HTTP 412 is skipped, not retried against a newly edited event. Re-execution with
the same data is a no-op. A later source failure stops the run; earlier confirmed
writes remain, are reported through the caller's error handling, and are safe to
revisit. It is not a cross-calendar transaction. No full `runSync` is called by
cloud code. The existing PC full sync remains broader (create/move/delete) and
must not be used as a live development test.

## Current versus candidate runtime

Current production: Chrome extension, local authenticated BodyCodi scheduler,
local Chrome alarms; requires the PC/browser.

Parent discovery found a candidate dot `create_for_aeon` cloud automation with
an authenticated cloud browser and Calendar connector. This is **a candidate,
not a proven deployment**, and this branch neither replaces it with an invented
host nor claims a missing scheduler. It must be verified to execute the same
validated transformation and writer protocol without delegating to this PC.
No 30-minute cadence has been configured or verified.

The Calendar update tool exposed in this engineering session accepts title and
description but **no ETag / If-Match argument**. Its documented schema therefore
cannot implement the lock's atomic compare-and-swap or protect the final write
from a concurrent manual edit. Parent must verify whether an approved connector
offers conditional writes or another proven single-writer design. A read followed
by an unconditional update is insufficient. Do not extract browser cookies,
tokens, sessions, or invent unsupported background APIs to work around this.
`calendarApi(fetch, getToken)` is tested code for a supported Calendar HTTP API;
it does not obtain or provision credentials. An approved runtime connection
must supply authorization. No credentials are in tests or this repository.

Google's conditional-write semantics are documented at
https://developers.google.com/workspace/calendar/api/guides/version-resources .
Scheduling functionality alone does not establish data access, conditional write
support, nonoverlap, or session renewal.

## Tested rollout sequence and approvals still needed

1. Review this draft and verify the source/identity evidence above. Implement the
   approved live source adapter; keep observations private and fixtures synthetic.
2. Confirm dot execution stays off-PC, supports the shared modules/contract,
   produces complete fresh reads, and stops on auth expiry. Confirm conditional
   Calendar writes through an approved connection. If new persistent credentials,
   OAuth grants, paid infrastructure, or security changes are required, obtain
   action-time approval first.
3. Obtain approval for the exact coordination resource creation and opt-in fleet rollout.
   Inventory all writers, provision one shared resource, configure each client,
   and verify an old/offline PC cannot resume an uncoordinated build. Then explicitly
   activate cloud on the shared resource with the reviewed rollout ID. This draft
   has not installed an extension, changed storage settings, or altered calendars.
4. Run synthetic end-to-end integration tests in the intended cloud runtime and
   an approved read-only dry run against the real source. Compare proposed changes
   privately. Explicitly verify the two-pass case and director-hold exclusion.
5. Obtain approval for the concrete reviewed release/install and a narrowly scoped
   live canary if needed. Never retry the user-cancelled single-event correction.
   No merge, Drive release archive, package installation, live full sync, or live
   canary is authorized by this draft's preparation alone.
6. Verify the canary with all PCs off; then turn on an upgraded PC and confirm it
   does not revert enrichment. Verify session expiry, concurrency, uncertain-write
   recovery, and next-run idempotency. Only then configure the approved schedule
   and report the actual cadence and verified unattended run.

## Validation

`npm test` uses Node's built-in runner (no packages/network). Tests cover the
39/26/13 example, remaining 14, two passes, ambiguous/no link, wrong member,
unknown semantics, inconsistent/zero/unlimited counts, actual-used assessment
rounds, manual notes, exact matching, only summary/description cloud writes,
source/session failures, stale/partial data, ETag conflict, simultaneous owners,
old heartbeat, uncertain writes, idempotency, actual scheduler extraction,
and a mocked actual PC `runSync` that preserves a cloud-corrected 39/13.

`npm run check` syntax-checks extension and new modules. No CI configuration
exists on baseline main; no live-browser extension installation or live calendar
test was performed. No production unattended execution is claimed.

Follow-up review fixed the pre-write failure lock leak, existing assessment round
regression, twin PATCH conflict -> POST fallback, legacy PC migration regression,
ambiguous program-note replacement, wrong event-ID response, and unbounded
freshness configuration. Tests now also cover committed-write response loss,
partial-run retry, explicit cloud activation, and read-only planning without
provisioning. See `source-runtime-path.md` for the next operational evidence.

# Remaining path from tested code to off-PC operation

This is an evidence/authorization plan, not a deployed service. No live source
binding or operational shared lock exists. All code tests use synthetic records.
The parent supplied the sanitized rendered UI contract; its parser and semantic
navigation implementation are in `bodycodi-ui-source.js`. See the
[observed path and remaining binding work](rendered-source-contract.md).

## What the existing repository can and cannot establish

`background.js` reads an in-page `scheduler` object and normalizes reservation
IDs (`id` / `seq_schedule`), rendered text, coach and times. It does not document
an authoritative booked-pass ID. Its old list of numeric key guesses was not a
field-semantics contract. The new code intentionally preserves unknown counts.

`bc-netlog.js` wraps fetch/XHR, samples the first array item, and keeps selected
date/number fields plus truncated URL information. It is a diagnostic interceptor,
not a supported BodyCodi API or a booking/pass join. Its presence in this repo
does not authorize using hidden state/network hooks in the cloud browser. Do not
install it, dump scheduler state, or inspect cookies/tokens to bridge this gap.

README and CLAUDE.md document no public BodyCodi API, export schema, or supported
booking-to-pass lookup endpoint. They cannot establish the relation on their own.
The parent's cloud browser verified the selected `productList` option on a
particular reservation, the member navigation and matching pass detail. That
establishes the rendered booking-to-pass relation; it does not establish an
undocumented scheduler field. No real identifiers are committed here.

## Evidence to preserve in the live binding

The already authenticated cloud browser can perform read-only binding validation.
For the single-pass and two-pass cases, privately verify the following fields and
their rendered locations, including coverage beyond the supplied pass path:

| Evidence | Acceptance condition | On failure |
| --- | --- | --- |
| Reservation identity | Stable booking ID from the selected reservation detail UI; same on reopen | Skip |
| Member identity | Stable member identifier on that reservation and its member/pass detail | Skip; no name join |
| Booked-pass edge | In that reservation detail, the selected/linked pass points to exactly one stable pass ID | Keep counts; flag ambiguous |
| Pass owner | Opened pass belongs to the same stable member identifier | Keep counts |
| Counts | Labels visibly mean total, actual used, remaining for that pass; explicit unlimited convention | Keep counts |
| Program | Program on selected booking/pass, not the member-wide badge or an arbitrary pass row | Preserve uncertain value |
| Visit round | Explicit round or evidence that this booking is the next unconsumed visit | Preserve existing round |
| Classification | UI booking type and member record confirm a member reservation, not a director hold/notice | Skip |
| Time/calendar | Booking start/end, timezone and coach-to-calendar mapping are exact | Skip |
| Google event link | Exact reservation marker or authoritative link to a Google event ID | Skip; no same-name/slot guess |

Also record loading-complete signals, pagination/range coverage, error/login
screen signals and a capture timestamp. Reopen the same appointment immediately
before writing; if its member/pass/time changes, replan or skip. Member-wide
17/11 is never substituted for the selected pass's 10/6. IDs in separate unrelated
screens without a visible linking action are insufficient.

The sanitized selected-pass locator-and-label map is now implemented and tested.
Do not invent missing selectors for candidate enumeration, visible contact data,
classification, event mapping or loading-complete detection. Bind the semantic
driver only through supported browser tools; test it read-only without extracting
credentials or calling an undocumented background endpoint. The edit form's
end-time controls are unreliable and must never replace grid/detail times.

## Runtime options, including a real single-writer alternative

**First candidate: the existing dot cloud automation/browser.** The parent found
`create_for_aeon`; this engineering environment does not expose that tool. Keep
the candidate, but verify in a read-only scheduled test that it opens the existing
cloud BodyCodi session, obtains the complete evidence above, runs the transformation
off-PC, and reports expiry without delegating to the connected PC. A scheduler's
existence does not prove those properties or any particular cadence.

The currently exposed Calendar connector has no `If-Match` input. A second read
before an unconditional update cannot substitute for compare-and-swap. It cannot
operate this implementation's shared lock or protect a manual note edited in the
gap between read and write. No production lock is claimed.

**Exclusive-writer alternative rejected for the current workflow:** staff must
remain able to edit their calendars. Serializing one automation, turning a PC off,
or setting a Boolean cannot prevent concurrent manual edits. Retain conditional
writes; do not promise exclusive ownership or require staff to stop editing as a
workaround. See [the runtime decision](runtime-decision.md) for the two retained
options and their minimum persistent permissions.

**Conditional-write bridge if the existing connector cannot provide it:** a
user-owned Google Apps Script project is a documented cloud runtime candidate.
Google documents [installable triggers](https://developers.google.com/apps-script/guides/triggers/installable),
[script-scoped locks](https://developers.google.com/apps-script/reference/lock/lock-service),
[authorization scopes](https://developers.google.com/apps-script/concepts/scopes), and
[authenticated web-app execution](https://developers.google.com/apps-script/guides/web).
These establish platform capabilities, not a working integration for this task.
Script locks alone do not coordinate PC HTTP writes. Direct Calendar conditional
requests must still use [ETags](https://developers.google.com/workspace/calendar/api/guides/version-resources).
Apps Script also does not inherit the authenticated BodyCodi browser session;
the UI data handoff is a separate required integration.

Before proposing deployment, verify an owner-authenticated way for the dot cloud
browser to submit the normalized records to an Apps Script web UI. Do not deploy
an anonymous write endpoint, share a bearer key, or export a session. If that
authenticated handoff cannot be demonstrated, the bridge remains blocked.

## Minimum external actions, destinations and persistence

No approval is needed for the remaining read-only UI investigation or synthetic
implementation. No external action below has been requested/executed yet.

1. **Source access:** reuse the existing signed-in BodyCodi cloud browser. If it
   expires, the user signs in interactively to `crm.bodycodi.com` in that cloud
   browser. The browser retains its own session; nothing is copied into this PC,
   GitHub, or a script secret store. No new grant is presently justified.
2. **Conditional Calendar connection:** first seek an already authorized connector
   capability. If unavailable and the bridge is chosen, request approval for a
   specifically named owner-only Apps Script project, `BodyCodi reservation
   enrichment`, in the user's Google account. Likely required scopes are
   `calendar.events` and `script.external_request` (confirm from the final manifest).
   Google-managed authorization persists until revoked; never export refresh
   tokens. Persist only code, allowlisted calendar IDs, coordination ID and rollout
   settings in that project; process member snapshots transiently without logging
   payloads. No public endpoint and no paid service is authorized. A concrete
   reviewed manifest/UI implementation must precede the approval request.
3. **PC coexistence:** approve the named extension release/install and explicit
   `coordinationMode: 'coordinated'` plus one `coordinationEvent` on EACH verified
   writer. Default legacy mode remains usable. Offline PCs must be accounted for
   before activation; do not claim that changing one PC migrates the fleet.
4. **Shared control resource:** approve creation of one separate coordination
   calendar/event under the same account, after naming the exact destination and
   any access requirements. Its description stores owner/heartbeat/activation
   metadata persistently, never member data. Creating ACLs or changing permissions
   requires separate specific approval if existing access is insufficient.
5. **Activation and schedule:** only after source, ETag adapter, native-sync behavior
   and fleet tests pass, approve the concrete canary and remote activation ID.
   Then configure the chosen cloud schedule and report actual verified timing.
   Scheduling is persistent until disabled. Do not use the cancelled single-event
   correction as the canary, and do not run live full sync.

If authorization is not needed because an existing approved conditional-write
connection is found, skip the bridge entirely. The next step is supported live
UI binding and connector capability confirmation, not purchasing a server
or asking the user for credentials.

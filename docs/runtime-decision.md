# Runtime decision — pending live bindings and connection verification

**Decision:** retain concurrent manual Calendar editing and conditional writes.
Prefer the existing dot cloud connections if they can expose real ETag-conditional
updates. Otherwise evaluate a private, owner-authenticated Apps Script bridge.
Neither route is operational. The parent delivered the observed booking-detail
to selected-pass UI contract, now covered by `bodycodi-ui-source.js` and synthetic
tests. Binding it to the supported live cloud browser remains a separate step.

| | Existing connections (preferred) | Private Apps Script bridge (fallback) |
| --- | --- | --- |
| Source | Existing authenticated dot cloud BodyCodi browser; rendered UI only | Same browser; Apps Script cannot inherit its session |
| Execution | Proven dot cloud execution, with no connected-PC dependency | Dot browser plus Google-hosted Apps Script; current Node runner needs an adapted/tested server wrapper |
| Calendar conflict safety | Connector must return event ETag and accept actual If-Match with HTTP 412 on conflict | Server-side Calendar HTTP requests with If-Match; script-local lock is additional serialization, not a replacement |
| Blocking fact | Exposed update connector has no If-Match argument | Authenticated browser-to-script UI handoff, owner-only access and module adaptation are not yet demonstrated |
| New persistent grant | None if the existing approved connection gains/has that capability; otherwise stop and reassess | New Google authorization to this named script project, as specified below |
| Operational changes | Approved fleet coordination, control resource and cloud activation after verification | Same, plus approved private project/deployment and Google authorization |

Reading twice or serializing one automation does not prevent a staff edit between
read and PATCH. The proposed exclusive-writer workaround is **rejected for these
editable calendars**; we will not require staff to stop editing or weaken conflict
safety. Native BodyCodi writes and legacy PC versions still need coexistence
verification. ETags prevent concurrent lost updates, not a later stale overwrite
by an unmodified legacy integration.

## Minimum persistent authorization if the bridge is necessary

Destination: a new user-owned project named **BodyCodi reservation enrichment**
at `script.google.com`, with a deployment restricted to that owner. Exact account,
project ID, deployment access and allowed calendars must be shown before approval.
No anonymous/public endpoint, shared bearer key or exported browser session.

1. **Calendar event authorization — choose ONE after verifying ownership:**
   - `https://www.googleapis.com/auth/calendar.events.owned` if every target and
     coordination calendar is owned by the authorizing Google account.
   - Otherwise `https://www.googleapis.com/auth/calendar.events` for writable
     shared calendars. This grants event access beyond a single selected calendar;
     a fixed server-side calendar allowlist and summary/description allowlist
     restrict this application, not the OAuth grant itself.
   Both permit more than this application's PATCH-only use; Google has no scope
   limited to two fields on named existing events. No full `calendar`, ACL,
   calendar-list, or calendar-creation scope is needed for the fixed-ID runtime.
   [Google Calendar scope definitions](https://developers.google.com/workspace/calendar/api/auth).
2. **Outbound HTTP authorization:**
   `https://www.googleapis.com/auth/script.external_request` is needed for
   `UrlFetchApp` to call Calendar with the If-Match header. The implementation must
   restrict outbound requests to the Calendar API; the grant itself is broader.
   [UrlFetchApp authorization](https://developers.google.com/apps-script/reference/url-fetch/url-fetch-app).

The user grants these scopes in Google's authorization UI to the new project.
That Google-managed grant persists across runs while valid; revocation/expiry
must stop processing and request interactive reconnection. A short-lived runtime
token may be used only inside the approved server script, never returned to the
browser, logged, copied to this PC/GitHub, or saved as a script property.
[Apps Script web-app identity and token precautions](https://developers.google.com/apps-script/guides/web).

With dot as the only scheduler, no Apps Script trigger or `script.scriptapp`
authorization is required. No Drive scope is needed to process transient submitted
records. Persist project code, fixed calendar/control IDs and rollout metadata;
do not persist source member payloads or include them in logs. If a separate
coordination calendar is needed, create it only after destination-specific approval
using the existing UI/connection; do not broaden runtime OAuth solely to create it.

## Next gates and user actions

1. Parent supplies sanitized observed UI labels/selectors and booking-to-pass
   relationship evidence. Implement/fixture-test only that observed contract.
2. Parent confirms whether an existing approved connector supports conditional
   writes. Current schema does not; no new grant is justified just to investigate.
3. If it cannot, prepare a concrete private bridge package/manifest and demonstrate
   the supported owner-authenticated handoff before asking to create/authorize it.
   The request must name the Google account, project, exact scopes, deployment
   access, data handling and revocation route. No project or grant is created now.
4. Separately approve coordinated PC rollout/control resource, verify every writer,
   and then test a scoped canary with manual-edit conflict injection and PCs off.
   Only after that configure the verified dot schedule. No cadence is assumed.

Status: implementation draft only; no grant, project, deployment, settings change,
control event, calendar mutation or schedule has been created by this work.

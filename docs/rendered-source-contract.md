# Rendered source contract, 2026-10-14

The parent verified the following read-only path in the authenticated cloud
BodyCodi browser and supplied sanitized locator/label evidence. The implementation
in `bodycodi-ui-source.js` and `test/ui-source.test.cjs` contains synthetic data
only. It is a tested parser/navigation contract, **not a bound live browser driver**.

## Observed path

1. Locate `div.dhx_cal_event[event_id="APPOINTMENT_ID"]` and open its `.dhx_title`
   time header. Do not click `.dhx_body`: overlapping short reservations can open
   the next appointment. Revalidate booking ID, member name, date and start/end.
2. Open `예약 내역 수정`. Confirm heading `개인레슨 이용권 수정하기` and the visible
   `form#scheduleForm`. Read visible `select#productList`, its value and exactly
   one selected option. Disabled controls are still valid visible observations.
   The positive option value is the booked pass ID. `-100` (상담예약) and `-999`
   (OT상품) are unsupported. The selected label's `이용:N / 잔여:R / 예약:B`
   gives used/remaining/reserved; it does **not** contain explicit total.
3. Read visible `input#member_name` and compare the name. It has no stable member
   ID. Close with `팝업 닫기`, without touching any field or pressing `수정하기` /
   `#btnSave`. The driver must close only this form and safely tolerate no form.
4. Reopen the **same** time header and verify identity again. Open `회원 정보 보기`.
   Verify member name and exact URL `/member/MEMBER_ID/home`. This UI navigation
   establishes the booking-to-member edge; a separate name search is forbidden.
5. Follow visible `이용권` to `/member/MEMBER_ID/pass`. Match exactly one visible
   `.ticket` containing `No. PASS_ID`. Read that card's `h4` full program name.
   Open its `이용권 상세`; validate `/member/MEMBER_ID/pass/PASS_ID` against both
   established identifiers. Never use the first ticket or program-name matching.
6. Read visible `th` labels `전체횟수` and `사용횟수(잔여횟수)` with adjacent visible
   `td` values. Require one of each, finite nonnegative integers, and
   `total == used + remaining`. The latter cell is `used(remaining)`. Require
   used/remaining to agree with the selected option observed earlier.

The member-wide badge is an aggregate, never selected-pass evidence. The two-pass
synthetic fixture has selected 10/4/6 and another 7/2/5; aggregate 17/11 is ignored.
Unlimited/missing/ambiguous counts fail closed in this UI adapter until a visible
convention is separately verified. The normalized core supports explicit unlimited
data, but this observed UI path does not yet establish that convention.

## Driver obligations and known hazard

`readLinkedPass(driver, expected, options)` consumes semantic driver methods:
`openTimeHeader`, `openContextAction`, `observeEditForm`, `closePopupUnsaved`,
`observeMemberHome`, `followVisibleLink`, `observePassCards`, `openPassDetails`,
`observePassDetail`. The module makes no requests and has no credential access.
Optional DOM capture helpers read only the selectors above when a supported browser
tool permits rendered DOM reads. They do not constitute permission to use a browser
debugger, inject scripts, dump hidden state, or bypass the browser tool contract.

Every observation must assert authenticated, complete, capturedAt only after the
driver has checked current login/loading/visibility and identity. Reobserve after
rerenders; never supply cached identity as if freshly verified. Form `booking`
identity must come from the same current grid/detail surface. **Never use form time
inputs:** the observed untouched form showed an end of 23:00 while the grid/detail
showed 15:00, and duplicate hidden time inputs also exist. Original grid/detail
start/end are retained unchanged. The minimum capturedAt for the whole chain is
returned as readAt and must still be within 60 seconds. A fresh final screen does
not make earlier observations fresh. If navigation cannot meet this bound, report
the limitation; do not increase the bound or relabel timestamps silently.

## Remaining integration

Bind these semantic operations to the existing supported cloud browser and run a
read-only acceptance test. Implement complete candidate enumeration with all date /
coach coverage, positive member classification, visible contact data, exact Google
event markers and allowlisted calendar mapping. `readLinkedPass` expects those
candidate fields; it does not invent or verify their absent source selectors.
It supplies the single-appointment `source.readAppointment` normalization; no
`source.readSnapshot` browser binding is implemented. Use the same normalized
resolve/render path in PC integration. The current PC guard preserves count lines
when its legacy scheduler extraction cannot establish the linked pass.

No extension was installed, no cloud source was run by this module, no Calendar
event was modified, and no runtime, shared lock or schedule was provisioned.

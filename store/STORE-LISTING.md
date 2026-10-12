# 크롬 웹스토어 입력 문구 (복사해서 붙여넣기용)

웹스토어 개발자 대시보드의 각 칸에 아래 회색 상자 안의 글을 그대로 복사해 붙여 넣으세요.
상자 오른쪽 위의 복사 버튼을 누르면 됩니다.

---

## A. "스토어 등록정보" 탭

**설명 (Description)**

```
바디코디(crm.bodycodi.com) 개인레슨 예약을 강사별 구글 캘린더에 자동으로 맞춰 주는 센터 업무용 확장 프로그램입니다.

주요 기능
• 이번 주부터 4주치 예약의 회원번호·성함·연락처·프로그램명을 구글 캘린더 일정 제목에 반영
• 바디코디에서 예약을 다른 날짜·시간으로 옮기면 캘린더 일정도 같은 시각으로 이동
• 캘린더에 없는 예약은 새 일정으로 생성 (끌 수 있음)
• 일정 설명에 프로그램명·유효기간·총횟수·잔여횟수 자동 기록
• 15분~24시간 중 고른 주기로 평일 09~21시에 자동 실행, "미리보기"로 바뀔 내용을 먼저 확인 가능
• 취소된 예약은 캘린더에서 [취소]·회색으로 표시 (일정은 절대 삭제하지 않음)
• 담당 강사가 바뀌면 일정을 새 강사의 캘린더로 이동

사용 방법
1. 크롬에서 바디코디에 로그인합니다. 동기화할 때 확장이 스케줄 화면을 잠깐 새 탭으로 열어 최신 예약을 읽고 닫습니다.
2. 확장 아이콘 → "강사 목록 불러오기" → 구글 로그인 → 강사별 캘린더 선택 → "매핑 저장".
3. "지금 동기화"를 누르거나 자동 동기화 주기를 고릅니다.

개인정보
예약 정보는 사용자의 브라우저에서 사용자 본인의 구글 캘린더로만 보내지며, 개발자나 제3자 서버로 전송되지 않습니다.
```

**카테고리:** `생산성` → `업무 흐름 및 계획` (Productivity → Workflow & Planning)

**언어:** `한국어`

**그래픽 이미지** (이 폴더 안에 있습니다)

| 칸 | 올릴 파일 |
|---|---|
| 스토어 아이콘 (128×128) | `icons/icon128.png` |
| 스크린샷 (1280×800) | `store/screenshot-1280x800.png` |
| 작은 프로모션 타일 (440×280) | `store/promo-440x280.png` |

스크린샷 속 회원 정보는 모두 가짜 예시입니다.

---

## B. "개인정보 보호" 탭

**단일 목적 (Single purpose)**

```
Syncs appointment information from the BodyCodi schedule page (crm.bodycodi.com) into the user's own Google Calendar events, so that each coach's calendar shows the member and program for every booking.
```

**권한별 사용 이유 (Permission justification)** — 칸 이름에 맞춰 하나씩 붙여 넣으세요.

`storage`
```
Stores the user's settings (coach-to-calendar mapping, auto-sync interval, checkbox state) and a short local activity log. Nothing is sent off the device.
```

`identity`
```
Gets a Google OAuth token through chrome.identity so the extension can read and update events in the user's own Google Calendar.
```

`alarms`
```
Runs the automatic sync at the interval the user selects (15 minutes to 24 hours, weekdays 09:00-21:00) and checks once a minute whether the scheduled sync alarm still exists.
```

`scripting`
```
Runs a read-only script in the open BodyCodi schedule tab to read the appointments shown by the page's scheduler (and to move the page's calendar view forward week by week to read 4 weeks, then restore it).
```

`tabs`
```
Opens the BodyCodi schedule page (crm.bodycodi.com/manager/schedule) in a background tab during each sync so the latest appointments are read, then closes that tab. Also finds an already open BodyCodi schedule tab as a fallback, and opens the page for the user from the popup.
```

호스트 권한 (`https://crm.bodycodi.com/*`, `https://www.googleapis.com/*`)
```
crm.bodycodi.com: read the appointment schedule the user is viewing. www.googleapis.com: call the Google Calendar API to list, update and create events in the user's own calendars. No other hosts are contacted.
```

**원격 코드 사용 (Remote code)**
`아니요, 원격 코드를 사용하지 않습니다` 를 고르세요.

**데이터 사용 (Data usage)** — 아래 두 개만 체크하세요.

- [x] 개인 식별 정보 (Personally identifiable information) — 회원 성함, 연락처
- [x] 웹사이트 콘텐츠 (Website content) — 바디코디 예약 화면의 내용

나머지(건강 정보, 금융 정보, 인증 정보, 개인 통신, 위치, 웹 기록, 사용자 활동)는 체크하지 않습니다.

아래 세 문장에는 모두 체크합니다.

- [x] 승인된 사용 사례를 제외하고 제3자에게 사용자 데이터를 판매하거나 전송하지 않습니다
- [x] 항목의 단일 목적과 관련 없는 목적으로 사용자 데이터를 사용하거나 전송하지 않습니다
- [x] 신용도 판단이나 대출 목적으로 사용자 데이터를 사용하거나 전송하지 않습니다

**개인정보처리방침 URL**
```
https://github.com/dckook1982-hub/bodycodi/blob/main/store/PRIVACY.md
```

---

## C. "배포" 탭

| 항목 | 선택 |
|---|---|
| 결제 | 무료 |
| 공개 범위 (Visibility) | **미등록 (Unlisted)** — 링크를 아는 사람만 설치 가능, 검색에는 안 나옴 |
| 배포 지역 | 모든 지역 (또는 대한민국만) |

> 더 엄격하게 하려면 **비공개 (Private)** 를 고르고 직원 구글 이메일을 "신뢰할 수 있는 테스터"로 넣을 수도 있습니다. 직원이 바뀔 때마다 명단을 고쳐야 하므로 처음에는 미등록을 권합니다.

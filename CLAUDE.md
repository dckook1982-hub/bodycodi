# bodycodi-sync — 작업 규칙 (Claude Code용)

바디코디(crm.bodycodi.com) 예약을 구글 캘린더에 동기화하는 Chrome 확장. 직원 PC는 GitHub `main`의 `manifest.json` 버전을 10분마다 확인해 **더 높을 때만** 자동으로 내려받는다 (`AUTO-UPDATE.ps1`).

## 릴리스 절차 (버전이 바뀌는 모든 변경)

1. `manifest.json`의 `version`을 올린다 (semver). 버전이 같으면 직원 PC에 배포되지 않는다.
2. `README.md`의 "📌 버전" 목록 맨 위에 변경 요약을 추가한다.
3. `node --check background.js popup.js bc-netlog.js` 로 문법 확인. 동기화 로직을 건드렸으면 chrome/fetch를 모킹한 runSync 시뮬레이션으로 검증한다.
4. 작업 브랜치에 커밋·푸시 → `main`으로 PR 생성 → 머지. (main에 올라가야 자동 배포가 시작된다)
5. **Google Drive 버전 아카이브 = ZIP, Claude가 자동 업로드** (원장님 결정): 6·7번의 ZIP 2개를
   ① 공개 저장소의 `release-zips` 브랜치에 커밋·푸시(원장님 승인, main·자동 업데이트와 무관) →
   ② 공개 주소 `https://raw.githubusercontent.com/dckook1982-hub/bodycodi/release-zips/<파일명>`를 내려받아 sha256이 로컬과 같은지 확인 →
   ③ Zapier MCP의 Google Drive **Upload File**(file=그 공개 주소, folder=`1X_SpbZxKQl1NI3zdt1J_TafHi1dp4fUx`, convert=false, **new_name은 넣지 않는다** — 넣으면 `.zip.zip`이 됨)로 올린다 (연결: dckook1982@gmail.com, 기본 연결로 지정됨) →
   ④ Zapier 응답의 `fileSize`·`md5Checksum`이 로컬(`wc -c`·`md5sum`)과 같은지, 파일 이름이 맞는지 확인한다 (이름이 틀리면 Drive MCP `update_file`로 고친다).
   - 아카이브 폴더: https://drive.google.com/drive/folders/1X_SpbZxKQl1NI3zdt1J_TafHi1dp4fUx (ID `1X_SpbZxKQl1NI3zdt1J_TafHi1dp4fUx`). ZIP은 이 폴더 바로 아래에 둔다 (원장님이 v1.18.1·v1.18.2를 이렇게 올림).
   - Drive MCP `create_file`로 ZIP을 base64로 옮겨 적지 않는다 (깨질 위험). Zapier 연결이 없거나 실패하면 ZIP을 첨부하고 원장님께 올려 달라고 안내한다.
   - v1.18.1까지의 `v{version}` 폴더(파일을 푼 상태)는 그대로 둔다.
6. 설치 ZIP(`bodycodi-sync-v{version}.zip`, 최상위 폴더명 `bodycodi-sync`, `.gitignore`·`.claude/` 제외)을 만들어 사용자에게 첨부한다. 자동 배포가 아직 안 잡힌 PC용.
7. **크롬 웹스토어용 ZIP** `bodycodi-sync-store-v{version}.zip`도 만들어 첨부한다. 내용: 최상위에 바로 `manifest.json`(**`key` 줄 제거**), `*.js`, `*.html`, `*.css`, `icons/` — 스크립트·문서·`store/`·`.pem`은 넣지 않는다. 사용자는 대시보드 → 패키지 → 새 패키지 업로드로 올린다.
   - **웹스토어 항목은 이미 있다**: 이름 "BodyCodi → Google Calendar Sync", 항목 ID `heojbjjphafhlepaopagaejebacclfmc`, 상태 "게시됨 - 미등록". 새 항목을 만들지 말고 이 항목에 새 패키지를 올린다 (`MAKE-STORE-ZIP.bat`·개인키 불필요).
   - 이 ID는 unpacked ID(`clgekekmmlpiggplilhgagfkepepjelk`)와 달라서 OAuth 클라이언트가 따로 필요하다. 스토어용 ZIP의 `oauth2.client_id`만 그 클라이언트 ID로 바꾼다 (저장소의 `manifest.json`은 그대로).
   - 스토어용 OAuth 클라이언트 ID: `969122042285-8eeaqe29m3nn1lsqomnlo2rc64qblukn.apps.googleusercontent.com` (v1.17.0부터 스토어용 ZIP에 적용).

## 절대 하지 말 것

- `manifest.json`의 `key` 필드를 바꾸지 않는다 (Extension ID 고정용). `.pem`은 저장소에 넣지 않는다.
- 일정 **삭제는 두 경우만** 한다 (v1.18.0, 원장님 결정): ① 바디코디에서 취소·삭제된 예약의 일정(예약번호 연결 또는 같은 시각·같은 회원), ② 같은 예약의 중복 일정(1개만 남김). 둘 다 최신 데이터(동기화 전용 새 탭)일 때만, "사라짐"은 기존 보류 조건을 모두 통과할 때만. 확장이 만든 적 없는(마커 없는) 고객 일정 중 바디코디에 예약이 없는 것은 **지우지 말고** 📍로 보고만 한다. 회원 정보·프로그램명이 없는 개인 일정(가족일정·회의 등)은 절대 건드리지 않는다.
- 자동 동기화가 오래된 탭 데이터로 실행되게 하지 않는다 (여러 PC가 서로 덮어씀). 최신 데이터는 동기화 전용 새 탭에서 읽는다.
- 모델명·세션 식별자를 커밋 메시지나 코드에 적지 않는다.

## 구조 메모

- `background.js`: 동기화 본체. `SYNC_WEEKS`(기본 4)가 범위. 바디코디는 `openFreshBodyCodiTab`이 연 새 탭에서 읽는다(화면 단위로 넘기며 `bc-netlog`의 요청 완료를 기다림). 모든 매핑 캘린더를 먼저 조회한 뒤 매칭 계획 → 실행. 매칭은 ① 같은 캘린더 예약번호 마커 ② 다른 캘린더 마커(강사 변경 → `events.move`) ③ 시간 ±3분(다른 회원번호면 제외) ④ 회원번호 기준 짝 잃은 일정 재사용. 짝 없으면 생성(`createMissing`). 취소 상태·사라진 예약은 `[취소]` 표시. v1.17.0: 데이터엔 있으나 화면(DOM `[event_id]`)에 안 그려진 예약도 취소로 본다(그 강사의 다른 예약이 그려져 있고 숨김 1건 또는 1/3 이하, 0.4초 후 재확인). "사라짐"은 캘린더별로 판정(그 캘린더 강사 예약이 데이터에 없으면 보류, 50%/최소 5건 대량 보류, 시간초과·못 읽은 주·0건 주는 그 주만 보류 — v1.18.1, 예전엔 시간초과 1회면 전체 보류). v1.18.0: 바디코디 **자체 구글 캘린더 연동**도 같은 캘린더에 일정을 만든다(제목 `회원번호 이름_전화_프로그램 - 프로그램` 또는 `02 집중관절관리 3회차`, 몇 분 늦게 생성). 그래서 예약 1건당 일정 1개만 남기는 중복 정리(`slotTwins`/`sameBookingTitle`)와 생성 직전 재확인을 한다. 바디코디 데이터의 같은 회원·같은 시각 예약 2건은 1건만 반영. 시간 매칭은 같은 예약으로 보이는 제목만(개인 일정 오인 방지). v1.18.2: 쓰기 가능한 매핑 안 된 캘린더도 읽어, 사용자가 옮겨 둔 예약 일정(같은 예약번호 마커 또는 같은 시각·같은 회원키)을 0차로 매칭하고 그 캘린더에서 패치만 한다(이동·생성·삭제 안 함, 강사 캘린더의 같은 예약 일정은 중복 정리). v1.18.3: 처음 본 지 12분 안 된 예약(PC별 `bcFirstSeen`)은 만들지 않고 대기 → 바디코디 연동 일정이 생기면 2차 시간 매칭으로 연결, 없으면 다음 동기화 때 생성(첫 실행은 기준만 잡고 대기 없음). 자동 주기는 `syncIntervalMin`(15~1440분, 평일 09~21시) 하나의 `sync-next` 알람(실행 시 0~20초 분산).
- 검증 스크립트(채팅 세션 scratchpad에 있었음): chrome/fetch 모킹 runSync 시뮬레이션(가짜 scheduler + 가짜 DOM으로 숨김·강사 필터·시간초과 시나리오 포함) + 실제 Chromium에 확장을 올려 가짜 바디코디·가짜 캘린더 API(HTTPS, host-resolver-rules)로 끝까지 실행.
- `bc-netlog.js`: 바디코디 페이지의 서버 응답에서 이용권 유효기간 후보 필드만 기록하는 탐지기 (개인정보 미기록).
- `AUTO-UPDATE.ps1` / `.vbs`, `SETUP-PERMANENT.ps1`, `INSTALL.bat`, `UNINSTALL.bat`: Windows 배포. `.ps1`은 UTF-8 BOM 필수.

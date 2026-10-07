# bodycodi-sync — 작업 규칙 (Claude Code용)

바디코디(crm.bodycodi.com) 예약을 구글 캘린더에 동기화하는 Chrome 확장. 직원 PC는 GitHub `main`의 `manifest.json` 버전을 10분마다 확인해 **더 높을 때만** 자동으로 내려받는다 (`AUTO-UPDATE.ps1`).

## 릴리스 절차 (버전이 바뀌는 모든 변경)

1. `manifest.json`의 `version`을 올린다 (semver). 버전이 같으면 직원 PC에 배포되지 않는다.
2. `README.md`의 "📌 버전" 목록 맨 위에 변경 요약을 추가한다.
3. `node --check background.js popup.js bc-netlog.js` 로 문법 확인. 동기화 로직을 건드렸으면 chrome/fetch를 모킹한 runSync 시뮬레이션으로 검증한다.
4. 작업 브랜치에 커밋·푸시 → `main`으로 PR 생성 → 머지. (main에 올라가야 자동 배포가 시작된다)
5. **Google Drive 버전 아카이브**: 아래 폴더 안에 `v{version}` 폴더를 만들고, 저장소 파일을 **압축 풀린 상태 그대로** 올린다 (`.git`, `.gitignore` 제외, `icons/` 하위 폴더 포함).
   - 폴더: https://drive.google.com/drive/folders/1X_SpbZxKQl1NI3zdt1J_TafHi1dp4fUx (ID `1X_SpbZxKQl1NI3zdt1J_TafHi1dp4fUx`)
   - Google Drive MCP `create_file`로 올릴 때: 텍스트 파일은 `textContent`, PNG·BOM이 있는 `.ps1`은 `base64Content`. **반드시 `disableConversionToGoogleType: true`** (빠뜨리면 PNG가 Google 문서로 변환된다).
   - 업로드 후 응답의 `fileSize`가 로컬 바이트 수(`wc -c`)와 같은지 전부 확인한다.
6. 설치 ZIP(`bodycodi-sync-v{version}.zip`, 최상위 폴더명 `bodycodi-sync`)을 만들어 사용자에게 첨부한다. 자동 배포가 아직 안 잡힌 PC용.

## 절대 하지 말 것

- `manifest.json`의 `key` 필드를 바꾸지 않는다 (Extension ID 고정용). `.pem`은 저장소에 넣지 않는다.
- 구글 캘린더 일정을 **삭제**하는 코드를 넣지 않는다. 바디코디에 없는 일정은 📍로 보고만 한다.
- 모델명·세션 식별자를 커밋 메시지나 코드에 적지 않는다.

## 구조 메모

- `background.js`: 동기화 본체. `SYNC_WEEKS`(기본 4)가 범위. 매칭은 ① 예약번호 마커 ② 시간 ±3분(다른 회원번호면 제외) ③ 회원번호 기준 짝 잃은 일정 재사용 순. 짝 없으면 생성(`createMissing` 설정).
- `bc-netlog.js`: 바디코디 페이지의 서버 응답에서 이용권 유효기간 후보 필드만 기록하는 탐지기 (개인정보 미기록).
- `AUTO-UPDATE.ps1` / `.vbs`, `SETUP-PERMANENT.ps1`, `INSTALL.bat`, `UNINSTALL.bat`: Windows 배포. `.ps1`은 UTF-8 BOM 필수.

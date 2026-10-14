# 개인정보처리방침 — BodyCodi → Google Calendar Sync

시행일: 2026-10-14

이 크롬 확장 프로그램(이하 "확장")은 바디코디(crm.bodycodi.com) 예약 화면의 정보를 사용자의 구글 캘린더에 옮겨 적는 업무용 도구입니다. 센터 직원이 자기 센터의 예약을 관리할 목적으로만 사용합니다.

## 1. 다루는 정보

| 정보 | 어디서 | 왜 |
|---|---|---|
| 예약 정보: 회원번호, 회원 성함, 연락처, 프로그램명, 예약 일시, 담당 강사, 총횟수·잔여횟수, 이용권 유효기간 | 사용자가 로그인해 열어 둔 바디코디 스케줄 화면 | 구글 캘린더 일정의 제목과 설명에 적기 위해 |
| 구글 캘린더 일정과 캘린더 목록 | 사용자 본인의 구글 계정 (Google Calendar API) | 같은 예약의 일정을 찾아 갱신하거나 새로 만들기 위해 |
| 설정값: 강사↔캘린더 연결, 자동 동기화 주기, 체크박스 상태 | 사용자가 팝업에서 선택 | 다음 동기화에 같은 설정을 쓰기 위해 |
| 실행 기록(로그): 동기화 시각, 처리 건수, 바뀐 일정의 회원번호·성함 | 확장 자신 | 문제가 생겼을 때 원인을 확인하기 위해 |

## 2. 보관과 전송

- 예약 정보는 사용자의 브라우저 안에서 읽혀 **사용자 본인의 구글 캘린더로만** 보내집니다.
- 개발자나 제3자의 서버로 보내지 않습니다. 확장에는 별도 서버가 없습니다.
- 설정값과 실행 기록은 사용자의 브라우저 안(chrome.storage.local)에만 저장되며, 실행 기록은 최근 항목만 유지됩니다.
- 확장을 삭제하면 브라우저 안에 저장된 설정값과 실행 기록도 함께 삭제됩니다.
- 구글 로그인 토큰은 크롬이 관리하며 확장은 캘린더 API 호출에만 사용합니다.

## 3. 하지 않는 것

- 정보를 판매하거나 광고·마케팅·신용 평가 목적으로 쓰지 않습니다.
- 분석 도구, 추적 코드, 외부 스크립트를 넣지 않습니다.
- 구글 캘린더 일정은 두 경우에만 삭제합니다: 바디코디에서 취소·삭제된 예약의 일정, 같은 예약의 중복 일정. 회원 정보가 없는 개인 일정은 삭제하지 않습니다. 삭제된 일정은 구글 캘린더 휴지통에서 30일간 복구할 수 있습니다.

## 4. Google API 사용자 데이터 정책 준수

이 확장이 Google API로 받은 정보의 사용과 다른 앱으로의 전송은 제한적 사용 요건을 포함한 [Google API 서비스 사용자 데이터 정책](https://developers.google.com/terms/api-services-user-data-policy)을 따릅니다.

## 5. 문의

크롬 웹스토어 등록 페이지에 표시된 개발자 연락처로 문의해 주세요.

---

## Privacy Policy (English summary)

This extension reads appointment data (member number, name, phone, program, time, coach, session counts, membership expiry) from the BodyCodi schedule page the user has open, and writes it only to the user's own Google Calendar through the Google Calendar API. It deletes a calendar event only when the booking was cancelled or deleted in BodyCodi, or when the event duplicates another event for the same booking. No data is sent to the developer or any third-party server. Settings and a short activity log are stored locally in the browser (chrome.storage.local) and are removed when the extension is uninstalled. Data is never sold, never used for advertising or creditworthiness, and never used for purposes unrelated to the extension's single purpose. Use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.

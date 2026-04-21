# ewoo-hospital - 병동현황관리 시스템

> **공통 아키텍처**: 3프로젝트 통합 맥락(인증 통합, EMR DB 이원화, 치료계획↔EMR 검증 태그 체계 등)은 [INTEGRATION.md](./INTEGRATION.md) 참조.

## 프로젝트 개요
병원 병동 입퇴원 현황, 치료 일정, 상담일지를 실시간으로 관리하는 웹 시스템.

## 기술 스택
- Next.js 14, React 18
- Firebase Realtime Database (client SDK `firebase@10`)
- Firebase Admin SDK (서버/스크립트용)
- MSSQL (`mssql@12`) - EMR DB 직접 연결
- Claude API (raw fetch, model: claude-haiku-4-5-20251001)
- 배포: Vercel

## 관련 프로젝트
| 프로젝트 | 역할 | Firebase 프로젝트 |
|----------|------|-------------------|
| ewoo-hospital | 병동현황, 치료, 상담일지 | ewoo-hospital-ward |
| ewoo-approval | 전자결재, 경영현황 | ewoo-approval |
| ewoo-clinical | 임상서식 (간호라운딩, 바이탈) | ewoo-clinical (Firestore) |

- 3개 프로젝트는 Firebase 프로젝트가 각각 분리되어 있음
- ewoo-clinical은 인증을 ewoo-approval과 공유 (Auth만)
- 공유 데이터: users/profiles만 공유, 나머지는 완전 독립

## EMR 연동 아키텍처

### EMR DB
- 서버: 192.168.0.253:1433 (병원 내부망 SQL Server)
- 인증: SQL Server 인증 (sa)
- **2개 DB 분리**:
  - **BrWonmu** (원무): 청구·수납 확정 데이터. 주요 테이블 Wbedm(병상배치), VIEWJUBLIST(환자마스터), SILVER_PATIENT_INFO(입원이력), Widam(확정 처방), Wodam(외래), Wmomm(약품명)
  - **BrOcs** (진료실, Order Communication System): 의사 입력 원본. 주요 테이블 Oidam(진료실 처방), Oidamsub, Onote(SOAP), Oworkmemo(업무메모), Onotem(의사메모)
- 테이블 대응: `Widam↔Oidam`, `Widamsub↔Oidamsub`, `Wodam↔Oodam` (W=원무, O=OCS)

### DB 선택 기준 (용도별)
| 용도 | 권장 DB·테이블 | 근거 |
|---|---|---|
| 치료계획표 ↔ EMR 비교 (`syncTreatmentEMR.js`) | **BrOcs.Oidam** | RO(반복처방)·미래 예정 오더·당일 입력분까지 실시간 반영 |
| 경영현황 수가·매출 집계 (`syncDirectorStats.js`) | **BrWonmu.Widam** | 청구 확정 기준이 맞음, 미청구 RO 제외해야 과대추정 방지 |
| 소견서·환자 처방이력 (`emr-proxy-server.js` opinion-data, `pages/api/emr/patients.js`) | **BrWonmu.Widam** | 실제 시행·청구된 치료만 포함해야 적절 |

### EMR DB 주의사항
- **BrWonmu.Widam은 청구 확정 시점에 복사되므로** 미래 RO·당일 미확정 오더 누락. 치료계획표 검증용으로 부적합 (2026-04-18 발견)
- **BrOcs.Oidam은 `.` placeholder 레코드 혼재** — `EMR_TO_PLAN` 매핑으로 자동 스킵됨
- 크로스 DB 조인 시 `BrOcs.dbo.Oidam` 형식으로 fully-qualified 참조 가능

### 라즈베리파이 연동
- 병원 내부 네트워크에 라즈베리파이 설치
- syncEMR.js 스크립트를 cron으로 실행하여 EMR DB → Firebase 동기화
- 경량 모드: 매시간 실행 (Phase 1L + Phase 2)
- 전체 모드: 새벽 실행 --full 플래그 (Phase 0~3 전체)
- 라즈베리파이만 EMR DB에 직접 접근 가능 (내부망)

### syncEMR Phase 구성
```
[0]   차트번호 중복 정리 (전체모드)
[0.5] 구형 슬롯 키 마이그레이션 (전체모드)
[1]   환자 마스터 동기화 (경량: 입원환자만 / 전체: 전체)
[2]   병상 배치 동기화 + monthlyBoards 입퇴원 기록
[2.5] 상담일지 자동 연결 (phone/birthYear 매칭)
[2.6] 입원 환자 consultation 상태 업데이트
[3]   과거 입원이력 동기화 (전체모드)
```

### 검증 스케줄러 (2원화)
- **EMR 검증** — 라즈베리파이 cron `scripts/syncTreatmentEMR.js`, 10분마다. 치료계획 ↔ EMR(BrOcs.Oidam) 비교해 `item.emr` 태그 갱신
- **치료실 검증** — **Firebase Cloud Functions** `functions/index.js > scheduledTreatmentRoomSync`, 매일 20:00 Asia/Seoul. 당일 치료실(physicalSchedule/hyperthermiaSchedule) 미반영 pain/manip1/manip2/hyperthermia에 `item.room:"removed"` 태깅. RPi 의존성 없음
- 수동 복구용: `scripts/syncTreatmentRoom.js` (과거 백필·스케줄러 실패 복구용)
- 두 스케줄러는 서로의 태그를 보존하며 금액·UI·EMR 검증에서 각각 제외 처리됨 (자세한 규칙은 INTEGRATION.md 4장 참고)

### Firebase Cloud Functions 배포
- 루트 `firebase.json`, `.firebaserc`(default=ewoo-hospital-ward), `functions/` 디렉토리
- 배포: `cd functions && npm install && firebase deploy --only functions`
- 전제: ewoo-hospital-ward 프로젝트가 Blaze 플랜이어야 함

## Claude Code 제한사항

### Firebase DB 직접 확인 불가
- Claude Code는 Firebase에 인증할 수 없어 DB 데이터를 직접 조회/검증할 수 없음
- 데이터 구조나 값을 확인해야 할 때는 사용자에게 요청하거나, 코드 로직에서 추론해야 함
- Firebase Rules, 실제 데이터 상태, 인덱스 설정 등을 직접 확인할 방법이 없음
- 개선 방향: Firebase 데이터를 조회할 수 있는 API 엔드포인트나 스크립트를 만들면 Claude Code가 간접적으로 확인 가능

### EMR DB 직접 확인 불가
- EMR DB는 병원 내부망(192.168.0.253)에 있어 외부 접근 불가
- 라즈베리파이를 통해서만 접근 가능
- EMR 테이블 구조나 데이터를 확인해야 할 때는 사용자에게 요청해야 함

## Firebase 데이터 구조
- `slots/{roomId}-{bedNum}`: 병상 데이터 (current, reservations)
- `patients/{normChart}`: 환자 마스터 (chartNo 10자리 0패딩 키)
- `patientByChartNo/{normChart}`: 차트번호 → internalId 인덱스
- `patientByPhone/{digits}`: 전화번호 → internalId 인덱스
- `consultations/{id}`: 상담일지
- `treatmentPlansV2/{patientId}/{admissionKey}/{YYYY-MM}/{day}`: 치료 계획 (patient-keyed, 2026-04-21 전환)
- `weeklyPlansV2/{patientId}/{admissionKey}`: 주N회 치료 계획
- `admissionPlansV2/{patientId}/{admissionKey}`: 입원 기간 총 N회 치료 계획 (주N회보다 우선 적용, 5종 한정)
- `treatmentPlans/{slotKey}/...` (구): 2026-04-21 이전 스키마. patient-keyed V2 전환 후 백업(`_backup_2026-04-21_1753/`)만 보존. 이후 제거 예정.
- `admissionKey`: 입원일을 `YYYY-MM-DD`로 정규화한 값. 재입원 시 에피소드 분리용.
- `monthlyBoards/{YYYY-MM}/{YYYY-MM-DD}`: 월간 입퇴원 기록
- `dailyBoards/{YYYY-MM-DD}`: 일일 현황판
- `physicalSchedule/`, `hyperthermiaSchedule/`: 치료실 일정
- `logs`: 변경 이력 (최대 200건)
- `settings`: 치료사 이름 등

## 병동 구조 (WARD_ROOMS)
- 2병동: 201(4인), 202(1인), 203(4인), 204(2인), 205(6인), 206(6인)
- 3병동: 301(4인), 302(1인), 303(4인), 304(2인), 305(2인), 306(6인)
- 5병동: 501(4인), 502(1인), 503(4인), 504(2인), 505(6인), 506(6인)
- 6병동: 601(6인), 602(1인), 603(6인)

## 페이지 구성
- `pages/index.js` - 병동 현황 메인
- `pages/room.js` - 병실 상세 (입퇴원 관리)
- `pages/treatment.js` - 치료계획표 (병실료 자동계산)
- `pages/daily.js` - 일일 치료 일정
- `pages/therapy.js` - 통합 치료실
- `pages/consultation.js` - 상담일지
- `pages/monthly.js` - 월간 입퇴원 예정표
- `pages/daily-board.js` - 일일 현황판
- `pages/ward-timeline.js` - 병동 타임라인
- `pages/patients.js` - 환자 DB + 데이터 진단
- `pages/settings.js` - 설정

## API 엔드포인트
- `POST /api/naver-works-send` - 네이버 웍스 봇으로 공지 메시지 단방향 발송 (치료계획 입력 완료 알림 등)
- `POST /api/inquiry` - 외부 웹사이트 문의 접수

## 주요 규칙
- 입원 예약 자동 승격: admitDate < today (당일 미포함, 과거만) — index.js, room.js 양쪽 동일 로직
- normName(): 동명이인 숫자(이현주5) 보존 필수
- parseMD: YYYY-MM-DD, M/D 두 형식 모두 지원
- monthlyBoards frozen 데이터: syncEMR이 기록, monthly.js는 당일만 live 병합

## MCP 서버 연동 (.mcp.json)
- **firebase**: `@gannonh/firebase-mcp` (서비스 계정 키 방식, ewoo-hospital-ward 프로젝트)
- **github**: stdio 방식 (`@modelcontextprotocol/server-github`, PAT 인증)
- **playwright**: `@playwright/mcp` (브라우저 자동화/테스트)
- **vercel**: HTTP 방식 (`mcp.vercel.com`, OAuth 인증)

## 인증
- Email/Password (이름@ewoo.com 형식)
- 비밀번호 변경 시 모든 기기 강제 로그아웃 (userPwChangedAt)

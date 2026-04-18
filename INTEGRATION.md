# 이우병원 3-프로젝트 통합 아키텍처

> 이 문서는 `ewoo-hospital`, `ewoo-clinical`, `ewoo-approval` 3개 프로젝트에 동일하게 배포됨.
> 인증·데이터 소스·배포의 공통 맥락을 담당 개발자가 빠르게 파악하기 위한 것이다.

## 1. 프로젝트 구성

| 프로젝트 | 역할 | Firebase 프로젝트 | 주 DB |
|---|---|---|---|
| **ewoo-approval** | 전자결재·경영현황·사용자 프로필·**통합 인증 마스터** | `ewoo-approval` | RTDB |
| **ewoo-hospital** | 병동현황·치료계획표·상담일지 | `ewoo-hospital-ward` | RTDB |
| **ewoo-clinical** | 임상서식 (의과·간호과 라운딩, 바이탈 등) | `ewoo-clinical` | Firestore |

관계:
- 사용자 인증은 `ewoo-approval` Auth가 **소스 오브 트루스**
- 프로필(부서·권한)은 `ewoo-approval` RTDB `/users/{emailKey}` 경로
- 각 프로젝트의 업무 데이터는 **해당 프로젝트 DB에 독립 저장**

## 2. 통합 인증 아키텍처 (2026-04-18 통합)

### 원리: Dual Auth Session
각 프로젝트는 로그인 시 **두 개의 Firebase Auth 세션**을 병행 유지한다:
- `auth` (**approval** Auth) — 사용자 신원·프로필 조회의 단일 진실. 비밀번호 변경의 주체.
- `wardAuth` (**ward** Auth) — `ewoo-hospital-ward` RTDB security rules(`auth != null`) 통과용. read-only 세컨드 세션.

`ewoo-approval` 자신은 ward 세션 불필요 (결재 시스템은 ward DB 안 씀).

### 로그인 플로우 (`ewoo-hospital`, `ewoo-clinical`)
```
[사용자 입력]
    ↓
Promise.all([
  signInWithEmailAndPassword(approvalAuth, email, pw),
  signInWithEmailAndPassword(wardAuth,     email, pw),
])
    ↓
양쪽 성공? → 완료
    ↓
한쪽만 성공 → /api/auth/migrate 호출 (양방향 동기화)
    ↓
서버: approval/ward REST API로 인증 시도
    ├─ 한쪽만 성공 → Admin SDK로 반대쪽 계정 생성/비밀번호 업데이트
    └─ 양쪽 실패  → 401
    ↓
재시도 signIn → 완료
```

### 비밀번호 변경
- `approval` Auth에서만 변경
- 다음 로그인 시 ward 측 동기화는 `migrate` API가 자동 처리
- `ewoo-hospital`만 `userPwChangedAt` 기반 강제 로그아웃 유지 (ward RTDB `userPwChangedAt/{uid}`)

### 자동 마이그레이션 사용 사례
- **신규 직원**: 관리자가 어느 한 시스템에만 계정 생성해도 첫 로그인 시 다른 쪽 자동 생성
- **비밀번호 불일치**: 한쪽에서 PW 변경했는데 다른 쪽 미동기화 시 자동 복구
- **부분 복구**: 한쪽 Auth에서 실수로 삭제된 계정은 반대쪽으로부터 복원

### Firebase Admin SDK 요구사항 (Vercel 환경변수)
| 키 | 값 출처 | 필요 프로젝트 |
|---|---|---|
| `FIREBASE_*` | 해당 프로젝트 자체 서비스 계정 | 모두 |
| `APPROVAL_FIREBASE_*` | `serviceAccount-new.json` (approval) | hospital, clinical |
| `WARD_FIREBASE_*` | `serviceAccount-old.json` (ward) | clinical, (필요시 approval) |

`serviceAccount-new.json` / `serviceAccount-old.json`은 `ewoo-approval` 레포 로컬에만 보관. Vercel 환경변수로만 배포 환경에 주입.

## 3. EMR DB 이원화 (ewoo-hospital, ewoo-clinical)

브레인 닥터스 EMR은 **2개 DB 분리**:
| DB | 역할 | 대응 테이블 |
|---|---|---|
| **BrWonmu** (원무) | 청구·수납 확정 데이터 | `Widam`, `Widamsub`, `Wodam`, `Wmomm`, `Wbedm`, `VIEWJUBLIST`, `SILVER_PATIENT_INFO` |
| **BrOcs** (진료실·OCS) | 의사 입력 원본 처방 | `Oidam`, `Oidamsub`, `Onote`(SOAP), `Oworkmemo`, `Onotem` |

### 용도별 DB 선택 기준
| 용도 | 권장 DB·테이블 | 근거 |
|---|---|---|
| 치료계획↔EMR 비교 (`syncTreatmentEMR.js`) | **BrOcs.Oidam** | RO(반복처방)·미래 예정 오더·당일 입력분까지 실시간 반영 |
| 경영현황 수가·매출 집계 (`syncDirectorStats.js`) | **BrWonmu.Widam** | 청구 확정 기준이 맞음 |
| 소견서·환자 처방이력 (`emr-proxy-server opinion-data`, `emr/patients`) | **BrWonmu.Widam** | 과거 실제 시행·청구된 치료 기준 |

### 주의사항
- BrWonmu.Widam은 청구 확정 시 복사되므로 **미래 RO/미확정 오더 누락** (2026-04-18 발견)
- BrOcs.Oidam에는 `.` placeholder 레코드 혼재 — `EMR_TO_PLAN` 매핑으로 자동 스킵됨
- 크로스 DB 조인은 `BrOcs.dbo.Oidam` fully-qualified 참조로 가능

## 4. 치료계획 ↔ EMR / 치료실 검증 시스템

### EMR 태그 (`item.emr`) — `treatmentPlans/{slotKey}/{YYYY-MM}/{D}` 의 각 item
| 태그 | 의미 | UI 배지 | 흐리기 | 금액 계산 |
|---|---|---|---|---|
| `match` | 계획 = EMR | 초록 `EMR` | 없음 | 포함 |
| `added` / `modified` | EMR에만 있음 / 수량 불일치 | 파랑 `EMR+` | 없음 | 포함 |
| `removed` | 과거 날짜, 계획만 있고 EMR 미입력 | 빨강 `EMR-` | `0.4` | **제외** (실제 미시행) |
| `missing` | 오늘/미래 날짜, 계획만 있고 EMR 미입력 | 빨강 `EMR-` | `0.7` | 포함 (입력 누락 알림) |

### 치료실 태그 (`item.room`) — 물리치료·고주파 전용
EMR 주문과 별개로 **치료실에서의 실시행** 여부를 검증한다. 대상: `pain`·`manip1`·`manip2`·`hyperthermia`.
| 태그 | 의미 | UI 배지 | 흐리기 | 금액 계산 | EMR 검증 |
|---|---|---|---|---|---|
| _(태그 없음)_ | 치료실에 실제 기록 있음 또는 대상 외 항목 | - | - | 기존 로직 | 기존 로직 |
| `removed` | 과거 날짜, 계획에 있으나 `physicalSchedule`/`hyperthermiaSchedule`에 미반영 | 갈색 `치료실-` | `0.4` | **제외** | **제외**(EMR 집계에서 빠짐) |

- `emr` 과 `room` 은 **독립** 필드 — 동시에 존재 가능. 한쪽이라도 `removed`면 금액에서 제외되고 흐리게 표시.
- `room:"removed"` 는 EMR 불일치 목록에서 빠지고, `/daily`·`/forms/treatment-verify` 모두 "치료실 미반영" 별도 섹션/배지로 노출.

### 운영 — 독립된 두 개의 스케줄러
- **EMR 검증**: 라즈베리파이 cron `syncTreatmentEMR.js` — 10분마다 `sync.sh` 내에서 실행 (`:03,:13,:23,:33,:43,:53`). EMR DB는 내부망이라 RPi에서만 접근 가능
- **치료실 검증**: Firebase Cloud Functions `scheduledTreatmentRoomSync` (ewoo-hospital/functions/index.js) — 매일 **20:00 Asia/Seoul**에 당일 데이터 처리. RPi 의존성 없음. `firebase.json` + `.firebaserc`(default → ewoo-hospital-ward) + `functions/` 디렉토리로 배포. 수동 복구용 스크립트 `scripts/syncTreatmentRoom.js` 도 별도 보유
- `emrSyncLog/lastSync` / `roomSyncLog/lastSync` 에 ISO 타임스탬프 기록, UI가 "N분 전" 표시
- 둘 다 현재 Firebase `slots/{sk}/current` 기반 — 퇴원자의 잔존 태그는 건드리지 않음
- 두 스케줄러는 **서로의 태그를 건드리지 않는다**. EMR sync는 `{ ...inFb, emr: ... }` 패턴으로 `room` 필드를 보존하고, 치료실 sync는 `room` 필드만 조작하고 `emr` 은 그대로 둔다
- `ewoo-clinical/forms/treatment-verify`: **오늘 이전 날짜의 `room:"removed"` 항목은 검증 대상에서 완전 제외** (치료실이 과거 사실의 최종 진실). 오늘/미래는 여전히 "치료실-" 배지로 표시

## 5. 배포 구성

### Vercel 프로젝트
- ewoo-hospital: `prj_ZjaXIU8IArRo3mgd7FijuFxmJ8Hb`
- ewoo-clinical: `prj_sBwqlySrX9cZWzc4eaLmNDY3xSmU`
- ewoo-approval: (확인 필요)
- 팀: `team_5m8ltQuFiPMS1LfqyY15VY6a` (junesnest-cpus-projects)

### 라즈베리파이 (192.168.0.5, pi@ewoo-sync)
- EMR DB 게이트웨이 + cron 동기화 허브
- `/home/pi/ewoo-hospital`, `/home/pi/ewoo-clinical` 코드 보유
- `~/emr-proxy/` — Cloudflare 터널 프록시 서버 (`emrproxy.ewoohospital.com`)
- crontab: 경량 EMR sync (10분), EMR 프록시 헬스체크(5분), ewoo-clinical 라운딩 캐시(30분 주기) 등

### 환경변수 관리
- 로컬: 각 레포의 `.env.local` (git ignore)
- 라즈베리파이: 각 프로젝트 폴더의 `.env.local`
- Vercel: 프로젝트별 Environment Variables 섹션 (Production/Preview/Development 모두)

## 6. Claude Code 제한사항

- Firebase DB·Auth에 직접 접근 불가 → Admin SDK 스크립트를 작성해 라즈베리파이에서 실행하거나 API 라우트 경유
- EMR DB는 병원 내부망(`192.168.0.253`) → 라즈베리파이 통해서만 접근 가능
- Firebase rules·Vercel env 변경은 사용자가 콘솔에서 수동으로 처리해야 함
- Firebase CLI(`firebase auth:export/import`, `apps:sdkconfig`)로 사용자·config 조회 가능

## 7. 변경 이력

| 날짜 | 변경 | 담당 |
|---|---|---|
| 2026-04-10 | 병동현황·전자결재 시스템 분리 | |
| 2026-04-11 | 데이터 연동 리팩토링 (normName 등) | |
| 2026-04-13 | 입원 예약→입원 전환 흐름 개선 | |
| 2026-04-18 | 치료계획↔EMR 검증 시스템 (BrOcs.Oidam) + 3프로젝트 사용자 인증 통합 (dual Auth) | |
| 2026-04-18 | 치료실↔치료계획 검증 (`room:"removed"` 태그, EMR 검증에서도 제외) | |
| 2026-04-18 | 치료실 검증을 Firebase Cloud Functions(매일 20:00 KST)로 이관 — RPi 의존성 제거 | |

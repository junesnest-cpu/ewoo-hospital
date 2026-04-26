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

## 6. 보안 책임 분담

3프로젝트 모두 동일한 다층 방어 구조를 따른다. 각 레이어가 다른 위협을 막으므로 한 층에 의존하지 말 것.

| 레이어 | 보호 대상 | 메커니즘 | 우회 가능 조건 |
|---|---|---|---|
| **L1. RTDB / Firestore 룰** | DB 직접 호출 (클라이언트 SDK) | 경로별 룰 (서버 전용/읽기 전용/append-only/일반 분리) | 로그인된 모든 사용자가 룰 허용 범위 내에서 자유. hospital 은 2026-04-26 강화 완료 — 아래 `1.1 RTDB 룰 구조` 참조 |
| **L2. API 토큰 검증** | `/api/*` 라우트 | `lib/verifyAuth.js` (`requireAuth`) — Firebase ID Token 검증, audit/enforce 모드 | `AUTH_ENFORCE` env 미설정 시 audit (경고만). hospital 은 enforce 활성, clinical/approval 은 4/29~30 enforce 예정 |
| **L3. 역할 검증** | 민감 API (예: `/api/director-stats`) | `requireRole('director')` — approval `/users/{emailKey}/role` 조회 | L2 통과한 직원도 역할 미달 시 차단 |
| **L4. Rate limit / Dedup** | 폼 spam, password spraying | `lib/rateLimit.js` — RTDB 슬라이딩 윈도우, fail-open | RTDB 장애 시 통과 (사용자 lockout 방지 우선) |
| **L5. CORS / Origin allowlist** | 외부 공개 폼 (`/api/inquiry`) | Allow-Origin 명시 도메인만 | ⚠️ `origin.includes('imweb')` 패턴은 부분일치라 우회 여지 있음 — 정확 매칭 권장 |
| **L6. Admin SDK env 분리** | 서버 측 권한 상승 호출 | `APPROVAL_FIREBASE_*` / `WARD_FIREBASE_*` / `FIREBASE_*` 분리 적재 | env 유출 시 해당 프로젝트 전권. literal `\n` PEM 형식 + Vercel scope 분리로 보호 |

### 데이터 분류와 적용 레이어

| 데이터 | 분류 | 적용 레이어 |
|---|---|---|
| 환자 마스터 (`patients/`, EMR 처방 이력) | 🔴 PHI (개인 의료정보) | L1+L2+L3 — clinical 의 8개 EMR 엔드포인트 audit 모드 운영 중 |
| 사용자 프로필·비밀번호 (`/users/`) | 🔴 인증 자체 | L1+L2 + Firebase Auth 자체 보호 |
| 매출·수가 집계 | 🟠 경영 정보 | L2+L3 (`director` role 한정) |
| 외부 문의 (홈페이지) | 🟡 외부 입력 | L4+L5 (rate limit + CORS) |
| 치료계획·병상배치 | 🟡 운영 데이터 | L1 (auth != null) + L2 |
| 로그 (`/logs`) | 🟡 운영 메타 | L1 append-only — 직원 wipe 후 변조 차단 |
| 서버 전용 메타 (`/rateLimits`, `/dedupKeys`, `/pendingChanges`, `/migrationReports`) | 🟢 서버 전용 | L1 — 클라이언트 read/write 모두 false. Admin SDK 만 |
| 동기화 결과 (`/monthlyBoards`, `/emrSyncLog`, `/roomSyncLog`) | 🟢 서버 기록 | L1 — 클라이언트 read 만, write 는 RPi/Cloud Functions Admin SDK |
| 백업 (`_backup_*`) | 🟢 보존 | L1 — 클라이언트 read/write 모두 차단 (admin SDK 만) |

### 6.1 RTDB 룰 구조 (2026-04-26 강화)

`database.rules.json` 는 **명시 노드별 룰 + `$node` 와일드카드 fallback** 구조:

| 룰 패턴 | 적용 노드 | 효과 |
|---|---|---|
| `false / false` | `rateLimits`, `dedupKeys`, `pendingChanges`, `migrationReports` | 클라이언트 완전 차단. Admin SDK 만 (룰 우회) |
| `read: auth!=null / write: false` | `monthlyBoards`, `emrSyncLog`, `roomSyncLog` | 클라이언트 읽기만, 쓰기는 서버 전용 |
| append-only (`logs/$logId`) | `logs` | 신규 entry 추가만 허용. 기존 변경·삭제 차단 — 직원 wipe 방지 |
| `$node` 와일드카드 (`auth != null && !$node.beginsWith('_backup_')`) | 위에서 명시되지 않은 모든 child | 기존 `auth != null` 동작 유지 + `_backup_*` prefix 차단 |

**RTDB 룰의 cascading 함정**: 부모 노드의 룰이 true 면 자식은 항상 허용 (자식에서 더 엄격하게 못 함). 따라서 root `.read/.write` 를 두지 않고 `$node` 와일드카드로 fallback 처리 — 미명시 경로는 자동 deny by default 가 아닌 `auth != null` 유지.

**logs append-only 코드 호환**: `lib/WardDataContext.js` `addLog` 가 set(전체 배열) 패턴에서 `push()` 키 기반으로 전환됨 (2026-04-26). 기존 배열 데이터는 `Object.values` 로 호환 처리되어 마이그레이션 없이 점진 전환.

### 비밀번호 변경·계정 회수 흐름

- 비밀번호 변경: `ewoo-approval` Auth 단일 출처. 클라이언트는 `userPwChangedAt` 갱신 → `ewoo-hospital` 다음 로그인 시 강제 로그아웃
- 계정 비활성화 (퇴직): approval Admin SDK 로 `disabled:true` → ID Token 검증 자동 실패 → L2 차단
- 키 회전 (Admin SDK 서비스 계정): Firebase Console 에서 새 키 발급 → Vercel env 갱신 → 구 키 폐기 (literal `\n` 함정 주의 — TODO-STAGE3.md 학습한 함정 참조)

## 7. Claude Code 제한사항

- Firebase DB·Auth에 직접 접근 불가 → Admin SDK 스크립트를 작성해 라즈베리파이에서 실행하거나 API 라우트 경유
- EMR DB는 병원 내부망(`192.168.0.253`) → 라즈베리파이 통해서만 접근 가능
- Firebase rules·Vercel env 변경은 사용자가 콘솔에서 수동으로 처리해야 함
- Firebase CLI(`firebase auth:export/import`, `apps:sdkconfig`)로 사용자·config 조회 가능

## 7. 변경 이력 (섹션 번호 변경: 6→7)

| 날짜 | 변경 | 담당 |
|---|---|---|
| 2026-04-10 | 병동현황·전자결재 시스템 분리 | |
| 2026-04-11 | 데이터 연동 리팩토링 (normName 등) | |
| 2026-04-13 | 입원 예약→입원 전환 흐름 개선 | |
| 2026-04-18 | 치료계획↔EMR 검증 시스템 (BrOcs.Oidam) + 3프로젝트 사용자 인증 통합 (dual Auth) | |
| 2026-04-18 | 치료실↔치료계획 검증 (`room:"removed"` 태그, EMR 검증에서도 제외) | |
| 2026-04-18 | 치료실 검증을 Firebase Cloud Functions(매일 20:00 KST)로 이관 — RPi 의존성 제거 | |
| 2026-04-20 | Stage 1·2 — `/api/generate` 토큰 검증 + Firestore 룰 재작성 (clinical), Naver Works 시그니처 audit (hospital) | |
| 2026-04-25 | Stage 3 audit — 3프로젝트 합 12개 엔드포인트에 `requireAuth` + `apiFetch` 일괄 적용 (hospital `f0f5af6`, clinical `cb67446`, approval `36bc123`) | |
| 2026-04-25 | H1 `/api/inquiry` rate limit + dedup, H3 `/api/auth/migrate` rate limit (`0fbcc34`) — `lib/rateLimit.js` 신설 | |
| 2026-04-25 | **C3 hospital enforce 활성화** (`f173b61`, `AUTH_ENFORCE=true`) — 원래 5/1 일정에서 audit 당일 앞당김. clinical/approval 은 4/29~30 예정 | |
| 2026-04-26 | INTEGRATION.md 6장 보안 책임 분담 추가 — L1~L6 다층 방어 구조와 데이터 분류별 적용 레이어 정리 | |
| 2026-04-26 | 코드 갭 패치 — `lib/firebaseAdmin.js` safeInit, `apiFetch` stale token 자동 복구, `/api/naver-works-send` rate limit + 길이 상한 | |
| 2026-04-26 | **RTDB 룰 강화** — 서버 전용/읽기 전용/append-only/일반 4분류로 경로별 분리. `logs` append-only 전환 (`addLog` push 패턴), `_backup_*` 클라이언트 차단 | |

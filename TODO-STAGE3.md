# Stage 3 — API 인증 미들웨어 전면 적용

> **예약일**: 2026-04-25 (토요일)
> **예상 소요**: 3~4시간 + 24~48시간 모니터링
> **작성일**: 2026-04-20

## 목표
이미 토큰 검증이 적용된 `/api/generate` 외에, 나머지 **민감 엔드포인트 전부**에
Firebase ID Token 검증 미들웨어를 적용한다.

> 참고: `/api/analyze`·`/api/naver-works-webhook`·`pages/history.js` 는 2026-04-21
> AI 자동 입력 기능 철회와 함께 제거됨. 관련 작업 항목 취소선 처리.

## 대상 엔드포인트

### ewoo-clinical (우선순위 🔴 환자정보 노출)
- [x] `/api/emr/patients` — 환자 마스터 (2026-04-25, audit)
- [x] `/api/emr/opinion-data` — 처방이력 (2026-04-25, audit)
- [x] `/api/emr/find-memos` — 의사 메모 (2026-04-25, audit)
- [x] `/api/emr/rounding` — 라운딩 환자목록 (2026-04-25, audit)
- [x] `/api/emr/rounding-summary` — 의사 라운딩 요약 (2026-04-25, audit)
- [x] `/api/patients/search` — 환자 검색 (2026-04-25, audit)
- [x] `/api/rounding` — 라운딩 메모 저장 (2026-04-25, audit)
- [x] `/api/vitals` — 바이탈 저장/조회 (2026-04-25, audit)
- [ ] `/api/auth/migrate` — 이미 이메일+비밀번호로 자체 보호, 우선순위 낮음

### ewoo-hospital
- ~~`/api/analyze`~~ — 엔드포인트 삭제 (2026-04-21, AI 자동입력 기능 철회)
- ~~`/api/naver-works-webhook`~~ — 엔드포인트 삭제 (同 이유)
- [x] `/api/naver-works-send` — 봇 발송 (2026-04-25, audit 모드로 배포)
- [ ] `/api/inquiry` — **예외 유지** (외부 공개 폼, reCAPTCHA 등 별도 보호 권장)

### ewoo-approval
- [x] `/api/director-stats` — 경영·매출 집계 (2026-04-25, audit, requireRole('director'))

## 작업 절차

### Phase 1: 서버 측 (각 리포마다 1회)
1. `lib/verifyAuth.js` 이미 존재 (2026-04-20 추가) → 재사용
2. 각 엔드포인트 상단에 `import { verifyAuth } ...` 추가
3. handler 함수 초입에:
   ```js
   const user = await verifyAuth(req);
   if (!user) return res.status(401).json({ error: 'unauthorized' });
   ```

### Phase 2: 클라이언트 측 (fetch 호출 지점 전수 수정)
클라이언트 `fetch('/api/...', {...})` 호출을 모두 찾아 `Authorization: Bearer <token>` 헤더 추가.
**공통 래퍼 도입 권장**:
```js
// lib/apiFetch.js
import { auth } from './firebaseConfig';
export async function apiFetch(url, opts = {}) {
  const token = await auth.currentUser?.getIdToken();
  return fetch(url, {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${token}` },
  });
}
```
이후 `fetch('/api/...')` → `apiFetch('/api/...')` 일괄 치환.

### Phase 3: Audit 배포 (차단 없이)
- env `AUTH_ENFORCE=false`로 배포
- 코드에서 토큰 없으면 **로그만 남기고 통과**
- 24~48시간 로그 모니터링 → 누락된 호출 지점 식별

### Phase 4: Enforce 전환
- 누락 지점 전부 수정 후 `AUTH_ENFORCE=true`
- 모니터링: 401 급증 여부, 사용자 제보 여부
- 즉시 롤백: env 토글만으로 원복 가능

## 롤백 전략
각 커밋별 독립적이므로 문제 발생 시 해당 커밋만 `git revert` + 재배포.
또는 환경변수 `AUTH_ENFORCE=false`로 즉시 관찰 모드 전환.

## 사전 체크리스트 (토요일 시작 전)
- [ ] 수요일(04-22)부터 /api/generate 배포본 사용자 피드백 수집
- [ ] 네이버 웍스 봇 담당자에게 `NAVER_WORKS_BOT_SECRET` 환경변수 Vercel에 등록 요청 (clinical/hospital 프로젝트 모두)
- [ ] 토요일 당일 병동·임상 사용자 알림 — "오전 점검" 공지

## 관련 커밋 (2026-04-20 Stage 1·2 작업)
| 리포 | 커밋 | 내용 |
|---|---|---|
| hospital | `4b1fed5` | /api/analyze 인증 + Naver Works 시그니처 audit |
| clinical | `b154da8` | /api/generate 인증 |
| clinical | `4bacaff` | Firestore 규칙 재작성 (테스트모드 제거) |
| (snapshot) | `c297fb2`, `fac5309`, `7db5fc4` | Rules 리포 커밋 |

## Stage 3 작업 결과 (2026-04-25 토)

### 코드 배포 (audit 모드)

| 리포 | 커밋 | 내용 |
|---|---|---|
| hospital  | `f0f5af6` | requireAuth + apiFetch + /api/naver-works-send (audit 모드) |
| clinical  | `cb67446` | 8개 EMR/환자 엔드포인트 + 클라이언트 일괄 (audit 모드) |
| approval  | `36bc123` | /api/director-stats requireRole('director') (audit 모드) |

### 추가 보안 패치 (2026-04-25 토 — 같은 날 audit 직후)

| 리포 | 커밋 | 내용 |
|---|---|---|
| hospital | `0fbcc34` | H1 `/api/inquiry` rate limit (IP/h 10회) + dedup (phone+content 1h), H3 `/api/auth/migrate` rate limit (IP+email 5분 5회) — `lib/rateLimit.js` 신설 |
| hospital | `f173b61` | **C3 hospital enforce 활성화** — `AUTH_ENFORCE=true` Vercel env 등록 + 재배포. 일정 앞당겨짐 (원래 5/1) |

### approval 환경변수 등록 + 후속 수정

approval 은 `APPROVAL_FIREBASE_*` env 미설정이라 audit 시점에 approval 토큰 검증이 ward fallback 만 시도되며 매번 audit 경고 발생. 다음 절차로 정리:

1. `serviceAccount-new.json`(approval Firebase 콘솔 발급분, 리포 root 에 보관 중) 에서 값 추출
2. `npx vercel env add` 로 `APPROVAL_FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY` × 3환경(prod/preview/dev) 등록
3. **함정 발견**: vercel CLI 가 `--value="$VAR"` 로 multi-line 값 받을 때 newline 처리에 결함 → cert() PEM 파싱 실패 → 500 (배포 `13d2bcd` 직후)
4. `lib/firebaseAdmin.js` 를 `safeInit` 패턴으로 변경 (커밋 `10f38d8`) — init 실패 시 try-catch 로 잡고 null 반환, audit 에서 안전 fallback
5. `APPROVAL_FIREBASE_PRIVATE_KEY` 를 literal `\n` escape 형태로 재등록 — 코드의 `.replace(/\\n/g, '\n')` 가 actual newline 으로 변환해 정상 작동
6. 재배포 (`d4e5949`) — approval admin SDK init 성공 확인. 사용자 호출 6건 audit 경고 0건 정상 통과.

### 검증

- 3개 사이트 smoke test: 모두 로그인 화면 정상 렌더 (favicon 404 외 콘솔 에러 0)
- runtime logs: hospital/clinical 깨끗, approval audit 모드 정상 작동

---

## 향후 계획 (모니터링 → enforce 전환)

### 1단계: 로그 분석 (예약: 2026-04-28 화 13:00 — Google 캘린더 등록됨)

3개 Vercel 프로젝트 Logs 에서 `[auth-audit]` / `[role-audit]` / `[firebaseAdmin]` 검색:
- **0건이면**: 모든 호출에 토큰 정상 부착 → enforce 안전
- **있으면**: 누락된 클라이언트 호출 지점 식별 → `apiFetch` 로 마저 치환 → 추가 24h 관찰

### 2단계: enforce 전환 (위험도 낮음 → 높음, 24h 간격)

각 Vercel 프로젝트에 `AUTH_ENFORCE=true` 환경변수 추가 → 자동 재배포 → 토큰 없는 호출은 **401**.

| 일자 | 리포 | 상태 | 비고 |
|---|---|---|---|
| ~~2026-05-01 금~~ → **2026-04-25 토** | hospital  | ✅ 완료 (`f173b61`) | 영향 적어 audit 당일 바로 enforce 앞당김 |
| 2026-04-29 수 | clinical  | ⏳ 예정 — 사전 안전 패치 완료 (`c1e61ba`, 4/26) | 환자정보 노출 가장 위험. safeInit + apiFetch refresh + migrate 정보 누출 제거 적용. audit 28일 분석 후 |
| 2026-04-30 목 | approval  | ⏳ 예정 — 사전 안전 패치 완료 (`3849a7b`, `890d521`, 4/26) | 역할 검증(director) 포함. apiFetch refresh + verifyAuth ward null + RTDB 룰 강화(4분류 + cascading 회피) |

각 전환 직후 30분간 Logs 즉시 관찰. 401 폭증·사용자 제보 시 env 토글로 1분 내 audit 복귀.

#### 모니터링 플레이북 (enforce 전환 후 24~48h)

**Vercel Logs 검색 키워드** (각 프로젝트 dashboard → Logs → Filter):
- `[auth-enforce]` — 토큰 없이 들어와 **차단된** 호출. 0건이 정상. 1건이라도 보이면 어떤 클라이언트가 토큰 부착 누락인지 즉시 식별
- `[auth-audit]` — audit 모드 잔존 호출 (enforce 전환 후엔 발생 안 해야 함)
- `[role-audit]` / `[role-enforce]` — approval `director` 권한 미달 호출
- `[firebaseAdmin]` — Admin SDK init 실패 (env 누락·PEM 파싱 오류 등)
- `unauthorized` — 401 응답 raw 카운트

**대응 흐름**:
1. `[auth-enforce]` 발견 → 호출 path 확인 → 해당 페이지의 `fetch('/api/...')` 호출이 `apiFetch` 로 감싸졌는지 확인 → 패치 후 재배포
2. 401 폭증·사용자 제보 → Vercel env 에서 `AUTH_ENFORCE` 삭제 (audit 복귀, ~1분) → 원인 파악 후 재시도
3. `[firebaseAdmin]` 발생 → 해당 프로젝트 env(`*_FIREBASE_*`) 점검, PEM 줄바꿈은 literal `\n` 형태인지 확인 (학습한 함정 참조)

### 3단계: 정착 확인 (1주)

- 401 발생 빈도 (사용자 제보)
- 토큰 만료·재발급 흐름 자연스러운지 (`apiFetch` 가 `getIdToken()` 매 호출마다 재발급)
- 모바일 / 외부 도구 영향 여부

### 4단계: 후속 정리

- [~] `/api/inquiry` (hospital, 외부 공개 폼) — **단계 1 honeypot 적용 완료** (2026-04-26):
  - 폼에 화면 밖 숨김 `website` 필드(`#ewooHpField`/`#ewooHpFieldM`) — 데스크톱·모바일 양쪽
  - 서버: 비어있지 않으면 봇 판정 → fake success 응답(`{success:true, id:'hp-...'}`) + 서버 로그 (`[inquiry][honeypot]`)
  - DB 저장 skip → 가짜 문의 누적 방지. 봇 학습 차단 위해 거부 응답 위장
  - 단순 봇 ~70% 차단 예상. 정교한 헤드리스 봇·사람 형태 spam 은 못 막음
  - **단계 2 (reCAPTCHA v2 invisible)** 는 honeypot 모니터링 결과 보고 결정. 가짜 문의 발생 빈도가 월 5건 넘으면 진입
- [x] `/api/auth/migrate` (hospital) — rate limit 적용 (`0fbcc34`, IP+email 5분 5회). clinical 동일 적용 필요시 별건
- [x] `serviceAccount-old.json` / `serviceAccount-new.json` 정리 (2026-04-26) — **hospital 레포는 N/A**: 파일 자체 없음·git 미커밋·모든 스크립트가 환경변수만 사용. 예방 차원 `.gitignore` 패턴 추가(`serviceAccount*.json` 등).
  - **approval 레포 검토 결과 (2026-04-26)**: 옵션 A — **유지 결정**
    - `lib/firebaseAdmin.js` 는 환경변수만 사용 — JSON 자동 로드 안 됨 (JSON 파일 존재와 dev 서버 인증 동작은 자동 연결 안 됨)
    - 운영(Vercel deploy) 측면 — Vercel env 가 모든 키 공급, JSON 불필요
    - 로컬 dev 측면 — `.env.local` 도 없으므로 dev 서버에서 인증 라우트는 audit 모드 / 503 으로 동작. JSON 자체는 dev 에 자동 영향 없음
    - **JSON 직접 참조 7개 파일** — `scripts/migrateUsers.js`, `migrateData.js`, `extract-pk-literal.js`, `register-env.sh`, `re-register-pk.sh` (일회성 마이그레이션 + 키 회전 헬퍼)
    - 유지 사유: 향후 키 회전 시 `register-env.sh` 가 매우 유용 (HOTFIX 2026-04-25 의 literal `\n` 함정 회피용 표준 절차). 마이그레이션 스크립트 재실행 가능성도 있음
    - 보안 위생: `.gitignore` 21줄에 `serviceAccount*.json` 등재됨 → git 노출 위험 0. 로컬 PC 한 곳에만 존재 → 추가 노출 표면 없음
    - **회복 보증**: Vercel env 에 모든 키가 등록되어 있고 (`vercel env ls production` 으로 확인 가능), Firebase Console 에서 새 키 재발급 가능 → JSON 분실 시에도 회복 가능
- [x] HOTFIX.md 에 vercel CLI multi-line env 등록 함정 추가 (literal `\n` 형식 권장)

### 5단계: 추가 발견 보안 갭 (2026-04-26 점검)

문서 보완 과정에서 enforce 전환만으로는 막히지 않는 갭을 새로 식별. 우선순위 순:

- [x] **🔴 RTDB 룰 강화 (hospital)** (2026-04-26) — `database.rules.json` 4분류 구조로 재작성:
  - **서버 전용**(false/false): `rateLimits`, `dedupKeys`, `pendingChanges`, `migrationReports`
  - **읽기 전용**(read-only): `monthlyBoards`, `emrSyncLog`, `roomSyncLog` — RPi/Cloud Functions Admin SDK 만 write
  - **append-only**: `logs` — 신규 entry 추가만 허용 (직원 wipe 차단). `addLog` 를 set(전체 배열) → `push()` 패턴으로 전환 (`lib/WardDataContext.js`). 기존 배열 데이터는 `Object.values` 로 점진 호환
  - **일반**(`$node` 와일드카드): 명시 없는 모든 경로 — `auth != null` + `_backup_*` prefix 차단. cascading 함정 회피
  - 룰 변경 즉시 enforce. 영향 평가: 정상 사용자는 무영향 / 직원 콘솔 조작·악의 변조 차단 / 스크립트는 Admin SDK 로 룰 우회 가능

- [x] **🔴 RTDB 룰 강화 (approval)** (2026-04-26, `890d521`) — hospital 패턴 적용:
  - **서버 전용 / read-only**: `approvals/{$docId}` (서버 Admin SDK 만 write — `/api/approvals/action`), `patients/{$docId}` (서버 환불 처리만)
  - **read+write 일반**: `users/{$ek}` (profile setup, uid sync), `approvalCounters` (클라이언트 runTransaction), `userPwChangedAt` (PW 변경 감지)
  - **role 보호**: `users/{$ek}/role` 만 .write false — 직원 self-promote 차단
  - **`$node` 와일드카드 fallback**: 미명시 노드는 `auth != null` 유지 + `_backup_*` prefix 차단
  - **핵심 발견**: 기존 룰의 root `.read/.write: "auth != null"` cascading 때문에 child `.write: false` 가 **실제로 무력했음**. root 제거 + $node fallback 으로 보호가 진짜 작동하게 됨
  - 클라이언트 코드 변경 0 (logs append-only 같은 호환성 이슈 없음 — approval 은 set(전체) 패턴 사용 안 함)
- [x] **🔴 `lib/firebaseAdmin.js` safe-init 패턴** (2026-04-26) — `safeInit()` 헬퍼 도입. ENV 누락·PEM 파싱 실패 시 throw 대신 null 반환 + `[firebaseAdmin]` 경고 로그. `verifyAuth` 와 `/api/auth/migrate` 도 null-safe 처리 (migrate 는 503 반환). HOTFIX 2026-04-25 와 동일 패턴
- [x] **🟠 `/api/naver-works-send` rate limit + 길이 제한** (2026-04-26) — uid 우선·IP fallback 키로 1분 10회 제한 (`wardAdminDb` 백엔드). 메시지 2000자 상한 (413 반환). 정상 사용(시간당 수 건)은 영향 없음
- [x] **🟠 `/api/inquiry` CORS allowlist 정확 매칭** (2026-04-26) — `origin.includes('imweb')` → `URL` 파싱 후 `*.imweb.me` suffix 매칭(서브도메인 확보 검증). 명시 origin 외에는 헤더 부여 안 함 (origin 없는 호출은 rate limit + dedup 이 방어). `Vary: Origin` 추가
- [x] **🟡 `/api/auth/migrate` 정보 누출 제거** (2026-04-26) — 응답을 `{ ok: true }` 단일화. 어느 쪽 동기화됐는지는 서버 console 에만 기록 (`[migrate] {email}: {ward|approval} 동기화 완료`). 클라이언트 `_app.js` 는 자체 `trySignIn()` 결과만 사용 — 영향 없음 사전 확인됨
- [x] **🟠 `apiFetch` stale token 자동 복구** (2026-04-26) — 401 응답 + 로그인 상태일 때만 1회 `getIdToken(true)` 강제 refresh 후 재시도. enforce 직후 노트북 절전·idle 후 첫 호출 실패 자동 복구. 무한루프 방지로 retry 1회 한정. (우선순위 🟡→🟠 격상: enforce 켜진 직후 가장 먼저 사용자 제보 가능성 있는 항목이라 선처리)

### 비상 절차

| 증상 | 조치 | 소요 |
|---|---|---|
| 사용자 페이지 접근 불가 | Vercel env 에서 `AUTH_ENFORCE` 삭제 → audit 복귀 | ~1분 |
| 특정 엔드포인트만 깨짐 | `git revert <커밋>` + 푸시 | ~5분 |
| 데이터 노출 의심 | Firebase Rules 강화 (별도 작업) | 즉시 |

---

## 학습한 함정 (재발 방지용)

### vercel CLI 의 multi-line env 등록

- `--value="$VAR"` 에 actual newline 이 들어간 값을 넘기면 저장 시점에 일부 배포 환경에서 정상 파싱되지 않음 (FirebaseAppError: Failed to parse private key)
- **권장**: PEM 류 multi-line 비밀값은 반드시 literal `\n` escape 형태로 저장하고, 코드에서 `.replace(/\\n/g, '\n')` 로 변환
- approval 의 `scripts/extract-pk-literal.js` + `scripts/re-register-pk.sh` 가 표준 절차 — 다른 리포에서 같은 작업 시 재사용

### vercel CLI agent-detection 비대화 모드

- `CLAUDECODE` env 가 set 되어있으면 vercel CLI 가 일부 prompt 를 JSON `action_required` 로 반환하고 `--yes`/`--value` 만으로는 끝나지 않을 수 있음
- preview env 의 git-branch prompt 는 **빈 문자열 positional** (`vercel env add NAME preview "" --value="..." --yes`) 로 우회 필요

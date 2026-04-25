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

| 일자 | 리포 | 비고 |
|---|---|---|
| 2026-04-29 수 | clinical  | 환자정보 노출이 가장 위험하지만 audit 검증 완료 |
| 2026-04-30 목 | approval  | 역할 검증(director) 포함이라 진입 장벽 높음 |
| 2026-05-01 금 | hospital  | 영향 적음, 마지막 |

각 전환 직후 30분간 Logs 즉시 관찰. 401 폭증·사용자 제보 시 env 토글로 1분 내 audit 복귀.

### 3단계: 정착 확인 (1주)

- 401 발생 빈도 (사용자 제보)
- 토큰 만료·재발급 흐름 자연스러운지 (`apiFetch` 가 `getIdToken()` 매 호출마다 재발급)
- 모바일 / 외부 도구 영향 여부

### 4단계: 후속 정리

- [ ] `/api/inquiry` (hospital, 외부 공개 폼) — reCAPTCHA / hCaptcha 도입 검토
- [ ] `/api/auth/migrate` (clinical, hospital) — rate limit 검토 (현재 비번 자체 보호)
- [ ] `serviceAccount-old.json` / `serviceAccount-new.json` 정리 — 사용 중 키 확정 후 old 폐기 (보안 위생)
- [ ] HOTFIX.md 에 vercel CLI multi-line env 등록 함정 추가 (literal `\n` 형식 권장)

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

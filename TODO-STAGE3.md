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
- [ ] `/api/emr/patients` — 환자 마스터
- [ ] `/api/emr/opinion-data` — 처방이력
- [ ] `/api/emr/find-memos` — 의사 메모
- [ ] `/api/emr/rounding` — 라운딩 환자목록
- [ ] `/api/emr/rounding-summary` — 의사 라운딩 요약
- [ ] `/api/patients/search` — 환자 검색
- [ ] `/api/rounding` — 라운딩 메모 저장
- [ ] `/api/vitals` — 바이탈 저장/조회
- [ ] `/api/auth/migrate` — 이미 이메일+비밀번호로 자체 보호, 우선순위 낮음

### ewoo-hospital
- ~~`/api/analyze`~~ — 엔드포인트 삭제 (2026-04-21, AI 자동입력 기능 철회)
- ~~`/api/naver-works-webhook`~~ — 엔드포인트 삭제 (同 이유)
- [ ] `/api/naver-works-send` — 봇 발송 (토큰 검증 추가)
- [ ] `/api/inquiry` — **예외 유지** (외부 공개 폼, reCAPTCHA 등 별도 보호 권장)

### ewoo-approval
- [ ] `/api/director-stats` — 경영·매출 집계 (토큰 + 역할 검증)

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

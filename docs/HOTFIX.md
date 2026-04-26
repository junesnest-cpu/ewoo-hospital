# 핫픽스 로그

> **이 파일의 용도**
> 운영 중 발생한 오류의 원인·수정 내용을 시간순(최신 위)으로 누적 기록한다. Claude 는 **"오류/버그 수정" 요청을 받기 전에 반드시 이 파일을 먼저 읽어** 유사/동일 사례가 있는지 확인한 뒤 작업한다. 수정이 끝나면 새 섹션을 맨 위에 추가한다 (형식: `## YYYY-MM-DD — 제목`).
>
> **기록 규칙**
> - 증상: 사용자가 관찰한 현상을 그대로
> - 근본 원인: "어느 파일, 어느 라인, 어떤 조건" 까지 구체적으로
> - 수정: 변경 파일 · 커밋 해시 · 적용 레이어(클라이언트/RPi/Cloud Functions)
> - 재발 방지 가드: 동일 부류 오류를 앞으로 어떻게 막는지
> - 검증/복구 도구: 남긴 진단·복구 스크립트 경로
> - 연관 관찰: 이후 유사 증상을 발견하면 여기에 "같은 원인" 인지 먼저 확인

---

## 2026-04-26 — RTDB 룰 강화 시 logs `set(전체 배열)` 패턴이 룰에 막힘

### 증상
- `database.rules.json` 강화 배포 직후 환자 이동·예약 등 변경 작업 시 콘솔에 `PERMISSION_DENIED: Permission denied` 로그.
- 데이터 자체는 변경되지만 `logs` 항목이 누락됨.

### 근본 원인
- 새 룰의 `logs.$logId` 는 **append-only** (`!data.exists() && newData.exists()`).
- 기존 코드 `lib/WardDataContext.js addLog` 는 `set(ref(db, "logs"), updated)` 로 **전체 배열을 통째로 set**.
  - 부모 `logs` 노드 자체에는 .write 룰 없음 → 거부.
  - child `logs/$logId` 룰은 신규 추가만 허용 → 기존 entry 덮어쓰기 거부.
- 즉 룰 강화 후엔 set(전체) 패턴이 **반드시 거부**되며 push() 패턴으로의 코드 전환 필수.

### 수정 (커밋: RTDB 룰 강화와 동일 커밋)
- `lib/WardDataContext.js`:
  - `addLog` 를 `push(ref(db, "logs"))` + `set(newRef, newLog)` 패턴으로 변경.
  - `import { push }` 추가.
  - `u6` 읽기 코드는 이미 `Array.isArray(val) ? val : Object.values(val)` 처리되어 있어 객체 형태와 호환. ts 내림차순 정렬 + 200건 제한 추가.
  - 낙관적 갱신(setLogs) 은 유지 — onValue 가 정합성 보정.

### 재발 방지 가드
- **append-only 룰을 적용한 노드는 반드시 push() 패턴 코드여야 함**: `set(ref(db, "노드"), 전체)` 또는 `update(ref(db), {"노드": 전체})` 호출이 있는지 grep 으로 확인 후 룰 적용.
- **RTDB 룰 cascading 함정**: 부모 노드의 `.read/.write` 가 true 면 자식에서 더 엄격하게 만들 수 없음 (자식 룰 무시됨). root 에 `.read/.write: "auth != null"` 두면 모든 child 가 `auth != null` 로 고정됨. 그래서 root 룰을 제거하고 `$node` 와일드카드로 fallback 처리.
- **룰 변경은 audit 모드 없음**: `firebase deploy --only database` 즉시 enforce. 배포 직전 모든 페이지의 영향받는 동작(예약 등록·이동·퇴원·치료계획 입력·logs 기록) smoke test 필요. 깨지면 `git revert` + 재배포로 ~1분 내 복구.

### 검증·복구 도구
- 새 룰 배포 후 즉시 확인할 동작:
  - 병동 메인(`pages/index.js`)에서 환자 정보 수정 → console 에 `PERMISSION_DENIED` 가 안 나야 함
  - "변경 이력" 탭(`LogView`)에서 신규 항목이 즉시 표시되어야 함
  - 외부 문의(`/api/inquiry`) 접수 시 rate limit 정상 동작 (서버측 Admin SDK 라 룰 우회됨)
- 롤백: `database.rules.json` 을 직전 커밋으로 되돌리고 `firebase deploy --only database` 재실행.

### 연관 관찰
- `set(ref(db, "노드"), ...)` 또는 `update(ref(db), {"노드": ...})` 패턴은 append-only 룰과 호환 안 됨 — 새 룰 적용 노드에는 grep 으로 사전 확인.
- 부모 cascading 때문에 root 에 `auth != null` 두면 child 보호 룰이 무력화됨. 이 함정을 모르고 "child 만 강화" 시도하면 룰만 늘고 실효 없음.

---

## 2026-04-25 — Vercel CLI multi-line env 등록 시 PEM 줄바꿈 깨짐 → Admin SDK init 500

### 증상
- Stage 3 audit 배포(`13d2bcd`) 직후 ewoo-approval 의 모든 `/api/*` 가 500.
- Runtime logs: `FirebaseAppError: Failed to parse private key: Error: Invalid PEM formatted message`.
- `npx vercel env add APPROVAL_FIREBASE_PRIVATE_KEY production --value="$VAR" --yes` 로 actual newline 포함 PEM 문자열을 등록한 직후.

### 근본 원인
- vercel CLI 의 `--value="$VAR"` 가 multi-line 값(\n 실제 개행)을 일부 배포 환경에서 정상 저장하지 못함.
- 저장된 값을 firebase-admin `cert()` 가 PEM 으로 파싱할 때 줄바꿈 손상 → init 실패.
- approval 만 신규 등록한 상태였고 hospital/clinical 은 기존 env 사용으로 영향 없음.

### 수정 (커밋)
- `10f38d8` (approval) — `lib/firebaseAdmin.js` 를 **safeInit 패턴**으로 변경: try-catch 로 cert 실패 잡고 null 반환. audit 모드에서도 안전 fallback.
- `APPROVAL_FIREBASE_PRIVATE_KEY` 를 **literal `\n` escape** 형태로 재등록 (한 줄 문자열). 코드의 `.replace(/\\n/g, '\n')` 가 actual newline 으로 변환.
- `d4e5949` (approval) 재배포 — Admin SDK init 성공 확인.

### 재발 방지 가드
- **PEM/multi-line secret 등록은 반드시 literal `\n` escape 형태로**: 줄바꿈을 `\n` 두 글자로 치환해 한 줄 문자열로 만든 뒤 등록. 코드는 `.replace(/\\n/g, '\n')` 로 디코드.
- **Admin SDK init 은 safeInit 패턴**: import 자체가 죽어 모든 라우트가 500 되는 사태 방지. ⚠️ hospital `lib/firebaseAdmin.js` 는 아직 safeInit 미적용 (TODO-STAGE3.md 5단계 항목).
- **Vercel CLI agent-detection 비대화 모드**: `CLAUDECODE` env 가 set 이면 vercel CLI 가 일부 prompt 를 JSON `action_required` 로 반환 — `--yes`/`--value` 만으로 끝나지 않을 수 있음. preview env 의 git-branch prompt 는 빈 문자열 positional 로 우회: `vercel env add NAME preview "" --value="..." --yes`.

### 검증·복구 도구
- approval 레포 `scripts/extract-pk-literal.js` + `scripts/re-register-pk.sh` — literal `\n` 변환 + Vercel 등록 자동화. 다른 리포에서 같은 작업 시 재사용.
- Vercel runtime logs 에서 `[firebaseAdmin]` 키워드로 init 실패 즉시 감지 가능.

### 연관 관찰
- 같은 증상(특정 프로젝트만 Admin SDK 관련 500)이면 가장 먼저 env 의 `*_PRIVATE_KEY` 가 literal `\n` 인지, actual newline 인지 확인.
- 키 회전 시에도 동일 함정 재발 가능 — 회전 절차 문서에 반드시 포함.

---

## 2026-04-24 — 재입원 예약 시 과거 상담(동명) reservedSlot 오염 → "2건 예약" 표시

### 증상
- 강영희(2026-01-05 상담 후 Jan 입원·퇴원)가 다시 연락 → 4/24 신규 상담+예약 등록.
- 상담일지 "입원 예정 / 병상배정" 목록에 **동일 환자가 2건**으로 표시.
- 1/5 상담 레코드의 `reservedSlot/admitDate/dischargeDate` 가 4/24 예약 값과 **동일하게 덮어써짐**.

### 근본 원인
`pages/consultation.js` `slotOverrides` fallback (line 198-223, "consultationId 없는 경우 이름으로 전체 slots 검색") 이 너무 관대함.
1. 강영희 1/5 상담은 퇴원 후 slots에 직접 링크(`consultationId`)가 없음 → fallback 진입.
2. 4/24 신규 예약이 slot X 에 막 등록돼 `name="강영희"` reservation 이 있음.
3. Fallback 이 slot X 의 Apr24 reservation(다른 consultation 이 이미 owner) 을 Jan5 cid 에 귀속.
4. 이어 `useEffect` auto-sync(line 229-243) 가 Jan5 consultation 의 reservedSlot/admitDate/dischargeDate 를 Apr24 값으로 덮어쓰기. finalized(입원완료/취소) 가드 없음.
5. UI `effectiveStatus` + `isReserved` 가 둘 다 "예약완료"로 판정 → "2건 예약" 표시.

### 수정 (커밋 예정)
- `pages/consultation.js`:
  - `slotOverrides` fallback 에 **3가지 가드** 추가: (a) 다른 consultation 이 이미 owner 인 slot entry 는 claim 금지, (b) status='입원완료'/'취소' consultation 은 재연결 금지, (c) 과거 admitDate(>2일) consultation 은 재연결 금지.
  - Auto-sync `useEffect` 에 **입원완료/취소 consultation 덮어쓰기 금지** 가드 추가.

### 재발 방지 가드
- **slot entry owner 보호**: 동명이인·재입원 상담 상황에서, 이름만으로 slot entry 를 가져가지 않음. 반드시 `consultationId` 가 비어있거나 같은 cid 인 entry 만 claim.
- **finalized consultation 은 frozen**: status='입원완료'/'취소' 는 slotOverrides 에서 재연결·데이터 덮어쓰기 대상 아님.
- **과거 admitDate 는 재연결 대상 아님**: 역사적 기록이 최근 slot 데이터로 오염되지 않도록 fallback 자체 차단.

### 검증·복구 도구
- `scripts/repairKangYounghee.js` — 강영희 전체 상담 조회 + createdAt 2026-01 상담을 `status=입원완료, reservedSlot=null` 로 되돌림. admitDate/dischargeDate 는 수동 확인용 (자동 변경 안 함). `--apply` 로 적용, 백업 자동.

### 연관 관찰
- 같은 버그 패턴: **동명 환자 + 과거 상담** 조합이면 모두 오염 가능. 비슷한 증상(과거 상담의 예약 정보가 "어제 방금 변경된 것처럼" 보임) 발견 시 `slotOverrides` fallback 이 재발한 것인지 먼저 확인.
- 2026-04-23 HOTFIX 항목 #5 (`syncConsultationOnSlotChange`) 의 "matches 전체 갱신" 수정과는 별개 경로. 이번 건은 fallback 이 애초에 잘못된 cid 를 link 한 것.

---

## 2026-04-23 — 재입원 예약 자동삭제 / 과거 실적 자동 예약화 / 드래그 원위치 잔존

### 증상
1. 상담일지에만 입력된 환자(예: 조미정 4/27)가 환자목록에서 검색되지 않음.
2. 조미정 4/27 입원예정 상담이 오늘자 '입원완료' 로 자동 전환(실제 입원 없음).
3. 서주영(보) 2025년 입원 실적이 2026-05-04 306-1 예약으로 자동 생성.
4. 박경옥2·설정희 재입원 예약이 타임라인에서 10분 내 자동 삭제.
5. 타임라인 드래그 이동 후 원위치에 바가 그대로 잔존, 한 번 삭제해야 사라짐.

### 근본 원인

| # | 원인 | 경로 |
|---|------|------|
| 1 | `pages/patients.js` 검색이 `patients/` 노드만 봄. `chartNo/patientId` 없는 상담예약 환자는 어떤 인덱스에도 없어 결과 0건 | 검색 로직 |
| 2 | `scripts/syncEMR.js` Phase 2.6 안전망(`b34ec35`, 2026-04-22 도입) 이 `consultation.reservedSlot === 현재 EMR 점유 slot` 조건만으로 `status='입원완료' + reservedSlot=null`. 같은 slot 다른 환자까지 덮어씀 | RPi sync |
| 3 | 오늘 오전 `restoreFutureAdmitCompleted.js` 로 33건 일괄 복원 시 M/D 만 저장된 과거 입원 실적(서주영(보) 포함)까지 '입원완료→예약완료' 로 되돌림. 이후 `pages/consultation.js` auto-restore (`a7394f8`) 가 `slots/306-1/reservations` 에 자동 생성 | 복원 과잉 + 클라이언트 |
| 4 | Phase 2 예약→입원 매칭(`82e51b5`) 이 "같은 slot + 이름 완전일치" 로 예약 제거. 재원 환자와 같은 slot 재입원 예약이 삭제. 또 Phase 2.6 안전망 chartNo 경로에 미래예약 가드 없음 → 다른 slot 재입원 예약 덮어씀 | RPi sync |
| 5 | `lib/WardDataContext.js` `syncConsultationOnSlotChange` 가 `matches[0]` 1건만 `reservedSlot=target` 갱신. 중복 상담이 있으면 나머지 reservedSlot 이 원래 slot 으로 남아 auto-restore 가 원위치 복원 | 클라이언트 |

### 수정 (커밋)
- `6d53c55` — Phase 2.6 안전망을 chart/pid/name+date 매칭으로 축소. 이름 폴백에도 admitDate 가드.
- `e4d7ccf` — `pages/patients.js` 에 `consultations/` 보조 검색 추가 (pseudo-patient). 중복 제거 규칙 포함.
- `c49a70d` — (1) auto-restore 스코프 축소: `createdAt != 올해` 또는 `M/D admitDate 가 올해 기준 2일 이상 과거` 면 스킵. (2) Phase 2 same-slot 매칭에 재입원 예약 가드. (3) Phase 2.6 안전망 chart/pid 경로에도 미래예약 보호. (4) `syncConsultationOnSlotChange` 가 matches 전체 갱신.

### 재발 방지 가드
- **auto-restore**: 과거 상담·과거 M/D admitDate 는 절대 복원 안 함. (과거 실적이 예약으로 튀어나오는 현상 차단.)
- **Phase 2 매칭**: `예약.admitDate ≠ EMR.admitDate && 예약.admitDate > 오늘` 이면 매칭에서 제외. (재입원 예약 보호.)
- **Phase 2.6 안전망**: chart/pid 일치해도 `consultation.admitDate` 가 미래이고 EMR admitDate 와 다르면 스킵.
- **드래그 이동**: 이동 시 동명·동일인 중복 상담의 reservedSlot 도 함께 업데이트.
- **일괄 복원 스크립트**: M/D 만 저장된 admitDate 는 연도 정보가 없어 "미래/과거" 판정이 불안정함 — 대량 state 전환 전에 반드시 createdAt 연도·레코드 source 도 함께 봐서 false positive 제외.

### 검증·복구 도구
- `scripts/auditFutureAdmitCompleted.js` — 미래 admitDate + status='입원완료' 탐지. createdAt 연도 오탐 제거 포함.
- `scripts/inspectJomijeong.js` / `scripts/inspectSlot206_5.js` / `scripts/inspectThreeBugs.js` — 특정 환자·슬롯 상태 덤프.
- `scripts/restoreJomijeong.js` / `scripts/restoreSeojuyoung.js` / `scripts/restoreFutureAdmitCompleted.js --apply` — 원복. 모두 `_backup_<ts>/...` 에 원본 저장.

### 연관 관찰
- 같은 사람이 `patients/` 와 `consultations/` 양쪽에 있을 때 dedupe 는 `chartNo → phone → name+birthYear` 순 강도. 신규 증상 발견 시 이 순서로 확인.
- `status='입원완료'` 는 auto-restore, syncEMR Phase 2/2.6 모두에서 "건드리지 말 것" 신호. 과거 실적 롤백은 항상 이 상태를 보존하는 것이 안전.

---

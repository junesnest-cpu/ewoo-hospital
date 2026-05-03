/**
 * 보안 이벤트 로깅 — ward RTDB `securityEvents/{YYYY-MM-DD}/{push-id}` 에 누적.
 *
 * Why: Vercel runtime logs API 의 짧은 retention 한계로 Stage 3 1주 모니터링 회고가
 *   불가능했다 (2026-05-03 점검에서 확인). 코드 자체에서 구조화된 이벤트를 self-host
 *   하면 다음 점검부터 일괄 조회·집계 가능.
 *
 * 통합 저장: 3프로젝트(hospital/approval/clinical) 모두 ward RTDB 의 같은 노드에 push.
 *   각 이벤트의 `project` 필드로 구분.
 *
 * fail-safe: db null 또는 write 실패 시 console.warn 만 남기고 통과.
 *   기존 console.warn/log(Vercel realtime logs) 는 그대로 유지 — 즉시 알림용 백업.
 *
 * retention: functions/index.js 의 scheduledSecurityEventCleanup 이 30일 이전 노드 삭제.
 *
 * type enum:
 *   - 'auth-enforce'   토큰 누락/무효로 401 차단
 *   - 'auth-audit'     audit 모드에서 토큰 누락 통과
 *   - 'role-enforce'   역할 미달로 403 차단 (approval)
 *   - 'role-audit'     audit 모드에서 역할 미달 통과 (approval)
 *   - 'rate-limit-hit' rate limit 거부 (key 메타로 어느 라우트인지 식별)
 *   - 'inquiry-honeypot' 외부 폼의 honeypot 필드 채워짐 (봇 의심)
 *   - 'migrate-sync'   approval/ward 한쪽만 인증되어 반대쪽 동기화 발생
 */
import { wardAdminDb } from './firebaseAdmin';

const PROJECT = 'hospital';

export async function logSecurityEvent(event) {
  if (!wardAdminDb || !event?.type) return;
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  try {
    await wardAdminDb.ref(`securityEvents/${ymd}`).push({
      project: PROJECT,
      ts: now.getTime(),
      ...event,
    });
  } catch (e) {
    console.warn(`[securityLog] write failed (${event.type}): ${e.message}`);
  }
}

/**
 * API 인증 헬퍼 — Firebase ID Token 검증
 *
 * verifyAuth(req): 토큰을 검증해 user 또는 null 반환 (저수준)
 *
 * requireAuth(req, res): 핸들러 초입에서 사용. AUTH_ENFORCE 환경변수로
 *   강제/관찰 모드 분기:
 *     - AUTH_ENFORCE='true'  : 토큰 없거나 무효면 401 응답 후 { ok:false }
 *     - 그 외 (audit 모드)   : 경고 로그만 남기고 { ok:false, audited:true } 반환,
 *                              호출자는 그대로 진행 가능
 *   호출 패턴:
 *     const a = await requireAuth(req, res);
 *     if (!a.ok && !a.audited) return; // enforce 모드에서 401 이미 응답됨
 *
 * approval·ward 양쪽 토큰 모두 수용 (통합 인증 환경).
 */
import { approvalAdminAuth, wardAdminAuth } from './firebaseAdmin';

export async function verifyAuth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;

  if (approvalAdminAuth) {
    try { return await approvalAdminAuth.verifyIdToken(token); } catch {}
  }
  if (wardAdminAuth) {
    try { return await wardAdminAuth.verifyIdToken(token); } catch {}
  }
  return null;
}

export async function requireAuth(req, res) {
  const user = await verifyAuth(req);
  if (user) return { ok: true, user };

  const enforce = process.env.AUTH_ENFORCE === 'true';
  const path = req.url || '?';
  console.warn(`[auth-${enforce ? 'enforce' : 'audit'}] ${req.method} ${path} — missing/invalid token`);

  if (enforce) {
    res.status(401).json({ error: 'unauthorized' });
    return { ok: false, audited: false };
  }
  return { ok: false, audited: true };
}

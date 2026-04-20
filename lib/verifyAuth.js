/**
 * API 인증 헬퍼 — Firebase ID Token 검증
 * 사용: const user = await verifyAuth(req); if (!user) return res.status(401)...
 *
 * approval·ward 양쪽 토큰 모두 수용 (통합 인증 환경).
 */
import { approvalAdminAuth, wardAdminAuth } from './firebaseAdmin';

export async function verifyAuth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;

  try { return await approvalAdminAuth.verifyIdToken(token); }
  catch {}
  try { return await wardAdminAuth.verifyIdToken(token); }
  catch {}
  return null;
}

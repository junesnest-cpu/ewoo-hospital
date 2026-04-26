/**
 * 전화 수신 알림 클레임 — "내가 받음" 버튼 클릭 시 호출.
 *
 * 인증: 사용자 ID 토큰 (requireAuth, AUTH_ENFORCE 적용).
 * 동작: incomingCalls/{id} 에 claimedBy/claimedAt 기록 (transaction 으로 race 방지).
 *   이미 다른 사람이 claim 했으면 409 + 누가 했는지 회신.
 */
import { requireAuth } from '../../../lib/verifyAuth';
import { wardAdminDb } from '../../../lib/firebaseAdmin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const a = await requireAuth(req, res);
  if (!a.ok && !a.audited) return;
  if (!a.user) return res.status(401).json({ error: 'auth required' });

  if (!wardAdminDb) return res.status(503).json({ error: 'admin not initialized' });

  const { id } = req.body || {};
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id required' });

  const claimer = a.user.email || a.user.uid || 'unknown';
  const ref = wardAdminDb.ref(`incomingCalls/${id}`);
  let outcome = null;
  try {
    const result = await ref.transaction(curr => {
      if (!curr) return;
      if (curr.claimedBy) {
        outcome = { conflict: true, by: curr.claimedBy };
        return;
      }
      curr.claimedBy = claimer;
      curr.claimedAt = Date.now();
      outcome = { ok: true, by: claimer };
      return curr;
    });
    if (!result.committed && outcome?.conflict) {
      return res.status(409).json({ error: 'already claimed', by: outcome.by });
    }
    if (!result.committed) {
      return res.status(404).json({ error: 'not found' });
    }
    return res.json({ ok: true, by: claimer });
  } catch (e) {
    console.error('[incoming-call/claim] failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

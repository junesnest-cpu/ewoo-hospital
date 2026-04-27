/**
 * 임시 디버그 endpoint (2026-04-27).
 * RTDB debug/incomingCallMismatch 의 최근 entry 반환.
 * 디버그 끝나면 제거.
 */
import { wardAdminDb } from '../../../lib/firebaseAdmin';

export default async function handler(req, res) {
  if (!wardAdminDb) return res.status(503).json({ error: 'admin not initialized' });
  try {
    const snap = await wardAdminDb.ref('debug/incomingCallMismatch').limitToLast(20).once('value');
    const entries = [];
    snap.forEach(child => {
      entries.push({ id: child.key, ...child.val() });
    });
    return res.json({ entries, count: entries.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

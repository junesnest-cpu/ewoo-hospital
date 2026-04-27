/**
 * 전화 수신 알림 — Android 앱이 incoming call 감지 시 POST.
 *
 * 인증: X-Incoming-Secret 헤더 (env INCOMING_CALL_SECRET).
 *   사용자 토큰 검증 안 함 (앱이 Firebase Auth 안 쓰므로).
 *   분실 시 즉시 env 회전 + 새 APK 배포로 차단 가능.
 *
 * 동작: incomingCalls/{pushId} 에 {phone, ts, claimedBy:null, claimedAt:null} push.
 *   1시간 이상 된 entry 는 부수적으로 cleanup (fire-and-forget).
 */
import { wardAdminDb } from '../../../lib/firebaseAdmin';

const MAX_AGE_MS = 60 * 60 * 1000;

function normalizePhone(s) {
  return String(s || '').replace(/\D/g, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = req.headers['x-incoming-secret'] || '';
  const expected = process.env.INCOMING_CALL_SECRET || '';
  if (!expected || secret !== expected) {
    const debug = {
      got: { len: secret.length, prefix: secret.slice(0, 4), suffix: secret.slice(-4) },
      expected: { len: expected.length, prefix: expected.slice(0, 4), suffix: expected.slice(-4) },
    };
    console.warn(`[incoming-call] secret mismatch ${JSON.stringify(debug)}`);
    // 디버그 응답 (2026-04-27 회전 후 제거)
    return res.status(401).json({ error: 'unauthorized', debug });
  }

  if (!wardAdminDb) {
    return res.status(503).json({ error: 'admin not initialized' });
  }

  const { phone } = req.body || {};
  const digits = normalizePhone(phone);
  if (!digits) return res.status(400).json({ error: 'phone required' });

  const ts = Date.now();
  const ref = wardAdminDb.ref('incomingCalls').push();
  try {
    await ref.set({ phone: digits, ts, claimedBy: null, claimedAt: null });
  } catch (e) {
    console.error('[incoming-call] push failed:', e.message);
    return res.status(500).json({ error: e.message });
  }

  (async () => {
    try {
      const cutoff = ts - MAX_AGE_MS;
      const oldSnap = await wardAdminDb.ref('incomingCalls')
        .orderByChild('ts').endAt(cutoff).once('value');
      const updates = {};
      oldSnap.forEach(ch => { updates[ch.key] = null; });
      if (Object.keys(updates).length > 0) {
        await wardAdminDb.ref('incomingCalls').update(updates);
      }
    } catch (e) {
      console.warn('[incoming-call] cleanup failed:', e.message);
    }
  })();

  return res.json({ ok: true, id: ref.key, ts });
}

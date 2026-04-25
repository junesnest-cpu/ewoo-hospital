/**
 * Rate limit / dedup 유틸 (Firebase RTDB 기반).
 *
 * 사용:
 *   import { checkRateLimit, getClientIp } from '../../../lib/rateLimit';
 *   const ip = getClientIp(req);
 *   const rl = await checkRateLimit({ key: `migrate/${ip}__${email}`, max:5, windowMs:5*60*1000, db: approvalAdminDb });
 *   if (!rl.allowed) return res.status(429).json({ error:'too many', retryAfter: rl.retryAfter });
 *
 * 설계:
 *   - sliding window. windowMs 안에 max 회 초과하면 거부.
 *   - 저장: rateLimits/{key}/{timestamp}: true
 *   - cleanup: 매 호출마다 만료 entry fire-and-forget 삭제 (성능 저하 회피)
 *   - 실패 fail-open: RTDB 장애 시 차단보다 통과 (사용자 lockout 방지)
 *
 * key 규약:
 *   - Firebase 키는 . / # $ [ ] 금지 → IP 점·콜론 모두 _ 로 정규화 필수.
 *   - 호출자가 sanitizeKey() 또는 직접 정규화한 값 사용.
 */

export function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'] || '';
  const ip = (xff.split(',')[0] || '').trim() || req.socket?.remoteAddress || 'unknown';
  return sanitizeKey(ip);
}

export function sanitizeKey(s) {
  return String(s || '').replace(/[.#$\[\]\/]/g, '_').replace(/:/g, '_');
}

export async function checkRateLimit({ key, max, windowMs, db }) {
  if (!db) {
    console.warn('[rateLimit] db missing — fail-open');
    return { allowed: true, count: 0 };
  }
  const ref = db.ref(`rateLimits/${key}`);
  const now = Date.now();
  const windowStart = now - windowMs;

  let entries;
  try {
    const snap = await ref.once('value');
    entries = snap.val() || {};
  } catch (e) {
    console.warn(`[rateLimit] read failed for ${key}: ${e.message} — fail-open`);
    return { allowed: true, count: 0 };
  }

  const allTimes = Object.keys(entries).map(Number).filter(Number.isFinite);
  const recentTimes = allTimes.filter(t => t > windowStart);

  if (recentTimes.length >= max) {
    const oldest = Math.min(...recentTimes);
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfter, count: recentTimes.length };
  }

  // 새 entry 기록 (정상 path 만)
  try {
    await ref.child(String(now)).set(true);
  } catch (e) {
    console.warn(`[rateLimit] write failed for ${key}: ${e.message} — fail-open`);
    // 쓰기 실패해도 통과 (read는 성공한 상태)
  }

  // 만료 entry cleanup — fire-and-forget
  const expired = allTimes.filter(t => t <= windowStart);
  if (expired.length > 0) {
    const updates = {};
    for (const t of expired) updates[String(t)] = null;
    ref.update(updates).catch(() => {});
  }

  return { allowed: true, count: recentTimes.length + 1 };
}

/**
 * Dedup: 같은 key 가 windowMs 안에 이미 있으면 거부.
 * 인구학적 중복 검출용 (예: 동일 phone+content 의 문의 중복).
 */
export async function checkDedup({ key, windowMs, db }) {
  if (!db) {
    console.warn('[checkDedup] db missing — fail-open');
    return { duplicate: false };
  }
  const ref = db.ref(`dedupKeys/${key}`);
  const now = Date.now();
  const windowStart = now - windowMs;

  let prevAt;
  try {
    const snap = await ref.once('value');
    prevAt = Number(snap.val()) || 0;
  } catch (e) {
    console.warn(`[checkDedup] read failed for ${key}: ${e.message} — fail-open`);
    return { duplicate: false };
  }

  if (prevAt > windowStart) {
    return { duplicate: true, prevAt };
  }

  try {
    await ref.set(now);
  } catch (e) {
    console.warn(`[checkDedup] write failed for ${key}: ${e.message}`);
  }
  return { duplicate: false };
}

/**
 * 양방향 Auth 동기화 API (approval ↔ ward)
 *
 * 흐름:
 *   1) approval·ward REST 양쪽 인증 시도 (최소 한쪽 성공 필요)
 *   2) 한쪽만 성공 → 반대쪽 계정 생성/비밀번호 업데이트 (정답: 성공한 쪽)
 *   3) 둘 다 성공 → 동기화 불필요
 *   4) 양쪽 실패 → 401
 *
 * ewoo-hospital은 approval(로그인)과 ward(RTDB 접근) 양쪽 세션이 필요하므로
 * 이 엔드포인트 호출 후 클라이언트는 두 auth에 signInWithEmailAndPassword 재시도.
 */
import { approvalAdminAuth, approvalAdminDb, wardAdminAuth } from "../../../lib/firebaseAdmin";
import publicConfig from "../../../lib/firebasePublicConfig.json";
import { checkRateLimit, getClientIp, sanitizeKey } from "../../../lib/rateLimit";

const APPROVAL_API_KEY = publicConfig.approval.apiKey;
const WARD_API_KEY     = publicConfig.ward.apiKey;

async function signInREST(apiKey, email, password) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  if (!res.ok) return null;
  return res.json(); // { localId, ... }
}

async function ensureAccount(adminAuth, email, password, preferredUid) {
  let user;
  try {
    user = await adminAuth.getUserByEmail(email);
    await adminAuth.updateUser(user.uid, { password });
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    try {
      user = await adminAuth.createUser({ uid: preferredUid, email, password });
    } catch {
      user = await adminAuth.createUser({ email, password });
    }
  }
  return user;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email·password required" });

  // Rate limit: (IP + email) 키로 5분당 5회.
  // password spraying 차단 + 정상 사용자(평생 0~3회 호출)는 영향 없음.
  const rlKey = `migrate/${getClientIp(req)}__${sanitizeKey(email)}`;
  const rl = await checkRateLimit({ key: rlKey, max: 5, windowMs: 5 * 60 * 1000, db: approvalAdminDb });
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({
      error: "too many login attempts",
      retryAfter: rl.retryAfter,
    });
  }

  try {
    const [approvalAuth, wardAuthRes] = await Promise.all([
      signInREST(APPROVAL_API_KEY, email, password),
      signInREST(WARD_API_KEY, email, password),
    ]);

    if (!approvalAuth && !wardAuthRes) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    // 한쪽만 성공한 경우 반대쪽 동기화
    if (approvalAuth && !wardAuthRes) {
      await ensureAccount(wardAdminAuth, email, password, approvalAuth.localId);
    } else if (!approvalAuth && wardAuthRes) {
      const user = await ensureAccount(approvalAdminAuth, email, password, wardAuthRes.localId);
      // /users 프로필 uid 동기화 (신규 생성 시)
      const emailKey = email.replace(/\./g, ",").replace(/@/g, "_at_");
      const profRef = approvalAdminDb.ref(`users/${emailKey}`);
      const snap = await profRef.once("value");
      if (snap.exists()) await profRef.update({ uid: user.uid });
    }

    return res.status(200).json({ ok: true, approvalOk: !!approvalAuth, wardOk: !!wardAuthRes });
  } catch (e) {
    console.error("sync error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}

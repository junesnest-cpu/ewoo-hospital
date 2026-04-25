/**
 * 인증 헤더 자동 부착 fetch 래퍼.
 *
 * 사용:
 *   import { apiFetch } from '../lib/apiFetch';
 *   const res = await apiFetch('/api/foo', { method:'POST', body: ... });
 *
 * - 로그인된 사용자가 있으면 Authorization: Bearer <ID Token> 자동 부착
 * - 토큰이 없거나 만료된 경우(로그인 전 등) 헤더 생략 — 호출은 그대로 시도됨
 *   (서버측 audit 모드에서는 통과, enforce 모드에서는 401)
 */
import { auth } from './firebaseConfig';

export async function apiFetch(url, opts = {}) {
  let token = null;
  try {
    token = (await auth.currentUser?.getIdToken()) || null;
  } catch {
    token = null;
  }

  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  return fetch(url, { ...opts, headers });
}

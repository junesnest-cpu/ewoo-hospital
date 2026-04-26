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
 *
 * stale token 자동 복구 (2026-04-26 추가):
 *   getIdToken() 은 기본 캐시 토큰 반환 (1h 유효, 만료 5분 전 자동 refresh).
 *   refresh 와 호출 사이 race window 가 존재 → enforce 모드에서 401 가능.
 *   401 응답 시 1회에 한해 강제 refresh(getIdToken(true)) 후 재시도.
 *   네트워크 장애 후 복귀, 노트북 절전 후 재개 등에서 사용자 경험 보호.
 */
import { auth } from './firebaseConfig';

async function fetchWithToken(url, opts, forceRefresh) {
  let token = null;
  try {
    token = (await auth.currentUser?.getIdToken(forceRefresh)) || null;
  } catch {
    token = null;
  }

  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...opts, headers });
}

export async function apiFetch(url, opts = {}) {
  const res = await fetchWithToken(url, opts, false);

  // 401 + 로그인 상태인 경우만 강제 refresh 재시도.
  // 토큰이 애초에 없는(로그아웃) 상태면 retry 의미 없음.
  if (res.status === 401 && auth.currentUser) {
    return fetchWithToken(url, opts, true);
  }
  return res;
}

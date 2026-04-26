/**
 * Firebase Admin SDK - 서버사이드 전용
 * approval Admin: 사용자 생성·비밀번호 업데이트·custom token 발급 (통합 인증)
 * ward Admin:     ward Auth 비밀번호 동기화·custom token 발급
 *
 * safeInit 패턴 (2026-04-26):
 *   ENV 누락·PEM 파싱 실패 시 throw 대신 null 반환.
 *   import 가 죽으면 모든 라우트가 500 → audit 모드로 안전 fallback 가능하도록.
 *   approval 의 동일 패턴(`10f38d8`) 을 hospital 로 포팅.
 *   호출자는 null 체크 후 사용 (verifyAuth 등은 try/catch 로 우회).
 */
import admin from "firebase-admin";

function safeInit(name, projectId, clientEmail, privateKeyRaw, databaseURL) {
  const existing = admin.apps.find(a => a?.name === name);
  if (existing) return existing;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    console.warn(`[firebaseAdmin] ${name}: ENV 미설정 — 비활성 (audit 모드에서만 안전)`);
    return null;
  }

  try {
    return admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey: privateKeyRaw.replace(/\\n/g, "\n"),
      }),
      databaseURL,
    }, name);
  } catch (e) {
    console.warn(`[firebaseAdmin] ${name}: init 실패 (${e.code || e.name}: ${e.message}) — 비활성. literal \\n 형식인지 확인 (HOTFIX 2026-04-25 참조)`);
    return null;
  }
}

const approvalAdminApp = safeInit(
  "approval-admin",
  process.env.APPROVAL_FIREBASE_PROJECT_ID,
  process.env.APPROVAL_FIREBASE_CLIENT_EMAIL,
  process.env.APPROVAL_FIREBASE_PRIVATE_KEY,
  "https://ewoo-approval-default-rtdb.firebaseio.com",
);

const wardAdminApp = safeInit(
  "ward-admin",
  process.env.FIREBASE_PROJECT_ID,
  process.env.FIREBASE_CLIENT_EMAIL,
  process.env.FIREBASE_PRIVATE_KEY,
  "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
);

export const approvalAdminApp2 = approvalAdminApp;
export const approvalAdminAuth = approvalAdminApp?.auth() ?? null;
export const approvalAdminDb   = approvalAdminApp?.database() ?? null;
export const wardAdminApp2     = wardAdminApp;
export const wardAdminAuth     = wardAdminApp?.auth() ?? null;
export const wardAdminDb       = wardAdminApp?.database() ?? null;

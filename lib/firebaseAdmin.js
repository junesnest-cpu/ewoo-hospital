/**
 * Firebase Admin SDK - 서버사이드 전용
 * approval Admin: 사용자 생성·비밀번호 업데이트·custom token 발급 (통합 인증)
 * ward Admin:     ward Auth 비밀번호 동기화·custom token 발급
 */
import admin from "firebase-admin";

function initApp(name, config) {
  const existing = admin.apps.find(a => a?.name === name);
  if (existing) return existing;
  return admin.initializeApp(config, name);
}

const approvalKey = process.env.APPROVAL_FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const approvalAdminApp = initApp("approval-admin", {
  credential: admin.credential.cert({
    projectId:   process.env.APPROVAL_FIREBASE_PROJECT_ID,
    clientEmail: process.env.APPROVAL_FIREBASE_CLIENT_EMAIL,
    privateKey:  approvalKey,
  }),
  databaseURL: "https://ewoo-approval-default-rtdb.firebaseio.com",
});

const wardKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
const wardAdminApp = initApp("ward-admin", {
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  wardKey,
  }),
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
});

export const approvalAdminApp2 = approvalAdminApp;
export const approvalAdminAuth = approvalAdminApp.auth();
export const approvalAdminDb   = approvalAdminApp.database();
export const wardAdminApp2     = wardAdminApp;
export const wardAdminAuth     = wardAdminApp.auth();
export const wardAdminDb       = wardAdminApp.database();

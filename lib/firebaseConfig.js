import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import publicConfig from "./firebasePublicConfig.json";

// Firebase web client config(공개 식별자)는 firebasePublicConfig.json 단일 소스
// ewoo-hospital-ward — 치료계획·병상·환자 데이터 (RTDB)
const wardConfig = publicConfig.ward;
// ewoo-approval — 통합 사용자 인증 (3개 프로젝트 공통)
const approvalConfig = publicConfig.approval;

const wardApp = getApps().length === 0 ? initializeApp(wardConfig) : getApps()[0];

let approvalApp;
try { approvalApp = getApp("approval"); }
catch { approvalApp = initializeApp(approvalConfig, "approval"); }

// 데이터 접근
export const db          = getDatabase(wardApp);         // ward RTDB (기존 유지)
export const storage     = getStorage(wardApp);
export const approvalDb  = getDatabase(approvalApp);     // approval RTDB (/users 프로필 참조)

// 인증: approval이 소스 오브 트루스
export const auth        = getAuth(approvalApp);

// 자동 마이그레이션용 ward Auth (fallback 전용, 이관 완료 후 제거 예정)
export const wardAuth    = getAuth(wardApp);

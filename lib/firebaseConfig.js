import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";

// ewoo-hospital-ward — 치료계획·병상·환자 데이터 (RTDB)
const wardConfig = {
  apiKey:            "AIzaSyAgr-alU71ZZj12S3MvCQKJQVdS6w-G3E4",
  authDomain:        "ewoo-hospital-ward.firebaseapp.com",
  databaseURL:       "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
  projectId:         "ewoo-hospital-ward",
  storageBucket:     "ewoo-hospital-ward.firebasestorage.app",
  messagingSenderId: "678990173440",
  appId:             "1:678990173440:web:2fa6878d9dff7d4039cfe5",
};

// ewoo-approval — 통합 사용자 인증 (3개 프로젝트 공통). client config는 공개 가능.
const approvalConfig = {
  apiKey:      "AIzaSyCajixUUY0le1NhvO2hMCJoPA_pffjs1rE",
  authDomain:  "ewoo-approval.firebaseapp.com",
  databaseURL: "https://ewoo-approval-default-rtdb.firebaseio.com",
  projectId:   "ewoo-approval",
  storageBucket: "ewoo-approval.firebasestorage.app",
  messagingSenderId: "100727939665",
  appId:       "1:100727939665:web:d5778c183f7bd2586a8e70",
};

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

import { initializeApp, getApps } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey:            "AIzaSyAgr-alU71ZZj12S3MvCQKJQVdS6w-G3E4",
  authDomain:        "ewoo-hospital-ward.firebaseapp.com",
  databaseURL:       "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
  projectId:         "ewoo-hospital-ward",
  storageBucket:     "ewoo-hospital-ward.firebasestorage.app",
  messagingSenderId: "678990173440",
  appId:             "1:678990173440:web:2fa6878d9dff7d4039cfe5",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const db   = getDatabase(app);
export const auth = getAuth(app);

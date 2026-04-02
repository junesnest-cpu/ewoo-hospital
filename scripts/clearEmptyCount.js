/**
 * 세금계산서 건수(count) 정리 스크립트
 *
 * 금액(amount)이 비어있거나 0인 항목의 건수(count)를 "" 로 초기화합니다.
 *
 * 사용법: node scripts/clearEmptyCount.js [--dry-run]
 *   --dry-run  실제 수정 없이 변경 예정 내용만 출력
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { initializeApp }   = require("firebase/app");
const { getDatabase, ref, get, update } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const DRY_RUN = process.argv.includes("--dry-run");

const firebaseConfig = {
  apiKey:      "AIzaSyAgr-alU71ZZj12S3MvCQKJQVdS6w-G3E4",
  authDomain:  "ewoo-hospital-ward.firebaseapp.com",
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
  projectId:   "ewoo-hospital-ward",
};
const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

function isEmptyAmount(amt) {
  if (amt === "" || amt === null || amt === undefined) return true;
  const n = Number(String(amt).replace(/[₩,\s]/g, ""));
  return n === 0;
}

async function main() {
  if (DRY_RUN) console.log("🔍 DRY-RUN 모드 (실제 수정 없음)\n");

  await signInWithEmailAndPassword(auth, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  console.log("✅ Firebase 로그인 완료\n");

  const snap = await get(ref(db, "approvals"));
  let totalDocs = 0, totalFixed = 0;

  const updates = [];

  snap.forEach(child => {
    const d = child.val();
    if (d.type !== "tax" || !d.formData?.groups) return;

    const docId = child.key;
    const groups = d.formData.groups;
    let docFixed = 0;

    const updatedGroups = groups.map(g => ({
      ...g,
      items: (g.items || []).map(it => {
        if (it.count && it.count !== "" && isEmptyAmount(it.amount)) {
          docFixed++;
          if (DRY_RUN) {
            console.log(`  [${d.formData.reportMonth || docId}] ${it.vendor || ""} | ${it.content || ""} | 금액=${it.amount} → 건수 "${it.count}" ➜ ""`);
          }
          return { ...it, count: "" };
        }
        return it;
      }),
    }));

    if (docFixed > 0) {
      totalDocs++;
      totalFixed += docFixed;
      updates.push({ docId, updatedGroups });
    }
  });

  if (!DRY_RUN) {
    for (const { docId, updatedGroups } of updates) {
      await update(ref(db, `approvals/${docId}`), {
        "formData/groups": updatedGroups,
        updatedAt: Date.now(),
      });
      console.log(`✅ ${docId} 업데이트 완료`);
    }
  }

  console.log(`\n${DRY_RUN ? "🔍 시뮬레이션" : "🎉 수정"} 완료: ${totalDocs}개 문서, 총 ${totalFixed}건`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e); process.exit(1); });

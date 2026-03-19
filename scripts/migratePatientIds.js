/**
 * 기존 patients에 internalId 부여 + 역인덱스 생성
 * 사용법: node scripts/migratePatientIds.js
 */

require("dotenv").config({ path: ".env.local" });
const admin = require("firebase-admin");

const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
});
const db = admin.database();

function padId(n) {
  return "P" + String(n).padStart(5, "0"); // P00001 ~ P99999
}

function normalizePhone(raw) {
  if (!raw) return "";
  return String(raw).replace(/\D/g, "");
}

async function main() {
  console.log("📥 Firebase에서 patients 읽는 중...");
  const snap = await db.ref("patients").once("value");
  const patients = snap.val();

  if (!patients) { console.log("❌ patients 데이터 없음"); process.exit(1); }

  const entries = Object.entries(patients); // [chartNo, data]
  console.log(`📊 총 ${entries.length}명`);

  // 접수일자 기준 정렬 (오래된 순 → 낮은 번호)
  entries.sort((a, b) => {
    const da = a[1].lastAdmitDate || "";
    const db2 = b[1].lastAdmitDate || "";
    return da < db2 ? -1 : da > db2 ? 1 : 0;
  });

  const updates = {};
  let seq = 1;
  let dupPhone = 0;
  const phoneSet = new Set();

  for (const [chartNo, data] of entries) {
    const internalId = padId(seq++);
    const phone = normalizePhone(data.phone);

    // patients에 internalId 추가
    updates[`patients/${chartNo}/internalId`] = internalId;
    updates[`patients/${chartNo}/phone`] = phone; // 정규화된 번호로 덮어쓰기

    // 차트번호 역인덱스
    updates[`patientByChartNo/${chartNo}`] = internalId;

    // 전화번호 역인덱스 (중복 전화번호는 첫 번째 우선)
    if (phone && phone.length >= 10) {
      if (phoneSet.has(phone)) {
        dupPhone++;
      } else {
        phoneSet.add(phone);
        updates[`patientByPhone/${phone}`] = internalId;
      }
    }
  }

  // 카운터 저장 (신규 환자 등록 시 이어서 사용)
  updates["patientCounter/lastSeq"] = seq - 1;

  console.log(`✅ internalId 부여: ${seq - 1}명`);
  console.log(`📱 전화번호 인덱스: ${phoneSet.size}개 (중복 ${dupPhone}건 제외)`);
  console.log("🔥 Firebase 저장 중...");

  // 500개씩 나눠서 업로드
  const allEntries = Object.entries(updates);
  const BATCH = 500;
  for (let i = 0; i < allEntries.length; i += BATCH) {
    const batch = Object.fromEntries(allEntries.slice(i, i + BATCH));
    await db.ref("/").update(batch);
    console.log(`  ↑ ${Math.min(i + BATCH, allEntries.length)} / ${allEntries.length}`);
  }

  console.log("\n🎉 마이그레이션 완료!");
  console.log(`   internalId 범위: P00001 ~ ${padId(seq - 1)}`);
  console.log(`   다음 신규 환자: ${padId(seq)}`);
  process.exit(0);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });

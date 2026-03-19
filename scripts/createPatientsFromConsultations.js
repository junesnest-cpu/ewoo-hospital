/**
 * 미매칭 상담일지 → patients 신규 생성
 * (상담만 받고 입원 안 한 분들 + 전화번호 불일치 분들)
 *
 * 사용법:
 *   node scripts/createPatientsFromConsultations.js --dry
 *   node scripts/createPatientsFromConsultations.js --run
 */

require("dotenv").config({ path: ".env.local" });
const admin = require("firebase-admin");
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
admin.initializeApp({
  credential: admin.credential.cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey }),
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
});
const db = admin.database();

const isDry = !process.argv.includes("--run");

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}
function padId(n) { return "P" + String(n).padStart(5, "0"); }

async function main() {
  console.log(isDry ? "🔍 DRY RUN\n" : "🔥 LIVE RUN\n");

  console.log("📥 데이터 로딩 중...");
  const [cSnap, piSnap, counterSnap] = await Promise.all([
    db.ref("consultations").once("value"),
    db.ref("patientByPhone").once("value"),
    db.ref("patientCounter/lastSeq").once("value"),
  ]);

  const consultations = cSnap.val() || {};
  const phoneIndex    = piSnap.val() || {};
  let   seq           = counterSnap.val() || 0;

  // 미매칭 상담만 추출 (patientId 없고, 전화번호/이름 미매칭)
  const unlinked = Object.entries(consultations).filter(([, c]) => !c.patientId);
  console.log(`미연결 상담: ${unlinked.length}건\n`);

  const updates = {};
  let created = 0, skippedDot = 0, skippedDupPhone = 0;
  const phoneCreated = new Set(); // 이번 실행에서 생성한 전화번호 추적

  for (const [cId, con] of unlinked) {
    const name  = (con.name || "").trim();
    const phone = normalizePhone(con.phone);

    // '.' 이름 등 유효하지 않은 항목 건너뜀
    if (!name || name === "." || name.length < 2) { skippedDot++; continue; }

    // 전화번호가 이미 인덱스에 있으면 그걸 연결 (이번 배치에서 새로 만든 것 포함)
    if (phone && phone.length >= 10) {
      const existingId = phoneIndex[phone] || phoneCreated.get?.(phone);
      if (existingId) {
        // 상담에 연결만 추가
        updates[`consultations/${cId}/patientId`] = existingId;
        skippedDupPhone++;
        continue;
      }
    }

    // 신규 환자 생성
    seq++;
    const internalId = padId(seq);
    const dbKey = internalId; // 차트번호 없으므로 internalId를 키로

    const patient = {
      internalId,
      name,
      phone: phone || "",
      birthDate:  "", // 상담일지엔 birthYear만 있음
      birthYear:  con.birthYear || con.age || "",
      gender:     "",
      address:    "",
      doctor:     "",
      diagnosis:  con.diagnosis || "",
      chartNo:    "",
      source:     "consultation", // 상담일지에서 생성됨 표시
      createdAt:  new Date().toISOString(),
    };

    updates[`patients/${dbKey}`]      = patient;
    updates[`consultations/${cId}/patientId`] = internalId;
    if (phone && phone.length >= 10) {
      updates[`patientByPhone/${phone}`] = internalId;
      if (!phoneCreated.set) phoneCreated.set = (k, v) => phoneCreated[k] = v;
      phoneCreated.set(phone, internalId);
    }
    created++;
  }

  updates["patientCounter/lastSeq"] = seq;

  console.log(`✅ 신규 환자 생성: ${created}명`);
  console.log(`🔗 전화번호 중복 연결: ${skippedDupPhone}건`);
  console.log(`⏭  이름 없음 건너뜀: ${skippedDot}건`);
  console.log(`📊 총 업데이트: ${Object.keys(updates).length}건`);
  console.log(`   최종 patientCounter: P${String(seq).padStart(5,"0")}`);

  if (!isDry) {
    console.log("\n🔥 Firebase 저장 중...");
    const entries = Object.entries(updates);
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      await db.ref("/").update(Object.fromEntries(entries.slice(i, i + BATCH)));
      console.log(`  ↑ ${Math.min(i + BATCH, entries.length)} / ${entries.length}`);
    }
    console.log("🎉 완료!");
  } else {
    console.log("\n▶ 실제 저장: node scripts/createPatientsFromConsultations.js --run");
  }

  process.exit(0);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });

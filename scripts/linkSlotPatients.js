/**
 * 병실 미매칭 환자 처리
 * - '신)' 접두어 제거 후 재검색 또는 신규 생성
 * - 동명이인은 전화번호 없으므로 최신 입원일 기준으로 선택
 *
 * 사용법:
 *   node scripts/linkSlotPatients.js --dry
 *   node scripts/linkSlotPatients.js --run
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
function padId(n) { return "P" + String(n).padStart(5, "0"); }

async function main() {
  console.log(isDry ? "🔍 DRY RUN\n" : "🔥 LIVE RUN\n");

  const [sSnap, pSnap, counterSnap] = await Promise.all([
    db.ref("slots").once("value"),
    db.ref("patients").once("value"),
    db.ref("patientCounter/lastSeq").once("value"),
  ]);

  const slots   = sSnap.val() || {};
  const patients = pSnap.val() || {};
  let   seq      = counterSnap.val() || 0;

  // 이름 → [patient] 맵 (internalId 있는 것만)
  const byName = {};
  Object.values(patients).forEach(p => {
    if (!p.internalId || !p.name) return;
    if (!byName[p.name]) byName[p.name] = [];
    byName[p.name].push(p);
  });

  const updates = {};
  let linked = 0, created = 0, ambiguous = 0;

  function processEntry(slotKey, entry, path) {
    if (!entry?.name || entry.patientId) return;

    const rawName = entry.name.trim();
    // '신)' 접두어 제거
    const cleanName = rawName.replace(/^신\)/, "").trim();

    // 정제된 이름으로 검색
    const matches = (byName[cleanName] || []).filter(p => p.internalId);

    if (matches.length === 1) {
      // 유일 매칭
      updates[`slots/${path}/patientId`] = matches[0].internalId;
      linked++;
      if (rawName !== cleanName) {
        console.log(`  [자동] ${slotKey} "${rawName}" → ${matches[0].internalId} (${cleanName})`);
      }
    } else if (matches.length > 1) {
      // 동명이인: 가장 최근 입원일 기준으로 선택
      const sorted = matches.sort((a, b) =>
        (b.lastAdmitDate || "").localeCompare(a.lastAdmitDate || "")
      );
      updates[`slots/${path}/patientId`] = sorted[0].internalId;
      linked++;
      ambiguous++;
      console.log(`  [동명이인→최신] ${slotKey} "${rawName}" → ${sorted[0].internalId} (${sorted[0].birthDate})`);
    } else {
      // 완전 미매칭 → 신규 생성
      seq++;
      const internalId = padId(seq);
      updates[`patients/${internalId}`] = {
        internalId, name: cleanName, phone: "", birthDate: "", gender: "",
        address: "", doctor: "", diagnosis: "", chartNo: "",
        source: "slot", createdAt: new Date().toISOString(),
      };
      updates[`slots/${path}/patientId`] = internalId;
      created++;
      console.log(`  [신규생성] ${slotKey} "${rawName}" → ${internalId}`);
    }
  }

  for (const [slotKey, slot] of Object.entries(slots)) {
    if (slot?.current?.name && !slot.current.patientId) {
      processEntry(slotKey, slot.current, `${slotKey}/current`);
    }
    (slot?.reservations || []).forEach((r, ri) => {
      if (r?.name && !r.patientId) {
        processEntry(slotKey, r, `${slotKey}/reservations/${ri}`);
      }
    });
  }

  updates["patientCounter/lastSeq"] = seq;

  console.log(`\n✅ 자동 연결: ${linked - ambiguous}건`);
  console.log(`⚠  동명이인(최신선택): ${ambiguous}건`);
  console.log(`➕ 신규 생성: ${created}명`);
  console.log(`📊 최종 patientCounter: ${padId(seq)}`);

  if (!isDry && Object.keys(updates).length > 0) {
    console.log("\n🔥 Firebase 저장 중...");
    const entries = Object.entries(updates);
    for (let i = 0; i < entries.length; i += 500) {
      await db.ref("/").update(Object.fromEntries(entries.slice(i, i + 500)));
    }
    console.log("🎉 완료!");
  } else if (isDry) {
    console.log("\n▶ 실제 저장: node scripts/linkSlotPatients.js --run");
  }

  process.exit(0);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });

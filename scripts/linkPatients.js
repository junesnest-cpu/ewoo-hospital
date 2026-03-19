/**
 * 기존 데이터 → patients 연동 스크립트
 * 1차: 상담일지 (전화번호 매칭)
 * 2차: 병실 slots (이름 매칭)
 *
 * 사용법:
 *   node scripts/linkPatients.js --dry     (결과 확인만)
 *   node scripts/linkPatients.js --run     (실제 저장)
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

async function main() {
  console.log(isDry ? "🔍 DRY RUN (저장 안 함)\n" : "🔥 LIVE RUN (Firebase 저장)\n");

  // ── 데이터 로드 ──────────────────────────────────────────────────────────
  console.log("📥 데이터 로딩 중...");
  const [pSnap, cSnap, sSnap, piSnap] = await Promise.all([
    db.ref("patients").once("value"),
    db.ref("consultations").once("value"),
    db.ref("slots").once("value"),
    db.ref("patientByPhone").once("value"),
  ]);

  const patients     = pSnap.val() || {};
  const consultations = cSnap.val() || {};
  const slots        = sSnap.val() || {};
  const phoneIndex   = piSnap.val() || {};

  // patients를 internalId로도 조회할 수 있게 맵 생성
  const byInternalId = {};
  const byName = {};  // name → [patient, ...]
  Object.values(patients).forEach(p => {
    if (p.internalId) byInternalId[p.internalId] = p;
    if (p.name) {
      if (!byName[p.name]) byName[p.name] = [];
      byName[p.name].push(p);
    }
  });

  console.log(`patients: ${Object.keys(patients).length}명`);
  console.log(`consultations: ${Object.keys(consultations).length}건`);
  console.log(`slots: 입원 ${Object.values(slots).filter(s=>s?.current?.name).length}명 / 예약 ${Object.values(slots).reduce((n,s)=>n+(s?.reservations?.length||0),0)}건\n`);

  const updates = {};

  // ════════════════════════════════════════════════════════════════════════
  // 1단계: 상담일지 → 전화번호 매칭
  // ════════════════════════════════════════════════════════════════════════
  console.log("═".repeat(50));
  console.log("① 상담일지 전화번호 매칭");
  console.log("═".repeat(50));

  let cLinked = 0, cNoPhone = 0, cNoMatch = 0, cNameMatch = 0, cAlready = 0;
  const cUnmatched = [];

  for (const [cId, con] of Object.entries(consultations)) {
    if (con.patientId) { cAlready++; continue; }

    const phone = normalizePhone(con.phone);

    // 전화번호로 검색
    if (phone && phone.length >= 10) {
      const internalId = phoneIndex[phone];
      if (internalId) {
        const p = byInternalId[internalId];
        updates[`consultations/${cId}/patientId`] = internalId;
        cLinked++;
        continue;
      }
    } else {
      cNoPhone++;
    }

    // 전화번호 실패 → 이름으로 재시도 (internalId 있는 것만)
    const matches = (byName[con.name?.trim()] || []).filter(p => p.internalId);
    if (matches.length === 1) {
      updates[`consultations/${cId}/patientId`] = matches[0].internalId;
      cNameMatch++;
    } else {
      cUnmatched.push({ id: cId, name: con.name, phone: con.phone, candidates: matches.length });
      cNoMatch++;
    }
  }

  console.log(`✅ 전화번호 매칭: ${cLinked}건`);
  console.log(`✅ 이름 매칭:     ${cNameMatch}건`);
  console.log(`⏭  이미 연결됨:  ${cAlready}건`);
  console.log(`⚠  전화번호 없음: ${cNoPhone}건`);
  console.log(`❌ 미매칭:        ${cNoMatch}건`);
  if (cUnmatched.length > 0) {
    console.log("\n미매칭 상담일지 (최대 20건):");
    cUnmatched.slice(0, 20).forEach(u =>
      console.log(`  - ${u.name} (${u.phone||"번호없음"}) 후보:${u.candidates}명`)
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 2단계: 병실 slots → 이름 매칭
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n" + "═".repeat(50));
  console.log("② 병실 입원/예약 이름 매칭");
  console.log("═".repeat(50));

  let sLinked = 0, sAmbiguous = 0, sNoMatch = 0, sAlready = 0;
  const sAmbiguousList = [];
  const sNoMatchList   = [];

  for (const [slotKey, slot] of Object.entries(slots)) {
    // current 환자
    if (slot?.current?.name) {
      if (slot.current.patientId) { sAlready++; }
      else {
        const matches = (byName[slot.current.name] || []).filter(p => p.internalId);
        if (matches.length === 1) {
          updates[`slots/${slotKey}/current/patientId`] = matches[0].internalId;
          sLinked++;
        } else if (matches.length > 1) {
          sAmbiguousList.push({ slotKey, name: slot.current.name, type: "입원", candidates: matches });
          sAmbiguous++;
        } else {
          sNoMatchList.push({ slotKey, name: slot.current.name, type: "입원" });
          sNoMatch++;
        }
      }
    }

    // 예약 환자
    (slot?.reservations || []).forEach((r, ri) => {
      if (!r?.name) return;
      if (r.patientId) { sAlready++; return; }
      const matches = (byName[r.name] || []).filter(p => p.internalId);
      if (matches.length === 1) {
        updates[`slots/${slotKey}/reservations/${ri}/patientId`] = matches[0].internalId;
        sLinked++;
      } else if (matches.length > 1) {
        sAmbiguousList.push({ slotKey, name: r.name, type: "예약", candidates: matches });
        sAmbiguous++;
      } else {
        sNoMatchList.push({ slotKey, name: r.name, type: "예약" });
        sNoMatch++;
      }
    });
  }

  console.log(`✅ 이름 자동 매칭: ${sLinked}건`);
  console.log(`⏭  이미 연결됨:   ${sAlready}건`);
  console.log(`⚠  동명이인 (수동 확인 필요): ${sAmbiguous}건`);
  console.log(`❌ 미매칭 (신규 등록 필요):   ${sNoMatch}건`);

  if (sAmbiguousList.length > 0) {
    console.log("\n동명이인 목록:");
    sAmbiguousList.forEach(u => {
      console.log(`  ${u.slotKey} [${u.type}] ${u.name}`);
      u.candidates.forEach(c =>
        console.log(`    후보: ${c.internalId} | ${c.birthDate} | ${c.phone}`)
      );
    });
  }

  if (sNoMatchList.length > 0) {
    console.log("\n미매칭 환자 (patients DB에 없음):");
    sNoMatchList.forEach(u =>
      console.log(`  ${u.slotKey} [${u.type}] ${u.name}`)
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // 저장
  // ════════════════════════════════════════════════════════════════════════
  const totalUpdates = Object.keys(updates).length;
  console.log(`\n📊 총 업데이트 예정: ${totalUpdates}건`);
  console.log(`   (상담 ${cLinked + cNameMatch}건 + 병실 ${sLinked}건)`);

  if (!isDry && totalUpdates > 0) {
    console.log("🔥 Firebase 저장 중...");
    const entries = Object.entries(updates);
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      await db.ref("/").update(Object.fromEntries(entries.slice(i, i + BATCH)));
      console.log(`  ↑ ${Math.min(i + BATCH, entries.length)} / ${entries.length}`);
    }
    console.log("🎉 연동 완료!");
  } else if (isDry) {
    console.log("\n▶ 실제 저장하려면: node scripts/linkPatients.js --run");
  }

  process.exit(0);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });

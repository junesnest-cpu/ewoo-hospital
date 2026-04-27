/**
 * treatmentPlansV2 leak 감사
 *   2026-04-21 마이그레이션이 treatmentPlans/{slotKey} 전체를 현재 입원환자
 *   {pid}/{aKey} 아래로 그대로 복사 — slot 에 누적된 과거 환자들의 plan 까지
 *   같이 옮겨졌다. 결과: {pid}/{aKey}/{monthBeforeAdmit}/{day} 엔트리가 잔존,
 *   치료계획표 month 네비를 admit 이전 달로 옮기면 다른 환자 치료가 표시됨.
 *
 *   이 스크립트는 leak 후보를 보고만 함 (write 없음). cleanup 은 별도 스크립트.
 */
require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});
const db = admin.database();

(async () => {
  const [tpSnap, patSnap] = await Promise.all([
    db.ref('treatmentPlansV2').once('value'),
    db.ref('patients').once('value'),
  ]);
  const tp = tpSnap.val() || {};
  const patients = patSnap.val() || {};

  let totalPids = 0, totalAdmits = 0, leakedAdmits = 0, leakedDays = 0, leakedItems = 0;
  const samples = [];

  for (const [pid, byAdmit] of Object.entries(tp)) {
    if (!byAdmit || typeof byAdmit !== 'object') continue;
    totalPids++;
    const pname = patients[pid]?.name || patients[pid]?.lastName || '';
    for (const [aKey, byMonth] of Object.entries(byAdmit)) {
      if (!byMonth || typeof byMonth !== 'object') continue;
      totalAdmits++;
      const admitYM = aKey.slice(0, 7); // "YYYY-MM"
      let admitLeakMonths = [];
      let admitLeakDays = 0, admitLeakItems = 0;
      for (const [mk, byDay] of Object.entries(byMonth)) {
        if (!byDay || typeof byDay !== 'object') continue;
        // mk 형식 "YYYY-MM"
        if (mk >= admitYM) continue; // admit 월 이후는 정상
        admitLeakMonths.push(mk);
        for (const [dk, items] of Object.entries(byDay)) {
          const arr = Array.isArray(items) ? items : items ? Object.values(items) : [];
          if (arr.length === 0) continue;
          admitLeakDays++;
          admitLeakItems += arr.length;
        }
      }
      if (admitLeakMonths.length > 0) {
        leakedAdmits++;
        leakedDays += admitLeakDays;
        leakedItems += admitLeakItems;
        if (samples.length < 15) {
          samples.push({ pid, pname, aKey, leakMonths: admitLeakMonths.sort(), leakDays: admitLeakDays, leakItems: admitLeakItems });
        }
      }
    }
  }

  console.log('═ treatmentPlansV2 pre-admit leak 감사 ═');
  console.log(`  patient 총: ${totalPids}`);
  console.log(`  admission 총: ${totalAdmits}`);
  console.log(`  leak 있는 admission: ${leakedAdmits}`);
  console.log(`  leak 일자 합계: ${leakedDays}`);
  console.log(`  leak item 합계: ${leakedItems}`);
  if (samples.length > 0) {
    console.log('\n  샘플 (최대 15건):');
    samples.forEach(s => {
      console.log(`    [${s.pid}] ${s.pname} aKey=${s.aKey}`);
      console.log(`      leakMonths=${s.leakMonths.join(',')} days=${s.leakDays} items=${s.leakItems}`);
    });
  }
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

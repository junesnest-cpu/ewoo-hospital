/**
 * 박보영 환자 추적: 현재 slot 위치, 예전 305-1 상태, consultations 기록
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

async function main() {
  const [slotsSnap, consulSnap, mbSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
    db.ref('monthlyBoards/2026-04').once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const consultations = consulSnap.val() || {};
  const mb = mbSnap.val() || {};

  console.log('═ 박보영 slot.current 위치 ═');
  for (const [slotKey, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    if (cur?.name && cur.name.includes('박보영')) {
      console.log(`  ${slotKey}: ${JSON.stringify(cur, null, 2)}`);
    }
    const res = slot?.reservations || [];
    res.forEach((r, i) => {
      if (r?.name && r.name.includes('박보영')) {
        console.log(`  ${slotKey}/reservations[${i}]: ${JSON.stringify(r)}`);
      }
    });
  }

  console.log('\n═ 305-1 전체 slot 상태 ═');
  console.log(JSON.stringify(slots['305-1'], null, 2));

  console.log('\n═ 박보영 consultations ═');
  Object.entries(consultations).forEach(([id, c]) => {
    if (c?.name && c.name.includes('박보영')) {
      console.log(`  ${id}: name="${c.name}" status="${c.status}" reservedSlot="${c.reservedSlot||''}" admit=${c.admitDate||''} dis=${c.dischargeDate||''} chart=${c.chartNo||''} pid=${c.patientId||''}`);
    }
  });

  console.log('\n═ 박보영 monthlyBoards 2026-04 ═');
  Object.entries(mb).forEach(([dateStr, day]) => {
    const adm = (day.admissions || []).filter(a => a.name && a.name.includes('박보영'));
    const dis = (day.discharges || []).filter(d => d.name && d.name.includes('박보영'));
    if (adm.length || dis.length) {
      console.log(`  ${dateStr}:`);
      adm.forEach(a => console.log(`    ⬆ 입원: ${JSON.stringify(a)}`));
      dis.forEach(d => console.log(`    ⬇ 퇴원: ${JSON.stringify(d)}`));
    }
  });

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

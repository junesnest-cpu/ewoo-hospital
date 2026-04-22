/**
 * 김은정 이름의 모든 흔적 탐지 (slot current/reservations, consultations, timeline 관련)
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

function baseName(n) {
  return (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim().toLowerCase();
}

async function main() {
  const target = '김은정';
  const [slotsSnap, consulSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('consultations').once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const consultations = consulSnap.val() || {};

  // 1) slot.current 전체 탐색
  console.log('═ slot.current 중 baseName "김은정" 매칭 ═');
  for (const [sk, slot] of Object.entries(slots)) {
    const n = slot?.current?.name;
    if (n && baseName(n) === target) {
      console.log(`  ${sk} current: ${JSON.stringify(slot.current)}`);
    }
  }

  console.log('\n═ slot.reservations 중 baseName "김은정" 매칭 ═');
  for (const [sk, slot] of Object.entries(slots)) {
    (slot?.reservations || []).forEach((r, i) => {
      if (r?.name && baseName(r.name) === target) {
        console.log(`  ${sk}/reservations[${i}]: ${JSON.stringify(r)}`);
      }
    });
  }

  console.log('\n═ 601-3 전체 구조 (모든 키) ═');
  console.log(JSON.stringify(slots['601-3'], null, 2));

  console.log('\n═ consultations 중 baseName "김은정" 매칭 ═');
  Object.entries(consultations).forEach(([id, c]) => {
    if (c?.name && baseName(c.name) === target) {
      console.log(`  ${id}: name="${c.name}" status="${c.status}" reservedSlot="${c.reservedSlot||''}" chart=${c.chartNo||''} pid=${c.patientId||''} admit=${c.admitDate||''} dis=${c.dischargeDate||''} isNewPatient=${c.isNewPatient||false}`);
    }
  });

  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

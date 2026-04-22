/**
 * 304-2 박보영 discharge = 미정 / 504-2 김진순3 discharge = 4/26 정정
 * 동시에 해당 consultation 의 dischargeDate 도 동기화.
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
  const updates = {};

  // 1) 박보영 304-2: discharge 제거 (미정)
  updates['slots/304-2/current/discharge'] = null;
  updates['consultations/import_1058/dischargeDate'] = null;
  console.log('  박보영 (304-2): discharge → 미정, consultation import_1058 dischargeDate → null');

  // 2) 김진순3 504-2: discharge = 4/26
  updates['slots/504-2/current/discharge'] = '4/26';
  // 김진순3 consultation 은 검색으로 처리 (여러 건일 수 있음)
  const consulSnap = await db.ref('consultations').once('value');
  const consultations = consulSnap.val() || {};
  for (const [cid, c] of Object.entries(consultations)) {
    if (!c || c.status === '취소') continue;
    // 현재 입원인 김진순3 consultation
    if (c.patientId === 'P08139' && c.reservedSlot === '504-2') {
      updates[`consultations/${cid}/dischargeDate`] = '4/26';
      console.log(`  김진순3 consultation ${cid}: dischargeDate → 4/26`);
    }
  }
  updates['slots/504-2/current/discharge'] = '4/26';
  console.log('  김진순3 (504-2): discharge → 4/26');

  await db.ref('/').update(updates);
  console.log('\n✅ 완료');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

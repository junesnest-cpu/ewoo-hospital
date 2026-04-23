/**
 * 조미정 4/27 입원예정 상담일지 상태 원복
 *   syncEMR.js Phase 2.6 이름 폴백 매칭 버그로 status='입원완료' 잘못 승격된 케이스.
 *   reservedSlot=206-5 가 보존되어 있으므로 status 만 '예약완료' 로 되돌린다.
 *
 * 참고: chartNo/patientId 는 여전히 비어있음 → 실제 입원(4/27) 시 EMR 싱크가 다시 연결.
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

const TARGET_ID = '-OqnUE9xptwQjmCnZHLd';

(async () => {
  const ref = db.ref(`consultations/${TARGET_ID}`);
  const snap = await ref.once('value');
  const c = snap.val();
  if (!c) { console.log('❌ 대상 없음'); process.exit(1); }
  console.log(`before: name="${c.name}" status="${c.status}" admitDate=${c.admitDate} reservedSlot=${c.reservedSlot || '-'}`);
  if (c.status !== '입원완료') {
    console.log('⚠ 이미 입원완료 아님 — 스킵');
    process.exit(0);
  }
  await ref.update({ status: '예약완료' });
  const after = (await ref.once('value')).val();
  console.log(`after : name="${after.name}" status="${after.status}" admitDate=${after.admitDate} reservedSlot=${after.reservedSlot || '-'}`);
  console.log('✅ 복원 완료');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

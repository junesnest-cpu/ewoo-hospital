/**
 * 조주원 import_1207 (2026-02-06 등록 레거시) 정리
 *   증상: 같은 chartNo + 같은 admitDate(4/27) 인 -OqijM4sjFPQPUALHhMm 이
 *         이미 4/21 자로 정식 예약(slot=205-4) 을 잡았으나, 2월 import_1207 이
 *         status="상담중" + admitDate="4/27" + reservedSlot=null 로 남아 있어
 *         consultation 카드가 "병실 배정 필요" 노란 카드로 잘못 표시됨.
 *   조치: import_1207 의 status 를 "취소" 로 변경 (reservedSlot 은 이미 null).
 *         원본 보존: _backup_repairJoJuwon_<ts>/import_1207 에 백업.
 *
 *   --apply 가 없으면 dry-run.
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

const APPLY = process.argv.includes('--apply');
const TARGET_ID = 'import_1207';

(async () => {
  const snap = await db.ref(`consultations/${TARGET_ID}`).once('value');
  const c = snap.val();
  if (!c) {
    console.error(`❌ consultations/${TARGET_ID} 가 없습니다`);
    process.exit(1);
  }
  console.log('현재 상태:');
  console.log(`  name=${c.name} status=${c.status} admitDate=${c.admitDate} reservedSlot=${c.reservedSlot || '-'}`);
  console.log(`  chartNo=${c.chartNo} createdAt=${c.createdAt}`);

  if (c.status === '취소') {
    console.log('이미 status="취소" — 변경 없음.');
    process.exit(0);
  }

  if (!APPLY) {
    console.log('\n[dry-run] --apply 없이 실행 — status 를 "취소" 로 바꿀 예정. 실제 변경 안 함.');
    process.exit(0);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `_backup_repairJoJuwon_${ts}/${TARGET_ID}`;
  await db.ref(backupPath).set(c);
  console.log(`백업: ${backupPath}`);

  await db.ref(`consultations/${TARGET_ID}`).update({ status: '취소' });
  console.log('적용: status="취소"');

  const after = (await db.ref(`consultations/${TARGET_ID}`).once('value')).val();
  console.log(`확인: status=${after.status}`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

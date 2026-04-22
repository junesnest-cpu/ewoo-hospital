/**
 * syncEMR 유령퇴원 회수 중 잘못 삭제된 4/30 안미선 예약 퇴원 기록 복구
 *   - 2026-04-30 안미선(302호)  : 현재 입원 안미선의 퇴원 예정 등록
 *   - 2026-04-30 안미선(305호)  : (추가 파악 필요. 동명이인/이전기록 가능성)
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
  const ref = db.ref('monthlyBoards/2026-04/2026-04-30/discharges');
  const snap = await ref.once('value');
  const arr = snap.val() || [];
  const existingNames = new Set(arr.map(d => `${d?.name}|${d?.room}`));
  const toAdd = [];
  if (!existingNames.has('안미선|302')) toAdd.push({ name: '안미선', room: '302', note: '' });
  if (!existingNames.has('안미선|305')) toAdd.push({ name: '안미선', room: '305', note: '' });
  if (toAdd.length === 0) {
    console.log('⚠ 4/30 안미선 기록이 이미 존재. 복구 불필요.');
    process.exit(0);
  }
  const updated = [...arr, ...toAdd];
  await ref.set(updated);
  console.log(`✅ 4/30 discharges 에 ${toAdd.length}건 복구: ${toAdd.map(d=>`${d.name}(${d.room})`).join(', ')}`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

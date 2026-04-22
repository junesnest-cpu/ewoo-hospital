/**
 * monthlyBoards 의 잘못 기록된 퇴원 항목 제거
 *   - 2026-04-22 박보영 (305호): 병실 이동(305-1→304-2) 을 퇴원으로 오탐한 흔적
 *   - 2026-04-19 박보영 (201호): 추가 검토 필요 (박보영이 과거 201 호에 없었을 가능성)
 *
 * 실제 박보영은 현재 304-2 에 정상 입원 중 (EMR 확인됨).
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
  const target = '2026-04-22';
  const boardRef = db.ref(`monthlyBoards/2026-04/${target}`);
  const snap = await boardRef.once('value');
  const bd = snap.val();
  if (!bd) { console.log(`${target} 기록 없음`); process.exit(0); }

  const before = bd.discharges || [];
  const after  = before.filter(d => !(d && d.name === '박보영' && d.room === '305'));
  if (after.length === before.length) {
    console.log(`⚠ ${target}/discharges 에서 '박보영 (305호)' 못 찾음`);
  } else {
    await boardRef.update({ discharges: after });
    console.log(`✅ ${target}/discharges 에서 박보영(305) 제거 — ${before.length} → ${after.length}건`);
  }

  // 참고용 출력 (4/19 박보영 201호 — 정리 여부 사용자 결정 필요)
  const snap419 = await db.ref('monthlyBoards/2026-04/2026-04-19').once('value');
  const bd419 = snap419.val();
  if (bd419?.discharges) {
    const park201 = bd419.discharges.filter(d => d?.name === '박보영' && d?.room === '201');
    if (park201.length) {
      console.log(`\nℹ 2026-04-19/discharges 에도 박보영(201호) 기록 존재:`);
      park201.forEach(d => console.log(`   ${JSON.stringify(d)}`));
      console.log(`   → 이 기록도 유령이면 사용자 확인 후 별도 제거 필요`);
    }
  }

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

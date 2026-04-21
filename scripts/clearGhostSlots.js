/**
 * 오늘 퇴원했지만 slot.current 에 남아있는 2건(박민경 201-2, 문경옥 205-5) 정리.
 * monthlyBoards 2026-04-21 discharges 에 기록되어 EMR 에서도 퇴원 처리됨.
 *
 * 실행: node scripts/clearGhostSlots.js --apply
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
const GHOSTS = [
  { slotKey: '201-2', name: '박민경' },
  { slotKey: '205-5', name: '문경옥' },
];

async function main() {
  const updates = {};
  for (const g of GHOSTS) {
    const snap = await db.ref(`slots/${g.slotKey}/current`).once('value');
    const cur = snap.val();
    console.log(`${g.slotKey} · ${g.name}`);
    console.log(`  current: ${cur ? JSON.stringify(cur) : 'null'}`);
    updates[`slots/${g.slotKey}/current`] = null;
  }

  if (!APPLY) { console.log('\n🟢 DRY RUN — --apply'); process.exit(0); }

  await db.ref('/').update(updates);
  console.log('\n✅ 두 슬롯 current = null 로 정리');
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });

/**
 * 박민경(201-2), 문경옥(205-5) 최종 정리:
 *   1. 관련 consultations 상태 = "입원완료", reservedSlot = null
 *   2. slot.current = null
 *
 * auto-restore 체인(consultation → reservation → 자동승격)을 끊기 위함.
 *
 * 실행: node scripts/finalizeGhostSlots.js --apply
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

const TARGETS = [
  { name: '박민경', slotKey: '201-2' },
  { name: '문경옥', slotKey: '205-5' },
];

function norm(n) { return (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim(); }

async function main() {
  const updates = {};

  // 1. consultations 상태 갱신
  const consSnap = await db.ref('consultations').once('value');
  const cons = consSnap.val() || {};

  for (const target of TARGETS) {
    const t = norm(target.name);
    const matched = [];
    for (const [cid, c] of Object.entries(cons)) {
      if (c?.name && norm(c.name) === t && c.reservedSlot === target.slotKey) {
        matched.push({ cid, ...c });
      }
    }
    console.log(`\n${target.slotKey} · ${target.name}`);
    console.log(`  매칭 consultations: ${matched.length}건`);
    for (const m of matched) {
      console.log(`    ${m.cid} status=${m.status} admitDate=${m.admitDate}`);
      updates[`consultations/${m.cid}/status`] = '입원완료';
      updates[`consultations/${m.cid}/reservedSlot`] = null;
    }
  }

  // 2. slot.current 비우기
  for (const target of TARGETS) {
    updates[`slots/${target.slotKey}/current`] = null;
  }

  console.log(`\n총 업데이트: ${Object.keys(updates).length}개 경로`);

  if (!APPLY) {
    console.log('\n🟢 DRY RUN — --apply 로 실제 실행');
    console.log('\n실행될 업데이트:');
    Object.entries(updates).forEach(([k, v]) => console.log(`  ${k} = ${JSON.stringify(v)}`));
    process.exit(0);
  }

  await db.ref('/').update(updates);
  console.log('\n✅ 완료');
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });

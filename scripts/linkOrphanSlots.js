/**
 * slot.current.patientId 가 비어있는 두 건에 patientId 연결 + admitDate 정규화.
 * 실행: node scripts/linkOrphanSlots.js --apply
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

const FIXES = [
  { slotKey: '201-2', patientId: 'P01711', admitDate: '2026-04-17', chartNo: '0000006913', name: '박민경' },
  { slotKey: '205-5', patientId: 'P01692', admitDate: '2026-04-20', chartNo: '0000006892', name: '문경옥' },
];

async function main() {
  console.log('🔍 현재 slot.current 상태 확인...\n');

  const updates = {};
  for (const fix of FIXES) {
    const snap = await db.ref(`slots/${fix.slotKey}/current`).once('value');
    const cur = snap.val() || {};
    console.log(`${fix.slotKey} · ${fix.name}`);
    console.log(`  BEFORE: patientId=${cur.patientId || '-'} admitDate=${cur.admitDate || '-'} chartNo=${cur.chartNo || '-'}`);

    const newCur = { ...cur,
      patientId: fix.patientId,
      admitDate: fix.admitDate,
      chartNo: cur.chartNo || fix.chartNo,
    };
    console.log(`  AFTER : patientId=${newCur.patientId} admitDate=${newCur.admitDate} chartNo=${newCur.chartNo}`);
    console.log('');

    updates[`slots/${fix.slotKey}/current`] = newCur;
  }

  if (!APPLY) {
    console.log('🟢 DRY RUN — --apply 로 실제 쓰기');
    process.exit(0);
  }

  await db.ref('/').update(updates);
  console.log('✅ 완료');
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

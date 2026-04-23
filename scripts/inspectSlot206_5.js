/**
 * 206-5 slot 현재 상태 + emrSyncLog 최근 로그 확인
 *   조미정 입원완료 덮어쓰기 원인을 역추적.
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
  const [slotSnap, logSnap, linkSnap] = await Promise.all([
    db.ref('slots/206-5').once('value'),
    db.ref('emrSyncLog').once('value'),
    db.ref('emrSyncLog/consultationLinking').once('value'),
  ]);
  const slot = slotSnap.val() || {};
  console.log('═ slots/206-5 ═');
  console.log('  current:', JSON.stringify(slot.current || null));
  console.log('  reservations:');
  (slot.reservations || []).forEach((r, i) => {
    console.log(`    [${i}] ${JSON.stringify(r)}`);
  });

  console.log('\n═ emrSyncLog (상위 필드) ═');
  const log = logSnap.val() || {};
  Object.entries(log).forEach(([k, v]) => {
    if (typeof v === 'object') {
      console.log(`  ${k}: (object, keys=${Object.keys(v).length})`);
    } else {
      console.log(`  ${k}: ${v}`);
    }
  });

  console.log('\n═ 조미정 최신 값 ═');
  const conSnap = await db.ref('consultations/-OqnUE9xptwQjmCnZHLd').once('value');
  console.log(JSON.stringify(conSnap.val(), null, 2));

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

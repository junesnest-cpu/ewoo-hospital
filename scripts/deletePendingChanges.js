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
  const snap = await db.ref('pendingChanges').once('value');
  const val = snap.val();
  const count = val ? Object.keys(val).length : 0;
  console.log(`현재 pendingChanges 항목: ${count}개`);
  if (count === 0) { console.log('삭제할 것 없음'); process.exit(0); }

  // 백업
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await db.ref(`_backup_${ts}/pendingChanges`).set(val);
  console.log(`백업: _backup_${ts}/pendingChanges`);

  // 삭제
  await db.ref('pendingChanges').remove();
  console.log('✅ pendingChanges 삭제 완료');
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });

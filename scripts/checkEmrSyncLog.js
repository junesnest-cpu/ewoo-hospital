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
  const [logSnap, logsSnap] = await Promise.all([
    db.ref('emrSyncLog').once('value'),
    db.ref('logs').limitToLast(50).once('value'),
  ]);
  console.log('═ emrSyncLog 전체 ═');
  console.log(JSON.stringify(logSnap.val(), null, 2));

  console.log('\n═ 최근 logs (관련만) ═');
  const logs = logsSnap.val();
  if (Array.isArray(logs)) {
    logs.filter(l => l && (l.type === 'emr' || l.msg?.includes('EMR') || l.action?.includes('입원') || l.action?.includes('퇴원'))).slice(-30).forEach(l => {
      console.log(` [${l.ts?.slice(0,19)||'-'}] ${l.type || l.action || '?'}: ${l.msg || JSON.stringify(l).slice(0, 150)}`);
    });
  } else if (logs) {
    Object.values(logs).filter(l => l && (l.type === 'emr' || l.msg?.includes('EMR'))).slice(-30).forEach(l => {
      console.log(` [${l.ts?.slice(0,19)||'-'}] ${l.msg || '?'}`);
    });
  }
  process.exit(0);
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });

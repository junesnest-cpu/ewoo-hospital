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
  const today = '2026-04-22';
  const [mbSnap, dbSnap] = await Promise.all([
    db.ref(`monthlyBoards/2026-04/${today}`).once('value'),
    db.ref(`dailyBoards/${today}`).once('value'),
  ]);
  console.log(`═ monthlyBoards/2026-04/${today} ═`);
  console.log(JSON.stringify(mbSnap.val(), null, 2));
  console.log(`\n═ dailyBoards/${today} ═`);
  console.log(JSON.stringify(dbSnap.val(), null, 2));
  process.exit(0);
})();

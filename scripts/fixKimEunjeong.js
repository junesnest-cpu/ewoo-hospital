/**
 * import_0501 (601-3 유령 예약 소스) 정리 — auto-restore 차단
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
  await db.ref('consultations/import_0501').update({
    reservedSlot: null,
    status: '입원완료',
    chartNo: '0000006720',
    patientId: 'P01760',
  });
  console.log('✅ import_0501 정리 완료 (reservedSlot=null + 입원완료 + 식별자 연결)');
  process.exit(0);
})();

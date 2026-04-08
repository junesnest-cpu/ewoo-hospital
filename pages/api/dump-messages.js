import admin from 'firebase-admin';

function getAdminDb() {
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
      databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
    });
  }
  return admin.database();
}

export default async function handler(req, res) {
  try {
    const db = getAdminDb();
    const snap = await db.ref('pendingChanges').orderByChild('ts').once('value');
    const data = snap.val() || {};

    // 메시지와 파싱 결과만 추출
    const messages = Object.values(data).map(item => ({
      ts: item.ts,
      message: item.message,
      action: item.parsed?.action,
      name: item.parsed?.name,
      dischargeDate: item.parsed?.dischargeDate,
      admitDate: item.parsed?.admitDate,
      note: item.parsed?.note,
      status: item.status,
    })).sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));

    res.status(200).json({ count: messages.length, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

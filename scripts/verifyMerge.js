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
  console.log('═ 조은주3 (chart=0000006876, 3건 병합) ═');
  const ids = ['import_0979', 'import_0982', '-OobaPPH_fIe666pPLXO'];
  for (const id of ids) {
    const c = (await db.ref(`consultations/${id}`).once('value')).val();
    console.log(`  ${id}:  status=${c?.status}  mergedInto=${c?.mergedInto || '-'}  name=${c?.name}`);
  }
  const s = (await db.ref('slots/202-1/current').once('value')).val();
  console.log(`  slot 202-1 current.consultationId: ${s?.consultationId || '-'}`);

  console.log('\n═ 이화진 (chart=0000007066, 2건 병합) ═');
  for (const id of ['import_0652', '-OnpGEVZrgcZll6SD9y5']) {
    const c = (await db.ref(`consultations/${id}`).once('value')).val();
    console.log(`  ${id}:  status=${c?.status}  mergedInto=${c?.mergedInto || '-'}  note="${(c?.note||'').slice(0,60)}"`);
  }
  const s2 = (await db.ref('slots/204-2/current').once('value')).val();
  console.log(`  slot 204-2 current.consultationId: ${s2?.consultationId || '-'}`);

  console.log('\n═ 한명규 재입원 (chart=0000006614, D 보존) ═');
  for (const id of ['import_0224', 'import_0275', 'import_0280']) {
    const c = (await db.ref(`consultations/${id}`).once('value')).val();
    console.log(`  ${id}:  status=${c?.status}  mergedInto=${c?.mergedInto || '-'}  admitDate=${c?.admitDate || '-'}`);
  }

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

require('dotenv').config({ path: '.env.local' });
const admin = require('firebase-admin');
const pk = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: pk,
  }),
  databaseURL: 'https://ewoo-hospital-ward-default-rtdb.firebaseio.com',
});

(async () => {
  const log = await admin.database().ref('roomSyncLog').once('value');
  console.log('roomSyncLog:', JSON.stringify(log.val(), null, 2));

  const plans = await admin.database().ref('treatmentPlans').once('value');
  const pl = plans.val() || {};
  const slots = (await admin.database().ref('slots').once('value')).val() || {};

  const samples = [];
  const counts = {};
  for (const sk of Object.keys(pl)) {
    for (const mk of Object.keys(pl[sk] || {})) {
      for (const dk of Object.keys(pl[sk][mk] || {})) {
        const items = pl[sk][mk][dk];
        const arr = Array.isArray(items) ? items : Object.values(items || {});
        for (const it of arr) {
          if (it?.room === 'removed') {
            counts[it.id] = (counts[it.id] || 0) + 1;
            if (samples.length < 8) {
              const patient = slots[sk]?.current?.name || '(없음)';
              samples.push({ sk, patient, date: `${mk}/${dk}`, id: it.id, emr: it.emr || '-', qty: it.qty });
            }
          }
        }
      }
    }
  }
  console.log('\n치료명별 room:removed 집계:', counts);
  console.log('\n샘플 태깅 항목 (최대 8개):');
  samples.forEach(s => console.log(' ', s));
  process.exit(0);
})();

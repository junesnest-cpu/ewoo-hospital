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

const TARGETS = ['박민경', '문경옥'];

function norm(n) { return (n || '').replace(/^신\)\s*/, '').replace(/\s/g, '').trim(); }

async function main() {
  const [patientsSnap, consSnap] = await Promise.all([
    db.ref('patients').once('value'),
    db.ref('consultations').once('value'),
  ]);
  const patients = patientsSnap.val() || {};
  const cons = consSnap.val() || {};

  for (const target of TARGETS) {
    console.log(`\n═══ ${target} ═══`);
    const t = norm(target);

    console.log('\n[patients 마스터 매칭]');
    const pMatches = [];
    for (const [key, p] of Object.entries(patients)) {
      if (p?.name && norm(p.name) === t) {
        pMatches.push({ key, ...p });
      }
    }
    if (pMatches.length === 0) console.log('  ❌ 없음');
    else pMatches.forEach(p => {
      console.log(`  ✓ internalId=${p.internalId || p.key} chartNo=${p.chartNo || '-'} admitDate=${p.admitDate || '-'} phone=${p.phone || '-'}`);
    });

    console.log('\n[consultations 매칭]');
    const cMatches = [];
    for (const [cid, c] of Object.entries(cons)) {
      if (c?.name && norm(c.name) === t) {
        cMatches.push({ cid, ...c });
      }
    }
    if (cMatches.length === 0) console.log('  ❌ 없음');
    else cMatches.forEach(c => {
      console.log(`  ✓ cid=${c.cid} status=${c.status || '-'} reservedSlot=${c.reservedSlot || '-'} admitDate=${c.admitDate || '-'} patientId=${c.patientId || '-'} isNew=${c.isNewPatient}`);
    });
  }
  process.exit(0);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

/**
 * 조미정 상담일지/슬롯/EMR 상태 점검
 *   - consultations 중 baseName 이 '조미정' 인 모든 건
 *   - slots 중 current/reservations 에 조미정 이 있는 슬롯
 *   - chartNo 인덱스
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

const baseName = (n) => (n || '').replace(/^신\)\s*/, '').replace(/\d+$/, '').replace(/\s/g, '').trim();

(async () => {
  const [conSnap, slotSnap] = await Promise.all([
    db.ref('consultations').once('value'),
    db.ref('slots').once('value'),
  ]);
  const cons = conSnap.val() || {};
  const slots = slotSnap.val() || {};

  console.log('═ consultations 중 baseName=조미정 ═');
  const matched = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c || baseName(c.name) !== '조미정') continue;
    matched.push({ id, ...c });
  }
  matched.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  matched.forEach(c => {
    console.log(`  ${c.id}`);
    console.log(`     name="${c.name}" status="${c.status || ''}" admitDate=${c.admitDate || '-'} dischargeDate=${c.dischargeDate || '-'}`);
    console.log(`     chartNo=${c.chartNo || '-'} patientId=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'}`);
    console.log(`     createdAt=${c.createdAt || '-'} mergedInto=${c.mergedInto || '-'} recontact=${c.recontact || '-'}`);
  });

  console.log('\n═ slots 중 조미정 (current / reservations) ═');
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && baseName(cur.name) === '조미정') {
      console.log(`  [current] ${sk} name="${cur.name}" chart=${cur.chartNo || '-'} admit=${cur.admitDate || '-'} discharge=${cur.discharge || '-'} consultationId=${cur.consultationId || '-'}`);
    }
    const res = slot.reservations || [];
    res.forEach((r, i) => {
      if (r && baseName(r.name) === '조미정') {
        console.log(`  [res#${i}]  ${sk} name="${r.name}" admit=${r.admitDate || '-'} discharge=${r.discharge || '-'} consultationId=${r.consultationId || '-'}`);
      }
    });
  }

  console.log('\n═ patientByChartNo (참고) ═');
  const pbcSnap = await db.ref('patientByChartNo').once('value');
  const pbc = pbcSnap.val() || {};
  const chartsFromCon = [...new Set(matched.map(c => c.chartNo).filter(Boolean))];
  chartsFromCon.forEach(ch => {
    console.log(`  chartNo=${ch} → internalId=${pbc[ch] || '-'}`);
  });

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

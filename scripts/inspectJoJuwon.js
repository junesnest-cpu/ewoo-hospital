/**
 * 조주원 상담일지/슬롯 상태 점검
 *   - consultations 중 baseName 이 '조주원' 인 모든 건
 *   - slots 중 current/reservations 에 조주원 이 있는 슬롯
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

  console.log('═ consultations 중 baseName=조주원 ═');
  const matched = [];
  for (const [id, c] of Object.entries(cons)) {
    if (!c || baseName(c.name) !== '조주원') continue;
    matched.push({ id, ...c });
  }
  matched.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  matched.forEach(c => {
    console.log(`  ${c.id}`);
    console.log(`     name="${c.name}" status="${c.status || ''}" admitDate=${c.admitDate || '-'} dischargeDate=${c.dischargeDate || '-'}`);
    console.log(`     phone=${c.phone || '-'} phone2=${c.phone2 || '-'} birthYear=${c.birthYear || '-'}`);
    console.log(`     chartNo=${c.chartNo || '-'} patientId=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'}`);
    console.log(`     createdAt=${c.createdAt || '-'} updatedAt=${c.updatedAt || '-'} mergedInto=${c.mergedInto || '-'}`);
    console.log(`     diagnosis=${c.diagnosis || '-'} hospital=${c.hospital || '-'}`);
  });

  console.log('\n═ slots 중 조주원 (current / reservations) ═');
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && baseName(cur.name) === '조주원') {
      console.log(`  [current] ${sk} name="${cur.name}" chart=${cur.chartNo || '-'} admit=${cur.admitDate || '-'} discharge=${cur.discharge || '-'} consultationId=${cur.consultationId || '-'}`);
    }
    const res = slot.reservations || [];
    res.forEach((r, i) => {
      if (r && baseName(r.name) === '조주원') {
        console.log(`  [res#${i}]  ${sk} name="${r.name}" admit=${r.admitDate || '-'} discharge=${r.discharge || '-'} consultationId=${r.consultationId || '-'}`);
      }
    });
  }

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

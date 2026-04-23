/**
 * 세 가지 진단:
 *   1. 서주영(보) — consultations import_0092, import_0668 현재 상태
 *   2. 박경옥2, 설정희 — 현재 입원 slot + 재입원 예약 잔존 여부
 *   3. slots/306-1 전체 상태
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

  console.log('═══ 서주영(보) ═══');
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (baseName(c.name) === baseName('서주영(보)') || c.name?.includes('서주영')) {
      console.log(`  ${id}`);
      console.log(`     name="${c.name}" status="${c.status}" admitDate=${c.admitDate} dischargeDate=${c.dischargeDate || '-'}`);
      console.log(`     chartNo=${c.chartNo || '-'} pid=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'}`);
      console.log(`     createdAt=${c.createdAt || '-'} updatedAt=${c.updatedAt || '-'} mergedInto=${c.mergedInto || '-'}`);
    }
  }

  console.log('\n═══ slots/306-1 ═══');
  const s306 = slots['306-1'] || {};
  console.log('  current:', JSON.stringify(s306.current || null));
  console.log('  reservations:');
  (s306.reservations || []).forEach((r, i) => console.log(`    [${i}] ${JSON.stringify(r)}`));

  console.log('\n═══ 박경옥2 ═══');
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (baseName(c.name) === '박경옥' || c.name?.startsWith('박경옥')) {
      console.log(`  ${id}  name="${c.name}" status="${c.status}" admit=${c.admitDate} discharge=${c.dischargeDate || '-'}`);
      console.log(`     chart=${c.chartNo || '-'} pid=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'} updatedAt=${c.updatedAt || '-'}`);
    }
  }
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && baseName(cur.name) === '박경옥') {
      console.log(`  [current] ${sk} ${JSON.stringify(cur)}`);
    }
    (slot.reservations || []).forEach((r, i) => {
      if (r && baseName(r.name) === '박경옥') {
        console.log(`  [res#${i}] ${sk} ${JSON.stringify(r)}`);
      }
    });
  }

  console.log('\n═══ 설정희 ═══');
  for (const [id, c] of Object.entries(cons)) {
    if (!c) continue;
    if (baseName(c.name) === '설정희' || c.name?.startsWith('설정희')) {
      console.log(`  ${id}  name="${c.name}" status="${c.status}" admit=${c.admitDate} discharge=${c.dischargeDate || '-'}`);
      console.log(`     chart=${c.chartNo || '-'} pid=${c.patientId || '-'} reservedSlot=${c.reservedSlot || '-'} updatedAt=${c.updatedAt || '-'}`);
    }
  }
  for (const [sk, slot] of Object.entries(slots)) {
    if (!slot) continue;
    const cur = slot.current;
    if (cur && baseName(cur.name) === '설정희') {
      console.log(`  [current] ${sk} ${JSON.stringify(cur)}`);
    }
    (slot.reservations || []).forEach((r, i) => {
      if (r && baseName(r.name) === '설정희') {
        console.log(`  [res#${i}] ${sk} ${JSON.stringify(r)}`);
      }
    });
  }

  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

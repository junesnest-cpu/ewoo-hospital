/**
 * 서주영(보) 과거 실적 복구
 *
 * 배경:
 *   restoreFutureAdmitCompleted.js 일괄 복원 시 admitDate="5/4" M/D 만 저장된
 *   2025년 입원 실적(status='입원완료')까지 '예약완료' 로 잘못 되돌렸다.
 *   그 후 consultation.js auto-restore 가 reservedSlot=306-1 을 보고
 *   slots/306-1/reservations 에 예약을 자동 생성 → 타임라인/병동현황에 미래 예약으로 오표시.
 *
 * 복구:
 *   - consultations/import_0092, import_0668:
 *       status='입원완료', reservedSlot=null 로 되돌림
 *   - slots/306-1/reservations 에서 서주영(보) 예약 제거
 *
 * 기존 status 는 _backup_<ts>/seojuyoung/ 에 보관.
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

const TARGETS = ['import_0092', 'import_0668'];

(async () => {
  const updates = {};
  const backup = {};

  for (const id of TARGETS) {
    const snap = await db.ref(`consultations/${id}`).once('value');
    const c = snap.val();
    if (!c) { console.log(`⚠ ${id} 없음 — 스킵`); continue; }
    backup[id] = c;
    console.log(`${id} before: status=${c.status} reservedSlot=${c.reservedSlot || '-'} admit=${c.admitDate}`);
    updates[`consultations/${id}/status`] = '입원완료';
    updates[`consultations/${id}/reservedSlot`] = null;
  }

  // slots/306-1/reservations 에서 서주영(보) 제거
  const sSnap = await db.ref('slots/306-1').once('value');
  const s = sSnap.val() || {};
  backup['_slot_306-1'] = s;
  const oldRes = s.reservations || [];
  const newRes = oldRes.filter(r => !(r && String(r.name || '').replace(/\s/g, '').startsWith('서주영')));
  if (newRes.length !== oldRes.length) {
    updates['slots/306-1/reservations'] = newRes;
    console.log(`slots/306-1/reservations: ${oldRes.length} → ${newRes.length} (서주영(보) 제거)`);
  } else {
    console.log('slots/306-1/reservations: 서주영(보) 없음');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  await db.ref(`_backup_${ts}/seojuyoung`).set(backup);
  console.log(`💾 백업: _backup_${ts}/seojuyoung`);

  if (Object.keys(updates).length === 0) { console.log('변경사항 없음'); process.exit(0); }
  await db.ref('/').update(updates);
  console.log('✅ 복구 완료');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });

/**
 * 치료실(physicalSchedule, hyperthermiaSchedule)에 입력된 db_ 슬롯키 항목을
 * treatmentPlans에 반영하는 일회성 백필 스크립트
 *
 * 실행: node scripts/backfillTreatPlans.js
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

// 월요일 기준 주 시작일 계산
function getWeekStart(d) {
  const x = new Date(d);
  const dw = x.getDay();
  x.setDate(x.getDate() + (dw === 0 ? -6 : 1 - dw));
  x.setHours(0, 0, 0, 0);
  return x;
}
function weekKey(ws) { return ws.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

async function main() {
  // 1) slots에서 patientId → slotKey 매핑
  const slotsSnap = await db.ref('slots').once('value');
  const slots = slotsSnap.val() || {};
  const patientToSlot = {};
  for (const [sk, sd] of Object.entries(slots)) {
    if (sd?.current?.patientId) {
      patientToSlot[sd.current.patientId] = sk;
    }
  }
  console.log(`[INFO] slots 로드: ${Object.keys(slots).length}개, patientId 매핑: ${Object.keys(patientToSlot).length}개`);

  // 2) 대상 주차 결정 (4/13 ~ 4/17 포함 주)
  const targetDate = new Date(2026, 3, 13); // 2026-04-13
  const ws = getWeekStart(targetDate);
  const wk = weekKey(ws);
  console.log(`[INFO] 대상 주차: ${wk}`);

  // 3) physicalSchedule, hyperthermiaSchedule 읽기
  const [physSnap, hyperSnap, treatSnap] = await Promise.all([
    db.ref(`physicalSchedule/${wk}`).once('value'),
    db.ref(`hyperthermiaSchedule/${wk}`).once('value'),
    db.ref('treatmentPlans').once('value'),
  ]);
  const phys = physSnap.val() || {};
  const hyper = hyperSnap.val() || {};
  const treatPlans = treatSnap.val() || {};

  const updates = {};
  let count = 0;

  // 4) physicalSchedule 순회: th1, th2
  for (const roomId of ['th1', 'th2']) {
    const roomData = phys[roomId] || {};
    for (const [dayIdx, times] of Object.entries(roomData)) {
      for (const [time, cell] of Object.entries(times || {})) {
        if (!cell?.slotKey?.startsWith('db_') || !cell.treatmentId) continue;
        const internalId = cell.slotKey.slice(3);
        const realSlot = patientToSlot[internalId];
        if (!realSlot) {
          console.log(`  [SKIP] ${cell.patientName}: db_${internalId} → 현재 입원 병실 없음`);
          continue;
        }
        const date = addDays(ws, parseInt(dayIdx));
        const mKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        const dKey = String(date.getDate());
        const existing = treatPlans[realSlot]?.[mKey]?.[dKey] || [];
        if (existing.some(e => e.id === cell.treatmentId)) {
          console.log(`  [EXISTS] ${cell.patientName} ${realSlot} ${mKey}/${dKey} ${cell.treatmentId}`);
          continue;
        }
        const path = `treatmentPlans/${realSlot}/${mKey}/${dKey}`;
        const newItems = [...existing, { id: cell.treatmentId, qty: '1' }];
        updates[path] = newItems;
        count++;
        console.log(`  [ADD] ${cell.patientName} ${realSlot} ${mKey}/${dKey} ${cell.treatmentId}`);
      }
    }
  }

  // 5) hyperthermiaSchedule 순회: hyperthermia, hyperbaric
  for (const roomType of ['hyperthermia', 'hyperbaric']) {
    const roomData = hyper[roomType] || {};
    const tid = roomType === 'hyperthermia' ? 'hyperthermia' : 'hyperbaric';
    for (const [dayIdx, times] of Object.entries(roomData)) {
      for (const [time, cellOrSlots] of Object.entries(times || {})) {
        const cells = roomType === 'hyperbaric'
          ? Object.values(cellOrSlots || {})  // a, b 슬롯
          : [cellOrSlots];
        for (const cell of cells) {
          if (!cell?.slotKey?.startsWith('db_')) continue;
          const internalId = cell.slotKey.slice(3);
          const realSlot = patientToSlot[internalId];
          if (!realSlot) {
            console.log(`  [SKIP] ${cell.patientName}: db_${internalId} → 현재 입원 병실 없음`);
            continue;
          }
          const date = addDays(ws, parseInt(dayIdx));
          const mKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          const dKey = String(date.getDate());
          // updates에 이미 추가된 항목도 체크
          const path = `treatmentPlans/${realSlot}/${mKey}/${dKey}`;
          const existing = updates[path] || treatPlans[realSlot]?.[mKey]?.[dKey] || [];
          if (existing.some(e => e.id === tid)) {
            console.log(`  [EXISTS] ${cell.patientName} ${realSlot} ${mKey}/${dKey} ${tid}`);
            continue;
          }
          updates[path] = [...existing, { id: tid, qty: '1' }];
          count++;
          console.log(`  [ADD] ${cell.patientName} ${realSlot} ${mKey}/${dKey} ${tid}`);
        }
      }
    }
  }

  // 6) Firebase 업데이트
  if (count === 0) {
    console.log('\n[DONE] 추가할 항목이 없습니다.');
  } else {
    console.log(`\n[INFO] ${count}건 업데이트 중...`);
    await db.ref('/').update(updates);
    console.log('[DONE] 완료!');
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });

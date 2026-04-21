/**
 * 치료실 현황 → 치료계획표 검증 — 수동/백필용 스크립트
 *
 * 일상 자동화는 Firebase Cloud Functions (`functions/index.js` scheduledTreatmentRoomSync)가
 * 매일 20:00 Asia/Seoul에 당일 데이터를 처리한다. 이 스크립트는 다음 용도로만 사용:
 *   1) 과거 날짜 백필
 *   2) 스케줄러 실패 후 복구
 *   3) 로컬/수동 테스트
 *
 * 물리치료(pain/manip1/manip2)와 고주파(hyperthermia)는 치료실 실시행 기록이 최종 진실.
 * 치료계획표에 있지만 치료실(physicalSchedule/hyperthermiaSchedule)에 없는 항목은
 *   room:"removed" 태그를 붙여 UI 흐리게 + 금액 제외 + EMR 검증 대상에서도 제외.
 *
 * 안전장치: 미래 날짜는 거부 (오늘 포함해서 오늘 이전만 처리 가능).
 *
 * 실행:
 *   node scripts/syncTreatmentRoom.js               # 오늘 처리 (기본)
 *   node scripts/syncTreatmentRoom.js 2026-04-17    # 특정 날짜 처리
 *   node scripts/syncTreatmentRoom.js --days 7      # 최근 7일 (오늘 포함)
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

// 치료실에서 실시행 기록이 남는 항목 (EMR 처방과 별개)
const ROOM_ITEMS = new Set(['pain', 'manip1', 'manip2', 'hyperthermia']);

// admissionKey: admitDate → YYYY-MM-DD (patient-keyed 스키마)
function admissionKey(admitDate) {
  if (!admitDate) return null;
  const s = String(admitDate).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (md) {
    const y = new Date().getFullYear();
    return `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  return null;
}

function getWeekStart(d) {
  const x = new Date(d);
  const dw = x.getDay();
  x.setDate(x.getDate() + (dw === 0 ? -6 : 1 - dw));
  x.setHours(0, 0, 0, 0);
  return x;
}
function toISODate(d) {
  // 로컬 타임존 기준 YYYY-MM-DD (toISOString은 UTC라 KST와 9시간 차이가 남)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function resolveSlotKey(rawKey, slots) {
  if (!rawKey) return null;
  if (rawKey.startsWith('pending_') || rawKey === '__pending__') return null;
  if (rawKey.startsWith('db_')) {
    const internalId = rawKey.slice(3);
    const found = Object.entries(slots).find(([, sd]) => sd?.current?.patientId === internalId);
    return found ? found[0] : null;
  }
  return rawKey;
}

async function processDate(targetDate, slots, allPlans) {
  const targetYMD = toISODate(targetDate);
  const weekStart = getWeekStart(targetDate);
  const wk = toISODate(weekStart);
  const dayIdx = String(Math.round((targetDate - weekStart) / 86400000));
  const [yr, mo, d] = targetYMD.split('-');
  const monthKey = `${yr}-${mo}`;
  const dayStr = String(parseInt(d));

  // 해당 주의 치료실 일정 로드
  const [physSnap, hyperSnap] = await Promise.all([
    db.ref(`physicalSchedule/${wk}`).once('value'),
    db.ref(`hyperthermiaSchedule/${wk}`).once('value'),
  ]);
  const phys = physSnap.val() || {};
  const hyper = hyperSnap.val() || {};

  // slotKey → {patientId, admissionKey} (현재 입원환자 기준)
  const slotToPatient = {};
  for (const [sk, slot] of Object.entries(slots)) {
    const cur = slot?.current;
    if (!cur?.patientId) continue;
    const aKey = admissionKey(cur?.admitDate);
    if (!aKey) continue;
    slotToPatient[sk] = { patientId: cur.patientId, admissionKey: aKey };
  }

  // 해당 날짜에 실제로 수행된 (patientId, admissionKey, treatmentId) 수집
  const performed = new Set();
  const addPerformed = (rawSlotKey, treatmentId) => {
    const sk = resolveSlotKey(rawSlotKey, slots);
    if (!sk) return;
    const pa = slotToPatient[sk];
    if (!pa) return;
    performed.add(`${pa.patientId}|${pa.admissionKey}|${treatmentId}`);
  };

  for (const roomId of ['th1', 'th2']) {
    const daySlots = phys[roomId]?.[dayIdx] || {};
    for (const time of Object.keys(daySlots)) {
      const entry = daySlots[time];
      if (!entry?.slotKey || !entry?.treatmentId) continue;
      addPerformed(entry.slotKey, entry.treatmentId);
    }
  }
  const hyperDay = hyper.hyperthermia?.[dayIdx] || {};
  for (const time of Object.keys(hyperDay)) {
    const entry = hyperDay[time];
    if (!entry?.slotKey) continue;
    addPerformed(entry.slotKey, 'hyperthermia');
  }

  // 치료계획 순회 (patient-keyed)
  const fbUpdates = {};
  let removedCount = 0, restoredCount = 0;

  for (const [pid, byAdmission] of Object.entries(allPlans)) {
    for (const [aKey, byMonth] of Object.entries(byAdmission || {})) {
      const raw = byMonth?.[monthKey]?.[dayStr];
      if (!raw) continue;
      const items = Array.isArray(raw) ? raw : Object.values(raw);
      if (!items.length) continue;

      let changed = false;
      const newItems = items.map(item => {
        if (!item || !item.id) return item;
        if (!ROOM_ITEMS.has(item.id)) return item;

        const key = `${pid}|${aKey}|${item.id}`;
        if (performed.has(key)) {
          // 실시행 됨 → stale room:"removed" 제거
          if (item.room === 'removed') {
            const { room, ...rest } = item;
            changed = true;
            restoredCount++;
            return rest;
          }
          return item;
        } else {
          // 미반영 → room:"removed" 태그
          if (item.room === 'removed') return item;
          changed = true;
          removedCount++;
          return { ...item, room: 'removed' };
        }
      });
      if (changed) {
        fbUpdates[`treatmentPlansV2/${pid}/${aKey}/${monthKey}/${dayStr}`] = newItems;
      }
    }
  }

  if (Object.keys(fbUpdates).length > 0) {
    await db.ref('/').update(fbUpdates);
  }

  console.log(`  ${targetYMD}: 🛑 미반영 ${removedCount}건 / ✅ 복원 ${restoredCount}건`);
  return { removed: removedCount, restored: restoredCount };
}

async function main() {
  const args = process.argv.slice(2);
  const daysArgIdx = args.indexOf('--days');
  const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const targets = [];

  if (dateArg) {
    const d = new Date(dateArg + 'T00:00:00');
    if (d > today) {
      console.log('⚠ 미래는 처리하지 않습니다:', dateArg);
      process.exit(0);
    }
    targets.push(d);
  } else if (daysArgIdx >= 0 && args[daysArgIdx + 1]) {
    const n = parseInt(args[daysArgIdx + 1]);
    for (let i = 0; i < n; i++) targets.push(addDays(today, -i)); // 오늘부터 N일
  } else {
    targets.push(today); // 기본: 오늘
  }

  console.log(`🏥 치료실 현황 검증 시작 (${targets.length}일)`);
  console.log(`📅 대상: ${targets.map(toISODate).join(', ')}\n`);

  const [slotsSnap, plansSnap] = await Promise.all([
    db.ref('slots').once('value'),
    db.ref('treatmentPlansV2').once('value'),
  ]);
  const slots = slotsSnap.val() || {};
  const plans = plansSnap.val() || {};

  let totalRemoved = 0, totalRestored = 0;
  for (const t of targets) {
    const r = await processDate(t, slots, plans);
    totalRemoved += r.removed;
    totalRestored += r.restored;
  }

  await db.ref('roomSyncLog/lastSync').set(new Date().toISOString());
  await db.ref('roomSyncLog/lastCounts').set({
    dates: targets.map(toISODate),
    removed: totalRemoved,
    restored: totalRestored,
  });

  console.log('\n' + '═'.repeat(50));
  console.log(`✅ 치료실 검증 완료`);
  console.log(`   🛑 미반영(room:removed) 태깅: ${totalRemoved}건`);
  console.log(`   ✅ 복원(태그 제거):          ${totalRestored}건`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});

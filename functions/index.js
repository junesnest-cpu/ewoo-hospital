/**
 * Cloud Functions for ewoo-hospital-ward
 *
 * scheduledTreatmentRoomSync:
 *   매일 20:00 Asia/Seoul에 당일 치료실 현황(physicalSchedule + hyperthermiaSchedule)을
 *   치료계획표(treatmentPlans)와 비교하여 미반영 항목에 room:"removed" 태그를 부여한다.
 *
 *   대상 치료: pain / manip1 / manip2 / hyperthermia 4종.
 *   EMR 동기화와 완전 독립 — 서로의 태그(emr / room)는 각자 보존한다.
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

initializeApp();

// 치료실 기록이 남는 항목 (EMR 처방과는 별개)
const ROOM_ITEMS = new Set(["pain", "manip1", "manip2", "hyperthermia"]);

// KST(UTC+9) 기준 오늘 00:00
function kstToday() {
  const now = new Date();
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const d = new Date(kstMs);
  d.setUTCHours(0, 0, 0, 0);
  // 반환은 UTC 시각이지만 날짜 컴포넌트는 KST 기준이 됨
  return d;
}

// 월요일 시작 주의 KST 일요일=6 인덱스 사용
function getWeekStartKST(kstDate) {
  const x = new Date(kstDate);
  const dw = x.getUTCDay(); // 여기서 getUTCDay는 KST 요일과 동일 (이미 offset 적용)
  x.setUTCDate(x.getUTCDate() + (dw === 0 ? -6 : 1 - dw));
  return x;
}

function toISODateKST(kstDate) {
  const y = kstDate.getUTCFullYear();
  const m = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resolveSlotKey(rawKey, slots) {
  if (!rawKey) return null;
  if (rawKey.startsWith("pending_") || rawKey === "__pending__") return null;
  if (rawKey.startsWith("db_")) {
    const internalId = rawKey.slice(3);
    const found = Object.entries(slots).find(([, sd]) => sd?.current?.patientId === internalId);
    return found ? found[0] : null;
  }
  return rawKey;
}

exports.scheduledTreatmentRoomSync = onSchedule(
  {
    schedule: "0 20 * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3",
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const db = getDatabase();

    const today = kstToday();
    const targetYMD = toISODateKST(today);
    const weekStart = getWeekStartKST(today);
    const wk = toISODateKST(weekStart);
    const dayIdx = String(Math.round((today - weekStart) / 86400000));
    const [yr, mo, d] = targetYMD.split("-");
    const monthKey = `${yr}-${mo}`;
    const dayStr = String(parseInt(d));

    logger.info(`치료실 현황 검증 시작: ${targetYMD} (wk=${wk}, dayIdx=${dayIdx})`);

    const [physSnap, hyperSnap, slotsSnap, plansSnap] = await Promise.all([
      db.ref(`physicalSchedule/${wk}`).once("value"),
      db.ref(`hyperthermiaSchedule/${wk}`).once("value"),
      db.ref("slots").once("value"),
      db.ref("treatmentPlans").once("value"),
    ]);

    const phys = physSnap.val() || {};
    const hyper = hyperSnap.val() || {};
    const slots = slotsSnap.val() || {};
    const plans = plansSnap.val() || {};

    // 당일 실제 수행된 (slotKey, treatmentId) 수집
    const performed = new Set();
    for (const roomId of ["th1", "th2"]) {
      const daySlots = phys[roomId]?.[dayIdx] || {};
      for (const time of Object.keys(daySlots)) {
        const entry = daySlots[time];
        if (!entry?.slotKey || !entry?.treatmentId) continue;
        const sk = resolveSlotKey(entry.slotKey, slots);
        if (!sk) continue;
        performed.add(`${sk}|${entry.treatmentId}`);
      }
    }
    const hyperDay = hyper.hyperthermia?.[dayIdx] || {};
    for (const time of Object.keys(hyperDay)) {
      const entry = hyperDay[time];
      if (!entry?.slotKey) continue;
      const sk = resolveSlotKey(entry.slotKey, slots);
      if (!sk) continue;
      performed.add(`${sk}|hyperthermia`);
    }

    // 치료계획 순회 → room 태그 조정
    const fbUpdates = {};
    let removedCount = 0;
    let restoredCount = 0;

    for (const sk of Object.keys(plans)) {
      const raw = plans[sk]?.[monthKey]?.[dayStr];
      if (!raw) continue;
      const items = Array.isArray(raw) ? raw : Object.values(raw);
      if (!items.length) continue;

      let changed = false;
      const newItems = items.map((item) => {
        if (!item || !item.id) return item;
        if (!ROOM_ITEMS.has(item.id)) return item;

        const key = `${sk}|${item.id}`;
        if (performed.has(key)) {
          // 실시행됨 — stale room:"removed" 제거
          if (item.room === "removed") {
            const { room, ...rest } = item;
            changed = true;
            restoredCount++;
            return rest;
          }
          return item;
        }
        // 미반영 — room:"removed" 태그
        if (item.room === "removed") return item;
        changed = true;
        removedCount++;
        return { ...item, room: "removed" };
      });

      if (changed) {
        fbUpdates[`treatmentPlans/${sk}/${monthKey}/${dayStr}`] = newItems;
      }
    }

    if (Object.keys(fbUpdates).length > 0) {
      await db.ref("/").update(fbUpdates);
    }

    await db.ref("roomSyncLog/lastSync").set(new Date().toISOString());
    await db.ref("roomSyncLog/lastCounts").set({
      date: targetYMD,
      removed: removedCount,
      restored: restoredCount,
    });

    logger.info(
      `치료실 검증 완료: ${targetYMD} — 미반영 ${removedCount}건 / 복원 ${restoredCount}건`
    );
  }
);

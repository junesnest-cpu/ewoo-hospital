/**
 * Cloud Functions for ewoo-hospital-ward
 *
 * scheduledTreatmentRoomSync:
 *   매일 20:00 Asia/Seoul에 당일 치료실 현황(physicalSchedule + hyperthermiaSchedule)을
 *   치료계획표(treatmentPlansV2)와 비교하여 미반영 항목에 room:"removed" 태그를 부여한다.
 *
 *   대상 치료: pain / manip1 / manip2 / hyperthermia 4종.
 *   EMR 동기화와 완전 독립 — 서로의 태그(emr / room)는 각자 보존한다.
 *
 *   2026-04-21: patient-keyed 스키마 (treatmentPlansV2/{pid}/{admissionKey})로 재작성.
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

initializeApp();

// 치료실 기록이 남는 항목 (EMR 처방과는 별개)
const ROOM_ITEMS = new Set(["pain", "manip1", "manip2", "hyperthermia"]);

// admissionKey: admitDate → YYYY-MM-DD
function admissionKey(admitDate) {
  if (!admitDate) return null;
  const s = String(admitDate).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (md) {
    const y = new Date().getFullYear();
    return `${y}-${String(md[1]).padStart(2, "0")}-${String(md[2]).padStart(2, "0")}`;
  }
  return null;
}

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

/**
 * scheduledSecurityEventCleanup:
 *   매일 03:00 KST 에 securityEvents/{YYYY-MM-DD}/ 노드 중 30일 이전 일자를 삭제한다.
 *   ward RTDB 의 `securityEvents` 는 3프로젝트(hospital/approval/clinical) 의 보안 이벤트가
 *   통합 누적되는 곳 (lib/securityLog.js). retention 없으면 무한 증가.
 *
 *   ymd 키가 YYYY-MM-DD 사전순 == 시간순 이므로 단순 문자열 비교로 cutoff 식별.
 */
exports.scheduledSecurityEventCleanup = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "Asia/Seoul",
    region: "asia-northeast3",
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async () => {
    const db = getDatabase();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const cutoffYMD = cutoff.toISOString().slice(0, 10);

    const snap = await db.ref("securityEvents").once("value");
    const all = snap.val() || {};
    const toDelete = Object.keys(all).filter((ymd) => ymd < cutoffYMD);
    if (toDelete.length === 0) {
      logger.info(`securityEvents cleanup: 삭제 대상 없음 (cutoff=${cutoffYMD})`);
      return;
    }

    const updates = {};
    let totalEvents = 0;
    for (const ymd of toDelete) {
      updates[`securityEvents/${ymd}`] = null;
      totalEvents += Object.keys(all[ymd] || {}).length;
    }
    await db.ref("/").update(updates);
    logger.info(
      `securityEvents cleanup: ${toDelete.length} 일 (${totalEvents} events) 삭제 (cutoff=${cutoffYMD})`,
    );
  },
);

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
      db.ref("treatmentPlansV2").once("value"),
    ]);

    const phys = physSnap.val() || {};
    const hyper = hyperSnap.val() || {};
    const slots = slotsSnap.val() || {};
    const plans = plansSnap.val() || {};

    // slotKey → {patientId, admissionKey} 매핑 (현재 입원환자 기준)
    const slotToPatient = {};
    for (const [sk, slot] of Object.entries(slots)) {
      const cur = slot?.current;
      if (!cur?.patientId) continue;
      const aKey = admissionKey(cur?.admitDate);
      if (!aKey) continue;
      slotToPatient[sk] = { patientId: cur.patientId, admissionKey: aKey };
    }

    // 당일 실제 수행된 (patientId, admissionKey, treatmentId) 수집
    const performed = new Set();
    const addPerformed = (rawSlotKey, treatmentId) => {
      const sk = resolveSlotKey(rawSlotKey, slots);
      if (!sk) return;
      const pa = slotToPatient[sk];
      if (!pa) return;
      performed.add(`${pa.patientId}|${pa.admissionKey}|${treatmentId}`);
    };

    for (const roomId of ["th1", "th2"]) {
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
      addPerformed(entry.slotKey, "hyperthermia");
    }

    // 치료계획 순회 → room 태그 조정 (patient-keyed)
    const fbUpdates = {};
    let removedCount = 0;
    let restoredCount = 0;

    for (const [pid, byAdmission] of Object.entries(plans)) {
      for (const [aKey, byMonth] of Object.entries(byAdmission || {})) {
        const raw = byMonth?.[monthKey]?.[dayStr];
        if (!raw) continue;
        const items = Array.isArray(raw) ? raw : Object.values(raw);
        if (!items.length) continue;

        let changed = false;
        const newItems = items.map((item) => {
          if (!item || !item.id) return item;
          if (!ROOM_ITEMS.has(item.id)) return item;

          const key = `${pid}|${aKey}|${item.id}`;
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
          fbUpdates[`treatmentPlansV2/${pid}/${aKey}/${monthKey}/${dayStr}`] = newItems;
        }
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

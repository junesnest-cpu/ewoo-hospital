import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { ref, onValue, set, update } from "firebase/database";
import { db } from "./firebaseConfig";

// ── 공유 유틸리티 ──────────────────────────────────────────────────────────
export function normName(n) {
  return (n || "").replace(/^신\)\s*/, "").trim().toLowerCase();
}

export function parseDateStr(str, contextYear) {
  if (!str || str === "미정") return null;
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
  const m = str.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return new Date(contextYear || new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]));
  return null;
}

// ── Context ────────────────────────────────────────────────────────────────
const WardDataContext = createContext(null);

export function WardDataProvider({ children }) {
  // ── 원본 Firebase 데이터 ────────────────────────────────────────────────
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});
  const [patients, setPatients] = useState({});
  const [newPatientFlags, setNewPatientFlags] = useState({});
  const [settings, setSettings] = useState({});
  const [logs, setLogs] = useState([]);
  const [emrSyncTime, setEmrSyncTime] = useState(null);
  const [slotsLoaded, setSlotsLoaded] = useState(false);

  // ── Firebase 구독 (앱 전체에서 1회) ──────────────────────────────────────
  useEffect(() => {
    const u1 = onValue(ref(db, "slots"), snap => {
      setSlots(snap.val() || {});
      setSlotsLoaded(true);
    });
    const u2 = onValue(ref(db, "consultations"), snap => {
      setConsultations(snap.val() || {});
    });
    const u3 = onValue(ref(db, "patients"), snap => {
      setPatients(snap.val() || {});
    });
    const u4 = onValue(ref(db, "newPatientFlags"), snap => {
      setNewPatientFlags(snap.val() || {});
    });
    const u5 = onValue(ref(db, "settings"), snap => {
      setSettings(snap.val() || {});
    });
    const u6 = onValue(ref(db, "logs"), snap => {
      const val = snap.val();
      if (val) setLogs(Array.isArray(val) ? val : Object.values(val));
    });
    const u8 = onValue(ref(db, "emrSyncLog/lastSync"), snap => {
      const val = snap.val();
      if (val) setEmrSyncTime(new Date(val));
    });
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u8(); };
  }, []);

  // ── 공유 함수: saveSlots ────────────────────────────────────────────────
  const saveSlots = useCallback(async (newS, changedKeys) => {
    setSlots(newS);
    if (changedKeys && changedKeys.length > 0) {
      const updates = {};
      for (const k of changedKeys) updates[`slots/${k}`] = newS[k] ?? null;
      await update(ref(db), updates);
    } else {
      await set(ref(db, "slots"), newS);
    }
  }, []);

  // ── 공유 함수: addLog ──────────────────────────────────────────────────
  const addLog = useCallback(async (entry) => {
    const newLog = { ...entry, ts: new Date().toISOString() };
    setLogs(prev => {
      const updated = [newLog, ...prev].slice(0, 100);
      set(ref(db, "logs"), updated).catch(console.error);
      return updated;
    });
  }, []);

  // ── 공유 함수: recordDischarge (퇴원 시 dailyBoards에 즉시 기록) ─────────
  const recordDischarge = useCallback(async (patientName, slotKey, dischargeDate) => {
    if (!patientName) return;
    const today = new Date();
    const dateStr = dischargeDate || `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-${String(today.getDate()).padStart(2,"0")}`;
    try {
      const boardRef = ref(db, `dailyBoards/${dateStr}`);
      const snap = await new Promise(resolve => {
        const unsub = onValue(boardRef, s => { unsub(); resolve(s.val()); }, { onlyOnce: true });
      });
      const bd = snap || {};
      const existing = bd.discharges || [];
      const nn = normName(patientName);
      if (existing.some(d => d.name && normName(d.name) === nn)) return; // 이미 존재
      const updated = {
        ...bd,
        discharges: [...existing, { id: `dis-${Date.now()}`, name: patientName, room: slotKey, note: "", time: "" }],
      };
      await set(boardRef, updated);
    } catch (e) { console.error("recordDischarge error:", e); }
  }, []);

  // ── 공유 함수: syncConsultationOnSlotChange ─────────────────────────────
  const syncConsultationOnSlotChange = useCallback(async (fromSlotKey, personName, consultationId, newSlotKey, updatedDates) => {
    const match = Object.entries(consultations).find(([id, c]) => {
      if (consultationId && id === consultationId) return true;
      if (c.reservedSlot === fromSlotKey && c.name === personName) return true;
      return false;
    });
    if (!match) return;
    const [cId, c] = match;
    if (newSlotKey) {
      const updates = { ...c, reservedSlot: newSlotKey };
      if (updatedDates?.admitDate) updates.admitDate = updatedDates.admitDate;
      if (updatedDates?.dischargeDate) updates.dischargeDate = updatedDates.dischargeDate;
      await set(ref(db, `consultations/${cId}`), updates);
    } else {
      await set(ref(db, `consultations/${cId}`), { ...c, reservedSlot: null, status: "상담중" });
    }
  }, [consultations]);

  // ── 공유 함수: cleanupDailyBoards (예약 변경/삭제 시 이전 dailyBoards 항목 정리) ──
  const cleanupDailyBoards = useCallback(async (patientName, oldDates, newDates) => {
    if (!patientName) return;
    const nn = normName(patientName);
    if (!nn) return;

    const toDateStr = (d) => {
      if (!d || d === "미정") return null;
      const pd = parseDateStr(d, new Date().getFullYear());
      if (!pd) return null;
      return `${pd.getFullYear()}-${String(pd.getMonth()+1).padStart(2,"0")}-${String(pd.getDate()).padStart(2,"0")}`;
    };

    const oldAdmit = toDateStr(oldDates?.admitDate);
    const newAdmit = toDateStr(newDates?.admitDate);
    const oldDischarge = toDateStr(oldDates?.discharge);
    const newDischarge = toDateStr(newDates?.discharge);

    const removals = [];
    // 입원일이 변경된 경우: 이전 날짜의 admissions에서 제거
    if (oldAdmit && oldAdmit !== newAdmit) {
      removals.push({ dateStr: oldAdmit, field: "admissions" });
    }
    // 퇴원일이 변경된 경우: 이전 날짜의 discharges에서 제거
    if (oldDischarge && oldDischarge !== newDischarge) {
      removals.push({ dateStr: oldDischarge, field: "discharges" });
    }

    for (const { dateStr, field } of removals) {
      try {
        const boardRef = ref(db, `dailyBoards/${dateStr}`);
        const snap = await new Promise(resolve => {
          const unsub = onValue(boardRef, s => { unsub(); resolve(s.val()); }, { onlyOnce: true });
        });
        if (!snap || !snap[field]) continue;
        const filtered = snap[field].filter(e => normName(e.name) !== nn);
        if (filtered.length !== snap[field].length) {
          await set(boardRef, { ...snap, [field]: filtered });
        }
      } catch (e) { console.error("cleanupDailyBoards error:", e); }
    }
  }, []);

  // ── 파생 데이터 ────────────────────────────────────────────────────────
  const nameToSlotRoom = useMemo(() => {
    const map = {};
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomLabel = slotKey;
      if (slot?.current?.name) {
        const n = normName(slot.current.name);
        if (n) map[n] = roomLabel;
      }
      (slot?.reservations || []).forEach(r => {
        if (!r?.name) return;
        const n = normName(r.name);
        if (n && !map[n]) map[n] = roomLabel;
      });
    });
    return map;
  }, [slots]);

  const namesInSlots = useMemo(() => {
    const s = new Set();
    Object.values(slots).forEach(slot => {
      if (slot?.current?.name) s.add(normName(slot.current.name));
      (slot?.reservations || []).forEach(r => { if (r?.name) s.add(normName(r.name)); });
    });
    return s;
  }, [slots]);

  const value = useMemo(() => ({
    // 원본 데이터
    slots, setSlots,
    consultations, setConsultations,
    patients,
    newPatientFlags, setNewPatientFlags,
    settings,
    logs, setLogs,
    emrSyncTime,
    slotsLoaded,
    // 파생 데이터
    nameToSlotRoom,
    namesInSlots,
    // 공유 함수
    saveSlots,
    addLog,
    recordDischarge,
    syncConsultationOnSlotChange,
    cleanupDailyBoards,
  }), [slots, consultations, patients, newPatientFlags, settings, logs, emrSyncTime, slotsLoaded, nameToSlotRoom, namesInSlots, saveSlots, addLog, recordDischarge, syncConsultationOnSlotChange, cleanupDailyBoards]);

  return (
    <WardDataContext.Provider value={value}>
      {children}
    </WardDataContext.Provider>
  );
}

export function useWardData() {
  const ctx = useContext(WardDataContext);
  if (!ctx) throw new Error("useWardData must be used within WardDataProvider");
  return ctx;
}

export default WardDataContext;

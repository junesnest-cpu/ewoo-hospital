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
  const [pendingCount, setPendingCount] = useState(0);
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
    const u7 = onValue(ref(db, "pendingChanges"), snap => {
      const val = snap.val();
      setPendingCount(val ? Object.values(val).filter(c => c.status === "pending").length : 0);
    });
    const u8 = onValue(ref(db, "emrSyncLog/lastSync"), snap => {
      const val = snap.val();
      if (val) setEmrSyncTime(new Date(val));
    });
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); };
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
    pendingCount, setPendingCount,
    emrSyncTime,
    slotsLoaded,
    // 파생 데이터
    nameToSlotRoom,
    namesInSlots,
    // 공유 함수
    saveSlots,
    addLog,
    syncConsultationOnSlotChange,
  }), [slots, consultations, patients, newPatientFlags, settings, logs, pendingCount, emrSyncTime, slotsLoaded, nameToSlotRoom, namesInSlots, saveSlots, addLog, syncConsultationOnSlotChange]);

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

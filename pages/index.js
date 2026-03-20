import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";
import PatientSearchModal from "../components/PatientSearchModal";

const WARD_STRUCTURE = {
  2: { name: "2병동", rooms: [
    { id: "201", type: "4인실", capacity: 4 }, { id: "202", type: "1인실", capacity: 1 },
    { id: "203", type: "4인실", capacity: 4 }, { id: "204", type: "2인실", capacity: 2 },
    { id: "205", type: "6인실", capacity: 6 }, { id: "206", type: "6인실", capacity: 6 },
  ]},
  3: { name: "3병동", rooms: [
    { id: "301", type: "4인실", capacity: 4 }, { id: "302", type: "1인실", capacity: 1 },
    { id: "303", type: "4인실", capacity: 4 }, { id: "304", type: "2인실", capacity: 2 },
    { id: "305", type: "2인실", capacity: 2 }, { id: "306", type: "6인실", capacity: 6 },
  ]},
  5: { name: "5병동", rooms: [
    { id: "501", type: "4인실", capacity: 4 }, { id: "502", type: "1인실", capacity: 1 },
    { id: "503", type: "4인실", capacity: 4 }, { id: "504", type: "2인실", capacity: 2 },
    { id: "505", type: "6인실", capacity: 6 }, { id: "506", type: "6인실", capacity: 6 },
  ]},
  6: { name: "6병동", rooms: [
    { id: "601", type: "6인실", capacity: 6 }, { id: "602", type: "1인실", capacity: 1 },
    { id: "603", type: "6인실", capacity: 6 },
  ]},
};

// 모든 빈 병상 목록 (roomId, slotKey, capacity 포함)
function getAllEmptySlots(slots, getRoomStats) {
  const empty = [];
  Object.values(WARD_STRUCTURE).forEach(ward =>
    ward.rooms.forEach(room => {
      const { bedList } = getRoomStats(room.id, room.capacity);
      bedList.forEach((b, i) => {
        if (!b.person && !b.hasReserve) {
          empty.push({ roomId: room.id, slotKey: `${room.id}-${i+1}`, bedIndex: i, roomType: room.type });
        }
      });
    })
  );
  return empty;
}

const TYPE_COLOR = { "1인실": "#6366f1", "2인실": "#0ea5e9", "4인실": "#10b981", "6인실": "#f59e0b" };
const TYPE_BG    = { "1인실": "#eef2ff", "2인실": "#e0f2fe", "4인실": "#d1fae5", "6인실": "#fef3c7" };

function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]));
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toInputValue(date) { return date.toISOString().slice(0, 10); }
function toKoreanDate(date) {
  return `${date.getMonth()+1}월 ${date.getDate()}일 (${["일","월","화","수","목","금","토"][date.getDay()]})`;
}
function todayDate() { return dateOnly(new Date()); }

function getDdayLabel(discharge) {
  const d = parseDateStr(discharge);
  if (!d) return null;
  const diff = Math.round((dateOnly(d) - todayDate()) / 86400000);
  if (diff === 0) return { text: "D-Day", color: "#dc2626", bg: "#fee2e2" };
  if (diff > 0)   return { text: `D-${diff}`, color: diff <= 3 ? "#d97706":"#64748b", bg: diff <= 3 ? "#fef3c7":"#f1f5f9" };
  return { text: `D+${Math.abs(diff)}`, color: "#9ca3af", bg: "#f3f4f6" };
}

function getSlotOccupant(slot, viewDate) {
  if (!slot) return { person: null, type: null };
  const vd = dateOnly(viewDate);

  // 현재 환자: 퇴원일이 뷰 날짜 이상인 경우
  if (slot.current?.name) {
    const dischargeD = parseDateStr(slot.current.discharge);
    const stillHere = !dischargeD || dateOnly(dischargeD) >= vd;
    if (stillHere) {
      const dischargingToday = dischargeD && dateOnly(dischargeD).getTime() === vd.getTime();
      return { person: slot.current, type: dischargingToday ? "discharging_today" : "current" };
    }
  }

  // 예약 중 뷰 날짜에 해당하는 것 찾기
  // 1) 뷰 날짜에 체류 중인 예약(admitD <= vd <= dischargeD)을 모두 찾아 가장 가까운 것
  const reservations = slot.reservations || [];
  const active = reservations
    .map(r => {
      const admitD = parseDateStr(r.admitDate);
      const dischargeD = parseDateStr(r.discharge);
      if (!admitD) return null;
      const stillHere = !dischargeD || dateOnly(dischargeD) >= vd;
      if (dateOnly(admitD) <= vd && stillHere) return { r, admitD };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.admitD - b.admitD); // 가장 빠른 입원일 우선

  if (active.length > 0) {
    const { r, admitD } = active[0];
    return { person: r, type: dateOnly(admitD).getTime() === vd.getTime() ? "admitting_today" : "reserved" };
  }

  return { person: null, type: null };
}

function hasUpcomingReservation(slot) {
  if (!slot?.reservations?.length) return false;
  return slot.reservations.some(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) > todayDate(); });
}

function countUpcomingReservations(slot) {
  if (!slot?.reservations?.length) return 0;
  return slot.reservations.filter(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) > todayDate(); }).length;
}

const INIT_SLOTS = {
  "201-1": { current: { name: "임순태", bedPosition: 1, discharge: "미정", note: "이뮤알파·이스카도(월수금)", scheduleAlert: true }, reservations: [] },
  "201-2": { current: { name: "황세영", bedPosition: 2, discharge: "3/17 점심후", note: "페인 2-3회, 퇴원약 메시마", scheduleAlert: true },
    reservations: [{ name: "김예약", admitDate: "3/18", discharge: "3/25", note: "예약 입원 샘플", scheduleAlert: false, bedPosition: 2 }] },
};

async function analyzeMessengerText(text) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ════════════════════════════════════════════════════════════════════════════════
export default function HospitalWardManager() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [slots,          setSlots]          = useState({});
  const [view,           setView]           = useState("ward");
  const [selectedRoom,   setSelectedRoom]   = useState(null);
  const [editingSlot,    setEditingSlot]    = useState(null);
  const [addingTo,       setAddingTo]       = useState(null);
  const [patientPickFor, setPatientPickFor] = useState(null); // { slotKey, mode } — 환자 검색 선행
  const [movingPatient,  setMovingPatient]  = useState(null); // { slotKey, mode, data, resIndex }
  const [uploading,      setUploading]      = useState(false);
  const [uploadResult,   setUploadResult]   = useState(null);
  const [jsonPasteOpen,  setJsonPasteOpen]  = useState(false);
  const [moreOpen,       setMoreOpen]       = useState(false);
  const [jsonPasteText,  setJsonPasteText]  = useState("");
  const [logs,           setLogs]           = useState([]);
  const [pendingCount,   setPendingCount]   = useState(0);
  const [lastSync,       setLastSync]       = useState(null);
  const [syncing,        setSyncing]        = useState(true);
  const [previewDate,    setPreviewDate]    = useState(null);
  const [previewInput,   setPreviewInput]   = useState(toInputValue(todayDate()));
  const [showReserved,   setShowReserved]   = useState(true);
  // 빈 병상 하이라이트
  const [highlightEmpty, setHighlightEmpty] = useState(false);
  const [emptySlotIdx,   setEmptySlotIdx]   = useState(0); // 현재 포커스된 빈 병상 인덱스
  const fileInputRef = useRef();

  // ── 환자 검색 ────────────────────────────────────────────────────────────
  const [searchQuery,    setSearchQuery]    = useState("");
  const [searchResults,  setSearchResults]  = useState([]); // [{slotKey, name, type, roomId}]
  const [searchFocused,  setSearchFocused]  = useState(false);
  const searchRef = useRef();

  // ── 가용 병실 조회 ────────────────────────────────────────────────────────
  const [availOpen,        setAvailOpen]        = useState(false);
  const [availAdmit,       setAvailAdmit]       = useState("");
  const [availDischarge,   setAvailDischarge]   = useState("");
  const [availTypes,       setAvailTypes]       = useState([]);
  const [availResults,     setAvailResults]     = useState(null);
  const [availAdjustments, setAvailAdjustments] = useState([]);
  const [applyingMove,     setApplyingMove]     = useState(false);
  const cardRefs = useRef({});

  const isPreview = previewDate !== null;
  const viewDate  = previewDate || todayDate();

  useEffect(() => {
    setSyncing(true);
    const sRef = ref(db, "slots");
    const unsubS = onValue(sRef, snap => {
      const val = snap.val();
      if (!val) { set(sRef, INIT_SLOTS); setSlots(INIT_SLOTS); setLastSync(new Date()); setSyncing(false); return; }
      setSlots(val);
      setLastSync(new Date()); setSyncing(false);
    }, () => setSyncing(false));
    const unsubL = onValue(ref(db, "logs"), snap => {
      const val = snap.val();
      if (val) setLogs(Array.isArray(val) ? val : Object.values(val));
    });
    const unsubP = onValue(ref(db, "pendingChanges"), snap => {
      const val = snap.val();
      if (val) {
        const pending = Object.values(val).filter(c => c.status === "pending").length;
        setPendingCount(pending);
      } else {
        setPendingCount(0);
      }
    });
    return () => { unsubS(); unsubL(); unsubP(); };
  }, []);

  // ── 자동 처리: 입원일 도달 예약 자동 전환 + 지난 예약 자동 삭제 ──────────────
  useEffect(() => {
    if (Object.keys(slots).length === 0) return;
    const today = todayDate();
    const newSlots = JSON.parse(JSON.stringify(slots));
    let changed = false;
    Object.entries(newSlots).forEach(([slotKey, slot]) => {
      if (!slot?.reservations?.length) return;
      const keep = [];
      let promoted = false;
      slot.reservations.forEach((r) => {
        const admitD    = parseDateStr(r.admitDate);
        const dischargeD = parseDateStr(r.discharge);
        // 퇴원 예정일이 어제 이전인 예약 → 자동 삭제
        if (dischargeD && dateOnly(dischargeD) < today) { changed = true; return; }
        // 입원일 도달 + current 빈 자리 → 자동 입원 전환
        if (!promoted && admitD && dateOnly(admitD) <= today && !newSlots[slotKey].current?.name) {
          const { admitDate, ...rest } = r;
          newSlots[slotKey].current = rest;
          promoted = true;
          changed = true;
          return;
        }
        keep.push(r);
      });
      newSlots[slotKey].reservations = keep;
    });
    if (changed) set(ref(db, "slots"), newSlots);
  }, [slots]);

  // ── sessionStorage에서 pendingMove 복원 (room.js에서 이동 시작 시) ─────────
  useEffect(() => {
    const pending = sessionStorage.getItem("pendingMove");
    if (pending) {
      try { setMovingPatient(JSON.parse(pending)); } catch(e) {}
      sessionStorage.removeItem("pendingMove");
    }
  }, []);

  const saveSlots = useCallback(async (newS) => {
    setSlots(newS);
    await set(ref(db, "slots"), newS);
  }, []);



  const addLog = useCallback(async (entry) => {
    const newLog = { ...entry, ts: new Date().toISOString() };
    setLogs(prev => {
      const updated = [newLog, ...prev].slice(0, 100);
      set(ref(db, "logs"), updated).catch(console.error);
      return updated;
    });
  }, []);

  // 예약 → 현재 입원 전환 (addLog 선언 후에 위치)
  const convertReservation = useCallback(async (slotKey, resIndex) => {
    const slot = slots[slotKey];
    if (!slot?.reservations?.[resIndex]) return;
    const r = slot.reservations[resIndex];
    if (!window.confirm(`${r.name}님을 현재 입원 환자로 전환하시겠습니까?\n기존 입원 환자가 있으면 덮어씌워집니다.`)) return;
    const newSlots = JSON.parse(JSON.stringify(slots));
    const { admitDate, ...rest } = r;
    newSlots[slotKey].current = { ...rest };
    newSlots[slotKey].reservations = slot.reservations.filter((_, i) => i !== resIndex);
    await saveSlots(newSlots);
    await addLog({ action: "입원전환", slotKey, name: r.name, note: `예약→입원 전환 (예약일: ${admitDate||"미정"})` });
  }, [slots, saveSlots, addLog]);

  const manualRefresh = useCallback(async () => {
    setSyncing(true);
    const snap = await get(ref(db, "slots"));
    if (snap.val()) setSlots(snap.val());
    setLastSync(new Date()); setSyncing(false);
  }, []);

  // ── 환자 검색 ──────────────────────────────────────────────────────────────
  const doSearch = (q) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    const results = [];
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomId = slotKey.split("-")[0];
      // 현재 입원
      if (slot?.current?.name?.includes(q.trim())) {
        results.push({ slotKey, name: slot.current.name, type: "current", roomId });
      }
      // 예약
      (slot?.reservations || []).forEach(r => {
        if (r.name?.includes(q.trim())) {
          results.push({ slotKey, name: r.name, type: "reserved", roomId, admitDate: r.admitDate });
        }
      });
    });
    setSearchResults(results);
  };

  const scrollToCard = (roomId) => {
    setView("ward");
    setSelectedRoom(null);
    setTimeout(() => {
      const el = cardRefs.current[roomId];
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }, 100);
  };

  // ── 가용 병실 조회 (개선판) ────────────────────────────────────────────────

  // 특정 기간 동안 병상이 비어있는지 확인
  const slotFreeForPeriod = (slotsData, slotKey, fromD, toD) => {
    const slot = slotsData[slotKey];
    if (!slot) return true;
    if (slot.current?.name) {
      const d = parseDateStr(slot.current.discharge);
      if (!d || dateOnly(d) >= fromD) return false;
    }
    for (const r of (slot.reservations || [])) {
      const rA = parseDateStr(r.admitDate);
      if (!rA) continue;
      const rD = parseDateStr(r.discharge);
      const rEnd = rD ? dateOnly(rD) : null;
      if (rEnd && toD) { if (dateOnly(rA) <= toD && rEnd >= fromD) return false; }
      else if (rEnd)   { if (rEnd >= fromD) return false; }
      else             { if (!toD || dateOnly(rA) <= toD) return false; }
    }
    return true;
  };

  // 같은 병실 유형의 이동 가능한 대체 병상 목록
  const findAltSlots = (slotsData, excludeKey, roomType, fromD, toD) => {
    const alts = [];
    Object.entries(WARD_STRUCTURE).forEach(([, ward]) => {
      ward.rooms.forEach(room => {
        if (room.type !== roomType) return;
        for (let b = 1; b <= room.capacity; b++) {
          const sk = `${room.id}-${b}`;
          if (sk === excludeKey) continue;
          if (slotFreeForPeriod(slotsData, sk, fromD, toD))
            alts.push({ slotKey: sk, roomId: room.id, bedNum: b, wardName: ward.name });
        }
      });
    });
    return alts;
  };

  // 직접 가용 + 조정 가능 목록 동시 계산
  const computeAvail = (slotsData, admitD, dischargeD, types) => {
    const allRooms = Object.entries(WARD_STRUCTURE).flatMap(([, ward]) =>
      ward.rooms.map(r => ({ ...r, wardName: ward.name }))
    );
    const results = [], adjustments = [];

    allRooms.forEach(room => {
      if (types.length > 0 && !types.includes(room.type)) return;
      for (let bedNum = 1; bedNum <= room.capacity; bedNum++) {
        const slotKey = `${room.id}-${bedNum}`;

        // 직접 가용
        if (slotFreeForPeriod(slotsData, slotKey, admitD, dischargeD)) {
          results.push({ slotKey, roomId: room.id, bedNum, roomType: room.type, wardName: room.wardName });
          continue;
        }

        const slot = slotsData[slotKey];

        // 예약이 막고 있는 경우만 조정 제안 (입원 중인 환자는 이동 제외)
        (slot?.reservations || []).forEach((r, resIdx) => {
          const rA = parseDateStr(r.admitDate);
          if (!rA) return;
          const rD = parseDateStr(r.discharge);
          const rEnd = rD ? dateOnly(rD) : null;
          let overlaps = false;
          if (rEnd && dischargeD) overlaps = dateOnly(rA) <= dischargeD && rEnd >= admitD;
          else if (rEnd)          overlaps = rEnd >= admitD;
          else                    overlaps = !dischargeD || dateOnly(rA) <= dischargeD;
          if (!overlaps) return;

          const alts = findAltSlots(slotsData, slotKey, room.type, dateOnly(rA), rEnd);
          if (alts.length === 0) return;

          // 대안 병상 우선순위: 동일 병상번호(10점) > 동일 병실(5점) > 동일 병동(2점)
          const scoredAlts = alts
            .map(alt => ({
              ...alt,
              score: (alt.bedNum === bedNum   ? 10 : 0)
                   + (alt.roomId === room.id  ?  5 : 0)
                   + (alt.wardName === room.wardName ?  2 : 0),
            }))
            .sort((x, y) => y.score - x.score);

          adjustments.push({
            slotKey, roomId: room.id, bedNum, roomType: room.type, wardName: room.wardName,
            blocker: { type: "reservation", name: r.name,
              admitDate: r.admitDate, discharge: r.discharge, resIndex: resIdx },
            alternatives: scoredAlts,
            bestScore: scoredAlts[0].score,
          });
        });
      }
    });

    // 우선순위(bestScore) 높은 순 정렬 → 상위 5건만
    adjustments.sort((x, y) => y.bestScore - x.bestScore);
    return { results, adjustments: adjustments.slice(0, 5) };
  };

  const doAvailCheck = (slotsOverride) => {
    if (!availAdmit) return;
    const admitD     = dateOnly(new Date(availAdmit + "T00:00:00"));
    const dischargeD = availDischarge ? dateOnly(new Date(availDischarge + "T00:00:00")) : null;
    const { results, adjustments } = computeAvail(slotsOverride || slots, admitD, dischargeD, availTypes);
    setAvailResults(results);
    setAvailAdjustments(adjustments);
  };

  // 예약을 다른 병상으로 이동 적용
  const applyReservationMove = async (fromSlot, resIndex, toSlot, patientName) => {
    if (!confirm(`${patientName}님 예약을 ${toSlot.replace("-", "호 ")}번으로 이동하시겠습니까?`)) return;
    setApplyingMove(true);
    try {
      const fromData   = slots[fromSlot] || {};
      const reservation = (fromData.reservations || [])[resIndex];
      if (!reservation) return;
      const newFromRes = (fromData.reservations || []).filter((_, i) => i !== resIndex);
      const toData     = slots[toSlot] || { current: null, reservations: [] };
      const newToRes   = [...(toData.reservations || []), reservation]
        .sort((a, b2) => {
          const da = parseDateStr(a.admitDate), db2 = parseDateStr(b2.admitDate);
          if (!da) return 1; if (!db2) return -1;
          return dateOnly(da) - dateOnly(db2);
        });
      await set(ref(db, `slots/${fromSlot}`), { ...fromData, reservations: newFromRes });
      await set(ref(db, `slots/${toSlot}`),   { ...toData,   reservations: newToRes   });
      // 낙관적 업데이트로 즉시 재조회
      doAvailCheck({ ...slots, [fromSlot]: { ...fromData, reservations: newFromRes }, [toSlot]: { ...toData, reservations: newToRes } });
    } catch (e) {
      alert("이동 중 오류: " + e.message);
    }
    setApplyingMove(false);
  };

  const applyPreview = () => { setPreviewDate(new Date(previewInput + "T00:00:00")); };
  const clearPreview = () => { setPreviewDate(null); setPreviewInput(toInputValue(todayDate())); };

  const getRoomStats = useCallback((roomId, capacity) => {
    const bedList = Array.from({ length: capacity }, (_, i) => {
      const key = `${roomId}-${i+1}`;
      const slot = slots[key] || null;
      const { person, type } = getSlotOccupant(slot, viewDate);
      const hasReserve = !isPreview && hasUpcomingReservation(slot);
      const reserveCount = !isPreview ? countUpcomingReservations(slot) : 0;
      return { slotKey: key, person, type, hasReserve, reserveCount, slot };
    });
    const occupied = bedList.filter(b => {
      if (b.person) return true;
      if (!isPreview && showReserved && b.hasReserve) return true;
      return false;
    }).length;
    return { occupied, available: capacity - occupied, bedList };
  }, [slots, viewDate, isPreview, showReserved]);

  const totalStats = useCallback(() => {
    let occ = 0;
    Object.values(WARD_STRUCTURE).forEach(ward =>
      ward.rooms.forEach(r => { occ += getRoomStats(r.id, r.capacity).occupied; })
    );
    return { total: 78, occupied: occ, available: 78 - occ };
  }, [getRoomStats]);

  // ── 빈 병상 순환 하이라이트 ───────────────────────────────────────────────
  const emptySlots = !isPreview ? getAllEmptySlots(slots, getRoomStats) : [];

  const handleHighlightEmpty = () => {
    if (!highlightEmpty) {
      setHighlightEmpty(true);
      setEmptySlotIdx(0);
    } else {
      const next = (emptySlotIdx + 1) % Math.max(emptySlots.length, 1);
      setEmptySlotIdx(next);
    }
  };

  const stopHighlight = () => { setHighlightEmpty(false); setEmptySlotIdx(0); };

  // ── 환자 이동 ─────────────────────────────────────────────────────────────
  // movingPatient: { slotKey, mode:"current"|"reservation", data, resIndex }
  // 이동 시작하면 병실 현황으로 돌아가서 어느 병실로든 이동 가능
  const startMove = (slotKey, mode, data, resIndex) => {
    setMovingPatient({ slotKey, mode, data, resIndex });
    setView("ward"); // 현황판으로 돌아가서 병실 선택
  };

  const executeMove = async (targetSlotKey) => {
    if (!movingPatient) return;
    const { slotKey: fromKey, mode, data, resIndex } = movingPatient;
    if (fromKey === targetSlotKey) { setMovingPatient(null); return; }

    const newSlots = JSON.parse(JSON.stringify(slots)); // deep copy

    // 원래 자리에서 제거
    if (mode === "current") {
      newSlots[fromKey] = { ...(newSlots[fromKey] || {}), current: null };
    } else {
      const oldRes = [...(newSlots[fromKey]?.reservations || [])];
      oldRes.splice(resIndex, 1);
      newSlots[fromKey] = { ...(newSlots[fromKey] || {}), reservations: oldRes };
    }

    // 새 자리에 추가
    if (!newSlots[targetSlotKey]) newSlots[targetSlotKey] = { current: null, reservations: [] };
    const targetSlot = newSlots[targetSlotKey];

    if (mode === "current") {
      if (targetSlot.current) {
        // 이미 사람 있으면 예약으로 추가
        if (!targetSlot.reservations) targetSlot.reservations = [];
        targetSlot.reservations.push({ ...data });
      } else {
        targetSlot.current = { ...data };
      }
    } else {
      if (!targetSlot.reservations) targetSlot.reservations = [];
      targetSlot.reservations.push({ ...data });
    }

    await saveSlots(newSlots);
    await addLog({ type: "edit", msg: `${data.name} 이동: ${fromKey} → ${targetSlotKey}` });
    setMovingPatient(null);
  };

  // ── CRUD ─────────────────────────────────────────────────────────────────
  const saveCurrentPatient = async (slotKey, data) => {
    const newSlots = { ...slots, [slotKey]: { ...(slots[slotKey] || { reservations: [] }), current: data } };
    await saveSlots(newSlots);
    await addLog({ type: "edit", msg: `${slotKey} ${data.name} 정보 수정` });
    setEditingSlot(null); setAddingTo(null);
  };

  const dischargeCurrentPatient = async (slotKey) => {
    if (!window.confirm("퇴원 처리하시겠습니까?")) return;
    const name = slots[slotKey]?.current?.name;
    const newSlot = { ...(slots[slotKey] || {}), current: null };
    const reservations = newSlot.reservations || [];
    const nextIdx = reservations.findIndex(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) <= todayDate(); });
    if (nextIdx >= 0) {
      newSlot.current = { ...reservations[nextIdx] };
      delete newSlot.current.admitDate;
      newSlot.reservations = reservations.filter((_, i) => i !== nextIdx);
    }
    await saveSlots({ ...slots, [slotKey]: newSlot });
    await addLog({ type: "discharge", msg: `${slotKey} ${name} 퇴원 처리` });
    setEditingSlot(null);
  };

  const saveReservation = async (slotKey, resData, resIndex) => {
    const oldSlot = slots[slotKey] || { current: null, reservations: [] };
    const reservations = [...(oldSlot.reservations || [])];
    if (resIndex !== undefined) reservations[resIndex] = resData;
    else reservations.push(resData);
    reservations.sort((a, b) => { const da = parseDateStr(a.admitDate), db2 = parseDateStr(b.admitDate); if (!da) return 1; if (!db2) return -1; return da - db2; });
    await saveSlots({ ...slots, [slotKey]: { ...oldSlot, reservations } });
    await addLog({ type: "reserve", msg: `${slotKey} ${resData.name} ${resIndex !== undefined ? "예약 수정":"예약 등록"} (${resData.admitDate})` });
    setEditingSlot(null); setAddingTo(null);
  };

  const cancelReservation = async (slotKey, resIndex) => {
    if (!window.confirm("예약을 취소하시겠습니까?")) return;
    const oldSlot = slots[slotKey] || { current: null, reservations: [] };
    const name = oldSlot.reservations?.[resIndex]?.name;
    const reservations = (oldSlot.reservations || []).filter((_, i) => i !== resIndex);
    await saveSlots({ ...slots, [slotKey]: { ...oldSlot, reservations } });
    await addLog({ type: "reserve", msg: `${slotKey} ${name} 예약 취소` });
    setEditingSlot(null);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true); setUploadResult(null);
    try { setUploadResult({ results: await analyzeMessengerText(await file.text()) }); }
    catch (err) { setUploadResult({ error: "분석 실패: " + err.message }); }
    setUploading(false); e.target.value = "";
  };

  const applyAnalysis = async (results) => {
    const newSlots = { ...slots }; let applied = 0;
    results.forEach(r => {
      if (!r.room || !r.name) return;
      let cap = 4;
      for (const ward of Object.values(WARD_STRUCTURE)) { const rm = ward.rooms.find(x => x.id === r.room); if (rm) { cap = rm.capacity; break; } }
      for (let i = 1; i <= cap; i++) {
        const key = `${r.room}-${i}`;
        if (newSlots[key]?.current?.name === r.name) {
          newSlots[key] = { ...newSlots[key], current: { ...newSlots[key].current, discharge: r.discharge, note: r.note, scheduleAlert: r.scheduleAlert } };
          applied++; return;
        }
      }
      for (let i = 1; i <= cap; i++) {
        const key = `${r.room}-${i}`;
        if (!newSlots[key]?.current) {
          newSlots[key] = { current: { name: r.name, bedPosition: i, discharge: r.discharge || "미정", note: r.note || "", scheduleAlert: r.scheduleAlert || false }, reservations: [] };
          applied++; return;
        }
      }
    });
    await saveSlots(newSlots);
    await addLog({ type: "upload", msg: `메신저 분석 완료: ${applied}명 반영` });
    setUploadResult(null);
  };

  const stats = totalStats();
  const currentEmptySlotKey = highlightEmpty && emptySlots.length > 0 ? emptySlots[emptySlotIdx % emptySlots.length]?.slotKey : null;

  if (syncing && Object.keys(slots).length === 0) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:16, background:"#f0f4f8" }}>
      <img src="/favicon.png" style={{ width:48, height:48, objectFit:"contain" }} />
      <div style={{ fontSize:16, fontWeight:700, color:"#0f2744" }}>병동 현황 불러오는 중...</div>
    </div>
  );

  return (
    <div style={S.app} onClick={movingPatient ? undefined : undefined}>
      {/* 이동 중 오버레이 안내 */}
      {movingPatient && (
        <div style={S.movingBanner}>
          🚚 <strong>{movingPatient.data.name}</strong> 이동 중 — 병실을 선택하고 이동할 병상을 클릭하세요
          <button style={S.movingCancelBtn} onClick={() => setMovingPatient(null)}>취소</button>
        </div>
      )}

      {/* 헤더 */}
      <header style={{ ...S.header, position:"sticky", top:0, zIndex:40, background: isPreview ? "#0d3320" : movingPatient ? "#1e1b4b" : "#0f2744",
        flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "stretch" : "center",
        padding: isMobile ? "8px 12px" : "10px 16px", gap: isMobile ? 6 : 12 }}>
        {/* 첫 줄: 로고+타이틀 + 새로고침 + 햄버거 */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <img src="/favicon.png" style={{ width: isMobile?32:40, height: isMobile?32:40, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
          <div style={{ flex:1 }}>
            <div style={{ ...S.title, fontSize: isMobile ? 13 : 15 }}>이우 병동 현황 관리</div>
            {!isMobile && <div style={S.subtitle}>EWOO Ward Management System</div>}
          </div>
          {isMobile && (
            <>
              <button style={S.btnRefresh} onClick={manualRefresh} title="새로고침">↻</button>
              <div style={{ position:"relative" }}>
                <button style={{ ...S.navBtn, fontSize:18, padding:"4px 10px" }}
                  onClick={() => setMobileMenuOpen(v => !v)}>☰</button>
                {mobileMenuOpen && (
                  <div style={{ position:"fixed", top:0, left:0, right:0, bottom:0, zIndex:999 }}
                    onClick={() => setMobileMenuOpen(false)}>
                    <div style={{ position:"absolute", top:54, right:8, background:"#1e293b", borderRadius:10,
                      boxShadow:"0 8px 32px rgba(0,0,0,0.4)", minWidth:180, overflow:"hidden" }}
                      onClick={e => e.stopPropagation()}>
                      {[
                        { label:"🏠 홈", action:() => { setView("ward"); setSelectedRoom(null); clearPreview(); stopHighlight(); setMovingPatient(null); } },
                        { label:`🔔 웹훅 승인${pendingCount > 0 ? ` (${pendingCount})` : ""}`, action:() => router.push("/history") },
                        { label:"📅 월간 예정표", action:() => router.push("/monthly") },
                        { label:"🏥 치료실", action:() => router.push("/therapy") },
                        { label:"📋 상담일지", action:() => router.push("/consultation") },
                        { label:"📋 일일 현황판", action:() => router.push("/daily-board") },
                        { label:"📋 일일 치료", action:() => router.push("/daily") },
                        { label:"📜 변경 이력", action:() => setView("log") },
                        { label:"👤 환자조회", action:() => router.push("/patients") },
                        { label:"⚙️ 설정", action:() => router.push("/settings") },
                      ].map(item => (
                        <button key={item.label}
                          style={{ display:"block", width:"100%", textAlign:"left", padding:"12px 18px",
                            background:"none", border:"none", borderBottom:"1px solid #334155",
                            color:"#e2e8f0", fontSize:14, fontWeight:600, cursor:"pointer" }}
                          onClick={() => { item.action(); setMobileMenuOpen(false); }}>
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {/* 통계 필 + 토글 버튼 */}
        <div style={{ ...S.headerCenter, justifyContent: isMobile ? "flex-start" : "center" }}>
          <StatPill label="전체 병상"  value={stats.total}     color="#64748b" />
          <StatPill label="사용 중"    value={stats.occupied}  color={isPreview ? "#34d399":"#0ea5e9"} />
          <StatPill label="빈 병상"    value={stats.available} color={isPreview ? "#6ee7b7":"#10b981"} />
          {!isPreview && (
            <>
              <button onClick={() => setShowReserved(v => !v)}
                style={{ ...S.reserveToggle, background: showReserved ? "#312e81":"#1e293b", color: showReserved ? "#a5b4fc":"#94a3b8" }}>
                📅 예약 {showReserved ? "포함":"미포함"}
              </button>
              <button onClick={handleHighlightEmpty}
                style={{ ...S.reserveToggle, background: highlightEmpty ? "#065f46":"#1e293b", color: highlightEmpty ? "#34d399":"#94a3b8", position:"relative" }}>
                🔍 빈 병상 {highlightEmpty ? `(${emptySlotIdx + 1}/${emptySlots.length})` : `(${emptySlots.length})`}
              </button>
              {highlightEmpty && (
                <button onClick={stopHighlight} style={{ ...S.reserveToggle, background:"#7f1d1d", color:"#fca5a5" }}>✕ 해제</button>
              )}
            </>
          )}
        </div>
        {/* 데스크탑 전용 네비 */}
        {!isMobile && (
          <div style={S.headerRight}>
            <span style={S.syncInfo}>{syncing ? "🔄 동기화 중..." : lastSync ? `✓ ${lastSync.toLocaleTimeString("ko")} 저장됨` : ""}</span>
            <button style={S.btnRefresh} onClick={manualRefresh} title="새로고침">↻</button>
            {/* 주요 메뉴 */}
            <button style={{ ...S.navBtn, display:"flex", alignItems:"center", gap:5 }}
              onClick={() => { setView("ward"); setSelectedRoom(null); clearPreview(); stopHighlight(); setMovingPatient(null); }}>
              🏠 홈
            </button>
            <button style={{ ...S.navBtn, background:"#431407", color:"#fed7aa" }} onClick={() => router.push("/history")}>
              🔔 웹훅 승인{pendingCount > 0 && <span style={{ marginLeft:4, background:"#dc2626", color:"#fff", borderRadius:9, padding:"0 5px", fontSize:11, fontWeight:800 }}>{pendingCount}</span>}
            </button>
            <button style={{ ...S.navBtn, background:"#1e3a5f", color:"#a5f3fc" }} onClick={() => router.push("/monthly")}>📅 월간 예정표</button>
            <button style={{ ...S.navBtn, background:"#064e3b", color:"#6ee7b7" }} onClick={() => router.push("/therapy")}>🏥 치료실</button>
            <button style={{ ...S.navBtn, background:"#713f12", color:"#fef08a" }} onClick={() => router.push("/consultation")}>📋 상담일지</button>
            {/* 더보기 드롭다운 */}
            <div style={{ position:"relative" }}>
              <button style={{ ...S.navBtn, background:"#334155", color:"#cbd5e1" }}
                onClick={() => setMoreOpen(v => !v)}>
                ⋯ 더보기
              </button>
              {moreOpen && (
                <div style={{ position:"absolute", top:"calc(100% + 6px)", right:0, background:"#1e293b",
                  borderRadius:8, boxShadow:"0 8px 24px rgba(0,0,0,0.4)", minWidth:160, overflow:"hidden", zIndex:50 }}
                  onMouseLeave={() => setMoreOpen(false)}>
                  {[
                    { label:"📋 일일 현황판", action:() => router.push("/daily-board"), color:"#fde68a" },
                    { label:"📋 일일 치료", action:() => router.push("/daily"), color:"#6ee7b7" },
                    { label:"📜 변경 이력", action:() => { setView("log"); setMoreOpen(false); }, color:"#cbd5e1" },
                    { label:"👤 환자조회", action:() => router.push("/patients"), color:"#93c5fd" },
                    { label:"⚙️ 설정", action:() => router.push("/settings"), color:"#cbd5e1" },
                  ].map(item => (
                    <button key={item.label}
                      style={{ display:"block", width:"100%", textAlign:"left", padding:"10px 16px",
                        background:"none", border:"none", borderBottom:"1px solid #334155",
                        color: item.color, fontSize:13, fontWeight:600, cursor:"pointer" }}
                      onClick={() => { item.action(); setMoreOpen(false); }}>
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* 날짜 바 */}
      <div style={{ ...S.datebar, background: isPreview ? "#f0fdf4":"#fff", borderBottom: isPreview ? "2px solid #6ee7b7":"1px solid #e2e8f0" }}>
        <div style={S.datebarLeft}>
          {isPreview ? <span style={S.previewBadge}>🔭 미래 미리보기 중</span> : <span style={S.todayBadge}>📅 오늘 실시간 현황</span>}
          <span style={S.activeDateLabel}>{toKoreanDate(viewDate)}</span>
        </div>
        <div style={S.datebarRight}>
          <span style={{ fontSize:13, color:"#64748b", fontWeight:600 }}>날짜 미리보기:</span>
          <input type="date" style={S.dateInput} value={previewInput} onChange={e => setPreviewInput(e.target.value)} />
          <button style={S.btnPreview} onClick={applyPreview}>미리보기</button>
          {isPreview && <button style={S.btnToday} onClick={clearPreview}>← 오늘로</button>}
        </div>
      </div>

      {/* 검색 + 가용병실 조회 바 */}
      {!isPreview && (
        <div style={{background:"#fff",borderBottom:"1px solid #e2e8f0",padding:"8px 16px",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",position:"sticky",top:0,zIndex:29}}>
          {/* 환자 검색 */}
          <div style={{position:"relative",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:0,border:"1.5px solid #e2e8f0",borderRadius:8,overflow:"hidden",background:"#f8fafc"}}>
              <span style={{padding:"0 8px",fontSize:14,color:"#94a3b8"}}>🔍</span>
              <input
                ref={searchRef}
                style={{border:"none",outline:"none",background:"transparent",padding:"7px 4px",fontSize:13,width:140,fontFamily:"inherit"}}
                placeholder="환자 이름 검색..."
                value={searchQuery}
                onChange={e=>doSearch(e.target.value)}
                onFocus={()=>setSearchFocused(true)}
                onBlur={()=>setTimeout(()=>setSearchFocused(false),200)}
              />
              {searchQuery&&<button onClick={()=>{setSearchQuery("");setSearchResults([]);}} style={{border:"none",background:"none",cursor:"pointer",padding:"0 8px",color:"#94a3b8",fontSize:14}}>✕</button>}
            </div>
            {/* 검색 결과 드롭다운 */}
            {searchFocused && searchResults.length > 0 && (
              <div style={{position:"absolute",top:"100%",left:0,minWidth:240,background:"#fff",borderRadius:8,
                boxShadow:"0 4px 20px rgba(0,0,0,0.15)",border:"1px solid #e2e8f0",zIndex:100,maxHeight:280,overflowY:"auto",marginTop:4}}>
                {searchResults.map((r,i)=>(
                  <div key={i} onClick={()=>{ scrollToCard(r.roomId); setSearchFocused(false); }}
                    style={{padding:"8px 14px",cursor:"pointer",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:8,
                      background:"#fff",transition:"background 0.1s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#f0f9ff"}
                    onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
                    <span style={{fontSize:11,background:r.type==="current"?"#dbeafe":"#f5f3ff",color:r.type==="current"?"#1d4ed8":"#7c3aed",
                      borderRadius:4,padding:"1px 6px",fontWeight:700,flexShrink:0}}>
                      {r.type==="current"?"입원중":"예약"}
                    </span>
                    <span style={{fontWeight:700,fontSize:13}}>{r.name}</span>
                    <span style={{fontSize:11,color:"#94a3b8",marginLeft:"auto"}}>{r.roomId}호{r.admitDate&&` · ${r.admitDate} 예정`}</span>
                  </div>
                ))}
              </div>
            )}
            {searchFocused && searchQuery.trim() && searchResults.length === 0 && (
              <div style={{position:"absolute",top:"100%",left:0,width:240,background:"#fff",borderRadius:8,
                boxShadow:"0 4px 20px rgba(0,0,0,0.15)",border:"1px solid #e2e8f0",zIndex:100,padding:"12px 14px",marginTop:4,
                fontSize:13,color:"#94a3b8",textAlign:"center"}}>검색 결과 없음</div>
            )}
          </div>

          {/* 구분선 */}
          <div style={{width:1,height:28,background:"#e2e8f0",flexShrink:0}}/>

          {/* 가용병실 조회 토글 버튼 */}
          <button onClick={()=>{setAvailOpen(o=>!o);setAvailResults(null);}}
            style={{background:availOpen?"#0f2744":"#f1f5f9",color:availOpen?"#fff":"#475569",
              border:"1.5px solid "+(availOpen?"#0f2744":"#e2e8f0"),borderRadius:8,padding:"6px 13px",
              cursor:"pointer",fontSize:12,fontWeight:700,flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
            🏠 가용 병실 조회{availOpen?" ▲":" ▼"}
          </button>

          {/* 가용병실 조회 패널 */}
          {availOpen && (
            <div style={{width:"100%",background:"#f8fafc",borderRadius:10,border:"1.5px solid #e2e8f0",
              padding:"12px 16px",display:"flex",gap:12,alignItems:"flex-start",flexWrap:"wrap",marginTop:4}}>
              {/* 날짜 입력 */}
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <label style={{fontSize:11,fontWeight:700,color:"#64748b"}}>입원 예정일</label>
                  <input type="date" value={availAdmit} onChange={e=>setAvailAdmit(e.target.value)}
                    style={{border:"1.5px solid #e2e8f0",borderRadius:7,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
                </div>
                <div style={{fontSize:16,color:"#94a3b8",marginTop:16}}>~</div>
                <div style={{display:"flex",flexDirection:"column",gap:3}}>
                  <label style={{fontSize:11,fontWeight:700,color:"#64748b"}}>퇴원 예정일 (선택)</label>
                  <input type="date" value={availDischarge} onChange={e=>setAvailDischarge(e.target.value)}
                    style={{border:"1.5px solid #e2e8f0",borderRadius:7,padding:"5px 8px",fontSize:12,outline:"none",fontFamily:"inherit"}}/>
                </div>
              </div>
              {/* 병실 종류 */}
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                <label style={{fontSize:11,fontWeight:700,color:"#64748b"}}>병실 종류 (복수 선택)</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["1인실","2인실","4인실","6인실"].map(t=>(
                    <button key={t} onClick={()=>setAvailTypes(prev=>prev.includes(t)?prev.filter(x=>x!==t):[...prev,t])}
                      style={{border:`1.5px solid ${TYPE_COLOR[t]}`,borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:12,fontWeight:700,
                        background:availTypes.includes(t)?TYPE_COLOR[t]:TYPE_BG[t],
                        color:availTypes.includes(t)?"#fff":TYPE_COLOR[t]}}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"flex-end",paddingBottom:1}}>
                <button onClick={() => doAvailCheck()} disabled={!availAdmit}
                  style={{background:availAdmit?"#0f2744":"#94a3b8",color:"#fff",border:"none",borderRadius:8,
                    padding:"8px 18px",cursor:availAdmit?"pointer":"not-allowed",fontSize:13,fontWeight:700}}>
                  조회
                </button>
              </div>
              {/* 결과 */}
              {availResults !== null && (
                <div style={{width:"100%",marginTop:4}}>
                  {/* ① 직접 가용 병상 */}
                  {availResults.length > 0 ? (
                    <div style={{marginBottom:10}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#16a34a",marginBottom:6}}>
                        ✅ 직접 가용 병상 {availResults.length}개
                        {availTypes.length>0&&<span style={{fontWeight:400,color:"#64748b",marginLeft:4}}>({availTypes.join("·")})</span>}
                      </div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        {availResults.map((r,i)=>(
                          <button key={i} onClick={()=>scrollToCard(r.roomId)}
                            style={{background:TYPE_BG[r.roomType],border:`1.5px solid ${TYPE_COLOR[r.roomType]}`,
                              borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:700,
                              color:TYPE_COLOR[r.roomType],display:"flex",alignItems:"center",gap:4}}>
                            <span style={{fontSize:11,color:"#64748b"}}>{r.wardName}</span>
                            {r.roomId}호 {r.bedNum}번
                            <span style={{fontSize:10,background:TYPE_COLOR[r.roomType],color:"#fff",borderRadius:3,padding:"1px 5px"}}>{r.roomType}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div style={{color:"#ef4444",fontWeight:700,fontSize:12,marginBottom:8}}>
                      ⚠️ 직접 가용한 병상 없음
                    </div>
                  )}

                  {/* ② 예약 조정으로 확보 가능 */}
                  {availAdjustments.length > 0 && (
                    <div style={{borderTop:"1.5px solid #e9d5ff",paddingTop:10}}>
                      <div style={{fontSize:12,fontWeight:700,color:"#7c3aed",marginBottom:8}}>
                        🔄 예약 조정으로 확보 가능 (우선순위 상위 {availAdjustments.length}건)
                        <span style={{fontSize:11,fontWeight:400,color:"#64748b",marginLeft:6}}>
                          — 예약자를 같은 조건의 다른 병상으로 이동 시
                        </span>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:6}}>
                        {availAdjustments.map((adj, i) => (
                          <div key={i} style={{background:"#faf5ff",border:"1px solid #e9d5ff",borderRadius:8,padding:"8px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:5}}>
                              <span style={{fontSize:11,color:"#94a3b8",fontWeight:700,flexShrink:0}}>#{i+1}</span>
                              <span style={{background:"#7c3aed",color:"#fff",borderRadius:5,padding:"2px 8px",fontSize:11,fontWeight:700,flexShrink:0}}>
                                {adj.roomId}호 {adj.bedNum}번
                              </span>
                              <span style={{fontSize:10,background:TYPE_BG[adj.roomType],color:TYPE_COLOR[adj.roomType],borderRadius:4,padding:"1px 6px",fontWeight:700}}>
                                {adj.roomType}
                              </span>
                              <span style={{fontSize:12,color:"#374151"}}>
                                <strong>{adj.blocker.name}</strong>님 예약 {adj.blocker.admitDate}~{adj.blocker.discharge||"미정"}
                              </span>
                            </div>
                            <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                              <span style={{fontSize:11,color:"#7c3aed",fontWeight:700,flexShrink:0}}>이동 →</span>
                              {adj.alternatives.slice(0, 3).map((alt, ai) => (
                                <button key={ai}
                                  disabled={applyingMove}
                                  onClick={() => applyReservationMove(adj.slotKey, adj.blocker.resIndex, alt.slotKey, adj.blocker.name)}
                                  style={{
                                    border:"1.5px solid #7c3aed",
                                    borderRadius:6,padding:"3px 10px",
                                    fontSize:11,fontWeight:700,
                                    background:"#fff",color:"#7c3aed",
                                    cursor:"pointer",opacity:applyingMove?0.6:1,
                                  }}>
                                  {alt.wardName} {alt.roomId}호 {alt.bedNum}번 ✓ 적용
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {availResults.length===0 && availAdjustments.length===0 && (
                    <div style={{color:"#94a3b8",fontSize:12,marginTop:4}}>
                      조정 가능한 예약도 없습니다.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 업로드 바 — 일시 숨김 */}
      {false && !isPreview && (
        <div style={S.uploadBar}>
          <span style={S.uploadLabel}>📩 메신저 파일 분석</span>
          <input ref={fileInputRef} type="file" accept=".txt" style={{ display:"none" }} onChange={handleFileUpload} />
          <button style={S.btnUpload} onClick={() => fileInputRef.current.click()} disabled={uploading}>{uploading ? "⏳ 분석 중...":"📂 파일 업로드"}</button>
          <button style={{ ...S.btnUpload, background:"#7c3aed" }} onClick={() => setJsonPasteOpen(true)}>📋 JSON 붙여넣기</button>
          {uploadResult?.error && <span style={{ color:"#dc2626", fontSize:13 }}>❌ {uploadResult.error}</span>}
        </div>
      )}
      {false && uploadResult?.results && <AnalysisPreview results={uploadResult.results} onApply={() => applyAnalysis(uploadResult.results)} onDiscard={() => setUploadResult(null)} />}

      {/* 본문 */}
      <main style={S.main}>
        {view === "ward" && (
          <WardView
            slots={slots} getRoomStats={getRoomStats} isPreview={isPreview} viewDate={viewDate}
            showReserved={showReserved} highlightEmpty={highlightEmpty} currentEmptySlotKey={currentEmptySlotKey}
            movingPatient={movingPatient} onMoveTarget={executeMove}
            onSelectRoom={r => {
              if (movingPatient) sessionStorage.setItem("pendingMove", JSON.stringify(movingPatient));
              router.push(`/room?roomId=${r.id}${previewDate?`&preview=${toInputValue(previewDate)}`:""}`)
            }}
            cardRefs={cardRefs}
          />
        )}
        {view === "room" && selectedRoom && (
          <RoomDetailView room={selectedRoom} slots={slots} getRoomStats={getRoomStats} isPreview={isPreview} viewDate={viewDate}
            movingPatient={movingPatient} onStartMove={startMove} onMoveTarget={executeMove}
            onEditCurrent={(sk, data) => setEditingSlot({ slotKey: sk, mode: "current", data })}
            onEditReservation={(sk, data, idx) => setEditingSlot({ slotKey: sk, mode: "reservation", data, resIndex: idx })}
            onAddCurrent={sk => setPatientPickFor({ slotKey: sk, mode: "current" })}
            onAddReservation={sk => setPatientPickFor({ slotKey: sk, mode: "reservation" })}
            onConvertReservation={convertReservation}
            onBack={() => setView("ward")} />
        )}
        {view === "log" && <LogView logs={logs} />}
      </main>

      {/* 모달들 */}
      {editingSlot?.mode === "current" && (
        <PatientModal title={`${editingSlot.slotKey} 현재 환자 수정`} data={editingSlot.data} mode="current"
          onSave={data => saveCurrentPatient(editingSlot.slotKey, data)}
          onDelete={() => dischargeCurrentPatient(editingSlot.slotKey)}
          onClose={() => setEditingSlot(null)} />
      )}
      {editingSlot?.mode === "reservation" && (
        <PatientModal title={`${editingSlot.slotKey} 예약 수정`} data={editingSlot.data} mode="reservation"
          onSave={data => saveReservation(editingSlot.slotKey, data, editingSlot.resIndex)}
          onDelete={() => cancelReservation(editingSlot.slotKey, editingSlot.resIndex)}
          onClose={() => setEditingSlot(null)} />
      )}
      {/* 입원/예약 등록 — 환자 검색 선행 */}
      {patientPickFor && (
        <PatientSearchModal
          onSelect={p => {
            setPatientPickFor(null);
            setAddingTo({ ...patientPickFor, prefill: { name: p.name, patientId: p.internalId } });
          }}
          onClose={() => setPatientPickFor(null)}
        />
      )}
      {addingTo?.mode === "current" && (
        <PatientModal title={`${addingTo.slotKey} 입원 등록`}
          data={{ name: addingTo.prefill?.name||"", patientId: addingTo.prefill?.patientId||"", bedPosition:"", admitDate:"", discharge:"미정", note:"", scheduleAlert:false }}
          mode="current" isNew
          onSave={data => saveCurrentPatient(addingTo.slotKey, data)} onClose={() => setAddingTo(null)} />
      )}
      {addingTo?.mode === "reservation" && (
        <PatientModal title={`${addingTo.slotKey} 예약 입원 등록`}
          data={{ name: addingTo.prefill?.name||"", patientId: addingTo.prefill?.patientId||"", bedPosition:"", admitDate:"", discharge:"미정", note:"", scheduleAlert:false }}
          mode="reservation" isNew
          onSave={data => saveReservation(addingTo.slotKey, data, undefined)} onClose={() => setAddingTo(null)} />
      )}

      {/* JSON 붙여넣기 모달 */}
      {jsonPasteOpen && (
        <div style={S.modalOverlay}>
          <div style={{ ...S.modal, maxWidth:540 }}>
            <div style={{ ...S.modalTitle, color:"#7c3aed" }}>📋 Claude.ai JSON 붙여넣기</div>
            <div style={{ fontSize:13, color:"#64748b", marginBottom:12, lineHeight:1.7 }}>
              1. <a href="https://claude.ai" target="_blank" rel="noreferrer" style={{ color:"#7c3aed" }}>claude.ai</a>에서 아래 프롬프트와 메신저 내용을 함께 붙여넣으세요.<br/>
              2. 반환된 JSON을 아래에 붙여넣고 "반영하기" 클릭.
            </div>
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:12, fontSize:12, color:"#475569", marginBottom:12, lineHeight:1.8, userSelect:"all" }}>
              아래 병원 메신저 내용 분석해서 JSON만 출력해줘. 다른 말 없이 JSON만.<br/>
              병실: 2병동(201~206), 3병동(301~306), 5병동(501~506), 6병동(601~603)<br/>
              형식: [{"{"}"room":"201","name":"홍길동","discharge":"3/20","note":"요약","scheduleAlert":false{"}"}]<br/>
              메신저 내용: (여기에 붙여넣기)
            </div>
            <label style={S.label}>Claude가 반환한 JSON</label>
            <textarea style={{ ...S.input, height:160, resize:"vertical", fontFamily:"monospace", fontSize:12 }}
              value={jsonPasteText} onChange={e => setJsonPasteText(e.target.value)}
              placeholder={'[{"room":"201","name":"홍길동","discharge":"3/20","note":"페인2회","scheduleAlert":false}]'} />
            <div style={S.modalBtns}>
              <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={() => { setJsonPasteOpen(false); setJsonPasteText(""); }}>취소</button>
              <button style={{ ...S.btnModal, background:"#7c3aed", color:"#fff" }} onClick={() => {
                try {
                  const results = JSON.parse(jsonPasteText.replace(/```json|```/g, "").trim());
                  if (!Array.isArray(results)) throw new Error("배열 형식이 아닙니다.");
                  setUploadResult({ results }); setJsonPasteOpen(false); setJsonPasteText("");
                } catch(e) { alert("JSON 오류: " + e.message); }
              }}>반영하기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── WardView ──────────────────────────────────────────────────────────────────
function WardView({ slots, getRoomStats, isPreview, viewDate, showReserved, highlightEmpty, currentEmptySlotKey, movingPatient, onMoveTarget, onSelectRoom, cardRefs }) {
  return (
    <div style={S.wardGrid}>
      {Object.entries(WARD_STRUCTURE).map(([wardNo, ward]) => (
        <div key={wardNo}>
          <div style={{ ...S.wardTitle, borderLeftColor: isPreview ? "#10b981":"#0ea5e9" }}>{ward.name}</div>
          <div style={{ ...S.roomGrid,
            gridTemplateColumns:`repeat(${ward.rooms.length},1fr)`,
            maxWidth: ward.rooms.length < 6 ? `${ward.rooms.length * (100/6)}%` : "100%" }}>
            {ward.rooms.map(room => {
              const { occupied, available, bedList } = getRoomStats(room.id, room.capacity);
              const alertCount = bedList.filter(b => b.person?.scheduleAlert && b.type !== null).length;
              const totalReserveCount = bedList.reduce((sum, b) => sum + (b.reserveCount || 0), 0);
              // 이 방에 하이라이트된 빈 병상이 있는지
              const hasHighlighted = highlightEmpty && bedList.some(b => b.slotKey === currentEmptySlotKey);
              const isMoveTarget = !!movingPatient;

              return (
                <div key={room.id}
                  ref={el => { if(cardRefs) cardRefs.current[room.id] = el; }}
                  onClick={() => onSelectRoom(room)}
                  style={{ ...S.roomCard,
                    borderTop:`3px solid ${TYPE_COLOR[room.type]}`,
                    background: available===0 ? "#fff5f5":"#fff",
                    outline: hasHighlighted ? "3px solid #10b981" : isMoveTarget ? "2px dashed #7c3aed" : "none",
                    boxShadow: hasHighlighted ? "0 0 0 4px #d1fae5, 0 1px 6px rgba(0,0,0,0.06)" : "0 1px 6px rgba(0,0,0,0.06)",
                    cursor: isMoveTarget ? "pointer" : "pointer",
                    transition: "all 0.2s",
                  }}>
                  <div style={S.roomHeader}>
                    <span style={S.roomNo}>{room.id}호</span>
                    <span style={{ ...S.roomTypeBadge, background:TYPE_BG[room.type], color:TYPE_COLOR[room.type] }}>{room.type}</span>
                  </div>
                  {/* 병상 도트 */}
                  <div style={S.bedBar}>
                    {bedList.map((b, i) => {
                      const isHighlighted = highlightEmpty && b.slotKey === currentEmptySlotKey;
                      let bg = "#e2e8f0";
                      if (b.type === "current")               bg = TYPE_COLOR[room.type];
                      else if (b.type === "discharging_today") bg = "#fbbf24";
                      else if (b.type === "admitting_today")   bg = "#93c5fd";
                      else if (b.type === "reserved")          bg = "#a78bfa";
                      else if (!isPreview && b.hasReserve)     bg = "#c4b5fd";
                      else if (isHighlighted)                  bg = "#10b981";
                      return (
                        <div key={i} style={{ ...S.bedDot, background: bg,
                          transform: isHighlighted ? "scale(1.5)" : "scale(1)",
                          transition: "all 0.3s",
                          boxShadow: isHighlighted ? "0 0 6px #10b981" : "none" }} />
                      );
                    })}
                  </div>
                  {/* 병상 수 + 예약 수 */}
                  <div style={S.roomOccupancy}>
                    <span style={{ fontWeight:700 }}>{occupied}</span>
                    <span style={{ color:"#94a3b8" }}>/{room.capacity}</span>
                    {!isPreview && totalReserveCount > 0 && (
                      <span style={{ fontSize:12, fontWeight:700, color:"#7c3aed", marginLeft:6, background:"#f5f3ff", borderRadius:4, padding:"1px 6px" }}>
                        📅{totalReserveCount}
                      </span>
                    )}
                  </div>
                  {/* 환자 목록 */}
                  <div style={S.patientList}>
                    {bedList.map((b, i) => {
                      const isHighlighted = highlightEmpty && b.slotKey === currentEmptySlotKey;
                      // 빈 병상도 번호 배지와 함께 표시

                      const isDischarging = b.type === "discharging_today";
                      const isAdmitting   = b.type === "admitting_today";
                      const isReservedType= b.type === "reserved";
                      const isCurrentType = b.type === "current";
                      const dday = isCurrentType && !isPreview ? getDdayLabel(b.person?.discharge) : null;
                      const posNum = (b.person?.bedPosition > 0 ? b.person.bedPosition : null) ?? (i+1);

                      if (!b.person && isHighlighted) {
                        return (
                          <div key={i} style={{ ...S.patientChip, background:"#d1fae5", borderRadius:6, padding:"2px 6px" }}>
                            <span style={{ ...S.bedPositionBadge, background:"#10b981" }}>{i+1}</span>
                            <span style={{ color:"#065f46", fontWeight:700, fontSize:12 }}>빈 병상</span>
                          </div>
                        );
                      }
                      if (b.person) {
                        // 다음 예약자 찾기 (현재 환자가 있는 병상의 미래 예약)
                        const nextResList = !isPreview
                          ? (b.slot?.reservations || [])
                              .filter(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) > todayDate(); })
                              .sort((a,b2) => parseDateStr(a.admitDate) - parseDateStr(b2.admitDate))
                          : [];
                        const nextRes = nextResList[0] || null;
                        return (
                          <div key={i} style={S.patientChip}>
                            {isDischarging && <span style={{ fontSize:11 }}>🚪</span>}
                            {isAdmitting   && <span style={{ fontSize:11 }}>🛏</span>}
                            <span style={{ ...S.bedPositionBadge, background: isAdmitting?"#2563eb":isReservedType?"#7c3aed":isDischarging?"#d97706":"#1e3a5f" }}>{posNum}</span>
                            <span
                              style={{ ...S.patientName, color: isAdmitting?"#2563eb":isReservedType?"#7c3aed":isDischarging?"#d97706":"#1e3a5f",
                                ...(b.person.patientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}) }}
                              onClick={b.person.patientId ? (e) => { e.stopPropagation(); router.push(`/patients?id=${encodeURIComponent(b.person.patientId)}`); } : undefined}>
                              {b.person.name}
                            </span>
                            {b.person.scheduleAlert && <span style={S.alertDot}>!</span>}
                            {b.person.discharge && b.person.discharge !== "미정" && (
                              <span style={S.dischargeDateWrap}>
                                <span style={S.dischargeDate}>{b.person.discharge}</span>
                                {dday && <span style={{ ...S.ddayBadge, color:dday.color, background:dday.bg }}>{dday.text}</span>}
                              </span>
                            )}
                            {nextRes && (
                              <span style={{ display:"inline-flex", alignItems:"center", gap:2,
                                background:"#f5f3ff", borderRadius:4, padding:"0 4px", marginLeft:2, flexShrink:0 }}>
                                <span style={{ fontSize:9, color:"#7c3aed", fontWeight:800 }}>→</span>
                                <span style={{ fontSize:11, fontWeight:700, color:"#6d28d9" }}>{nextRes.name}</span>
                                <span style={{ fontSize:10, color:"#a78bfa" }}>{nextRes.admitDate}</span>
                                {nextResList.length > 1 && (
                                  <span style={{ fontSize:9, color:"#7c3aed", background:"#ede9fe", borderRadius:3, padding:"0 3px", fontWeight:700 }}>
                                    +{nextResList.length - 1}
                                  </span>
                                )}
                              </span>
                            )}
                          </div>
                        );
                      }
                      if (!isPreview && b.hasReserve) {
                        const nextRes = b.slot?.reservations?.find(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) > todayDate(); });
                        return (
                          <div key={i} style={S.patientChip}>
                            <span style={{ ...S.bedPositionBadge, background:"#7c3aed" }}>{i+1}</span>
                            <span style={{ color:"#7c3aed", fontSize:13, fontWeight:700 }}>📅 {nextRes?.name}</span>
                            <span style={{ fontSize:11, color:"#a78bfa" }}>{nextRes?.admitDate}</span>
                          </div>
                        );
                      }
                      // 빈 자리 표시
                      return (
                        <div key={i} style={S.patientChip}>
                          <span style={{ ...S.bedPositionBadge, background:"#cbd5e1" }}>{i+1}</span>
                          <span style={{ color:"#cbd5e1", fontSize:13, fontWeight:500 }}>빈 자리</span>
                        </div>
                      );
                    })}
                  </div>
                  {alertCount > 0 && <div style={S.alertBadge}>⚠ {alertCount}건 확인필요</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── RoomDetailView ────────────────────────────────────────────────────────────
function RoomDetailView({ room, slots, getRoomStats, isPreview, viewDate, movingPatient, onStartMove, onMoveTarget, onEditCurrent, onEditReservation, onAddCurrent, onAddReservation, onConvertReservation, onBack }) {
  const router = useRouter();
  const { occupied, bedList } = getRoomStats(room.id, room.capacity);
  return (
    <div style={S.detailWrap}>
      <div style={S.detailHeader}>
        <button style={S.btnBack} onClick={onBack}>← 병실 현황</button>
        <span style={S.detailRoomNo}>{room.id}호</span>
        <span style={{ ...S.roomTypeBadge, background:TYPE_BG[room.type], color:TYPE_COLOR[room.type] }}>{room.type}</span>
        <span style={{ color:"#64748b", fontSize:14 }}>{occupied}/{room.capacity} 병상 사용</span>
        {movingPatient && <span style={{ fontSize:13, fontWeight:700, color:"#6d28d9", background:"#ede9fe", borderRadius:8, padding:"4px 12px" }}>🚚 {movingPatient.data.name} 이동 중 — 아래 병상 클릭</span>}
      </div>
      <div style={S.legend}>
        <span style={S.legendItem}><span style={{ ...S.legendDot, background:TYPE_COLOR[room.type] }}/>입원 중</span>
        <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#a78bfa" }}/>예약 입원</span>
        {isPreview && <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#93c5fd" }}/>당일 입원</span>}
        {isPreview && <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#fbbf24" }}/>당일 퇴원</span>}
        {!isPreview && <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#10b981" }}/>이동 대상</span>}
      </div>
      <div style={S.bedGrid}>
        {Array.from({ length: room.capacity }).map((_, i) => {
          const slotKey = `${room.id}-${i+1}`;
          const slot = slots[slotKey] || null;
          const b = bedList[i];
          const reservations = slot?.reservations || [];
          const isDischarging = b.type === "discharging_today";
          const isAdmitting   = b.type === "admitting_today";
          const isReservedType= b.type === "reserved";
          const isMovingFrom  = movingPatient?.slotKey === slotKey;
          const isMoveTarget  = !!movingPatient && !isMovingFrom;

          let borderColor = "#e2e8f0";
          if (isMovingFrom)             borderColor = "#f59e0b";
          else if (isMoveTarget)        borderColor = "#10b981";
          else if (b.type === "current") borderColor = TYPE_COLOR[room.type];
          else if (isDischarging)        borderColor = "#fbbf24";
          else if (isAdmitting || isReservedType) borderColor = "#a78bfa";
          else if (!isPreview && b.hasReserve)    borderColor = "#c4b5fd";

          return (
            <div key={i}
              onClick={() => { if (movingPatient && !isMovingFrom) onMoveTarget(slotKey); }}
              style={{ ...S.bedCard,
                border:`2px ${b.person ? "solid":"dashed"} ${borderColor}`,
                background: isMovingFrom ? "#fffbeb" : isMoveTarget ? "#f0fdf4" : isAdmitting ? "#eff6ff" : isDischarging ? "#fffbeb" : isReservedType ? "#faf5ff" : "#fff",
                cursor: movingPatient && !isMovingFrom ? "pointer" : "default",
                transition: "all 0.2s",
                transform: isMoveTarget ? "scale(1.02)" : "scale(1)",
              }}>
              <div style={{ ...S.bedNum, display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ background:"#1e3a5f", color:"#fff", borderRadius:5, padding:"1px 7px", fontSize:12, fontWeight:800 }}>{i+1}</span>
                <span>번 병상</span>
                {isMovingFrom  && <span style={{ color:"#d97706", fontWeight:700 }}>📦 이동 중</span>}
                {isMoveTarget && !b.person && <span style={{ color:"#059669", fontWeight:700 }}>← 여기로 이동</span>}
                {isDischarging && <span style={{ color:"#d97706", fontWeight:700 }}>🚪 당일 퇴원</span>}
                {isAdmitting   && <span style={{ color:"#2563eb", fontWeight:700 }}>🛏 당일 입원</span>}
                {isReservedType && <span style={{ color:"#7c3aed", fontWeight:700 }}>📅 예약 입원 중</span>}
              </div>

              {b.person ? (
                <>
                  <div
                    style={{ ...S.bedPatientName, color: isAdmitting||isReservedType?"#7c3aed":isDischarging?"#d97706":"#0f2744",
                      ...(b.person.patientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}) }}
                    onClick={b.person.patientId ? (e) => { e.stopPropagation(); router.push(`/patients?id=${encodeURIComponent(b.person.patientId)}`); } : undefined}>
                    {b.person.name}
                  </div>
                  {b.person.admitDate && <div style={{ fontSize:12, color:"#7c3aed", marginBottom:4 }}>입원일: {b.person.admitDate}</div>}
                  <div style={S.bedDischarge}>퇴원: {b.person.discharge}</div>
                  {b.person.note && <div style={S.bedNote}>{b.person.note}</div>}
                  {b.person.scheduleAlert && <div style={S.scheduleAlert}>⚠ 스케줄 확인 필요</div>}
                  {!isPreview && !movingPatient && (b.type==="current"||b.type==="discharging_today"||b.type==="admitting_today") && (
                    <div style={{ display:"flex", gap:6, marginTop:"auto", flexWrap:"wrap" }}>
                      <button style={S.btnEdit} onClick={() => onEditCurrent(slotKey, { ...b.person })}>수정</button>
                      <button style={{ ...S.btnEdit, background:"#7c3aed" }} onClick={() => onStartMove(slotKey, "current", b.person, undefined)}>🚚 이동</button>
                      <button style={{ ...S.btnEdit, background:"#dc2626", width:"100%", marginTop:2 }}
                        onClick={() => router.push("/treatment?slotKey=" + encodeURIComponent(slotKey) + "&name=" + encodeURIComponent(b.person.name) + "&discharge=" + encodeURIComponent(b.person.discharge||"") + "&admitDate=" + encodeURIComponent(b.person.admitDate||"") + (b.person.patientId ? "&patientId=" + encodeURIComponent(b.person.patientId) : ""))}>
                        📋 치료 일정표
                      </button>
                    </div>
                  )}
                  {/* 예약 입원 중(reserved/admitting_today): 입원 전환 + 수정 + 이동 + 치료일정 */}
                  {!isPreview && !movingPatient && (b.type==="reserved"||b.type==="admitting_today") && (() => {
                    // reservations에서 해당 예약 인덱스 찾기
                    const resIdx = (slot?.reservations||[]).findIndex(r => r.name === b.person.name && r.admitDate === b.person.admitDate);
                    return (
                      <div style={{ display:"flex", gap:6, marginTop:4, flexWrap:"wrap" }}>
                        <button style={{ ...S.btnEdit, background:"#059669" }}
                          onClick={() => resIdx>=0 && onConvertReservation(slotKey, resIdx)}>
                          🛏 입원 전환
                        </button>
                        {resIdx>=0 && <button style={S.btnEdit}
                          onClick={() => onEditReservation(slotKey, { ...(slot.reservations[resIdx]) }, resIdx)}>수정</button>}
                        {resIdx>=0 && <button style={{ ...S.btnEdit, background:"#7c3aed" }}
                          onClick={() => onStartMove(slotKey, "reservation", slot.reservations[resIdx], resIdx)}>🚚 이동</button>}
                        <button style={{ ...S.btnEdit, background:"#dc2626", width:"100%", marginTop:2 }}
                          onClick={() => router.push("/treatment?slotKey=" + encodeURIComponent(slotKey) + "&name=" + encodeURIComponent(b.person.name) + "&discharge=" + encodeURIComponent(b.person.discharge||"") + "&admitDate=" + encodeURIComponent(b.person.admitDate||"") + (b.person.patientId ? "&patientId=" + encodeURIComponent(b.person.patientId) : ""))}>
                          📋 치료 일정표
                        </button>
                      </div>
                    );
                  })()}
                </>
              ) : (
                <div style={S.emptyBed}>
                  <span style={{ color: isMoveTarget ? "#10b981":"#cbd5e1", fontSize: isMoveTarget ? 32:28 }}>{isMoveTarget ? "↓":"+"}</span>
                  {!isPreview && !movingPatient && (
                    <button style={S.btnAdmit} onClick={() => onAddCurrent(slotKey)}>입원 등록</button>
                  )}
                  {isPreview && <span style={{ color:"#94a3b8", fontSize:12 }}>입원 가능</span>}
                </div>
              )}

              {/* 예약 목록 */}
              {!isPreview && reservations.length > 0 && (
                <div style={S.reservationList}>
                  <div style={S.reservationListTitle}>📅 입원 예약 ({reservations.length}건)</div>
                  {reservations.map((r, ri) => (
                    <div key={ri} style={S.reservationItem}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:4 }}>
                        <span style={{ fontWeight:700, color:"#7c3aed", fontSize:13 }}>{r.name}</span>
                        <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
                          {!movingPatient && <button style={{ ...S.btnEditSmall, color:"#7c3aed" }} onClick={() => onStartMove(slotKey, "reservation", r, ri)}>🚚</button>}
                          {!movingPatient && <button style={S.btnEditSmall} onClick={() => onEditReservation(slotKey, { ...r }, ri)}>수정</button>}
                          {!movingPatient && <button style={{ ...S.btnEditSmall, background:"#059669", color:"#fff", borderColor:"#059669" }}
                            onClick={() => onConvertReservation(slotKey, ri)}>🛏 입원 전환</button>}
                        </div>
                      </div>
                      <div style={{ fontSize:11, color:"#64748b" }}>입원: {r.admitDate} → 퇴원: {r.discharge}</div>
                      {r.note && <div style={{ fontSize:11, color:"#94a3b8" }}>{r.note}</div>}
                    </div>
                  ))}
                </div>
              )}

              {!isPreview && !movingPatient && (
                <button style={{ ...S.btnAdmit, background:"#f5f3ff", color:"#7c3aed", marginTop:8 }} onClick={() => onAddReservation(slotKey)}>
                  📅 예약 입원 추가
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── PatientModal ──────────────────────────────────────────────────────────────
function PatientModal({ title, data, mode, isNew, onSave, onDelete, onClose }) {
  const [form, setForm] = useState({ ...data });
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isReservation = mode === "reservation";
  const handleSave = () => {
    if (!form.name?.trim()) { alert("환자명을 입력해 주세요."); return; }
    if (isReservation && !form.admitDate?.trim()) { alert("입원 예정일을 입력해 주세요."); return; }
    onSave(form);
  };
  return (
    <div style={S.modalOverlay}>
      <div style={S.modal}>
        <div style={{ ...S.modalTitle, color: isReservation ? "#7c3aed":"#0f2744" }}>{title}</div>
        {isReservation && (
          <>
            <label style={{ ...S.label, color:"#7c3aed" }}>입원 예정일 ★</label>
            <input style={{ ...S.input, borderColor:"#a78bfa" }} value={form.admitDate||""} onChange={e => setF("admitDate", e.target.value)} placeholder="예: 3/18" />
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>M/D 형식 (예: 3/18)</div>
          </>
        )}
        {!isReservation && (
          <>
            <label style={S.label}>입원일</label>
            <input style={S.input} value={form.admitDate||""} onChange={e => setF("admitDate", e.target.value)} placeholder="예: 3/10" />
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>M/D 형식 (예: 3/10) — 치료 일정표 주차 계산에 사용됩니다</div>
          </>
        )}
        <label style={S.label}>환자명</label>
        <input style={S.input} value={form.name||""} onChange={e => setF("name", e.target.value)} placeholder="홍길동" />
        <label style={S.label}>퇴원 예정일</label>
        <input style={S.input} value={form.discharge||""} onChange={e => setF("discharge", e.target.value)} placeholder="예: 3/28, 미정" />
        <label style={S.label}>메모</label>
        <textarea style={{ ...S.input, height:80, resize:"vertical" }} value={form.note||""} onChange={e => setF("note", e.target.value)} placeholder="치료 내용, 약품, 스케줄 등" />
        <label style={S.labelCheck}>
          <input type="checkbox" checked={!!form.scheduleAlert} onChange={e => setF("scheduleAlert", e.target.checked)} />
          <span style={{ marginLeft:6 }}>⚠ 스케줄 확인 필요</span>
        </label>
        <div style={S.modalBtns}>
          {!isNew && onDelete && <button style={{ ...S.btnModal, background:"#fee2e2", color:"#dc2626" }} onClick={onDelete}>{isReservation?"예약 취소":"퇴원 처리"}</button>}
          <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={onClose}>취소</button>
          <button style={{ ...S.btnModal, background: isReservation?"#7c3aed":"#1e3a5f", color:"#fff" }} onClick={handleSave}>저장</button>
        </div>
      </div>
    </div>
  );
}

function AnalysisPreview({ results, onApply, onDiscard }) {
  return (
    <div style={S.analysisBar}>
      <div style={S.analysisTitle}>🤖 AI 분석 결과 — {results.length}명 감지됨</div>
      <div style={S.analysisList}>
        {results.map((r, i) => (
          <div key={i} style={S.analysisItem}>
            <strong>{r.room}호 {r.name}</strong><span style={{ color:"#64748b", marginLeft:8 }}>퇴원: {r.discharge}</span>
            {r.scheduleAlert && <span style={{ color:"#f59e0b", marginLeft:6 }}>⚠</span>}
            <div style={{ fontSize:12, color:"#94a3b8" }}>{r.note}</div>
          </div>
        ))}
      </div>
      <div style={S.analysisBtns}>
        <button style={{ ...S.btnModal, background:"#dcfce7", color:"#16a34a" }} onClick={onApply}>✓ 반영</button>
        <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={onDiscard}>취소</button>
      </div>
    </div>
  );
}

function LogView({ logs }) {
  const ICON = { upload:"📩", edit:"✏️", discharge:"🚪", admit:"🛏", reserve:"📅" };
  return (
    <div style={S.logWrap}>
      <div style={S.detailHeader}><span style={S.detailRoomNo}>변경 이력</span></div>
      {logs.length === 0 && <div style={{ color:"#94a3b8", padding:24 }}>변경 이력이 없습니다.</div>}
      {logs.map((l, i) => (
        <div key={i} style={S.logItem}>
          <span style={S.logIcon}>{ICON[l.type]||"📋"}</span>
          <span style={S.logMsg}>{l.msg}</span>
          <span style={S.logTs}>{new Date(l.ts).toLocaleString("ko")}</span>
        </div>
      ))}
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ ...S.statPill, borderColor:color }}>
      <span style={{ ...S.statVal, color }}>{value}</span>
      <span style={S.statLabel}>{label}</span>
    </div>
  );
}

const S = {
  app: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden", color:"#0f172a" },
  movingBanner: { position:"sticky", top:0, zIndex:200, background:"#1e1b4b", color:"#e0e7ff", padding:"10px 24px", fontSize:14, fontWeight:600, display:"flex", alignItems:"center", gap:12 },
  movingCancelBtn: { marginLeft:"auto", background:"#4c1d95", color:"#e9d5ff", border:"none", borderRadius:6, padding:"4px 12px", cursor:"pointer", fontSize:13, fontWeight:700 },
  header: { color:"#fff", display:"flex", alignItems:"center", padding:"10px 16px", gap:12, flexWrap:"wrap", boxShadow:"0 2px 12px rgba(0,0,0,0.18)", transition:"background 0.4s" },
  headerLeft: { display:"flex", alignItems:"center", gap:12, minWidth:180 },
  logoMark: { fontSize:24 }, title: { fontSize:15, fontWeight:800, letterSpacing:-0.5 }, subtitle: { fontSize:10, color:"#7dd3fc", letterSpacing:0.5 },
  headerCenter: { display:"flex", gap:8, flex:1, justifyContent:"center", alignItems:"center", flexWrap:"wrap" },
  headerRight: { display:"flex", alignItems:"center", gap:8 },
  syncInfo: { fontSize:11, color:"#94a3b8" },
  btnRefresh: { background:"none", border:"1px solid #334155", color:"#94a3b8", borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:16 },
  navBtn: { border:"1px solid #334155", color:"#e2e8f0", borderRadius:6, padding:"5px 10px", cursor:"pointer", fontSize:12, fontWeight:600, background:"transparent" },
  reserveToggle: { border:"none", borderRadius:8, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:700 },
  statPill: { border:"1.5px solid", borderRadius:10, padding:"4px 14px", textAlign:"center", minWidth:70, background:"rgba(255,255,255,0.06)" },
  statVal: { display:"block", fontSize:22, fontWeight:800, lineHeight:1.1 }, statLabel: { display:"block", fontSize:11, color:"#94a3b8" },
  datebar: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 12px", flexWrap:"wrap", gap:8, transition:"background 0.3s", position:"sticky", top:0, zIndex:30, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" },
  datebarLeft: { display:"flex", alignItems:"center", gap:12 }, datebarRight: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  previewBadge: { background:"#d1fae5", color:"#065f46", borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:800 },
  todayBadge:   { background:"#dbeafe", color:"#1d4ed8", borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:800 },
  activeDateLabel: { fontSize:15, fontWeight:700, color:"#0f2744" },
  dateInput: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"6px 10px", fontSize:13, outline:"none", fontFamily:"inherit" },
  btnPreview: { background:"#0f2744", color:"#fff", border:"none", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontWeight:700, fontSize:13 },
  btnToday: { background:"#ecfdf5", color:"#065f46", border:"1px solid #6ee7b7", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontWeight:700, fontSize:13 },
  uploadBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", display:"flex", alignItems:"center", gap:14, padding:"10px 28px", flexWrap:"wrap" },
  uploadLabel: { fontSize:13, fontWeight:700, color:"#0f2744" },
  btnUpload: { background:"#0f2744", color:"#fff", border:"none", borderRadius:7, padding:"7px 18px", cursor:"pointer", fontWeight:600, fontSize:13 },
  analysisBar: { background:"#f0fdf4", borderBottom:"1px solid #bbf7d0", padding:"14px 28px" },
  analysisTitle: { fontSize:14, fontWeight:700, color:"#166534", marginBottom:8 },
  analysisList: { display:"flex", flexWrap:"wrap", gap:8, marginBottom:10 },
  analysisItem: { background:"#fff", border:"1px solid #bbf7d0", borderRadius:8, padding:"8px 14px", minWidth:200, maxWidth:320 },
  analysisBtns: { display:"flex", gap:8 },
  main: { padding:"10px 6px", flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch" },
  wardGrid: { display:"flex", flexDirection:"column", gap:12 },
  wardTitle: { fontSize:20, fontWeight:800, color:"#0f2744", marginBottom:8, padding:"3px 0 3px 10px", borderLeft:"4px solid" },
  roomGrid: { display:"grid", gap:8 },
  roomCard: { borderRadius:10, padding:"12px 10px 10px", cursor:"pointer", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" },
  roomHeader: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 },
  roomNo: { fontSize:24, fontWeight:800 },
  roomTypeBadge: { fontSize:14, fontWeight:700, borderRadius:6, padding:"3px 10px" },
  bedBar: { display:"flex", gap:4, marginBottom:6 },
  bedDot: { width:16, height:16, borderRadius:"50%" },
  roomOccupancy: { fontSize:26, fontWeight:800, marginBottom:4, display:"flex", alignItems:"center", gap:0 },
  patientList: { display:"flex", flexDirection:"column", gap:3 },
  patientChip: { display:"flex", alignItems:"center", gap:5, fontSize:15, flexWrap:"wrap", overflow:"hidden", minWidth:0 },
  bedPositionBadge: { color:"#fff", borderRadius:4, width:22, height:22, fontSize:13, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  patientName: { fontWeight:700, fontSize:15 },
  dischargeDateWrap: { display:"flex", alignItems:"center", gap:3, marginLeft:2 },
  dischargeDate: { color:"#64748b", fontSize:12, background:"#f1f5f9", borderRadius:4, padding:"1px 5px" },
  ddayBadge: { fontSize:12, fontWeight:800, borderRadius:4, padding:"1px 6px" },
  alertDot: { background:"#fef3c7", color:"#d97706", borderRadius:"50%", width:22, height:22, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800 },
  alertBadge: { marginTop:6, background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"5px 12px", fontSize:13, fontWeight:700 },
  reserveBadge: { marginTop:6, background:"#f5f3ff", color:"#6d28d9", borderRadius:6, padding:"4px 10px", fontSize:13, fontWeight:700 },
  detailWrap: { maxWidth:960, margin:"0 auto" },
  detailHeader: { display:"flex", alignItems:"center", gap:14, marginBottom:16, flexWrap:"wrap" },
  btnBack: { background:"#fff", border:"1px solid #e2e8f0", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontWeight:600, fontSize:13 },
  detailRoomNo: { fontSize:22, fontWeight:800, color:"#0f2744" },
  legend: { display:"flex", gap:16, marginBottom:14, background:"#f8fafc", borderRadius:8, padding:"8px 14px", flexWrap:"wrap" },
  legendItem: { display:"flex", alignItems:"center", gap:6, fontSize:12, color:"#475569" },
  legendDot: { width:12, height:12, borderRadius:"50%", display:"inline-block" },
  bedGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:12 },
  bedCard: { background:"#fff", borderRadius:12, padding:"16px", minHeight:140, display:"flex", flexDirection:"column" },
  bedNum: { fontSize:11, color:"#94a3b8", fontWeight:600, marginBottom:8 },
  bedPatientName: { fontSize:18, fontWeight:800, marginBottom:4 },
  bedDischarge: { fontSize:12, color:"#64748b", marginBottom:6 },
  bedNote: { fontSize:12, color:"#475569", background:"#f8fafc", borderRadius:6, padding:"6px 8px", marginBottom:6, lineHeight:1.5 },
  scheduleAlert: { background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"4px 8px", fontSize:12, fontWeight:700, marginBottom:6 },
  btnEdit: { background:"#0f2744", color:"#fff", border:"none", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600 },
  btnEditSmall: { background:"#f1f5f9", color:"#64748b", border:"none", borderRadius:5, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:600 },
  emptyBed: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6 },
  btnAdmit: { background:"#dcfce7", color:"#166534", border:"none", borderRadius:6, padding:"5px 14px", cursor:"pointer", fontSize:12, fontWeight:600, width:"100%", textAlign:"center" },
  reservationList: { marginTop:10, borderTop:"1px dashed #e2e8f0", paddingTop:8 },
  reservationListTitle: { fontSize:11, fontWeight:700, color:"#7c3aed", marginBottom:6 },
  reservationItem: { background:"#faf5ff", border:"1px solid #e9d5ff", borderRadius:8, padding:"8px", marginBottom:6 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:14, padding:"20px 16px 16px", width:"calc(100% - 24px)", maxWidth:420, boxShadow:"0 8px 40px rgba(0,0,0,0.18)", maxHeight:"92vh", overflowY:"auto" },
  modalTitle: { fontSize:17, fontWeight:800, marginBottom:16 },
  label: { display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:4, marginTop:12 },
  labelCheck: { display:"flex", alignItems:"center", fontSize:13, color:"#475569", marginTop:12, cursor:"pointer" },
  input: { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"8px 12px", fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  modalBtns: { display:"flex", gap:8, justifyContent:"flex-end", marginTop:20 },
  btnModal: { border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontWeight:700, fontSize:13 },
  logWrap: { maxWidth:700, margin:"0 auto" },
  logItem: { background:"#fff", borderRadius:8, padding:"10px 16px", marginBottom:8, display:"flex", alignItems:"center", gap:12, boxShadow:"0 1px 4px rgba(0,0,0,0.05)" },
  logIcon: { fontSize:18 }, logMsg: { flex:1, fontSize:14, fontWeight:500 }, logTs: { fontSize:12, color:"#94a3b8", whiteSpace:"nowrap" },
};

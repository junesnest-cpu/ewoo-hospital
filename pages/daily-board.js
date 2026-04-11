import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, update } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];
const THERAPY_SLOTS = ["09:00~10:00","10:00~11:00","11:00~12:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];
const TIME_OPTIONS = ["아침 후","점심 후","저녁 후"];
const TREAT_NAMES = { pain:"페인", manip2:"도수2", manip1:"도수1" };
const VALID_ROOMS = new Set([
  "201","202","203","204","205","206","301","302","303","304","305","306",
  "501","502","503","504","505","506","601","602","603",
]);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function uid() { return Math.random().toString(36).slice(2,9); }
function toYM(dateStr) { return dateStr.slice(0,7); }
function normName(n) { return (n||"").replace(/^신\)\s*/,"").trim().toLowerCase(); }
function getWeekKey(dateStr) {
  const d = new Date(dateStr), dow = d.getDay();
  const monday = new Date(d); monday.setDate(d.getDate()+(dow===0?-6:1-dow)); monday.setHours(0,0,0,0);
  return monday.toISOString().slice(0,10);
}
function getDayIdx(dateStr) { const dow = new Date(dateStr).getDay(); return dow===0?6:dow-1; }
function parseMD(str, year) {
  if (!str||str==="미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return `${year}-${String(parseInt(m[1])).padStart(2,"0")}-${String(parseInt(m[2])).padStart(2,"0")}`;
}
function buildCellText(cell, useTreatNames, slotsRef, dateStr) {
  if (!cell) return "";
  const name = cell.patientName || cell.name || "";
  if (!name) return "";
  // 병실 정보: roomId/bedNum 직접 사용 → slotKey에서 추출 → db_ 환자는 slots에서 조회
  let room = "";
  if (cell.roomId && cell.bedNum) {
    room = `${cell.roomId}-${cell.bedNum}`;
  } else if (cell.slotKey) {
    if (cell.slotKey.startsWith("db_") && slotsRef) {
      const internalId = cell.slotKey.slice(3);
      for (const [sk, sl] of Object.entries(slotsRef)) {
        if (sl?.current?.patientId === internalId) { room = sk; break; }
      }
    } else if (!cell.slotKey.startsWith("pending_") && !cell.slotKey.startsWith("__")) {
      room = cell.slotKey;
    }
  }
  // 병실 없으면 예약 병실 조회
  if (!room && slotsRef && name) {
    const nn = normName(name);
    const viewDate = dateStr ? new Date(dateStr) : new Date();
    viewDate.setHours(0,0,0,0);
    for (const [sk, sl] of Object.entries(slotsRef)) {
      for (const r of (sl?.reservations || [])) {
        if (!r?.name || normName(r.name) !== nn) continue;
        if (!r.admitDate || r.admitDate === "미정") continue;
        const m = r.admitDate.match(/(\d{1,2})\/(\d{1,2})/);
        if (m) {
          const resDate = new Date(viewDate.getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
          if (viewDate >= resDate) { room = sk; break; }
        }
      }
      if (room) break;
    }
  }
  const treatName = useTreatNames ? (TREAT_NAMES[cell.treatmentId]||"") : "";
  const line1 = room ? `${name}(${room})` : name;
  return treatName ? `${line1}\n${treatName}` : line1;
}

const EMPTY_ADM = () => ({ id:uid(), room:"", name:"", doctor:"", time:"", note:"", isNew:false });
const EMPTY_DIS = () => ({ id:uid(), room:"", name:"", time:"", note:"" });
const EMPTY_TRN = () => ({ id:uid(), name:"", fromRoom:"", toRoom:"", time:"" });
const EMPTY_RES = () => ({ id:uid(), name:"", room:"", dischargeDate:"", readmitDate:"" });
const EMPTY_THERAPY = () => {
  const t = {};
  THERAPY_SLOTS.forEach(s => { t[s] = { highFreq:"", physio1:"", physio2:"", hyperbaric:"" }; });
  return t;
};

export default function DailyBoard() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const boardRef = useRef(null);
  const [date, setDate] = useState(todayStr());
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [filterName, setFilterName] = useState("");

  // 연동 데이터 소스
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});
  const [patients, setPatients] = useState({});
  const [monthlyBoard, setMonthlyBoard] = useState({});
  const [physSched, setPhysSched] = useState({});
  const [hyperSched, setHyperSched] = useState({});
  const [therapists, setTherapists] = useState(["치료사1","치료사2"]);

  // 수정 모드 편집 데이터
  const [editAdm, setEditAdm] = useState([]);
  const [editDis, setEditDis] = useState([]);
  const [editTrn, setEditTrn] = useState([]);
  const [editRes, setEditRes] = useState([]);
  const [editTherapy, setEditTherapy] = useState(EMPTY_THERAPY());

  // 저장된 오버라이드
  const [savedOverride, setSavedOverride] = useState(null);

  const wk = useMemo(() => getWeekKey(date), [date]);
  const dayIdx = useMemo(() => getDayIdx(date), [date]);
  const ym = useMemo(() => toYM(date), [date]);
  const dateYear = parseInt(date.slice(0,4));

  // 공유 신환 플래그
  const [newPatientFlags, setNewPatientFlags] = useState({});

  // ── Firebase 구독 ──
  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), s => setSlots(s.val()||{}));
    const u2 = onValue(ref(db,"consultations"), s => setConsultations(s.val()||{}));
    const u3 = onValue(ref(db,"settings"), s => {
      const v = s.val()||{};
      setTherapists([v.therapist1||"치료사1", v.therapist2||"치료사2"]);
    });
    const u4 = onValue(ref(db,"patients"), s => setPatients(s.val()||{}));
    const u5 = onValue(ref(db,"newPatientFlags"), s => setNewPatientFlags(s.val()||{}));
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, []);

  useEffect(() => {
    const u = onValue(ref(db, `monthlyBoards/${ym}/${date}`), s => setMonthlyBoard(s.val()||{}));
    return () => u();
  }, [ym, date]);

  useEffect(() => {
    const u1 = onValue(ref(db, `physicalSchedule/${wk}`), s => setPhysSched(s.val()||{}));
    const u2 = onValue(ref(db, `hyperthermiaSchedule/${wk}`), s => setHyperSched(s.val()||{}));
    return () => { u1(); u2(); };
  }, [wk]);

  useEffect(() => {
    const u = onValue(ref(db, `dailyBoards/${date}`), s => setSavedOverride(s.val()||null));
    return () => u();
  }, [date]);

  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) setFilterName(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  // ── 이름→환자정보 매핑 ──
  const patientInfo = useMemo(() => {
    const map = {};
    // patients DB에서 주치의 정보 (성만 추출: "강국형" → "강")
    Object.values(patients).forEach(p => {
      if (!p?.name) return;
      const n = normName(p.name);
      const doc = (p.lastDoctor || p.doctor || "").trim();
      if (n && doc) map[n] = { room:"", doctor: doc.charAt(0), note:"" };
    });
    // slots 현재 입원 정보로 덮어쓰기 (우선)
    Object.entries(slots).forEach(([sk, slot]) => {
      if (!slot?.current?.name) return;
      const n = normName(slot.current.name);
      if (n) map[n] = { room:sk, doctor:slot.current.doctor||map[n]?.doctor||"", note:slot.current.note||"" };
    });
    return map;
  }, [slots, patients]);

  // ── 퇴원 환자의 재입원 예정일 매핑 (이름→재입원 날짜, 해당일 이후만) ──
  const readmitInfo = useMemo(() => {
    const map = {};
    const today = new Date(date);
    today.setHours(0,0,0,0);
    // 모든 슬롯의 예약에서 미래 재입원 날짜 수집
    Object.values(slots).forEach(slot => {
      (slot?.reservations || []).forEach(r => {
        if (!r?.name || !r.admitDate || r.admitDate === "미정") return;
        const rd = parseMD(r.admitDate, dateYear);
        if (!rd || new Date(rd) <= today) return;  // 해당일 이후만
        const n = normName(r.name);
        if (!map[n]) map[n] = r.admitDate;
      });
    });
    // 상담일지에서도 재입원 일정 검색 (슬롯 미배정 환자 대비)
    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status === "취소") return;
      const cd = new Date(c.admitDate);
      if (isNaN(cd) || cd <= today) return;  // 해당일 이후만
      const n = normName(c.name);
      if (!map[n]) map[n] = `${cd.getMonth()+1}/${cd.getDate()}`;
    });
    return map;
  }, [slots, consultations, date, dateYear]);

  // ── slots 기반 calendarData (월간보드와 동일 로직) ──
  const calendarData = useMemo(() => {
    const adm = [], dis = [];
    const year = dateYear, month = parseInt(date.slice(5,7));

    // 이름→실제 병실 매핑
    const nameToRoom = {};
    Object.entries(slots).forEach(([sk, slot]) => {
      if (slot?.current?.name) nameToRoom[normName(slot.current.name)] = sk;
    });

    Object.entries(slots).forEach(([sk, slot]) => {
      const cur = slot?.current;
      if (cur?.name) {
        const aKey = parseMD(cur.admitDate, year);
        const dKey = parseMD(cur.discharge, year);
        if (aKey === date) adm.push({ id:uid(), name:cur.name, room:sk, note:cur.note||"", isNew:false, isReserved:false, time:cur.admitTime||"", _slotKey:sk, _consultationId:cur.consultationId||"" });
        if (dKey === date) dis.push({ id:uid(), name:cur.name, room:sk, note:"", time:cur.dischargeTime||"", _slotKey:sk });
      }
      (slot?.reservations||[]).forEach(r => {
        if (!r?.name) return;
        const aKey = parseMD(r.admitDate, year);
        const dKey = parseMD(r.discharge, year);
        if (aKey === date) adm.push({ id:uid(), name:r.name, room:sk, note:r.note||"", isNew:false, isReserved:true, time:r.admitTime||"", _slotKey:sk, _consultationId:r.consultationId||"" });
        if (dKey === date) dis.push({ id:uid(), name:r.name, room:sk, note:"", time:r.dischargeTime||"", _slotKey:sk });
      });
    });

    // consultations → 신환 병합
    Object.entries(consultations).forEach(([cid, c]) => {
      if (!c?.name || !c.admitDate) return;
      const cIsNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
      if (!cIsNew) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      if (c.admitDate !== date) return;
      const nc = normName(c.name);
      const actualRoom = nameToRoom[nc] || c.roomTypes?.join("/") || "";
      const noteFields = [c.diagnosis, c.hospital].filter(Boolean);
      if (c.surgery) noteFields.push(c.surgeryDate ? `수술후(${c.surgeryDate})` : "수술후");
      if (c.chemo) noteFields.push(c.chemoDate ? `항암(${c.chemoDate})` : "항암중");
      if (c.radiation) noteFields.push("방사선");
      const cNote = noteFields.join(" · ");

      const existIdx = adm.findIndex(a => normName(a.name) === nc);
      if (existIdx >= 0) {
        adm[existIdx] = { ...adm[existIdx], isNew: true, note: cNote || adm[existIdx].note };
      } else {
        adm.push({ id:uid(), name:c.name, room:actualRoom, note:cNote, isNew:true, isReserved:false, _consultationId:cid });
      }
    });

    return { admissions: adm, discharges: dis };
  }, [slots, consultations, date, dateYear]);

  // ── 월간보드 표시 데이터 (getDisplayData와 동일 로직) ──
  const displayData = useMemo(() => {
    const bd = monthlyBoard;
    const dedupList = (list) => {
      const seen = new Set();
      return (list||[]).filter(a => { const n = normName(a.name); if (!n||seen.has(n)) return false; seen.add(n); return true; });
    };

    if (bd?.frozen) {
      return { admissions: dedupList(bd.admissions||[]), discharges: dedupList(bd.discharges||[]) };
    }
    const cd = calendarData;
    if (!bd || (!bd.admissions?.length && !bd.discharges?.length && !bd.hiddenAdmissions?.length && !bd.hiddenDischarges?.length)) {
      return { admissions: dedupList(cd.admissions), discharges: dedupList(cd.discharges) };
    }
    const hiddenAdm = new Set(bd.hiddenAdmissions||[]);
    const hiddenDis = new Set(bd.hiddenDischarges||[]);
    const baseAdm = (cd.admissions||[]).filter(a => !hiddenAdm.has(normName(a.name)));
    const baseDis = (cd.discharges||[]).filter(d => !hiddenDis.has(normName(d.name)));
    const cdAdmNorms = new Set((cd.admissions||[]).map(a => normName(a.name)));
    const cdDisNorms = new Set((cd.discharges||[]).map(d => normName(d.name)));
    const manualAdm = (bd.admissions||[]).filter(a => !cdAdmNorms.has(normName(a.name)));
    const manualDis = (bd.discharges||[]).filter(d => !cdDisNorms.has(normName(d.name)));
    return { admissions: dedupList([...baseAdm,...manualAdm]), discharges: dedupList([...baseDis,...manualDis]) };
  }, [monthlyBoard, calendarData]);

  // ── 입원/퇴원 연동 (displayData + patientInfo 보강) ──
  const syncedAdmissions = useMemo(() => {
    const today = new Date(); today.setHours(0,0,0,0);
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    return (displayData.admissions||[]).map(a => {
      const info = patientInfo[normName(a.name)];
      // 공유 신환 플래그 확인 (입원일 기준 1주일 이내)
      let isNew = !!a.isNew;
      const nk = normName(a.name);
      const flag = newPatientFlags[nk];
      if (flag) {
        const admitD = flag.admitDate ? new Date(flag.admitDate) : null;
        if (admitD) { admitD.setHours(0,0,0,0); isNew = (today.getTime() - admitD.getTime()) < weekMs; }
        else isNew = true;
      }
      return { ...a, id:a.id||uid(), room:info?.room||a.room||"",
        doctor:info?.doctor||"", time:a.time||"", note:info?.note||a.note||"", isNew };
    });
  }, [displayData, patientInfo, newPatientFlags]);

  const syncedDischarges = useMemo(() => {
    return (displayData.discharges||[]).map(d => {
      const info = patientInfo[normName(d.name)];
      const readmit = readmitInfo[normName(d.name)];
      const readmitNote = readmit ? `${readmit} 재입원 예정` : "";
      const baseNote = d.note || "";
      // 재입원 예정이 비고에 이미 포함되어 있으면 중복 추가 안 함
      const note = readmitNote && !baseNote.includes("재입원") ? (baseNote ? `${baseNote} / ${readmitNote}` : readmitNote) : baseNote;
      return { ...d, id:d.id||uid(), room:info?.room||d.room||"", time:d.time||"", note };
    });
  }, [displayData, patientInfo, readmitInfo]);

  const syncedReserved = useMemo(() => {
    const list = [], seen = new Set();
    Object.entries(slots).forEach(([sk, slot]) => {
      const roomId = sk.split("-")[0];
      if (!VALID_ROOMS.has(roomId)) return;
      const cur = slot?.current;
      if (!cur?.name) return;
      const curDis = parseMD(cur.discharge, dateYear);
      if (!curDis) return;
      (slot?.reservations||[]).forEach(r => {
        if (!r?.name || !r?.preserveSeat) return;   // preserveSeat 플래그 필수
        const readmit = parseMD(r.admitDate, dateYear);
        if (!readmit) return;
        const diffDays = (new Date(readmit)-new Date(curDis))/(1000*60*60*24);
        if (diffDays<=0||diffDays>7) return;         // 퇴원→입원 간격 1~7일만
        const today = new Date(date);
        // 자리보존 기간: 퇴원 다음날 ~ 입원 전날 (퇴원일·입원일 당일은 제외)
        if (today<=new Date(curDis)||today>=new Date(readmit)) return;
        const n = normName(r.name); if (seen.has(n)) return; seen.add(n);
        list.push({ id:uid(), name:r.name, room:sk, dischargeDate:cur.discharge||"", readmitDate:r.admitDate||"" });
      });
    });
    return list;
  }, [slots, date, dateYear]);

  const autoTherapy = useMemo(() => {
    const t = {}, di = String(dayIdx);
    THERAPY_SLOTS.forEach(slot => {
      const st = slot.split("~")[0];
      t[slot] = {
        highFreq: buildCellText(hyperSched?.["hyperthermia"]?.[di]?.[st], false, slots, date),
        physio1: buildCellText(physSched?.["th1"]?.[di]?.[st], true, slots, date),
        physio2: buildCellText(physSched?.["th2"]?.[di]?.[st], true, slots, date),
        hyperbaric: buildCellText(hyperSched?.["hyperbaric"]?.[di]?.[st], false, slots, date),
      };
    });
    return t;
  }, [physSched, hyperSched, dayIdx, slots]);

  const therapyCols = useMemo(() => [
    { key:"highFreq",   label:"고주파 치료" },
    { key:"physio1",    label:`물리치료실\n(${therapists[0]})` },
    { key:"physio2",    label:`물리치료실\n(${therapists[1]})` },
    { key:"hyperbaric", label:"고압산소" },
  ], [therapists]);

  // ── 표시 데이터: 오버라이드가 있으면 오버라이드, 없으면 연동 ──
  const admissions   = savedOverride?.admissions   || syncedAdmissions;
  const discharges   = savedOverride?.discharges   || syncedDischarges;
  const transfers    = savedOverride?.transfers    || [EMPTY_TRN()];
  const reservedBeds = savedOverride?.reservedBeds || (syncedReserved.length ? syncedReserved : [EMPTY_RES()]);
  const therapy      = savedOverride?.therapy      || {};

  // ── 수정 모드 ──
  function startEdit() {
    setEditAdm([...admissions]);
    setEditDis([...discharges]);
    setEditTrn([...(savedOverride?.transfers || [EMPTY_TRN()])]);
    setEditRes([...(savedOverride?.reservedBeds || (syncedReserved.length ? syncedReserved : [EMPTY_RES()]))]);
    setEditTherapy({ ...EMPTY_THERAPY(), ...therapy });
    setEditMode(true);
  }

  async function saveEdit() {
    setSaving(true);
    // 이름 변경 시 consultation/slots 연동
    const origAdm = calendarData.admissions || [];
    const origDis = calendarData.discharges || [];
    const fbUpdates = {};
    for (const edited of [...editAdm, ...editDis]) {
      if (!edited.name) continue;
      const orig = [...origAdm, ...origDis].find(o => o.id === edited.id);
      if (!orig || orig.name === edited.name) continue;
      if (edited._consultationId) {
        fbUpdates[`consultations/${edited._consultationId}/name`] = edited.name;
      }
      if (edited._slotKey) {
        const slot = slots[edited._slotKey];
        if (slot?.current?.name === orig.name) {
          fbUpdates[`slots/${edited._slotKey}/current/name`] = edited.name;
        } else {
          const resList = slot?.reservations || [];
          const ri = resList.findIndex(r => r.name === orig.name);
          if (ri >= 0) fbUpdates[`slots/${edited._slotKey}/reservations/${ri}/name`] = edited.name;
        }
      }
    }
    if (Object.keys(fbUpdates).length > 0) {
      await update(ref(db), fbUpdates);
    }
    // 신환 플래그 공유 저장소 동기화
    for (const a of editAdm) {
      if (!a.name) continue;
      const nk = normName(a.name);
      if (a.isNew && !newPatientFlags[nk]) {
        await set(ref(db, `newPatientFlags/${nk}`), { admitDate: date, markedAt: new Date().toISOString() });
      } else if (!a.isNew && newPatientFlags[nk]) {
        await set(ref(db, `newPatientFlags/${nk}`), null);
      }
    }
    // _slotKey, _consultationId 메타데이터 제거 후 저장
    const cleanList = (list) => (list || []).map(({_slotKey, _consultationId, ...rest}) => rest);
    await set(ref(db, `dailyBoards/${date}`), {
      admissions: cleanList(editAdm), discharges: cleanList(editDis), transfers: editTrn, reservedBeds: editRes, therapy: editTherapy,
    });
    setSaving(false);
    setEditMode(false);
  }

  function cancelEdit() { setEditMode(false); }

  function updateRow(setter, id, field, val) { setter(rows => rows.map(r => r.id===id ? {...r,[field]:val} : r)); }
  function addRow(setter, empty) { setter(rows => [...rows, empty()]); }
  function deleteRow(setter, id) { setter(rows => rows.filter(r => r.id!==id)); }
  function updateTherapy(slot, col, val) {
    setEditTherapy(t => ({ ...t, [slot]: { ...t[slot], [col]:val } }));
  }

  // ── 공지 (스크린샷 → 클립보드) ──
  const captureToClipboard = useCallback(async () => {
    if (!boardRef.current) return;
    setCapturing(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(boardRef.current, { scale:3, useCORS:true, backgroundColor:"#ffffff" });
      canvas.toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          alert("클립보드에 복사되었습니다!");
        } catch { alert("클립보드 복사 실패. 브라우저 권한을 확인하세요."); }
        setCapturing(false);
      }, "image/png");
    } catch (err) { console.error(err); alert("스크린샷 생성 실패"); setCapturing(false); }
  }, []);

  function changeDate(delta) {
    const d = new Date(date); d.setDate(d.getDate()+delta);
    setDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
    setEditMode(false);
  }

  const dateObj = new Date(date);
  const dateLabel = `${dateObj.getFullYear()}년 ${dateObj.getMonth()+1}월 ${dateObj.getDate()}일 (${DOW[dateObj.getDay()]})`;

  // 수정 모드일 때 사용할 데이터
  const dAdm = editMode ? editAdm : admissions;
  const dDis = editMode ? editDis : discharges;
  const dTrn = editMode ? editTrn : transfers;
  const dRes = editMode ? editRes : reservedBeds;
  const dTher = editMode ? editTherapy : therapy;

  const dow = DOW[dateObj.getDay()];
  const isWeekend = dateObj.getDay()===0||dateObj.getDay()===6;

  return (
    <div style={{ minHeight:"100vh", background:"#f0f2f5", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{PRINT_CSS}</style>

      {/* ── 헤더 ── */}
      <header className="no-print" style={{ background:"linear-gradient(135deg,#0f2744 0%,#1e3a5f 100%)",
        color:"#fff", padding:"10px 20px", display:"flex", alignItems:"center", gap:12,
        position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 12px rgba(0,0,0,0.2)", flexWrap:"wrap" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={() => changeDate(-1)} style={S.navArrow}>‹</button>
          <input type="date" value={date} onChange={e => { setDate(e.target.value); setEditMode(false); }}
            style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)",
              borderRadius:8, padding:"5px 12px", fontSize:15, fontWeight:700, color:"#fff",
              outline:"none", colorScheme:"dark" }} />
          <button onClick={() => changeDate(1)} style={S.navArrow}>›</button>
        </div>
        <div style={{ display:"flex", flexDirection:"column", lineHeight:1.3 }}>
          <span style={{ fontSize:18, fontWeight:900, letterSpacing:1 }}>
            {dateObj.getMonth()+1}월 {dateObj.getDate()}일
            <span style={{ fontSize:16, fontWeight:700, marginLeft:6,
              color: isWeekend ? "#fbbf24" : "#94a3b8" }}>({dow})</span>
          </span>
          <span style={{ fontSize:11, color:"#94a3b8" }}>일일 현황판{editMode?" · 수정 중":""}</span>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          {filterName && (
            <span style={{ display:"inline-flex", alignItems:"center", gap:4,
              background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"3px 10px", fontSize:12, fontWeight:700 }}>
              "{filterName}"
              <button onClick={() => setFilterName("")} style={{ background:"none", border:"none", cursor:"pointer",
                color:"#92400e", fontSize:13, padding:0, lineHeight:1, fontWeight:800 }}>✕</button>
            </span>
          )}
          {!editMode && savedOverride && <span style={{ fontSize:11, color:"#94a3b8" }}>✓ 수정됨</span>}
          {editMode ? (
            <>
              <button onClick={saveEdit} disabled={saving}
                style={{ ...S.headerBtn, background:"rgba(5,150,105,0.3)", border:"1px solid rgba(5,150,105,0.5)" }}>
                {saving ? "..." : "💾 저장"}</button>
              <button onClick={cancelEdit}
                style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)" }}>취소</button>
            </>
          ) : (
            <>
              <button onClick={startEdit} style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.2)" }}>✏️ 수정</button>
              <button onClick={captureToClipboard} disabled={capturing}
                style={{ ...S.headerBtn, background:"rgba(14,165,233,0.25)", border:"1px solid rgba(14,165,233,0.4)" }}>
                {capturing ? "캡처 중..." : "📋 공지"}</button>
              <button onClick={() => window.print()}
                style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)" }}>🖨</button>
            </>
          )}
        </div>
      </header>

      {/* ── 본문 (캡처 대상) ── */}
      <div ref={boardRef}>
        {/* 인쇄/캡처 제목 */}
        <div className="print-title" style={{ display:"none", textAlign:"center", padding:"10px 0 6px",
          fontWeight:900, fontSize:26, color:"#0f2744", borderBottom:"3px solid #0f2744", marginBottom:10 }}>
          {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 ({dow}) 현황판
        </div>
        {/* 화면용 제목 (캡처 시에도 보임) */}
        <div className="no-print" style={{ textAlign:"center", padding:"8px 0 4px", fontWeight:900, fontSize:24, color:"#0f2744" }}>
          {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 ({dow}) 현황판
        </div>

        <div style={{ padding: isMobile?"10px":"12px 16px", display:"flex", flexDirection:"column", gap:12 }}>

          {/* ── 입원 / 퇴원 2열 ── */}
          <div style={{ display:"flex", gap:12, flexWrap: isMobile?"wrap":"nowrap" }}>
            {/* 입원 */}
            <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
              <SectionHeader icon="↑" label="입원" count={dAdm.filter(r=>r.name).length} color="#059669" bg="#ecfdf5" borderColor="#a7f3d0" />
              <div style={{ background:"#fff", border:"1px solid #d1fae5", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
                {dAdm.filter(r=>r.name).length===0 && !editMode && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
                {dAdm.map(row => (
                  <div key={row.id} style={{ display:"flex", gap:8, padding:"8px 12px",
                    borderBottom:"1px solid #f0fdf4", alignItems:"center",
                    background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                    {editMode ? (
                      <Field w={80} value={row.room} onChange={v=>updateRow(setEditAdm,row.id,"room",v)} placeholder="호실" style={{fontWeight:800,color:"#059669",textAlign:"center",fontSize:16}} />
                    ) : (
                      <span style={{ fontWeight:800, color:"#059669", fontSize:16, width:80, textAlign:"center", flexShrink:0 }}>{row.room}</span>
                    )}
                    <div style={{ display:"flex", alignItems:"center", gap:4, minWidth:130 }}>
                      {row.isNew && <span style={{ fontSize:12, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"0 5px", fontWeight:800, flexShrink:0 }}>★</span>}
                      {editMode ? (
                        <Field w={75} value={row.name} onChange={v=>updateRow(setEditAdm,row.id,"name",v)} placeholder="이름" style={{fontWeight:700,fontSize:16}} />
                      ) : (
                        <span style={{ fontWeight:700, fontSize:16 }}>{row.name}</span>
                      )}
                      <span style={{ color:"#d1d5db", fontSize:14 }}>/</span>
                      {editMode ? (
                        <Field w={40} value={row.doctor} onChange={v=>updateRow(setEditAdm,row.id,"doctor",v)} placeholder="Dr" style={{color:"#64748b",fontSize:14}} />
                      ) : (
                        <span style={{ fontSize:14, color:"#64748b" }}>{row.doctor}</span>
                      )}
                      {editMode && (
                        <button onClick={()=>updateRow(setEditAdm,row.id,"isNew",!row.isNew)}
                          style={{ fontSize:11, background:row.isNew?"#fef08a":"#f8fafc", border:"1px solid",
                            borderColor:row.isNew?"#fcd34d":"#e2e8f0", borderRadius:3, padding:"0 4px",
                            cursor:"pointer", color:row.isNew?"#713f12":"#cbd5e1", flexShrink:0, fontWeight:800, lineHeight:"18px" }}>★</button>
                      )}
                    </div>
                    {editMode ? (
                      (!row.time || TIME_OPTIONS.includes(row.time)) ? (
                        <select value={row.time||""} onChange={e=>{ if(e.target.value==="__custom__"){ const v=prompt("시간 입력"); updateRow(setEditAdm,row.id,"time",v?v.trim():""); } else updateRow(setEditAdm,row.id,"time",e.target.value); }}
                          style={{ border:"none", outline:"none", background:"transparent", fontSize:13, color:row.time?"#0891b2":"#94a3b8", fontFamily:"inherit", width:80, flexShrink:0 }}>
                          <option value="">시간</option>
                          {TIME_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}
                          <option value="__custom__">직접입력</option>
                        </select>
                      ) : (
                        <Field w={80} value={row.time} onChange={v=>updateRow(setEditAdm,row.id,"time",v)} placeholder="시간" style={{color:"#0891b2",textAlign:"center"}} />
                      )
                    ) : row.time ? (
                      <span style={{ fontSize:14, color:"#0891b2", fontWeight:600, flexShrink:0 }}>{row.time}</span>
                    ) : null}
                    {editMode ? (
                      <Field flex={1} value={row.note} onChange={v=>updateRow(setEditAdm,row.id,"note",v)} placeholder="비고" style={{color:"#64748b",fontSize:14,textAlign:"center"}} />
                    ) : (
                      <span style={{ fontSize:14, color:"#64748b", flex:1, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", textAlign:"center" }}>{row.note}</span>
                    )}
                    {editMode && <DelBtn onClick={()=>deleteRow(setEditAdm,row.id)} />}
                  </div>
                ))}
                {editMode && <AddBtn onClick={()=>addRow(setEditAdm,EMPTY_ADM)} />}
              </div>
            </div>

            {/* 퇴원 */}
            <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
              <SectionHeader icon="↓" label="퇴원" count={dDis.filter(r=>r.name).length} color="#dc2626" bg="#fef2f2" borderColor="#fecaca" />
              <div style={{ background:"#fff", border:"1px solid #fecaca", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
                {dDis.filter(r=>r.name).length===0 && !editMode && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
                {dDis.map(row => (
                  <div key={row.id} style={{ display:"flex", gap:8, padding:"8px 12px",
                    borderBottom:"1px solid #fff5f5", alignItems:"center",
                    background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                    {editMode ? (
                      <Field w={80} value={row.room} onChange={v=>updateRow(setEditDis,row.id,"room",v)} placeholder="호실" style={{fontWeight:800,color:"#dc2626",textAlign:"center",fontSize:16}} />
                    ) : (
                      <span style={{ fontWeight:800, color:"#dc2626", fontSize:16, width:80, textAlign:"center", flexShrink:0 }}>{row.room}</span>
                    )}
                    {editMode ? (
                      <Field w={90} value={row.name} onChange={v=>updateRow(setEditDis,row.id,"name",v)} placeholder="이름" style={{fontWeight:700,fontSize:16}} />
                    ) : (
                      <span style={{ fontWeight:700, fontSize:16, flexShrink:0 }}>{row.name}</span>
                    )}
                    {editMode ? (
                      (!row.time || TIME_OPTIONS.includes(row.time)) ? (
                        <select value={row.time||""} onChange={e=>{ if(e.target.value==="__custom__"){ const v=prompt("시간 입력"); updateRow(setEditDis,row.id,"time",v?v.trim():""); } else updateRow(setEditDis,row.id,"time",e.target.value); }}
                          style={{ border:"none", outline:"none", background:"transparent", fontSize:13, color:row.time?"#0891b2":"#94a3b8", fontFamily:"inherit", width:80, flexShrink:0 }}>
                          <option value="">시간</option>
                          {TIME_OPTIONS.map(t=><option key={t} value={t}>{t}</option>)}
                          <option value="__custom__">직접입력</option>
                        </select>
                      ) : (
                        <Field w={80} value={row.time} onChange={v=>updateRow(setEditDis,row.id,"time",v)} placeholder="시간" style={{color:"#0891b2",textAlign:"center"}} />
                      )
                    ) : row.time ? (
                      <span style={{ fontSize:14, color:"#0891b2", fontWeight:600, flexShrink:0, background:"#ecfeff", borderRadius:3, padding:"1px 6px" }}>{row.time}</span>
                    ) : null}
                    {editMode ? (
                      <Field flex={1} value={row.note} onChange={v=>updateRow(setEditDis,row.id,"note",v)} placeholder="재입원 일정 등" style={{color:"#64748b",fontSize:14,textAlign:"center"}} />
                    ) : (
                      <span style={{ fontSize:14, color:"#64748b", flex:1, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis", textAlign:"center" }}>{row.note}</span>
                    )}
                    {editMode && <DelBtn onClick={()=>deleteRow(setEditDis,row.id)} />}
                  </div>
                ))}
                {editMode && <AddBtn onClick={()=>addRow(setEditDis,EMPTY_DIS)} />}
              </div>
            </div>
          </div>

          {/* ── 전실 / 자리보존 2열 ── */}
          <div style={{ display:"flex", gap:12, flexWrap: isMobile?"wrap":"nowrap" }}>
            {/* 전실 */}
            <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
              <SectionHeader icon="⇄" label="전실" count={dTrn.filter(r=>r.name).length} color="#0369a1" bg="#f0f9ff" borderColor="#bae6fd" />
              <div style={{ background:"#fff", border:"1px solid #bae6fd", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
                {dTrn.filter(r=>r.name).length===0 && !editMode && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
                {dTrn.map(row => (
                  <div key={row.id} style={{ display:"flex", gap:8, padding:"8px 12px",
                    borderBottom:"1px solid #f0f9ff", alignItems:"center",
                    background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                    {editMode ? (
                      <Field w={80} value={row.name} onChange={v=>updateRow(setEditTrn,row.id,"name",v)} placeholder="이름" style={{fontWeight:700,fontSize:16}} />
                    ) : (
                      <span style={{ fontWeight:700, fontSize:16, flexShrink:0 }}>{row.name}</span>
                    )}
                    {editMode ? (
                      <Field w={65} value={row.fromRoom} onChange={v=>updateRow(setEditTrn,row.id,"fromRoom",v)} placeholder="기존" style={{textAlign:"center",color:"#64748b",fontSize:15}} />
                    ) : (
                      <span style={{ fontSize:15, color:"#64748b", flexShrink:0 }}>{row.fromRoom}</span>
                    )}
                    <span style={{ color:"#0369a1", fontWeight:800, fontSize:16, flexShrink:0 }}>→</span>
                    {editMode ? (
                      <Field w={65} value={row.toRoom} onChange={v=>updateRow(setEditTrn,row.id,"toRoom",v)} placeholder="이동" style={{textAlign:"center",color:"#0369a1",fontWeight:700,fontSize:15}} />
                    ) : (
                      <span style={{ fontSize:15, color:"#0369a1", fontWeight:700, flexShrink:0 }}>{row.toRoom}</span>
                    )}
                    {editMode ? (
                      <Field flex={1} value={row.time} onChange={v=>updateRow(setEditTrn,row.id,"time",v)} placeholder="시간" style={{color:"#64748b",fontSize:13}} />
                    ) : row.time ? (
                      <span style={{ fontSize:13, color:"#64748b" }}>{row.time}</span>
                    ) : null}
                    {editMode && <DelBtn onClick={()=>deleteRow(setEditTrn,row.id)} />}
                  </div>
                ))}
                {editMode && <AddBtn onClick={()=>addRow(setEditTrn,EMPTY_TRN)} />}
              </div>
            </div>

            {/* 자리보존 */}
            <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
              <SectionHeader icon="🔒" label="자리 보존" count={dRes.filter(r=>r.name).length} color="#7c3aed" bg="#faf5ff" borderColor="#ddd6fe" />
              <div style={{ background:"#fff", border:"1px solid #ddd6fe", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
                {dRes.filter(r=>r.name).length===0 && !editMode && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
                {dRes.map(row => (
                  <div key={row.id} style={{ display:"flex", gap:8, padding:"8px 12px",
                    borderBottom:"1px solid #faf5ff", alignItems:"center",
                    background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                    {editMode ? (
                      <Field w={80} value={row.room} onChange={v=>updateRow(setEditRes,row.id,"room",v)} placeholder="병실" style={{textAlign:"center",color:"#7c3aed",fontWeight:800,fontSize:16}} />
                    ) : (
                      <span style={{ fontSize:16, color:"#7c3aed", fontWeight:800, width:80, textAlign:"center", flexShrink:0 }}>{row.room}</span>
                    )}
                    {editMode ? (
                      <Field w={80} value={row.name} onChange={v=>updateRow(setEditRes,row.id,"name",v)} placeholder="이름" style={{fontWeight:700,fontSize:16}} />
                    ) : (
                      <span style={{ fontWeight:700, fontSize:16, flexShrink:0 }}>{row.name}</span>
                    )}
                    {editMode ? (
                      <>
                        <Field w={70} value={row.dischargeDate} onChange={v=>updateRow(setEditRes,row.id,"dischargeDate",v)} placeholder="퇴원일" style={{fontSize:14,color:"#64748b",textAlign:"center"}} />
                        <Field flex={1} value={row.readmitDate} onChange={v=>updateRow(setEditRes,row.id,"readmitDate",v)} placeholder="재입원" style={{fontSize:14,color:"#7c3aed",textAlign:"center"}} />
                      </>
                    ) : (
                      <span style={{ fontSize:14, color:"#64748b", flex:1, textAlign:"center", overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                        {[row.dischargeDate&&`퇴원:${row.dischargeDate}`, row.readmitDate&&`재입원:${row.readmitDate}`].filter(Boolean).join(" / ")}
                      </span>
                    )}
                    {editMode && <DelBtn onClick={()=>deleteRow(setEditRes,row.id)} />}
                  </div>
                ))}
                {editMode && <AddBtn onClick={()=>addRow(setEditRes,EMPTY_RES)} />}
              </div>
            </div>
          </div>

          {/* ── 치료실 이용계획 ── */}
          <div>
            <SectionHeader icon="💊" label="치료실 이용계획" color="#92400e" bg="#fffbeb" borderColor="#fde68a"
              right={<span className="no-print" style={{ fontSize:11, color:"#a16207", fontWeight:500 }}>치료실 스케줄 자동 연동</span>} />
            <div style={{ background:"#fff", border:"1px solid #fde68a", borderTop:"none",
              borderRadius:"0 0 10px 10px", overflowX:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", minWidth:520, tableLayout:"fixed" }}>
                <colgroup>
                  <col style={{ width:100 }} />
                  {therapyCols.map(c => <col key={c.key} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ ...S.thTh, background:"#fefce8" }}>시간</th>
                    {therapyCols.map(c => (
                      <th key={c.key} style={{ ...S.thTh, whiteSpace:"pre-line" }}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {THERAPY_SLOTS.map(slot => {
                    const auto = autoTherapy[slot]||{};
                    const isAft = slot.startsWith("13");
                    return (
                      <tr key={slot}>
                        <td style={{ padding:"5px 8px", borderBottom:"1px solid #f5f5f4", borderRight:"1px solid #f5f5f4",
                          fontWeight:800, fontSize:15, textAlign:"center", color:"#78350f",
                          background:isAft?"#fefce8":"#fafaf9", whiteSpace:"nowrap" }}>{slot}</td>
                        {therapyCols.map(c => {
                          const manual = dTher[slot]?.[c.key];
                          const autoVal = auto[c.key]||"";
                          const display = manual || autoVal;
                          return (
                            <td key={c.key} style={{ padding:4, borderBottom:"1px solid #f5f5f4",
                              borderRight:"1px solid #f5f5f4", verticalAlign:"middle",
                              background:isAft?"#fffef5":"#fff", height:48 }}>
                              {editMode ? (
                                <>
                                  {autoVal && !manual && (
                                    <div style={{ fontSize:14, fontWeight:700, color:"#1e293b", whiteSpace:"pre-wrap",
                                      lineHeight:1.5, padding:"3px 6px", background:"#f0f9ff",
                                      borderRadius:4, border:"1px solid #dbeafe", textAlign:"center" }}>{autoVal}</div>
                                  )}
                                  <textarea value={manual||""} onChange={e=>updateTherapy(slot,c.key,e.target.value)}
                                    rows={2} placeholder={autoVal?"":"-"}
                                    style={{ width:"100%", border:manual?"1px solid #fcd34d":"1px solid transparent",
                                      background:manual?"#fffbeb":"transparent", resize:"vertical", fontSize:14,
                                      fontFamily:"inherit", padding:"2px 5px", minHeight:40, outline:"none",
                                      lineHeight:1.5, borderRadius:4, marginTop:autoVal&&!manual?2:0, boxSizing:"border-box" }} />
                                </>
                              ) : display ? (
                                <div style={{ fontSize:14, fontWeight:700, color:"#1e293b", whiteSpace:"pre-wrap", lineHeight:1.5, padding:"2px 5px",
                                  textAlign:"center",
                                  background:manual?"#fffbeb":autoVal?"#f0f9ff":"transparent",
                                  borderRadius:4, border:autoVal&&!manual?"1px solid #dbeafe":"none" }}>{display}</div>
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 서브 컴포넌트 ── */
function SectionHeader({ icon, label, count, color, bg, borderColor, right }) {
  return (
    <div style={{ background:bg, border:`1.5px solid ${borderColor}`, borderBottom:"none",
      borderRadius:"10px 10px 0 0", padding:"8px 14px",
      display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontSize:18 }}>{icon}</span>
      <span style={{ fontWeight:900, fontSize:18, color, letterSpacing:1 }}>{label}</span>
      {count > 0 && <span style={{ fontSize:15, fontWeight:800, color,
        background:"rgba(255,255,255,0.7)", borderRadius:10, padding:"1px 9px" }}>{count}</span>}
      {right && <div style={{ marginLeft:"auto" }}>{right}</div>}
    </div>
  );
}

function Field({ value, onChange, placeholder, w, flex, style: extraStyle }) {
  return (
    <input value={value||""} onChange={e => onChange(e.target.value)} placeholder={placeholder}
      style={{ border:"none", outline:"none", background:"transparent", fontSize:14,
        padding:"3px 4px", fontFamily:"inherit", color:"#1e293b", width: w || "auto",
        flex: flex || undefined, minWidth:0, ...extraStyle }} />
  );
}

function DelBtn({ onClick }) {
  return (
    <button className="no-print" onClick={onClick} title="삭제"
      style={{ background:"none", border:"none", cursor:"pointer", color:"#d1d5db",
        fontSize:15, lineHeight:1, padding:"0 2px", flexShrink:0 }}
      onMouseEnter={e => e.target.style.color="#ef4444"}
      onMouseLeave={e => e.target.style.color="#d1d5db"}>✕</button>
  );
}

function AddBtn({ onClick }) {
  return (
    <div className="no-print" style={{ padding:"4px 8px" }}>
      <button onClick={onClick}
        style={{ background:"none", border:"1px dashed #e2e8f0", borderRadius:6, color:"#94a3b8",
          cursor:"pointer", fontSize:13, padding:"3px 14px", width:"100%", fontWeight:600 }}>
        + 추가
      </button>
    </div>
  );
}

const PRINT_CSS = `@media print {
  @page { size: A4 portrait; margin: 8mm; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 11px; }
  .no-print { display: none !important; }
  .print-title { display: block !important; }
  .section-card { break-inside: avoid; margin-bottom: 4mm; }
  input, textarea { border: none !important; background: transparent !important; padding: 0 !important; }
}`;

const S = {
  navArrow: {
    background:"rgba(255,255,255,0.1)", color:"#fff", border:"1px solid rgba(255,255,255,0.2)",
    borderRadius:8, padding:"4px 12px", cursor:"pointer", fontSize:18, fontWeight:700, lineHeight:1,
  },
  headerBtn: {
    color:"#e2e8f0", borderRadius:7, padding:"5px 12px", cursor:"pointer",
    fontSize:12, fontWeight:700, fontFamily:"inherit",
  },
  thTh: {
    background:"#fafaf9", borderBottom:"2px solid #e7e5e4", borderRight:"1px solid #f5f5f4",
    padding:"6px 8px", fontSize:13, fontWeight:700, color:"#44403c", textAlign:"center",
  },
};

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import { searchPatientsByName } from "../lib/patientSearch";

// 환자 목록 메모리 캐시 (세션 내 재사용)
let _patientCache = null;
async function getCachedPatients() {
  if (_patientCache) return _patientCache;
  const snap = await get(ref(db, "patients"));
  _patientCache = Object.values(snap.val() || {});
  return _patientCache;
}
import useIsMobile from "../lib/useismobile";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const WARD_STRUCTURE = {
  2: { name:"2병동", rooms:[{id:"201",type:"4인실",capacity:4},{id:"202",type:"1인실",capacity:1},{id:"203",type:"4인실",capacity:4},{id:"204",type:"2인실",capacity:2},{id:"205",type:"6인실",capacity:6},{id:"206",type:"6인실",capacity:6}]},
  3: { name:"3병동", rooms:[{id:"301",type:"4인실",capacity:4},{id:"302",type:"1인실",capacity:1},{id:"303",type:"4인실",capacity:4},{id:"304",type:"2인실",capacity:2},{id:"305",type:"2인실",capacity:2},{id:"306",type:"6인실",capacity:6}]},
  5: { name:"5병동", rooms:[{id:"501",type:"4인실",capacity:4},{id:"502",type:"1인실",capacity:1},{id:"503",type:"4인실",capacity:4},{id:"504",type:"2인실",capacity:2},{id:"505",type:"6인실",capacity:6},{id:"506",type:"6인실",capacity:6}]},
  6: { name:"6병동", rooms:[{id:"601",type:"6인실",capacity:6},{id:"602",type:"1인실",capacity:1},{id:"603",type:"6인실",capacity:6}]},
};
const TYPE_COLOR = {"1인실":"#6366f1","2인실":"#0ea5e9","4인실":"#10b981","6인실":"#f59e0b"};
const TYPE_BG    = {"1인실":"#eef2ff","2인실":"#e0f2fe","4인실":"#d1fae5","6인실":"#fef3c7"};
const DAY_KO = ["일","월","화","수","목","금","토"];

function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  const d = new Date(str); return isNaN(d) ? null : d;
}
function dateOnly(d) { const x=new Date(d); x.setHours(0,0,0,0); return x; }
function toInputValue(d) { return d.toISOString().slice(0,10); }
function todayDate() { return dateOnly(new Date()); }
function getDaysInMonth(y,m) { return new Date(y,m+1,0).getDate(); }
function getFirstDow(y,m) { return new Date(y,m,1).getDay(); }

function getSlotOccupant(slot, viewDate) {
  if (!slot) return { person:null, type:null };
  const vd = dateOnly(viewDate);
  if (slot.current?.name) {
    const dd = parseDateStr(slot.current.discharge);
    const stillHere = !dd || dateOnly(dd) >= vd;
    if (stillHere) return { person:slot.current, type: dd&&dateOnly(dd).getTime()===vd.getTime()?"discharging_today":"current" };
  }
  const reservations = slot.reservations || [];
  const active = reservations
    .map(r=>{ const ad=parseDateStr(r.admitDate),dd=parseDateStr(r.discharge); if(!ad) return null; const sh=!dd||dateOnly(dd)>=vd; if(dateOnly(ad)<=vd&&sh) return {r,ad}; return null; })
    .filter(Boolean).sort((a,b)=>a.ad-b.ad);
  if (active.length>0) {
    const {r,ad}=active[0];
    return { person:r, type:dateOnly(ad).getTime()===vd.getTime()?"admitting_today":"reserved" };
  }
  return { person:null, type:null };
}

// ── 병상 캘린더 ──────────────────────────────────────────────────────────────
function BedCalendar({ slot, year, month }) {
  const [tooltip, setTooltip] = React.useState(null); // {day, text, x, y}
  const days = getDaysInMonth(year, month);
  const firstDow = getFirstDow(year, month);
  const cells = [];
  for (let i=0;i<firstDow;i++) cells.push(null);
  for (let d=1;d<=days;d++) cells.push(d);
  while (cells.length%7!==0) cells.push(null);

  const getDayInfo = (day) => {
    if (!day) return { status: null, label: "" };
    const d = new Date(year, month, day);
    if (slot?.current?.name) {
      const dd = parseDateStr(slot.current.discharge);
      const ad = parseDateStr(slot.current.admitDate);
      const start = ad ? dateOnly(ad) : null;
      const end   = dd ? dateOnly(dd) : null;
      if ((!start || d >= start) && (!end || d <= end)) {
        if (end && dateOnly(end).getTime()===dateOnly(d).getTime())
          return { status:"discharge", label:`${slot.current.name} 퇴원` };
        return { status:"occupied", label:`${slot.current.name} 입원중` };
      }
    }
    for (const r of (slot?.reservations||[])) {
      const ad = parseDateStr(r.admitDate), dd = parseDateStr(r.discharge);
      if (!ad) continue;
      if (d >= dateOnly(ad) && (!dd || d <= dateOnly(dd))) {
        if (dateOnly(ad).getTime()===dateOnly(d).getTime())
          return { status:"admit", label:`${r.name} 입원일` };
        if (dd && dateOnly(dd).getTime()===dateOnly(d).getTime())
          return { status:"reserve_discharge", label:`${r.name} 예약퇴원` };
        return { status:"reserved", label:`${r.name} 예약` };
      }
    }
    return { status:"empty", label:"" };
  };

  const statusColor = {
    occupied:"#0ea5e9", discharge:"#fbbf24", admit:"#10b981",
    reserved:"#a78bfa", reserve_discharge:"#f9a8d4", empty:"#f1f5f9",
  };

  return (
    <div style={{ marginTop:6, borderTop:"1px solid #e2e8f0", paddingTop:5, position:"relative" }}>
      {/* 색상 범례 */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", marginBottom:4 }}>
        {[["#0ea5e9","입원"],["#10b981","입원일"],["#fbbf24","퇴원일"],["#a78bfa","예약"]].map(([col,lbl])=>(
          <span key={lbl} style={{ display:"flex",alignItems:"center",gap:2,fontSize:11,color:"#64748b",whiteSpace:"nowrap" }}>
            <span style={{ width:8,height:8,borderRadius:2,background:col,display:"inline-block",flexShrink:0 }}/>
            {lbl}
          </span>
        ))}
      </div>
      {/* 날짜 그리드 */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {cells.map((day,idx)=>{
          const { status, label } = getDayInfo(day);
          const bg = status ? statusColor[status] : "transparent";
          const isToday = day && dateOnly(new Date()).getTime()===dateOnly(new Date(year,month,day)).getTime();
          const dow = day ? (firstDow+day-1)%7 : 0;
          return (
            <div key={idx}
              onMouseEnter={e=>{ if(day&&label) setTooltip({day,label,x:e.clientX,y:e.clientY}); }}
              onMouseLeave={()=>setTooltip(null)}
              style={{
                aspectRatio:"1/1", borderRadius:3, background:day?bg:"transparent",
                display:"flex", alignItems:"center", justifyContent:"center",
                border:isToday?"2px solid #0f2744":"1px solid rgba(0,0,0,0.05)",
                boxSizing:"border-box", cursor:day&&label?"pointer":"default",
                transition:"transform 0.1s",
              }}>
              {day&&<span style={{
                fontSize:11, fontWeight:isToday?900:600,
                color:status==="empty"?(dow===0?"#dc2626":dow===6?"#2563eb":"#94a3b8"):"#fff",
                lineHeight:1, userSelect:"none" }}>{day}</span>}
            </div>
          );
        })}
      </div>
      {/* 툴팁 */}
      {tooltip&&(
        <div style={{
          position:"fixed", left:tooltip.x+10, top:tooltip.y-30, zIndex:9999,
          background:"#0f2744", color:"#fff", borderRadius:6, padding:"4px 10px",
          fontSize:12, fontWeight:600, pointerEvents:"none", whiteSpace:"nowrap",
          boxShadow:"0 2px 8px rgba(0,0,0,0.3)"
        }}>
          {month+1}/{tooltip.day} · {tooltip.label}
        </div>
      )}
    </div>
  );
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
export default function RoomPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();
  const { roomId: qRoomId, preview } = router.query;

  const [slots,         setSlots]         = useState({});
  const [consultations, setConsultations] = useState({});
  const [loading,  setLoading]  = useState(true);
  const [viewDateInput, setViewDateInput] = useState(toInputValue(todayDate()));
  const [previewDate,   setPreviewDate]   = useState(null);

  // 캘린더 월 네비
  const today = new Date();
  const [calYear,  setCalYear]  = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());

  // 편집 모달
  const [editingSlot,  setEditingSlot]  = useState(null);
  const [addingTo,     setAddingTo]     = useState(null);
  const [movingPatient,setMovingPatient]= useState(null);

  useEffect(()=>{
    if (preview) {
      setPreviewDate(dateOnly(new Date(preview)));
      setViewDateInput(preview);
    }
  }, [preview]);

  useEffect(()=>{
    const pending = sessionStorage.getItem("pendingMove");
    if (pending) {
      try { setMovingPatient(JSON.parse(pending)); } catch(e) {}
      sessionStorage.removeItem("pendingMove");
    }
  }, []);

  useEffect(()=>{
    const unsub = onValue(ref(db,"slots"), snap=>{ setSlots(snap.val()||{}); setLoading(false); });
    return ()=>unsub();
  },[]);

  useEffect(()=>{
    const unsub = onValue(ref(db,"consultations"), snap=>{ setConsultations(snap.val()||{}); });
    return ()=>unsub();
  },[]);

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
          newSlots[slotKey].current = { ...r };
          promoted = true;
          changed = true;
          return;
        }
        keep.push(r);
      });
      newSlots[slotKey].reservations = keep;
    });
    if (changed) set(ref(db,"slots"), newSlots);
  }, [slots]);

  // 병실 정보
  const room = qRoomId ? Object.values(WARD_STRUCTURE).flatMap(w=>w.rooms).find(r=>r.id===qRoomId) : null;

  const viewDate = previewDate || todayDate();
  const isPreview = !!previewDate;

  const applyPreview = () => {
    const d = new Date(viewDateInput+"T00:00:00");
    setPreviewDate(dateOnly(d));
  };
  const clearPreview = () => {
    setPreviewDate(null);
    setViewDateInput(toInputValue(todayDate()));
  };

  // 저장
  const saveSlots = useCallback(async (newS) => {
    setSlots(newS);
    await set(ref(db,"slots"), newS);
  },[]);

  const addLog = useCallback(async (entry) => {
    const newLog = {...entry, ts:new Date().toISOString()};
    const snap = await new Promise(res=>{ const u=onValue(ref(db,"logs"),s=>{u();res(s.val());},{onlyOnce:true}); });
    const logs = snap ? (Array.isArray(snap)?snap:Object.values(snap)) : [];
    await set(ref(db,"logs"), [newLog,...logs].slice(0,100));
  },[]);

  const saveSlotKey = useCallback(async (slotKey, newSlotData) => {
    const newSlots = {...slots, [slotKey]: newSlotData};
    await saveSlots(newSlots);
  },[slots, saveSlots]);

  // 상담일지 역방향 동기화
  const syncConsultationOnSlotChange = useCallback(async (fromSlotKey, personName, consultationId, newSlotKey) => {
    const match = Object.entries(consultations).find(([id, c]) => {
      if (c.reservedSlot !== fromSlotKey) return false;
      if (consultationId && id === consultationId) return true;
      return c.name === personName;
    });
    if (!match) return;
    const [cId, c] = match;
    if (newSlotKey) {
      await set(ref(db, `consultations/${cId}`), { ...c, reservedSlot: newSlotKey });
    } else {
      await set(ref(db, `consultations/${cId}`), { ...c, reservedSlot: null, status: "상담중" });
    }
  }, [consultations]);

  // 입원 전환
  const convertReservation = useCallback(async (slotKey, resIndex) => {
    const slot = slots[slotKey];
    if (!slot?.reservations?.[resIndex]) return;
    const r = slot.reservations[resIndex];
    if (!window.confirm(`${r.name}님을 현재 입원 환자로 전환하시겠습니까?`)) return;
    const newSlots = JSON.parse(JSON.stringify(slots));
    newSlots[slotKey].current = { ...r };
    newSlots[slotKey].reservations = slot.reservations.filter((_,i)=>i!==resIndex);
    await saveSlots(newSlots);
    await addLog({ action:"입원전환", slotKey, name:r.name });
  },[slots, saveSlots, addLog]);

  // 이동 실행
  const executeMove = useCallback(async (targetSlotKey) => {
    if (!movingPatient) return;
    const { slotKey:fromKey, mode, data, resIndex } = movingPatient;
    const newSlots = JSON.parse(JSON.stringify(slots));
    if (mode==="current") {
      newSlots[fromKey] = { ...(newSlots[fromKey]||{}), current:null };
    } else {
      const oldRes = [...(newSlots[fromKey]?.reservations||[])];
      oldRes.splice(resIndex,1);
      newSlots[fromKey] = { ...(newSlots[fromKey]||{}), reservations:oldRes };
    }
    if (!newSlots[targetSlotKey]) newSlots[targetSlotKey]={current:null,reservations:[]};
    const target = newSlots[targetSlotKey];
    if (mode==="current") {
      if (target.current?.name) {
        const existingName = target.current.name;
        const choice = window.confirm(
          `${targetSlotKey.replace("-","호 ")}번 병상에 ${existingName} 환자가 입원 중입니다.\n\n확인: 기존 환자를 예약으로 전환하고 이동\n취소: 이동 취소`
        );
        if (!choice) { setMovingPatient(null); return; }
        if (!target.reservations) target.reservations=[];
        target.reservations.push({...target.current});
      }
      target.current = {...data};
    } else {
      if (!target.reservations) target.reservations=[];
      target.reservations.push({...data});
    }
    setMovingPatient(null);
    await saveSlots(newSlots);
    await addLog({ action:"이동", from:fromKey, to:targetSlotKey, name:data.name });
    // 예약 이동 시 상담일지 연동
    if (mode === "reservation") {
      await syncConsultationOnSlotChange(fromKey, data.name, data.consultationId, targetSlotKey);
    }
  },[movingPatient, slots, saveSlots, addLog, syncConsultationOnSlotChange]);

  const allKnownPatients = useMemo(() => {
    const seen = new Set();
    const list = [];
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const room2 = slotKey.replace("-", "호 ") + "번";
      const add = (name, note, badge) => {
        const key = name.replace(/^신\)/, "").replace(/\d+$/, "").trim().toLowerCase();
        if (seen.has(key) || !name) return;
        seen.add(key);
        list.push({ name, room: room2, note: note || "", badge });
      };
      if (slot?.current?.name) add(slot.current.name, slot.current.note, "입원중");
      (slot?.reservations || []).forEach(r => { if (r?.name) add(r.name, r.note, "예약"); });
    });
    return list.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  }, [slots]);

  if (loading || !room) return (
    <div style={{ display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"'Noto Sans KR',sans-serif",color:"#64748b" }}>
      {loading ? "로딩 중..." : "병실을 찾을 수 없습니다."}
    </div>
  );

  const bedList = Array.from({length:room.capacity},(_,i)=>{
    const slotKey=`${room.id}-${i+1}`;
    const slot=slots[slotKey]||null;
    const {person,type}=getSlotOccupant(slot,viewDate);
    return { slotKey, slot, person, type };
  });
  const occupied = bedList.filter(b=>b.person).length;

  return (
    <div style={{ fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" }}>

      {/* 헤더 */}
      <header style={{ background: isPreview?"#0d3320":"#0f2744", color:"#fff", padding:"10px 16px",
        display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
        position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 8px rgba(0,0,0,0.15)" }}>
        <button onClick={()=>router.back()}
          style={{ background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff",
            borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 }}>
          ← 병실 현황
        </button>
        <span style={{ fontSize:24, fontWeight:900 }}>{room.id}호</span>
        <span style={{ background:TYPE_BG[room.type], color:TYPE_COLOR[room.type], borderRadius:6, padding:"2px 10px", fontSize:15, fontWeight:700 }}>{room.type}</span>
        <span style={{ fontSize:15, color:"#94a3b8" }}>{occupied}/{room.capacity} 병상 사용</span>
        {isPreview && <span style={{ background:"#d1fae5", color:"#065f46", borderRadius:8, padding:"3px 12px", fontSize:12, fontWeight:800 }}>🔭 미리보기: {viewDate.toLocaleDateString("ko-KR")}</span>}
        {movingPatient && <span style={{ background:"#ede9fe", color:"#6d28d9", borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:700 }}>🚚 {movingPatient.data.name} 이동 중</span>}
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:"#94a3b8" }}>날짜 미리보기:</span>
          <input type="date" value={viewDateInput} onChange={e=>setViewDateInput(e.target.value)}
            style={{ border:"1px solid rgba(255,255,255,0.3)", background:"rgba(255,255,255,0.1)", color:"#fff", borderRadius:6, padding:"4px 8px", fontSize:12, outline:"none" }}/>
          <button onClick={applyPreview}
            style={{ background:"#059669", border:"none", color:"#fff", borderRadius:6, padding:"5px 10px", cursor:"pointer", fontSize:12, fontWeight:700 }}>미리보기</button>
          {isPreview && <button onClick={clearPreview}
            style={{ background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:6, padding:"5px 10px", cursor:"pointer", fontSize:12 }}>← 오늘로</button>}
          {movingPatient && <button onClick={()=>setMovingPatient(null)}
            style={{ background:"#dc2626", border:"none", color:"#fff", borderRadius:6, padding:"5px 10px", cursor:"pointer", fontSize:12, fontWeight:700 }}>이동 취소</button>}
        </div>
      </header>

      {/* 캘린더 월 네비 */}
      <div style={{ background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"8px 16px", display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:15, fontWeight:700, color:"#0f2744" }}>📅 병상 캘린더</span>
        <button onClick={()=>{ if(calMonth===0){setCalYear(y=>y-1);setCalMonth(11);}else setCalMonth(m=>m-1); }}
          style={NS.btnMonth}>‹</button>
        <span style={{ fontSize:15, fontWeight:700, minWidth:80 }}>{calYear}년 {calMonth+1}월</span>
        <button onClick={()=>{ if(calMonth===11){setCalYear(y=>y+1);setCalMonth(0);}else setCalMonth(m=>m+1); }}
          style={NS.btnMonth}>›</button>
        <button onClick={()=>{ setCalYear(today.getFullYear()); setCalMonth(today.getMonth()); }}
          style={{ ...NS.btnMonth, width:"auto", padding:"0 10px", fontSize:13, fontWeight:700 }}>이번달</button>
      </div>

      {/* 범례 - 헤더 바에 통합 */}

      {/* 병상 그리드 */}
      <main style={{ padding:"14px 12px" }}>
        <div style={{ display:"grid", gridTemplateColumns:isMobile?`1fr`:`repeat(6,1fr)`, gap:8 }}>
          {bedList.map(({slotKey,slot,person,type},i)=>{
            const isDischarging = type==="discharging_today";
            const isAdmitting   = type==="admitting_today";
            const isReservedType= type==="reserved";
            const isMovingFrom  = movingPatient?.slotKey===slotKey;
            const isMoveTarget  = !!movingPatient && !isMovingFrom;
            const reservations  = slot?.reservations||[];

            let borderColor="#e2e8f0";
            if(isMovingFrom) borderColor="#f59e0b";
            else if(isMoveTarget) borderColor="#10b981";
            else if(type==="current") borderColor=TYPE_COLOR[room.type];
            else if(isDischarging) borderColor="#fbbf24";
            else if(isAdmitting||isReservedType) borderColor="#a78bfa";
            else if(!isPreview&&reservations.length>0) borderColor="#c4b5fd";

            return (
              <div key={i}
                onClick={()=>{ if(movingPatient&&!isMovingFrom) executeMove(slotKey); }}
                style={{ background: isMovingFrom?"#fffbeb":isMoveTarget?"#f0fdf4":isAdmitting?"#eff6ff":isDischarging?"#fffbeb":isReservedType?"#faf5ff":"#fff",
                  border:`2px ${person?"solid":"dashed"} ${borderColor}`,
                  borderRadius:10, padding:10, minWidth:0, overflow:"hidden",
                  cursor:movingPatient&&!isMovingFrom?"pointer":"default",
                  boxShadow:"0 1px 6px rgba(0,0,0,0.06)", transition:"all 0.2s" }}>

                {/* 병상 번호 */}
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <span style={{ background:"#1e3a5f",color:"#fff",borderRadius:5,padding:"2px 10px",fontSize:17,fontWeight:800 }}>{i+1}번</span>
                  {isMovingFrom   && <span style={{ color:"#d97706",fontWeight:700,fontSize:14 }}>📦 이동 중</span>}
                  {isMoveTarget&&!person && <span style={{ color:"#059669",fontWeight:700,fontSize:14 }}>← 여기로</span>}
                  {isDischarging  && <span style={{ color:"#d97706",fontWeight:700,fontSize:15 }}>🚪 당일 퇴원</span>}
                  {isAdmitting    && <span style={{ color:"#2563eb",fontWeight:700,fontSize:15 }}>🛏 당일 입원</span>}
                  {isReservedType && <span style={{ color:"#7c3aed",fontWeight:700,fontSize:15 }}>📅 예약 입원 중</span>}
                </div>

                {/* 환자 정보 (고정 높이) */}
                <div style={{ height:130, overflow:"hidden" }}>
                {person ? (
                  <div>
                    <div
                      style={{ fontSize:20, fontWeight:800,
                        color:isAdmitting||isReservedType?"#7c3aed":isDischarging?"#d97706":"#0f2744",
                        marginBottom:4,
                        ...(person.patientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}) }}
                      onClick={person.patientId ? () => router.push(`/patients?id=${encodeURIComponent(person.patientId)}`) : undefined}>
                      {person.name}
                    </div>
                    {person.admitDate&&<div style={{ fontSize:14,color:"#7c3aed",marginBottom:2 }}>입원일: {person.admitDate}</div>}
                    <div style={{ fontSize:15,color:"#64748b",marginBottom:4 }}>퇴원: {person.discharge||"미정"}</div>
                    {person.note&&<div style={{ fontSize:13,color:"#475569",background:"#f8fafc",borderRadius:6,padding:"4px 8px",marginBottom:4,lineHeight:1.4,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical" }}>{person.note}</div>}
                    {person.scheduleAlert&&<div style={{ background:"#fef3c7",color:"#92400e",borderRadius:6,padding:"3px 8px",fontSize:13,fontWeight:700 }}>⚠ 스케줄 확인 필요</div>}
                  </div>
                ) : (
                  <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:8 }}>
                    <span style={{ color:isMoveTarget?"#10b981":"#cbd5e1",fontSize:isMoveTarget?36:28 }}>{isMoveTarget?"↓":"+"}</span>
                    {!isPreview&&!movingPatient&&(
                      <button style={NS.btnAdmit} onClick={()=>setAddingTo({slotKey,mode:"current"})}>입원 등록</button>
                    )}
                    {isPreview&&<span style={{ color:"#94a3b8",fontSize:15 }}>입원 가능</span>}
                  </div>
                )}
                </div>

                {/* 현재 입원 환자 버튼 */}
                {person&&!isPreview&&!movingPatient&&(type==="current"||type==="discharging_today"||type==="admitting_today")&&(
                  <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:4 }}>
                    <button style={NS.btnEdit} onClick={()=>setEditingSlot({slotKey,mode:"current",data:{...person}})}>수정</button>
                    <button style={{...NS.btnEdit,background:"#7c3aed"}} onClick={()=>{ sessionStorage.setItem("pendingMove",JSON.stringify({slotKey,mode:"current",data:person,resIndex:undefined})); router.push("/"); }}>🚚 이동</button>
                    <button style={{...NS.btnEdit,background:"#dc2626",width:"100%",marginTop:2}}
                      onClick={()=>router.push(`/treatment?slotKey=${encodeURIComponent(slotKey)}&name=${encodeURIComponent(person.name)}&discharge=${encodeURIComponent(person.discharge||"")}&admitDate=${encodeURIComponent(person.admitDate||"")}${person.patientId?"&patientId="+encodeURIComponent(person.patientId):""}`)}>
                      📋 치료 일정표
                    </button>
                  </div>
                )}
                {/* 예약 입원 중 버튼 */}
                {person&&!isPreview&&!movingPatient&&(type==="reserved")&&(()=>{
                  const resIdx=(slot?.reservations||[]).findIndex(r=>r.name===person.name&&r.admitDate===person.admitDate);
                  return (
                    <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:4 }}>
                      <button style={{...NS.btnEdit,background:"#059669"}} onClick={()=>resIdx>=0&&convertReservation(slotKey,resIdx)}>🛏 입원 전환</button>
                      {resIdx>=0&&<button style={NS.btnEdit} onClick={()=>setEditingSlot({slotKey,mode:"reservation",data:{...(slot.reservations[resIdx])},resIndex:resIdx})}>수정</button>}
                      {resIdx>=0&&<button style={{...NS.btnEdit,background:"#7c3aed"}} onClick={()=>{ sessionStorage.setItem("pendingMove",JSON.stringify({slotKey,mode:"reservation",data:slot.reservations[resIdx],resIndex:resIdx})); router.push("/"); }}>🚚 이동</button>}
                      <button style={{...NS.btnEdit,background:"#dc2626",width:"100%",marginTop:2}}
                        onClick={()=>router.push(`/treatment?slotKey=${encodeURIComponent(slotKey)}&name=${encodeURIComponent(person.name)}&discharge=${encodeURIComponent(person.discharge||"")}&admitDate=${encodeURIComponent(person.admitDate||"")}${person.patientId?"&patientId="+encodeURIComponent(person.patientId):""}`)}>
                        📋 치료 일정표
                      </button>
                    </div>
                  );
                })()}

                {/* 예약 목록 (3건분 고정 높이) */}
                <div style={{ height:220, marginTop:10, borderTop:"1px solid #e2e8f0", paddingTop:8, overflowY:"auto" }}>
                  {!isPreview&&reservations.length>0&&(
                    <div>
                      <div style={{ fontSize:15,fontWeight:700,color:"#7c3aed",marginBottom:6 }}>📅 입원 예약 ({reservations.length}건)</div>
                      {reservations.map((r,ri)=>(
                        <div key={ri} style={{ background:"#faf5ff",border:"1px solid #e9d5ff",borderRadius:8,padding:"6px 10px",marginBottom:5 }}>
                          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:4 }}>
                            <span
                              style={{ fontWeight:700,color:"#7c3aed",fontSize:16,
                                cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" }}
                              onClick={() => r.patientId ? router.push(`/patients?id=${encodeURIComponent(r.patientId)}`) : router.push(`/patients?name=${encodeURIComponent(r.name)}`)}>
                              {r.name}
                            </span>
                            <div style={{ display:"flex",gap:4 }}>
                              <button style={{...NS.btnSmall,color:"#7c3aed"}} onClick={()=>{ sessionStorage.setItem("pendingMove",JSON.stringify({slotKey,mode:"reservation",data:r,resIndex:ri})); router.push("/"); }}>🚚</button>
                              <button style={NS.btnSmall} onClick={()=>setEditingSlot({slotKey,mode:"reservation",data:{...r},resIndex:ri})}>수정</button>
                              <button style={{...NS.btnSmall,background:"#059669",color:"#fff",borderColor:"#059669"}} onClick={()=>convertReservation(slotKey,ri)}>🛏 입원전환</button>
                            </div>
                          </div>
                          <div style={{ fontSize:13,color:"#64748b",marginTop:2 }}>입원: {r.admitDate} → 퇴원: {r.discharge||"미정"}</div>
                          {r.note&&<div style={{ fontSize:12,color:"#94a3b8",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis" }}>{r.note}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {!isPreview&&!movingPatient&&(
                    <button style={{...NS.btnAdmit,background:"#f5f3ff",color:"#7c3aed",marginTop:4,width:"100%"}}
                      onClick={()=>setAddingTo({slotKey,mode:"reservation"})}>📅 예약 입원 추가</button>
                  )}
                </div>

                {/* 병상 캘린더 */}
                <BedCalendar slot={slot} year={calYear} month={calMonth}/>
              </div>
            );
          })}
        </div>
      </main>

      {/* 편집 모달 */}
      {(editingSlot||addingTo)&&(
        <PatientModal
          title={editingSlot
            ? `${editingSlot.slotKey} ${editingSlot.mode==="current"?"현재 환자 수정":"예약 수정"}`
            : `${addingTo.slotKey} ${addingTo.mode==="current"?"입원 등록":"예약 입원 등록"}`}
          data={editingSlot?.data || {name:"",discharge:"미정",note:"",scheduleAlert:false,bedPosition:0,...(addingTo?.mode==="reservation"?{admitDate:""}:{})}}
          mode={editingSlot?.mode||addingTo?.mode}
          isNew={!!addingTo}
          allPatients={addingTo ? allKnownPatients : []}
          currentPatient={slots[(editingSlot?.slotKey||addingTo?.slotKey)]?.current || null}
          onClose={()=>{ setEditingSlot(null); setAddingTo(null); }}
          onSave={async(form)=>{
            const sk=editingSlot?.slotKey||addingTo?.slotKey;
            const newSlots=JSON.parse(JSON.stringify(slots));
            if(!newSlots[sk]) newSlots[sk]={current:null,reservations:[]};
            const slot2=newSlots[sk];
            if((editingSlot?.mode||addingTo?.mode)==="current"){
              // admitDate가 미래면 current → reservation으로 이동 (입원 연기 처리)
              const admitD = form.admitDate ? parseDateStr(form.admitDate) : null;
              if (admitD && dateOnly(admitD) > todayDate()) {
                slot2.current = null;
                if (!slot2.reservations) slot2.reservations = [];
                const dupIdx = slot2.reservations.findIndex(r => r.name === form.name);
                if (dupIdx >= 0) slot2.reservations[dupIdx] = form;
                else slot2.reservations.push(form);
              } else {
                slot2.current = form;
              }
            } else {
              if(!slot2.reservations) slot2.reservations=[];
              if(editingSlot?.resIndex!==undefined) slot2.reservations[editingSlot.resIndex]=form;
              else slot2.reservations.push(form);
            }
            await saveSlots(newSlots);
            await addLog({action:addingTo?"등록":"수정",slotKey:sk,name:form.name});
            setEditingSlot(null); setAddingTo(null);
          }}
          onDelete={editingSlot?async()=>{
            if(!window.confirm("삭제하시겠습니까?")) return;
            const sk=editingSlot.slotKey;
            const newSlots=JSON.parse(JSON.stringify(slots));
            if(editingSlot.mode==="current") newSlots[sk].current=null;
            else newSlots[sk].reservations=newSlots[sk].reservations.filter((_,i)=>i!==editingSlot.resIndex);
            await saveSlots(newSlots);
            await addLog({action:"삭제",slotKey:sk,name:editingSlot.data.name});
            // 예약 삭제 시 상담일지 연동
            if (editingSlot.mode === "reservation") {
              await syncConsultationOnSlotChange(sk, editingSlot.data.name, editingSlot.data.consultationId, null);
            }
            setEditingSlot(null);
          }:undefined}
        />
      )}
    </div>
  );
}

const TIME_OPTIONS_RM = ["아침 후","점심 후","저녁 후"];

// ── PatientModal (타임라인 EditModal과 동일 형식) ─────────────────────────────
function PatientModal({ title, data, mode, isNew, onSave, onDelete, onClose, allPatients=[], currentPatient=null }) {
  const [form, setForm] = useState({
    name:          data.name          || "",
    admitDate:     data.admitDate     || "",
    admitTime:     data.admitTime     || "",
    discharge:     data.discharge     || "미정",
    dischargeTime: data.dischargeTime || "",
    note:          data.note          || "",
    scheduleAlert: data.scheduleAlert || false,
    patientId:     data.patientId     || "",
    preserveSeat:  data.preserveSeat  || false,
    bedPosition:   data.bedPosition   || 0,
  });
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);
  const isRes = mode === "reservation";

  // 자리보존 조건: 현재 입원 환자 + 퇴원 후 7일 이내 재입원 예약
  const curDisD   = currentPatient?.discharge ? parseDateStr(currentPatient.discharge) : null;
  const frmAdmitD = form.admitDate ? parseDateStr(form.admitDate) : null;
  const diffDays  = (curDisD && frmAdmitD)
    ? Math.round((dateOnly(frmAdmitD).getTime() - dateOnly(curDisD).getTime()) / 86400000)
    : -1;
  const showPreserveSeat = isRes && !!currentPatient?.name && currentPatient.name === form.name && diffDays >= 1 && diffDays <= 7;

  const inpStyle = { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"9px 11px", fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };

  const onNameChange = (val) => {
    setForm(p => ({ ...p, name: val, patientId: "" }));
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val.trim()) { setSuggestions([]); setShowSuggestions(false); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchPatientsByName(val.trim());
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch(e) {}
      setSearching(false);
    }, 300);
  };

  const selectPatient = (p) => {
    setForm(prev => ({
      ...prev,
      name: p.name,
      patientId: p.internalId || "",
      note: prev.note || (p.diagnosis ? `[${p.diagnosis}]` : ""),
    }));
    setSuggestions([]);
    setShowSuggestions(false);
  };

  const handleSave = () => {
    if (!form.name?.trim()) { alert("환자명을 입력해 주세요."); return; }
    if (isRes && !form.admitDate?.trim()) { alert("입원 예정일을 입력해 주세요."); return; }
    onSave(form);
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:16, padding:"24px 28px", width:"min(92vw,400px)", boxShadow:"0 24px 64px rgba(0,0,0,0.3)", maxHeight:"92vh", overflowY:"auto" }}>
        <div style={{ fontWeight:800, fontSize:16, color: isRes?"#7c3aed":"#0f2744", marginBottom:4 }}>
          {title}
        </div>
        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:20 }}>{isRes ? "📅 예약 입원" : "🏥 입원 등록"}</div>

        {/* 이름 입력 + 환자 자동완성 */}
        <div style={{ marginBottom:14, position:"relative" }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>
            환자 이름 *
            {form.patientId && <span style={{ marginLeft:6, fontSize:11, color:"#059669", fontWeight:700 }}>✓ 기존 환자 연결됨</span>}
          </label>
          <div style={{ position:"relative" }}>
            <input style={{ ...inpStyle, borderColor: form.patientId?"#10b981":"#e2e8f0", paddingRight: searching?80:11 }}
              value={form.name} onChange={e => onNameChange(e.target.value)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="이름 입력 (기존 환자 자동완성)" autoFocus />
            {searching && <span style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#94a3b8" }}>검색 중…</span>}
          </div>
          {showSuggestions && (
            <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", borderRadius:8,
              boxShadow:"0 8px 24px rgba(0,0,0,0.18)", border:"1px solid #e2e8f0", zIndex:50, maxHeight:220, overflowY:"auto", marginTop:2 }}>
              {suggestions.map((p, i) => (
                <div key={i} onMouseDown={() => selectPatient(p)}
                  style={{ padding:"9px 12px", cursor:"pointer", borderBottom:"1px solid #f1f5f9",
                    display:"flex", flexDirection:"column", gap:2, background:"#fff", transition:"background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f0f9ff"}
                  onMouseLeave={e => e.currentTarget.style.background="#fff"}>
                  <div style={{ fontWeight:700, fontSize:14, color:"#0f2744" }}>{p.name}</div>
                  <div style={{ fontSize:11, color:"#94a3b8", display:"flex", gap:8, flexWrap:"wrap" }}>
                    {p.birthDate && <span>{p.birthDate}</span>}
                    {p.diagnosis && <span style={{ color:"#64748b" }}>{p.diagnosis}</span>}
                    {p.chartNo && <span>차트 {p.chartNo}</span>}
                    {p.doctor && <span>담당 {p.doctor}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 입원일 / 퇴원일 + 시간 */}
        {[
          ...(isRes
            ? [{ label:"예약 입원일 (예: 4/15)", key:"admitDate", timeKey:"admitTime", ph:"4/15" }]
            : [{ label:"입원일 (예: 4/10)", key:"admitDate", timeKey:"admitTime", ph:"4/10" }]),
          { label:"퇴원 예정일 (예: 4/25 또는 미정)", key:"discharge", timeKey:"dischargeTime", ph:"4/25 또는 미정" },
        ].map(f => (
          <div key={f.key} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>{f.label}</label>
            <div style={{ display:"flex", gap:6 }}>
              <input style={{...inpStyle, flex:1}} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph} />
              {(!form[f.timeKey] || TIME_OPTIONS_RM.includes(form[f.timeKey])) ? (
                <select value={form[f.timeKey]||""} onChange={e=>{ if(e.target.value==="__custom__"){ const v=prompt("시간 입력 (예: 14시)"); setForm(p=>({...p,[f.timeKey]:v?v.trim():""})); } else setForm(p=>({...p,[f.timeKey]:e.target.value})); }}
                  style={{...inpStyle, width:110, color:form[f.timeKey]?"#166534":"#94a3b8", flexShrink:0}}>
                  <option value="">시간</option>
                  {TIME_OPTIONS_RM.map(t=><option key={t} value={t}>{t}</option>)}
                  <option value="__custom__">직접입력</option>
                </select>
              ) : (
                <input value={form[f.timeKey]} onChange={e=>setForm(p=>({...p,[f.timeKey]:e.target.value}))}
                  style={{...inpStyle, width:110, color:"#166534", flexShrink:0}} />
              )}
            </div>
          </div>
        ))}

        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>메모</label>
          <textarea style={{...inpStyle, resize:"vertical", minHeight:72, lineHeight:1.6}} value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} placeholder="치료 내용, 특이사항 등" />
        </div>

        {showPreserveSeat && (
          <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14, cursor:"pointer", fontSize:13, color:"#92400e", background:"#fef3c7", borderRadius:8, padding:"10px 12px" }}>
            <input type="checkbox" checked={form.preserveSeat} onChange={e=>setForm(p=>({...p,preserveSeat:e.target.checked}))} />
            🛋 자리보존 서비스 — {currentPatient.name}님 퇴원 후 짐을 두고 재입원까지 병상 유지
          </label>
        )}

        <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20, cursor:"pointer", fontSize:13, color:"#64748b" }}>
          <input type="checkbox" checked={form.scheduleAlert} onChange={e=>setForm(p=>({...p,scheduleAlert:e.target.checked}))} />
          ⚠ 스케줄 확인 필요
        </label>

        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button onClick={handleSave} disabled={!form.name?.trim()}
            style={{ flex:1, background:form.name?.trim()?"#0f2744":"#e2e8f0", color:form.name?.trim()?"#fff":"#94a3b8", border:"none", borderRadius:9, padding:"11px", fontSize:14, fontWeight:700, cursor:form.name?.trim()?"pointer":"default" }}>
            저장
          </button>
          {onDelete && (
            <button onClick={onDelete}
              style={{ background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
              삭제
            </button>
          )}
          <button onClick={onClose}
            style={{ background:"#f1f5f9", color:"#64748b", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

const NS = {
  btnMonth:{ background:"rgba(255,255,255,0.1)",border:"1px solid #e2e8f0",borderRadius:6,width:32,height:32,cursor:"pointer",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center" },
  btnEdit: { background:"#0f2744",color:"#fff",border:"none",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:14,fontWeight:600 },
  btnSmall:{ background:"#f1f5f9",color:"#64748b",border:"1px solid #e2e8f0",borderRadius:5,padding:"3px 10px",cursor:"pointer",fontSize:13,fontWeight:600 },
  btnAdmit:{ background:"#dcfce7",color:"#166534",border:"none",borderRadius:6,padding:"7px 16px",cursor:"pointer",fontSize:15,fontWeight:600,textAlign:"center" },
  label:   { display:"block",fontSize:13,fontWeight:700,color:"#475569",marginBottom:4,marginTop:10 },
  input:   { width:"100%",border:"1.5px solid #e2e8f0",borderRadius:7,padding:"8px 10px",fontSize:14,outline:"none",boxSizing:"border-box",fontFamily:"inherit" },
};

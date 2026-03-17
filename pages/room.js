import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
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
  const days = getDaysInMonth(year, month);
  const firstDow = getFirstDow(year, month);
  const cells = [];
  for (let i=0;i<firstDow;i++) cells.push(null);
  for (let d=1;d<=days;d++) cells.push(d);
  while (cells.length%7!==0) cells.push(null);

  const getDayStatus = (day) => {
    if (!day) return null;
    const d = new Date(year, month, day);
    if (slot?.current?.name) {
      const dd = parseDateStr(slot.current.discharge);
      const ad = parseDateStr(slot.current.admitDate);
      const start = ad ? dateOnly(ad) : null;
      const end   = dd ? dateOnly(dd) : null;
      if ((!start || d >= start) && (!end || d <= end)) {
        if (end && dateOnly(end).getTime()===dateOnly(d).getTime()) return "discharge";
        return "occupied";
      }
    }
    for (const r of (slot?.reservations||[])) {
      const ad = parseDateStr(r.admitDate), dd = parseDateStr(r.discharge);
      if (!ad) continue;
      if (d >= dateOnly(ad) && (!dd || d <= dateOnly(dd))) {
        if (dateOnly(ad).getTime()===dateOnly(d).getTime()) return "admit";
        if (dd && dateOnly(dd).getTime()===dateOnly(d).getTime()) return "reserve_discharge";
        return "reserved";
      }
    }
    return "empty";
  };

  const statusColor = {
    occupied:"#0ea5e9", discharge:"#fbbf24", admit:"#10b981",
    reserved:"#a78bfa", reserve_discharge:"#f9a8d4", empty:"#f1f5f9",
  };

  return (
    <div style={{ marginTop:6, borderTop:"1px solid #e2e8f0", paddingTop:5 }}>
      {/* 날짜만 - 최소화 */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:1 }}>
        {cells.map((day,idx)=>{
          const status = getDayStatus(day);
          const bg = status ? statusColor[status] : "transparent";
          const isToday = day && dateOnly(new Date()).getTime()===dateOnly(new Date(year,month,day)).getTime();
          return (
            <div key={idx} style={{
              height:14, borderRadius:2, background:day?bg:"transparent",
              display:"flex", alignItems:"center", justifyContent:"center",
              border:isToday?"1.5px solid #0f2744":"none",
              boxSizing:"border-box",
            }}>
              {day&&<span style={{ fontSize:8, fontWeight:isToday?900:500,
                color:status==="empty"?"#94a3b8":"#fff", lineHeight:1 }}>{day}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
export default function RoomPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();
  const { roomId: qRoomId, preview } = router.query;

  const [slots,    setSlots]    = useState({});
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
    const unsub = onValue(ref(db,"slots"), snap=>{ setSlots(snap.val()||{}); setLoading(false); });
    return ()=>unsub();
  },[]);

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

  // 입원 전환
  const convertReservation = useCallback(async (slotKey, resIndex) => {
    const slot = slots[slotKey];
    if (!slot?.reservations?.[resIndex]) return;
    const r = slot.reservations[resIndex];
    if (!window.confirm(`${r.name}님을 현재 입원 환자로 전환하시겠습니까?`)) return;
    const newSlots = JSON.parse(JSON.stringify(slots));
    const { admitDate, ...rest } = r;
    newSlots[slotKey].current = rest;
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
      if (target.current?.name) { if (!target.reservations) target.reservations=[]; target.reservations.push({...data}); }
      else target.current = {...data};
    } else {
      if (!target.reservations) target.reservations=[];
      target.reservations.push({...data});
    }
    setMovingPatient(null);
    await saveSlots(newSlots);
    await addLog({ action:"이동", from:fromKey, to:targetSlotKey, name:data.name });
  },[movingPatient, slots, saveSlots, addLog]);

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
        <span style={{ fontSize:20, fontWeight:900 }}>{room.id}호</span>
        <span style={{ background:TYPE_BG[room.type], color:TYPE_COLOR[room.type], borderRadius:6, padding:"2px 10px", fontSize:13, fontWeight:700 }}>{room.type}</span>
        <span style={{ fontSize:13, color:"#94a3b8" }}>{occupied}/{room.capacity} 병상 사용</span>
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
        <span style={{ fontSize:13, fontWeight:700, color:"#0f2744" }}>📅 병상 캘린더</span>
        <button onClick={()=>{ if(calMonth===0){setCalYear(y=>y-1);setCalMonth(11);}else setCalMonth(m=>m-1); }}
          style={NS.btnMonth}>‹</button>
        <span style={{ fontSize:13, fontWeight:700, minWidth:70 }}>{calYear}년 {calMonth+1}월</span>
        <button onClick={()=>{ if(calMonth===11){setCalYear(y=>y+1);setCalMonth(0);}else setCalMonth(m=>m+1); }}
          style={NS.btnMonth}>›</button>
        <button onClick={()=>{ setCalYear(today.getFullYear()); setCalMonth(today.getMonth()); }}
          style={{ ...NS.btnMonth, fontSize:11, padding:"3px 8px" }}>이번달</button>
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
                  borderRadius:10, padding:10,
                  cursor:movingPatient&&!isMovingFrom?"pointer":"default",
                  boxShadow:"0 1px 6px rgba(0,0,0,0.06)", transition:"all 0.2s" }}>

                {/* 병상 번호 */}
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <span style={{ background:"#1e3a5f",color:"#fff",borderRadius:5,padding:"2px 10px",fontSize:14,fontWeight:800 }}>{i+1}번</span>
                  {isMovingFrom   && <span style={{ color:"#d97706",fontWeight:700,fontSize:12 }}>📦 이동 중</span>}
                  {isMoveTarget&&!person && <span style={{ color:"#059669",fontWeight:700,fontSize:12 }}>← 여기로</span>}
                  {isDischarging  && <span style={{ color:"#d97706",fontWeight:700,fontSize:13 }}>🚪 당일 퇴원</span>}
                  {isAdmitting    && <span style={{ color:"#2563eb",fontWeight:700,fontSize:13 }}>🛏 당일 입원</span>}
                  {isReservedType && <span style={{ color:"#7c3aed",fontWeight:700,fontSize:13 }}>📅 예약 입원 중</span>}
                </div>

                {/* 환자 정보 */}
                {person ? (
                  <div>
                    <div style={{ fontSize:15, fontWeight:800,
                      color:isAdmitting||isReservedType?"#7c3aed":isDischarging?"#d97706":"#0f2744",
                      marginBottom:4 }}>{person.name}</div>
                    {person.admitDate&&<div style={{ fontSize:12,color:"#7c3aed",marginBottom:2 }}>입원일: {person.admitDate}</div>}
                    <div style={{ fontSize:13,color:"#64748b",marginBottom:4 }}>퇴원: {person.discharge||"미정"}</div>
                    {person.note&&<div style={{ fontSize:12,color:"#475569",background:"#f8fafc",borderRadius:6,padding:"6px 8px",marginBottom:6,lineHeight:1.5 }}>{person.note}</div>}
                    {person.scheduleAlert&&<div style={{ background:"#fef3c7",color:"#92400e",borderRadius:6,padding:"4px 8px",fontSize:12,fontWeight:700,marginBottom:6 }}>⚠ 스케줄 확인 필요</div>}

                    {/* 현재 입원 환자 버튼 */}
                    {!isPreview&&!movingPatient&&(type==="current"||type==="discharging_today"||type==="admitting_today")&&(
                      <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:8 }}>
                        <button style={NS.btnEdit} onClick={()=>setEditingSlot({slotKey,mode:"current",data:{...person}})}>수정</button>
                        <button style={{...NS.btnEdit,background:"#7c3aed"}} onClick={()=>setMovingPatient({slotKey,mode:"current",data:person})}>🚚 이동</button>
                        <button style={{...NS.btnEdit,background:"#dc2626",width:"100%",marginTop:2}}
                          onClick={()=>router.push(`/treatment?slotKey=${encodeURIComponent(slotKey)}&name=${encodeURIComponent(person.name)}&discharge=${encodeURIComponent(person.discharge||"")}&admitDate=${encodeURIComponent(person.admitDate||"")}`)}>
                          📋 치료 일정표
                        </button>
                      </div>
                    )}
                    {/* 예약 입원 중 버튼 */}
                    {!isPreview&&!movingPatient&&(type==="reserved")&&(()=>{
                      const resIdx=(slot?.reservations||[]).findIndex(r=>r.name===person.name&&r.admitDate===person.admitDate);
                      return (
                        <div style={{ display:"flex",gap:6,flexWrap:"wrap",marginTop:8 }}>
                          <button style={{...NS.btnEdit,background:"#059669"}} onClick={()=>resIdx>=0&&convertReservation(slotKey,resIdx)}>🛏 입원 전환</button>
                          {resIdx>=0&&<button style={NS.btnEdit} onClick={()=>setEditingSlot({slotKey,mode:"reservation",data:{...(slot.reservations[resIdx])},resIndex:resIdx})}>수정</button>}
                          {resIdx>=0&&<button style={{...NS.btnEdit,background:"#7c3aed"}} onClick={()=>setMovingPatient({slotKey,mode:"reservation",data:slot.reservations[resIdx],resIndex:resIdx})}>🚚 이동</button>}
                          <button style={{...NS.btnEdit,background:"#dc2626",width:"100%",marginTop:2}}
                            onClick={()=>router.push(`/treatment?slotKey=${encodeURIComponent(slotKey)}&name=${encodeURIComponent(person.name)}&discharge=${encodeURIComponent(person.discharge||"")}&admitDate=${encodeURIComponent(person.admitDate||"")}`)}>
                            📋 치료 일정표
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                ) : (
                  <div style={{ display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:60,gap:8 }}>
                    <span style={{ color:isMoveTarget?"#10b981":"#cbd5e1",fontSize:isMoveTarget?36:28 }}>{isMoveTarget?"↓":"+"}</span>
                    {!isPreview&&!movingPatient&&(
                      <button style={NS.btnAdmit} onClick={()=>setAddingTo({slotKey,mode:"current"})}>입원 등록</button>
                    )}
                    {isPreview&&<span style={{ color:"#94a3b8",fontSize:13 }}>입원 가능</span>}
                  </div>
                )}

                {/* 예약 목록 */}
                {!isPreview&&reservations.length>0&&(
                  <div style={{ marginTop:10,borderTop:"1px solid #e2e8f0",paddingTop:8 }}>
                    <div style={{ fontSize:12,fontWeight:700,color:"#7c3aed",marginBottom:6 }}>📅 입원 예약 ({reservations.length}건)</div>
                    {reservations.map((r,ri)=>(
                      <div key={ri} style={{ background:"#faf5ff",border:"1px solid #e9d5ff",borderRadius:8,padding:"8px 10px",marginBottom:6 }}>
                        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:4 }}>
                          <span style={{ fontWeight:700,color:"#7c3aed",fontSize:14 }}>{r.name}</span>
                          <div style={{ display:"flex",gap:4 }}>
                            <button style={{...NS.btnSmall,color:"#7c3aed"}} onClick={()=>setMovingPatient({slotKey,mode:"reservation",data:r,resIndex:ri})}>🚚</button>
                            <button style={NS.btnSmall} onClick={()=>setEditingSlot({slotKey,mode:"reservation",data:{...r},resIndex:ri})}>수정</button>
                            <button style={{...NS.btnSmall,background:"#059669",color:"#fff",borderColor:"#059669"}} onClick={()=>convertReservation(slotKey,ri)}>🛏 입원전환</button>
                          </div>
                        </div>
                        <div style={{ fontSize:12,color:"#64748b",marginTop:3 }}>입원: {r.admitDate} → 퇴원: {r.discharge||"미정"}</div>
                        {r.note&&<div style={{ fontSize:11,color:"#94a3b8" }}>{r.note}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {!isPreview&&!movingPatient&&(
                  <button style={{...NS.btnAdmit,background:"#f5f3ff",color:"#7c3aed",marginTop:8,width:"100%"}}
                    onClick={()=>setAddingTo({slotKey,mode:"reservation"})}>📅 예약 입원 추가</button>
                )}

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
          onClose={()=>{ setEditingSlot(null); setAddingTo(null); }}
          onSave={async(form)=>{
            const sk=editingSlot?.slotKey||addingTo?.slotKey;
            const newSlots=JSON.parse(JSON.stringify(slots));
            if(!newSlots[sk]) newSlots[sk]={current:null,reservations:[]};
            const slot2=newSlots[sk];
            if((editingSlot?.mode||addingTo?.mode)==="current"){
              slot2.current=form;
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
            setEditingSlot(null);
          }:undefined}
        />
      )}
    </div>
  );
}

// ── PatientModal ──────────────────────────────────────────────────────────────
function PatientModal({ title, data, mode, isNew, onSave, onDelete, onClose }) {
  const [form,setForm]=useState({...data});
  const setF=(k,v)=>setForm(f=>({...f,[k]:v}));
  const isRes=mode==="reservation";
  return (
    <div style={{ position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16 }}>
      <div style={{ background:"#fff",borderRadius:14,padding:"20px 16px",width:"100%",maxWidth:420,maxHeight:"92vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.18)" }}>
        <div style={{ fontSize:16,fontWeight:800,marginBottom:14,color:isRes?"#7c3aed":"#0f2744" }}>{title}</div>
        {isRes&&<>
          <label style={NS.label}>입원 예정일 ★</label>
          <input style={{...NS.input,borderColor:"#a78bfa"}} value={form.admitDate||""} onChange={e=>setF("admitDate",e.target.value)} placeholder="예: 3/18"/>
          <div style={{ fontSize:11,color:"#94a3b8",marginTop:2,marginBottom:8 }}>M/D 형식 (예: 3/18)</div>
        </>}
        <label style={NS.label}>환자명 ★</label>
        <input style={NS.input} value={form.name||""} onChange={e=>setF("name",e.target.value)} placeholder="환자명"/>
        <label style={NS.label}>퇴원 예정일</label>
        <input style={NS.input} value={form.discharge||""} onChange={e=>setF("discharge",e.target.value)} placeholder="미정 또는 M/D"/>
        <label style={NS.label}>메모</label>
        <textarea style={{...NS.input,height:70,resize:"vertical"}} value={form.note||""} onChange={e=>setF("note",e.target.value)} placeholder="특이사항"/>
        <label style={{ display:"flex",alignItems:"center",gap:8,marginTop:8,fontSize:14,cursor:"pointer" }}>
          <input type="checkbox" checked={!!form.scheduleAlert} onChange={e=>setF("scheduleAlert",e.target.checked)}/>
          ⚠ 스케줄 확인 필요
        </label>
        <div style={{ display:"flex",gap:8,marginTop:16,flexWrap:"wrap" }}>
          <button style={{...NS.btnEdit,flex:1,padding:"9px",fontSize:14}} onClick={()=>{ if(!form.name?.trim()){alert("환자명을 입력해 주세요.");return;} if(isRes&&!form.admitDate?.trim()){alert("입원 예정일을 입력해 주세요.");return;} onSave(form); }}>저장</button>
          {onDelete&&<button style={{...NS.btnEdit,background:"#dc2626",padding:"9px 14px"}} onClick={onDelete}>삭제</button>}
          <button style={{...NS.btnEdit,background:"#f1f5f9",color:"#475569",padding:"9px 14px"}} onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}

const NS = {
  btnMonth:{ background:"rgba(255,255,255,0.1)",border:"1px solid #e2e8f0",borderRadius:6,width:28,height:28,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center" },
  btnEdit: { background:"#0f2744",color:"#fff",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:13,fontWeight:600 },
  btnSmall:{ background:"#f1f5f9",color:"#64748b",border:"1px solid #e2e8f0",borderRadius:5,padding:"2px 8px",cursor:"pointer",fontSize:12,fontWeight:600 },
  btnAdmit:{ background:"#dcfce7",color:"#166534",border:"none",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontSize:13,fontWeight:600,textAlign:"center" },
  label:   { display:"block",fontSize:13,fontWeight:700,color:"#475569",marginBottom:4,marginTop:10 },
  input:   { width:"100%",border:"1.5px solid #e2e8f0",borderRadius:7,padding:"8px 10px",fontSize:14,outline:"none",boxSizing:"border-box",fontFamily:"inherit" },
};

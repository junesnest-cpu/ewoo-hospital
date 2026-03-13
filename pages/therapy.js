import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DAYS  = ["월","화","수","목","금","토","일"];
const TIMES = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const LUNCH = "12:00";

const PHYS_TREATS = [
  { id:"pain",   name:"페인",  short:"P",  color:"#dc2626", bg:"#fef2f2" },
  { id:"manip2", name:"도수2", short:"D2", color:"#7c3aed", bg:"#faf5ff" },
  { id:"manip1", name:"도수1", short:"D1", color:"#059669", bg:"#f0fdf4" },
];

const ROOMS = [
  { id:"th1",          label:"치료사1", color:"#059669", bg:"#f0fdf4", type:"physical" },
  { id:"th2",          label:"치료사2", color:"#1d4ed8", bg:"#eff6ff", type:"physical" },
  { id:"hyperthermia", label:"고주파",  color:"#dc2626", bg:"#fef2f2", type:"hyper"   },
  { id:"hyperbaric",   label:"고압산소",color:"#0284c7", bg:"#f0f9ff", type:"hyper"   },
];

function getWeekStart(d) {
  const date = new Date(d); const dow = date.getDay();
  date.setDate(date.getDate()+(dow===0?-6:1-dow)); date.setHours(0,0,0,0); return date;
}
function weekKey(ws)  { return ws.toISOString().slice(0,10); }
function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d)   { return `${d.getMonth()+1}/${d.getDate()}`; }

export default function TherapyPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();
  const todayD   = new Date();

  const [weekStart,    setWeekStart]    = useState(()=>getWeekStart(todayD));
  const [physSched,    setPhysSched]    = useState({});
  const [hyperSched,   setHyperSched]   = useState({});
  const [slots,        setSlots]        = useState({});
  const [treatPlans,   setTreatPlans]   = useState({});
  const [therapists,   setTherapists]   = useState(["치료사1","치료사2"]);

  const [modal,     setModal]     = useState(null);
  const [physSlot,  setPhysSlot]  = useState("");
  const [physTreat, setPhysTreat] = useState("");
  const [physPend,  setPhysPend]  = useState("");
  const [selHyper,  setSelHyper]  = useState("");
  const [selHyperB, setSelHyperB] = useState("");
  const [pendH,     setPendH]     = useState("");
  const [pendHB,    setPendHB]    = useState("");
  const [extraTime, setExtraTime] = useState("");
  const [showExtra, setShowExtra] = useState(false);
  const [mobileDayIdx, setMobileDayIdx] = useState(()=>{ const d=new Date().getDay(); return d===0?6:d-1; });

  const physRef=React.useRef({}), hyperRef=React.useRef({}), treatRef=React.useRef({});
  const weekStartRef=React.useRef(weekStart);
  React.useEffect(()=>{ weekStartRef.current=weekStart; },[weekStart]);

  const wk=weekKey(weekStart);
  const weekDates=Array.from({length:7},(_,i)=>addDays(weekStart,i));
  const isThisWeek=weekKey(getWeekStart(todayD))===wk;

  useEffect(()=>{
    const u1=onValue(ref(db,"slots"),               s=>setSlots(s.val()||{}));
    const u2=onValue(ref(db,"treatmentPlans"),      s=>{ const v=s.val()||{}; setTreatPlans(v); treatRef.current=v; });
    const u3=onValue(ref(db,"physicalSchedule"),    s=>{ const v=s.val()||{}; setPhysSched(v);  physRef.current=v; });
    const u4=onValue(ref(db,"hyperthermiaSchedule"),s=>{ const v=s.val()||{}; setHyperSched(v); hyperRef.current=v; });
    const u5=onValue(ref(db,"settings"),            s=>{ const v=s.val()||{}; setTherapists([v.therapist1||"치료사1",v.therapist2||"치료사2"]); });
    return ()=>{ u1();u2();u3();u4();u5(); };
  },[]);

  const getCell=useCallback((roomId,dayIdx,time)=>{
    if(roomId==="th1"||roomId==="th2"){
      const th=roomId==="th1"?therapists[0]:therapists[1];
      return physSched[wk]?.[th]?.[dayIdx]?.[time]||null;
    }
    return hyperSched[wk]?.[roomId]?.[dayIdx]?.[time]||null;
  },[physSched,hyperSched,wk,therapists]);

  const syncTreat=useCallback(async(slotKey,dayIdx,treatmentId,action)=>{
    const date=addDays(weekStartRef.current,dayIdx);
    const mKey=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey=String(date.getDate());
    const tp=JSON.parse(JSON.stringify(treatRef.current));
    if(!tp[slotKey])       tp[slotKey]={};
    if(!tp[slotKey][mKey]) tp[slotKey][mKey]={};
    const ex=tp[slotKey][mKey][dKey]||[];
    tp[slotKey][mKey][dKey]=action==="add"?ex.some(e=>e.id===treatmentId)?ex:[...ex,{id:treatmentId,qty:"1"}]:ex.filter(e=>e.id!==treatmentId);
    treatRef.current=tp; setTreatPlans(tp);
    await set(ref(db,`treatmentPlans/${slotKey}/${mKey}/${dKey}`),tp[slotKey][mKey][dKey]);
  },[]);

  const savePhys=useCallback(async(th,dayIdx,time,data)=>{
    const cWk=weekKey(weekStartRef.current);
    const old=physRef.current[cWk]?.[th]?.[dayIdx]?.[time]||null;
    const nxt=JSON.parse(JSON.stringify(physRef.current));
    if(!nxt[cWk])             nxt[cWk]={};
    if(!nxt[cWk][th])         nxt[cWk][th]={};
    if(!nxt[cWk][th][dayIdx]) nxt[cWk][th][dayIdx]={};
    if(data===null) delete nxt[cWk][th][dayIdx][time]; else nxt[cWk][th][dayIdx][time]=data;
    physRef.current=nxt; setPhysSched(nxt);
    await set(ref(db,`physicalSchedule/${cWk}`),nxt[cWk]||{});
    if(data?.slotKey&&data?.treatmentId){
      if(old?.slotKey&&old?.treatmentId&&(old.slotKey!==data.slotKey||old.treatmentId!==data.treatmentId)) await syncTreat(old.slotKey,dayIdx,old.treatmentId,"remove");
      await syncTreat(data.slotKey,dayIdx,data.treatmentId,"add");
    } else if(data===null&&old?.slotKey&&old?.treatmentId){ await syncTreat(old.slotKey,dayIdx,old.treatmentId,"remove"); }
  },[syncTreat]);

  const saveHyper=useCallback(async(roomType,dayIdx,time,data)=>{
    const cWk=weekKey(weekStartRef.current);
    const old=hyperRef.current[cWk]?.[roomType]?.[dayIdx]?.[time]||null;
    const nxt=JSON.parse(JSON.stringify(hyperRef.current));
    if(!nxt[cWk])                   nxt[cWk]={};
    if(!nxt[cWk][roomType])         nxt[cWk][roomType]={};
    if(!nxt[cWk][roomType][dayIdx]) nxt[cWk][roomType][dayIdx]={};
    if(data===null) delete nxt[cWk][roomType][dayIdx][time]; else nxt[cWk][roomType][dayIdx][time]=data;
    hyperRef.current=nxt; setHyperSched(nxt);
    await set(ref(db,`hyperthermiaSchedule/${cWk}`),nxt[cWk]||{});
    const tid=roomType==="hyperthermia"?"hyperthermia":"hyperbaric";
    if(data?.slotKey){ if(old?.slotKey&&old.slotKey!==data.slotKey) await syncTreat(old.slotKey,dayIdx,tid,"remove"); await syncTreat(data.slotKey,dayIdx,tid,"add"); }
    else if(data===null&&old?.slotKey){ await syncTreat(old.slotKey,dayIdx,tid,"remove"); }
  },[syncTreat]);

  const openModal=(roomId,dayIdx,time)=>{
    const room=ROOMS.find(r=>r.id===roomId);
    if(room?.type==="physical"){ const ex=getCell(roomId,dayIdx,time); setPhysSlot(ex?.slotKey||""); setPhysTreat(ex?.treatmentId||""); setPhysPend(""); }
    else { const exH=getCell("hyperthermia",dayIdx,time); const exHB=getCell("hyperbaric",dayIdx,time); setSelHyper(exH?.slotKey||""); setSelHyperB(exHB?.slotKey||""); setPendH(""); setPendHB(""); }
    setShowExtra(false); setExtraTime(""); setModal({roomId,dayIdx,time});
  };

  const doPhysRegister=async()=>{
    if(!modal||!physTreat) return;
    const {roomId,dayIdx,time:base}=modal;
    const th=roomId==="th1"?therapists[0]:therapists[1];
    const time=showExtra&&extraTime?extraTime:base;
    let slotKey=physSlot,name="",roomI="",bedNum="";
    if(physSlot==="__pending__"){ if(!physPend.trim()) return; slotKey=`pending_${Date.now()}`; name=physPend.trim(); }
    else { name=slots[physSlot]?.current?.name||""; roomI=physSlot.split("-")[0]; bedNum=physSlot.split("-")[1]; }
    if(!slotKey) return;
    await savePhys(th,dayIdx,time,{slotKey,patientName:name,treatmentId:physTreat,isPending:physSlot==="__pending__",roomId:roomI,bedNum});
    setModal(null);
  };

  const doPhysRemove=async(roomId,dayIdx,time)=>{
    if(!confirm("삭제하시겠습니까?")) return;
    const th=roomId==="th1"?therapists[0]:therapists[1];
    const cWk=weekKey(weekStartRef.current);
    const old=physRef.current[cWk]?.[th]?.[dayIdx]?.[time];
    if(old?.slotKey&&old?.treatmentId) await syncTreat(old.slotKey,dayIdx,old.treatmentId,"remove");
    await savePhys(th,dayIdx,time,null);
  };

  const doHyperRegister=async()=>{
    if(!modal) return;
    const {dayIdx,time:base}=modal; const time=showExtra&&extraTime?extraTime:base;
    const save=async(rt,sel,pend)=>{
      if(sel==="__pending__"){ if(pend.trim()) await saveHyper(rt,dayIdx,time,{slotKey:"__pending__",patientName:pend.trim(),roomId:"",bedNum:"",isPending:true}); else await saveHyper(rt,dayIdx,time,null); }
      else if(sel){ const name=slots[sel]?.current?.name||""; await saveHyper(rt,dayIdx,time,{slotKey:sel,patientName:name,roomId:sel.split("-")[0],bedNum:sel.split("-")[1]}); }
      else { await saveHyper(rt,dayIdx,time,null); }
    };
    await save("hyperthermia",selHyper,pendH); await save("hyperbaric",selHyperB,pendHB); setModal(null);
  };

  const allPatients=Object.entries(slots).filter(([,sd])=>sd?.current?.name).map(([sk,sd])=>({slotKey:sk,name:sd.current.name})).sort((a,b)=>a.slotKey.localeCompare(b.slotKey));

  const physModalPatients=modal?.roomId?.startsWith("th")?(()=>{
    const {dayIdx}=modal; const date=weekDates[dayIdx];
    const mKey=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`; const dKey=String(date.getDate());
    const result=[];
    Object.entries(treatPlans).forEach(([sk,months])=>{ const items=months?.[mKey]?.[dKey]||[]; const ph=items.filter(e=>PHYS_TREATS.some(t=>t.id===e.id)); const name=slots[sk]?.current?.name; if(!name) return; result.push({slotKey:sk,name,treatmentIds:ph.map(e=>e.id),linked:true}); });
    Object.entries(slots).forEach(([sk,sd])=>{ if(!sd?.current?.name) return; if(result.find(r=>r.slotKey===sk)) return; result.push({slotKey:sk,name:sd.current.name,treatmentIds:[],linked:false}); });
    return result;
  })():[];

  const getConflicts=useCallback((dayIdx,time)=>{
    const seen=new Set(), dups=new Set();
    ROOMS.forEach(r=>{ const c=getCell(r.id,dayIdx,time); if(c?.slotKey&&!c.isPending){ if(seen.has(c.slotKey)) dups.add(c.slotKey); else seen.add(c.slotKey); } });
    return dups;
  },[getCell]);

  const modalRoom=modal?ROOMS.find(r=>r.id===modal.roomId):null;
  const isPhysModal=modalRoom?.type==="physical";

  const dayCols=isMobile?[mobileDayIdx]:Array.from({length:7},(_,i)=>i);

  return (
    <div style={S.page}>
      <header style={S.header}>
        <button style={S.btnBack} onClick={()=>router.push("/")}>← 현황판</button>
        <div style={S.hcenter}>
          <div style={S.htitle}>🏥 치료실 통합 일정표</div>
          <div style={S.hsub}>{fmtDate(weekDates[0])} ~ {fmtDate(weekDates[6])}</div>
        </div>
        <div style={S.hright}>
          <button style={S.btnW} onClick={()=>setWeekStart(w=>addDays(w,-7))}>‹ 전주</button>
          {!isThisWeek&&<button style={{...S.btnW,background:"#065f46",color:"#6ee7b7"}} onClick={()=>setWeekStart(getWeekStart(todayD))}>이번 주</button>}
          <button style={S.btnW} onClick={()=>setWeekStart(w=>addDays(w,7))}>다음 주 ›</button>
          <button style={S.btnW} onClick={()=>router.push("/settings")}>⚙️</button>
        </div>
      </header>

      {/* 범례 */}
      <div style={S.legend}>
        {ROOMS.map(r=>(
          <span key={r.id} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700}}>
            <span style={{width:10,height:10,borderRadius:3,background:r.color,display:"inline-block"}}/>
            {r.id==="th1"?therapists[0]:r.id==="th2"?therapists[1]:r.label}
          </span>
        ))}
        <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,color:"#dc2626",fontWeight:700,marginLeft:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#dc2626",display:"inline-block"}}/>
          겹침 주의
        </span>
        {PHYS_TREATS.map(t=>(
          <span key={t.id} style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:10,color:t.color,fontWeight:700}}>
            <span style={{fontSize:9,background:t.bg,border:`1px solid ${t.color}`,borderRadius:2,padding:"0 3px"}}>{t.short}</span>
            {t.name}
          </span>
        ))}
      </div>

      {/* 모바일 요일 탭 */}
      {isMobile&&(
        <div style={{display:"flex",background:"#fff",borderBottom:"1px solid #e2e8f0",flexShrink:0}}>
          {DAYS.map((day,di)=>{
            const date=weekDates[di]; const isWe=di>=5; const isSel=mobileDayIdx===di;
            const has=TIMES.some(t=>ROOMS.some(r=>getCell(r.id,di,t)));
            return (
              <button key={di} onClick={()=>setMobileDayIdx(di)}
                style={{flex:1,padding:"7px 2px",border:"none",cursor:"pointer",textAlign:"center",position:"relative",
                  background:isSel?(isWe?"#1d4ed8":"#0f2744"):(isWe?"#eff6ff":"#f8fafc"),
                  color:isSel?"#fff":(isWe?"#2563eb":"#374151")}}>
                <div style={{fontSize:11,fontWeight:700}}>{day}</div>
                <div style={{fontSize:9,opacity:0.8}}>{date?`${date.getMonth()+1}/${date.getDate()}`:""}</div>
                {has&&!isSel&&<div style={{position:"absolute",top:3,right:3,width:5,height:5,borderRadius:"50%",background:"#f59e0b"}}/>}
              </button>
            );
          })}
        </div>
      )}

      {/* 메인 테이블 */}
      <div style={S.tableWrap}>
        <table style={S.tbl}>
          <colgroup>
            <col style={{width:46}}/>
            {dayCols.map(di=><col key={di} style={{minWidth:isMobile?300:undefined}}/>)}
          </colgroup>
          <thead>
            <tr>
              <th style={S.thTime} rowSpan={2}>시간</th>
              {dayCols.map(di=>{
                const date=weekDates[di]; const isWe=di>=5;
                return (
                  <th key={di} style={{...S.thDay,background:isWe?"#dbeafe":"#f1f5f9",color:isWe?"#1d4ed8":"#0f2744"}}>
                    <div style={{fontSize:12,fontWeight:800}}>{DAYS[di]}</div>
                    <div style={{fontSize:10,fontWeight:400,color:isWe?"#3b82f6":"#64748b"}}>{date?fmtDate(date):""}</div>
                  </th>
                );
              })}
            </tr>
            <tr>
              {dayCols.map(di=>(
                <th key={di} style={{padding:"2px 3px",background:"#fff",borderBottom:"2px solid #e2e8f0"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:2}}>
                    {ROOMS.map(r=>(
                      <div key={r.id} style={{background:r.color,color:"#fff",borderRadius:3,padding:"2px 0",
                        fontSize:isMobile?10:8,fontWeight:800,textAlign:"center",lineHeight:1.3}}>
                        {r.id==="th1"?therapists[0].slice(0,3):r.id==="th2"?therapists[1].slice(0,3):r.label.slice(0,3)}
                      </div>
                    ))}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIMES.map(time=>{
              const isLunch=time===LUNCH;
              return (
                <tr key={time} style={{borderBottom:"1px solid #e2e8f0"}}>
                  <td style={{...S.tdTime,background:isLunch?"#f8fafc":"#fff",color:isLunch?"#94a3b8":"#0f2744",height:isLunch?20:54}}>
                    {time.slice(0,5)}{isLunch&&<div style={{fontSize:7,color:"#94a3b8"}}>점심</div>}
                  </td>
                  {dayCols.map(dayIdx=>{
                    if(isLunch) return <td key={dayIdx} style={{background:"#f8fafc",textAlign:"center",color:"#cbd5e1",fontSize:11}}>—</td>;
                    const conflicts=getConflicts(dayIdx,time);
                    return (
                      <td key={dayIdx} style={{padding:"2px 3px",verticalAlign:"top",background:"#fff"}}>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:2,height:50}}>
                          {ROOMS.map(r=>{
                            const cell=getCell(r.id,dayIdx,time);
                            const isConflict=cell&&!cell.isPending&&conflicts.has(cell.slotKey);
                            const tr2=cell?PHYS_TREATS.find(t=>t.id===cell.treatmentId):null;
                            const bg=cell?(tr2?tr2.bg:r.bg):"#f8fafc";
                            const col=cell?(tr2?tr2.color:r.color):"#d1d5db";
                            return (
                              <div key={r.id}
                                onClick={()=>openModal(r.id,dayIdx,time)}
                                style={{background:bg,borderRadius:4,cursor:"pointer",padding:"3px 3px",
                                  border:isConflict?"2px solid #dc2626":`1px solid ${col}44`,
                                  display:"flex",flexDirection:"column",justifyContent:"center",
                                  position:"relative",overflow:"hidden",boxSizing:"border-box"}}>
                                {cell?(
                                  <>
                                    <div style={{fontSize:isMobile?11:9,fontWeight:800,color:col,lineHeight:1.2,
                                      overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>
                                      {cell.patientName}
                                    </div>
                                    {cell.roomId&&<div style={{fontSize:isMobile?9:7,color:"#64748b",lineHeight:1.2}}>{cell.roomId}-{cell.bedNum}</div>}
                                    {tr2&&<div style={{fontSize:isMobile?9:7,color:tr2.color,fontWeight:800,lineHeight:1.1}}>{tr2.short}</div>}
                                    {cell.isPending&&<div style={{fontSize:7,color:"#f59e0b",fontWeight:700}}>예정</div>}
                                    {isConflict&&<div style={{position:"absolute",top:1,right:1,width:6,height:6,borderRadius:"50%",background:"#dc2626"}}/>}
                                    <button onClick={e=>{e.stopPropagation();
                                      if(r.type==="physical") doPhysRemove(r.id,dayIdx,time);
                                      else { if(!confirm("삭제?")) return; saveHyper(r.id,dayIdx,time,null); }}}
                                      style={{position:"absolute",bottom:1,right:1,background:"rgba(220,38,38,0.2)",
                                        border:"none",color:"#dc2626",borderRadius:2,width:11,height:11,
                                        cursor:"pointer",fontSize:7,lineHeight:"11px",textAlign:"center",padding:0}}>✕</button>
                                  </>
                                ):(
                                  <div style={{color:"#d1d5db",fontSize:16,textAlign:"center",userSelect:"none",lineHeight:1}}>+</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 물리치료 모달 */}
      {modal&&isPhysModal&&(
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={{...S.mHead,background:modalRoom.color}}>
              <span style={S.mTitle}>{modal.roomId==="th1"?therapists[0]:therapists[1]} · {DAYS[modal.dayIdx]} {fmtDate(weekDates[modal.dayIdx])} {modal.time}</span>
              <button style={S.mClose} onClick={()=>setModal(null)}>✕</button>
            </div>
            <div style={{padding:16}}>
              <label style={S.lbl}>환자 선택</label>
              <select style={S.sel} value={physSlot} onChange={e=>{setPhysSlot(e.target.value);setPhysTreat("");setPhysPend("");}}>
                <option value="">— 선택 —</option>
                <option value="__pending__">✏️ 예정 환자</option>
                <optgroup label="── 치료계획 연동 ──">{physModalPatients.filter(p=>p.linked).map(p=><option key={p.slotKey} value={p.slotKey}>★ {p.name} ({p.slotKey})</option>)}</optgroup>
                <optgroup label="── 전체 입원 환자 ──">{physModalPatients.filter(p=>!p.linked).map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}</optgroup>
              </select>
              {physSlot==="__pending__"&&<input style={{...S.inp,marginTop:8}} value={physPend} onChange={e=>setPhysPend(e.target.value)} placeholder="환자 이름"/>}
              <label style={{...S.lbl,marginTop:12}}>치료 종류</label>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {PHYS_TREATS.map(t=>(
                  <button key={t.id} style={{border:`1.5px solid ${t.color}`,borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:700,
                    background:physTreat===t.id?t.color:t.bg,color:physTreat===t.id?"#fff":t.color}}
                    onClick={()=>setPhysTreat(t.id)}>{t.name}</button>
                ))}
              </div>
              <label style={{display:"flex",alignItems:"center",gap:6,marginTop:12,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>다른 시간으로 등록
              </label>
              {showExtra&&<input style={{...S.inp,marginTop:6}} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800"/>}
              <div style={{display:"flex",gap:8,marginTop:16}}>
                <button style={{...S.btnOk,flex:1,background:modalRoom.color}} onClick={doPhysRegister}
                  disabled={(!physSlot||(physSlot==="__pending__"&&!physPend.trim()))||!physTreat}>등록</button>
                {getCell(modal.roomId,modal.dayIdx,modal.time)&&(
                  <button style={S.btnDel} onClick={()=>{doPhysRemove(modal.roomId,modal.dayIdx,modal.time);setModal(null);}}>삭제</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 고주파/고압산소 모달 */}
      {modal&&!isPhysModal&&modalRoom&&(
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={{...S.mHead,background:"#7c2d12"}}>
              <span style={S.mTitle}>{DAYS[modal.dayIdx]} {fmtDate(weekDates[modal.dayIdx])} {modal.time} — 고주파/고압산소</span>
              <button style={S.mClose} onClick={()=>setModal(null)}>✕</button>
            </div>
            <div style={{padding:16}}>
              <div style={{background:"#fef2f2",borderRadius:8,padding:"10px 12px",marginBottom:12}}>
                <label style={{...S.lbl,color:"#dc2626"}}>🔥 고주파 온열치료</label>
                <select style={S.sel} value={selHyper} onChange={e=>{setSelHyper(e.target.value);setPendH("");}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHyper==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendH} onChange={e=>setPendH(e.target.value)} placeholder="환자 이름"/>}
              </div>
              <div style={{background:"#f0f9ff",borderRadius:8,padding:"10px 12px",marginBottom:12}}>
                <label style={{...S.lbl,color:"#0284c7"}}>💨 고압산소치료</label>
                <select style={S.sel} value={selHyperB} onChange={e=>{setSelHyperB(e.target.value);setPendHB("");}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHyperB==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendHB} onChange={e=>setPendHB(e.target.value)} placeholder="환자 이름"/>}
              </div>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>다른 시간으로 등록
              </label>
              {showExtra&&<input style={{...S.inp,marginTop:6}} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800"/>}
              <div style={{display:"flex",gap:8,marginTop:14}}>
                <button style={{...S.btnOk,flex:1,background:"#dc2626"}} onClick={doHyperRegister}>저장</button>
                <button style={S.btnDel} onClick={async()=>{ if(!confirm("고주파/고압산소 모두 삭제?")) return; await saveHyper("hyperthermia",modal.dayIdx,modal.time,null); await saveHyper("hyperbaric",modal.dayIdx,modal.time,null); setModal(null); }}>전체삭제</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page:    { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", display:"flex", flexDirection:"column" },
  header:  { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", gap:12, padding:"10px 16px", boxShadow:"0 2px 8px rgba(0,0,0,0.15)", flexShrink:0, flexWrap:"wrap" },
  btnBack: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600 },
  hcenter: { flex:1, textAlign:"center" },
  htitle:  { fontSize:16, fontWeight:800 },
  hsub:    { fontSize:10, color:"#94a3b8", marginTop:1 },
  hright:  { display:"flex", gap:6, flexWrap:"wrap" },
  btnW:    { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:11, fontWeight:600 },
  legend:  { background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"6px 16px", display:"flex", gap:14, alignItems:"center", flexShrink:0, flexWrap:"wrap" },
  tableWrap:{ flex:1, overflowX:"auto", overflowY:"auto" },
  tbl:     { width:"100%", borderCollapse:"collapse", tableLayout:"fixed" },
  thTime:  { background:"#0f2744", color:"#fff", fontSize:9, fontWeight:700, textAlign:"center", border:"1px solid #1e3a5f", padding:"4px 1px", verticalAlign:"middle", width:46 },
  thDay:   { fontSize:11, fontWeight:800, textAlign:"center", border:"1px solid #e2e8f0", padding:"4px 2px" },
  tdTime:  { fontSize:9, fontWeight:700, textAlign:"center", border:"1px solid #e2e8f0", padding:"1px", whiteSpace:"nowrap", verticalAlign:"middle", width:46 },
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 },
  modal:   { background:"#fff", borderRadius:12, width:"100%", maxWidth:440, boxShadow:"0 8px 40px rgba(0,0,0,0.2)", overflow:"hidden", maxHeight:"90vh", overflowY:"auto" },
  mHead:   { color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 16px" },
  mTitle:  { fontSize:13, fontWeight:800 },
  mClose:  { background:"none", border:"none", color:"rgba(255,255,255,0.7)", fontSize:18, cursor:"pointer" },
  lbl:     { display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:4 },
  inp:     { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  sel:     { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", fontFamily:"inherit" },
  btnOk:   { background:"#059669", color:"#fff", border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontSize:13, fontWeight:700 },
  btnDel:  { background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:8, padding:"8px 14px", cursor:"pointer", fontSize:13, fontWeight:700 },
};

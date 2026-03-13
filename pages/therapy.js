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

// 유효 병실
const VALID_ROOMS = new Set([
  "201","202","203","204","205","206",
  "301","302","303","304","305","306",
  "501","502","503","504","505","506",
  "601","602","603",
]);

const ROOMS = [
  { id:"th1",          label:"치료사1", color:"#059669", bg:"#f0fdf4", type:"physical" },
  { id:"th2",          label:"치료사2", color:"#1d4ed8", bg:"#eff6ff", type:"physical" },
  { id:"hyperthermia", label:"고주파",  color:"#dc2626", bg:"#fef2f2", type:"hyper"   },
  { id:"hyperbaric",   label:"고압산소",color:"#0284c7", bg:"#f0f9ff", type:"hyper"   },
];

function getWeekStart(d) {
  const date=new Date(d); const dow=date.getDay();
  date.setDate(date.getDate()+(dow===0?-6:1-dow)); date.setHours(0,0,0,0); return date;
}
function weekKey(ws)  { return ws.toISOString().slice(0,10); }
function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d)   { return `${d.getMonth()+1}/${d.getDate()}`; }
function toHHMM(t)    { return t?.slice(0,5)||""; }
// 시간 문자열 정렬용
function timeVal(t)   { const [h,m]=(t||"00:00").split(":").map(Number); return h*60+m; }

export default function TherapyPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();
  const todayD   = new Date();

  const [weekStart,  setWeekStart]  = useState(()=>getWeekStart(todayD));
  const [physSched,  setPhysSched]  = useState({});
  const [hyperSched, setHyperSched] = useState({});
  const [slots,      setSlots]      = useState({});
  const [treatPlans, setTreatPlans] = useState({});
  const [therapists, setTherapists] = useState(["치료사1","치료사2"]);

  // 모달
  const [modal,      setModal]      = useState(null); // {roomId,dayIdx,time}
  const [physSlot,   setPhysSlot]   = useState("");
  const [physTreat,  setPhysTreat]  = useState("");
  const [physPend,   setPhysPend]   = useState("");
  const [selHyper,   setSelHyper]   = useState("");
  const [selHBa,     setSelHBa]     = useState(""); // 고압산소 정시 슬롯
  const [selHBb,     setSelHBb]     = useState(""); // 고압산소 +30분 슬롯
  const [pendH,      setPendH]      = useState("");
  const [pendHBa,    setPendHBa]    = useState("");
  const [pendHBb,    setPendHBb]    = useState("");
  const [extraTime,  setExtraTime]  = useState("");
  const [showExtra,  setShowExtra]  = useState(false);
  const [mobileDayIdx,setMobileDayIdx]=useState(()=>{ const d=new Date().getDay(); return d===0?6:d-1; });

  // 인쇄
  const [printMode,  setPrintMode]  = useState(false);
  const [printSel,   setPrintSel]   = useState({});
  const [printTab,   setPrintTab]   = useState("physical");

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

  // ── 셀 조회 ────────────────────────────────────────────────────────────────
  const getCell=useCallback((roomId,dayIdx,time)=>{
    if(roomId==="th1"||roomId==="th2"){
      const th=roomId==="th1"?therapists[0]:therapists[1];
      return physSched[wk]?.[th]?.[dayIdx]?.[time]||null;
    }
    if(roomId==="hyperbaric") return null; // 고압산소는 getHBCell 사용
    return hyperSched[wk]?.[roomId]?.[dayIdx]?.[time]||null;
  },[physSched,hyperSched,wk,therapists]);

  // 고압산소: a=정시, b=+30분
  const getHBCell=useCallback((dayIdx,time,slot)=>
    hyperSched[wk]?.["hyperbaric"]?.[dayIdx]?.[time]?.[slot]||null,
  [hyperSched,wk]);

  // ── 동적 시간 목록 (커스텀 시간 포함) ────────────────────────────────────
  const getAllTimes=useCallback((dayIdx)=>{
    const set_=new Set(TIMES);
    // physicalSchedule에서 커스텀 시간 수집
    therapists.forEach(th=>{
      Object.keys(physSched[wk]?.[th]?.[dayIdx]||{}).forEach(t=>set_.add(t));
    });
    // hyperthermiaSchedule에서 커스텀 시간 수집
    ["hyperthermia","hyperbaric"].forEach(rt=>{
      Object.keys(hyperSched[wk]?.[rt]?.[dayIdx]||{}).forEach(t=>set_.add(t));
    });
    return Array.from(set_).sort((a,b)=>timeVal(a)-timeVal(b));
  },[physSched,hyperSched,wk,therapists]);

  // ── treatmentPlan 동기화 ────────────────────────────────────────────────────
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

  // ── 물리치료 저장 ───────────────────────────────────────────────────────────
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

  // ── 고주파 저장 (hyperbaric: hbSlot="a"|"b") ────────────────────────────────
  const saveHyper=useCallback(async(roomType,dayIdx,time,data,hbSlot)=>{
    const cWk=weekKey(weekStartRef.current);
    const nxt=JSON.parse(JSON.stringify(hyperRef.current));
    if(!nxt[cWk])                   nxt[cWk]={};
    if(!nxt[cWk][roomType])         nxt[cWk][roomType]={};
    if(!nxt[cWk][roomType][dayIdx]) nxt[cWk][roomType][dayIdx]={};
    let old=null;
    if(roomType==="hyperbaric"&&hbSlot){
      old=hyperRef.current[cWk]?.[roomType]?.[dayIdx]?.[time]?.[hbSlot]||null;
      if(!nxt[cWk][roomType][dayIdx][time]) nxt[cWk][roomType][dayIdx][time]={};
      if(data===null) delete nxt[cWk][roomType][dayIdx][time][hbSlot];
      else nxt[cWk][roomType][dayIdx][time][hbSlot]=data;
    } else {
      old=hyperRef.current[cWk]?.[roomType]?.[dayIdx]?.[time]||null;
      if(data===null) delete nxt[cWk][roomType][dayIdx][time];
      else nxt[cWk][roomType][dayIdx][time]=data;
    }
    hyperRef.current=nxt; setHyperSched(nxt);
    await set(ref(db,`hyperthermiaSchedule/${cWk}`),nxt[cWk]||{});
    const tid=roomType==="hyperthermia"?"hyperthermia":"hyperbaric";
    if(data?.slotKey){ if(old?.slotKey&&old.slotKey!==data.slotKey) await syncTreat(old.slotKey,dayIdx,tid,"remove"); await syncTreat(data.slotKey,dayIdx,tid,"add"); }
    else if(data===null&&old?.slotKey){ await syncTreat(old.slotKey,dayIdx,tid,"remove"); }
  },[syncTreat]);

  // ── 모달 열기 ───────────────────────────────────────────────────────────────
  const openModal=(roomId,dayIdx,time)=>{
    const room=ROOMS.find(r=>r.id===roomId);
    if(room?.type==="physical"){
      const ex=getCell(roomId,dayIdx,time);
      setPhysSlot(ex?.slotKey||""); setPhysTreat(ex?.treatmentId||""); setPhysPend("");
    } else {
      const exH =getCell("hyperthermia",dayIdx,time);
      const exHBa=getHBCell(dayIdx,time,"a");
      const exHBb=getHBCell(dayIdx,time,"b");
      setSelHyper(exH?.slotKey||"");
      setSelHBa(exHBa?.slotKey||""); setSelHBb(exHBb?.slotKey||"");
      setPendH(""); setPendHBa(""); setPendHBb("");
    }
    setShowExtra(false); setExtraTime(""); setModal({roomId,dayIdx,time});
  };

  // ── 물리치료 등록 ───────────────────────────────────────────────────────────
  const doPhysRegister=async()=>{
    if(!modal||!physTreat) return;
    const {roomId,dayIdx,time:base}=modal;
    const th=roomId==="th1"?therapists[0]:therapists[1];
    const time=showExtra&&extraTime?toHHMM(extraTime):base;
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

  // ── 고주파/고압산소 등록 ────────────────────────────────────────────────────
  const doHyperRegister=async()=>{
    if(!modal) return;
    const {dayIdx,time:base}=modal;
    const time=showExtra&&extraTime?toHHMM(extraTime):base;

    // 고주파
    if(selHyper==="__pending__"){ if(pendH.trim()) await saveHyper("hyperthermia",dayIdx,time,{slotKey:"__pending__",patientName:pendH.trim(),roomId:"",bedNum:"",isPending:true}); else await saveHyper("hyperthermia",dayIdx,time,null); }
    else if(selHyper){ const name=slots[selHyper]?.current?.name||""; await saveHyper("hyperthermia",dayIdx,time,{slotKey:selHyper,patientName:name,roomId:selHyper.split("-")[0],bedNum:selHyper.split("-")[1]}); }
    else { await saveHyper("hyperthermia",dayIdx,time,null); }

    // 고압산소 a슬롯 (정시)
    if(selHBa==="__pending__"){ if(pendHBa.trim()) await saveHyper("hyperbaric",dayIdx,time,{slotKey:"__pending__",patientName:pendHBa.trim(),roomId:"",bedNum:"",isPending:true,subTime:time},"a"); else await saveHyper("hyperbaric",dayIdx,time,null,"a"); }
    else if(selHBa){ const name=slots[selHBa]?.current?.name||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBa,patientName:name,roomId:selHBa.split("-")[0],bedNum:selHBa.split("-")[1],subTime:time},"a"); }
    else { await saveHyper("hyperbaric",dayIdx,time,null,"a"); }

    // 고압산소 b슬롯 (+30분)
    const timeB=`${String(Math.floor(timeVal(time)/60)).padStart(2,"0")}:${String((timeVal(time)%60)+30).padStart(2,"0")}`;
    if(selHBb==="__pending__"){ if(pendHBb.trim()) await saveHyper("hyperbaric",dayIdx,time,{slotKey:"__pending__",patientName:pendHBb.trim(),roomId:"",bedNum:"",isPending:true,subTime:timeB},"b"); else await saveHyper("hyperbaric",dayIdx,time,null,"b"); }
    else if(selHBb){ const name=slots[selHBb]?.current?.name||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBb,patientName:name,roomId:selHBb.split("-")[0],bedNum:selHBb.split("-")[1],subTime:timeB},"b"); }
    else { await saveHyper("hyperbaric",dayIdx,time,null,"b"); }

    setModal(null);
  };

  // ── 환자 목록 (유효 병실만) ─────────────────────────────────────────────────
  const allPatients=Object.entries(slots)
    .filter(([sk,sd])=>{ if(!sd?.current?.name) return false; const room=sk.split("-")[0]; return VALID_ROOMS.has(room); })
    .map(([sk,sd])=>({slotKey:sk,name:sd.current.name}))
    .sort((a,b)=>a.slotKey.localeCompare(b.slotKey));

  const physModalPatients=modal?.roomId?.startsWith("th")?(()=>{
    const {dayIdx}=modal; const date=weekDates[dayIdx];
    const mKey=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`; const dKey=String(date.getDate());
    const result=[];
    Object.entries(treatPlans).forEach(([sk,months])=>{ const items=months?.[mKey]?.[dKey]||[]; const ph=items.filter(e=>PHYS_TREATS.some(t=>t.id===e.id)); const name=slots[sk]?.current?.name; if(!name) return; const room=sk.split("-")[0]; if(!VALID_ROOMS.has(room)) return; result.push({slotKey:sk,name,treatmentIds:ph.map(e=>e.id),linked:true}); });
    Object.entries(slots).forEach(([sk,sd])=>{ if(!sd?.current?.name) return; const room=sk.split("-")[0]; if(!VALID_ROOMS.has(room)) return; if(result.find(r=>r.slotKey===sk)) return; result.push({slotKey:sk,name:sd.current.name,treatmentIds:[],linked:false}); });
    return result;
  })():[];

  // ── 충돌 감지 ───────────────────────────────────────────────────────────────
  const getConflicts=useCallback((dayIdx,time)=>{
    const seen=new Set(), dups=new Set();
    ROOMS.forEach(r=>{
      if(r.id==="hyperbaric"){
        ["a","b"].forEach(s=>{ const c=getHBCell(dayIdx,time,s); if(c?.slotKey&&!c.isPending){ if(seen.has(c.slotKey)) dups.add(c.slotKey); else seen.add(c.slotKey); } });
      } else {
        const c=getCell(r.id,dayIdx,time); if(c?.slotKey&&!c.isPending){ if(seen.has(c.slotKey)) dups.add(c.slotKey); else seen.add(c.slotKey); }
      }
    });
    return dups;
  },[getCell,getHBCell]);

  // ── 인쇄용 데이터 ───────────────────────────────────────────────────────────
  const physPrintPatients=(()=>{
    const map={};
    therapists.forEach(th=>{ Object.entries(physSched[wk]?.[th]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,data])=>{ if(!data?.slotKey) return; const k=data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time,treatmentId:data.treatmentId,therapist:th}); }); }); });
    return Object.values(map).sort((a,b)=>a.name?.localeCompare(b.name,"ko"));
  })();

  const hyperPrintPatients=(()=>{
    const map={};
    Object.entries(hyperSched[wk]?.["hyperthermia"]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,data])=>{ if(!data?.slotKey) return; const k=data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time,treatmentName:"고주파 온열치료"}); }); });
    Object.entries(hyperSched[wk]?.["hyperbaric"]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,slots_])=>{ ["a","b"].forEach(s=>{ const data=slots_?.[s]; if(!data?.slotKey) return; const k=data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time:data.subTime||time,treatmentName:"고압산소치료"}); }); }); });
    return Object.values(map).sort((a,b)=>a.name?.localeCompare(b.name,"ko"));
  })();

  const curPrintPatients=printTab==="physical"?physPrintPatients:hyperPrintPatients;
  const modalRoom=modal?ROOMS.find(r=>r.id===modal.roomId):null;
  const isPhysModal=modalRoom?.type==="physical";
  const dayCols=isMobile?[mobileDayIdx]:Array.from({length:7},(_,i)=>i);

  // ── 렌더 ────────────────────────────────────────────────────────────────────
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
          <button style={{...S.btnW,background:printMode?"#7c3aed":"rgba(255,255,255,0.15)"}}
            onClick={()=>{setPrintMode(p=>!p);setPrintSel({});}}>
            {printMode?"✕ 취소":"🖨 인쇄"}
          </button>
        </div>
      </header>

      {/* 범례 */}
      <div style={S.legend}>
        {ROOMS.map(r=>(
          <span key={r.id} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700}}>
            <span style={{width:10,height:10,borderRadius:3,background:r.color,display:"inline-block"}}/>
            {r.id==="th1"?therapists[0]:r.id==="th2"?therapists[1]:r.label}
            {r.id==="hyperbaric"&&<span style={{fontSize:9,color:"#64748b",fontWeight:400}}>(A·B 30분)</span>}
          </span>
        ))}
        <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,color:"#dc2626",fontWeight:700,marginLeft:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#dc2626",display:"inline-block"}}/>겹침 주의
        </span>
      </div>

      {/* 인쇄 선택 바 */}
      {printMode&&(
        <div style={S.printBar}>
          <div style={{display:"flex",gap:0,borderRadius:7,overflow:"hidden",border:"1px solid #e9d5ff",flexShrink:0}}>
            <button style={{padding:"5px 12px",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",background:printTab==="physical"?"#059669":"#f8fafc",color:printTab==="physical"?"#fff":"#475569"}}
              onClick={()=>{setPrintTab("physical");setPrintSel({});}}>🏃 물리치료</button>
            <button style={{padding:"5px 12px",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",background:printTab==="hyper"?"#dc2626":"#f8fafc",color:printTab==="hyper"?"#fff":"#475569"}}
              onClick={()=>{setPrintTab("hyper");setPrintSel({});}}>⚡ 고주파/고압</button>
          </div>
          <div style={{display:"flex",gap:6,flex:1,flexWrap:"wrap"}}>
            {curPrintPatients.map(p=>(
              <label key={p.slotKey} style={{display:"flex",alignItems:"center",fontSize:12,cursor:"pointer",background:"#fff",border:"1px solid #e9d5ff",borderRadius:6,padding:"2px 8px"}}>
                <input type="checkbox" checked={!!printSel[p.slotKey]} onChange={e=>setPrintSel(prev=>({...prev,[p.slotKey]:e.target.checked}))}/>
                <span style={{marginLeft:5}}>{p.name}님</span>
              </label>
            ))}
          </div>
          <button style={{background:"#7c3aed",color:"#fff",border:"none",borderRadius:8,padding:"7px 16px",cursor:"pointer",fontSize:13,fontWeight:700}}
            onClick={()=>window.print()}>선택 인쇄</button>
        </div>
      )}

      {/* 모바일 요일 탭 */}
      {isMobile&&(
        <div style={{display:"flex",background:"#fff",borderBottom:"1px solid #e2e8f0",flexShrink:0}}>
          {DAYS.map((day,di)=>{
            const date=weekDates[di]; const isWe=di>=5; const isSel=mobileDayIdx===di;
            const allT=getAllTimes(di);
            const has=allT.some(t=>ROOMS.some(r=>r.id==="hyperbaric"?getHBCell(di,t,"a")||getHBCell(di,t,"b"):getCell(r.id,di,t)));
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
                        {r.id==="hyperbaric"&&<span style={{fontSize:7,opacity:0.8}}> A·B</span>}
                      </div>
                    ))}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* 각 날짜별 동적 시간 행 렌더링 */}
            {(()=>{
              // 데스크탑: 모든 날짜에 걸쳐 공통 시간 목록 계산
              const allTimesUnion = isMobile
                ? getAllTimes(mobileDayIdx)
                : (()=>{
                    const s=new Set(TIMES);
                    Array.from({length:7},(_,di)=>getAllTimes(di)).forEach(ts=>ts.forEach(t=>s.add(t)));
                    return Array.from(s).sort((a,b)=>timeVal(a)-timeVal(b));
                  })();

              return allTimesUnion.map(time=>{
                const isLunch=time===LUNCH;
                const isCustom=!TIMES.includes(time);
                return (
                  <tr key={time} style={{borderBottom:"1px solid #e2e8f0"}}>
                    <td style={{...S.tdTime,
                      background:isLunch?"#f8fafc":isCustom?"#fefce8":"#fff",
                      color:isLunch?"#94a3b8":isCustom?"#854d0e":"#0f2744",
                      height:isLunch?20:54}}>
                      {toHHMM(time)}
                      {isLunch&&<div style={{fontSize:7,color:"#94a3b8"}}>점심</div>}
                      {isCustom&&<div style={{fontSize:7,color:"#d97706"}}>추가</div>}
                    </td>
                    {dayCols.map(dayIdx=>{
                      if(isLunch) return <td key={dayIdx} style={{background:"#f8fafc",textAlign:"center",color:"#cbd5e1",fontSize:11}}>—</td>;
                      const conflicts=getConflicts(dayIdx,time);
                      return (
                        <td key={dayIdx} style={{padding:"2px 3px",verticalAlign:"top",background:isCustom?"#fefce8":"#fff"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:2,height:50}}>
                            {ROOMS.map(r=>{
                              // 고압산소: A·B 두 슬롯을 세로로 쌓아서 표시
                              if(r.id==="hyperbaric"){
                                const ca=getHBCell(dayIdx,time,"a");
                                const cb=getHBCell(dayIdx,time,"b");
                                const isConflictA=ca&&!ca.isPending&&conflicts.has(ca.slotKey);
                                const isConflictB=cb&&!cb.isPending&&conflicts.has(cb.slotKey);
                                return (
                                  <div key={r.id} onClick={()=>openModal(r.id,dayIdx,time)}
                                    style={{background:r.bg,borderRadius:4,cursor:"pointer",padding:"1px 2px",
                                      border:`1px solid ${r.color}33`,display:"flex",flexDirection:"column",gap:1,
                                      justifyContent:"space-around",overflow:"hidden",boxSizing:"border-box"}}>
                                    {/* A슬롯 */}
                                    <div style={{flex:1,borderRadius:3,padding:"1px 2px",minHeight:20,
                                      background:ca?"#e0f2fe":"#f8fafc",
                                      border:isConflictA?"1.5px solid #dc2626":"1px solid #bae6fd",
                                      display:"flex",flexDirection:"column",justifyContent:"center",position:"relative"}}>
                                      {ca?(
                                        <>
                                          <div style={{fontSize:isMobile?10:8,fontWeight:800,color:r.color,lineHeight:1.1,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{ca.patientName}</div>
                                          {ca.roomId&&<div style={{fontSize:7,color:"#64748b"}}>{ca.roomId}-{ca.bedNum}</div>}
                                          <div style={{fontSize:7,color:"#0284c7",fontWeight:700}}>{ca.subTime||time}</div>
                                          <button onClick={e=>{e.stopPropagation();if(!confirm("삭제?"))return;saveHyper("hyperbaric",dayIdx,time,null,"a");}}
                                            style={{position:"absolute",top:0,right:0,background:"rgba(220,38,38,0.2)",border:"none",color:"#dc2626",borderRadius:2,width:10,height:10,cursor:"pointer",fontSize:6,lineHeight:"10px",textAlign:"center",padding:0}}>✕</button>
                                        </>
                                      ):<div style={{color:"#bae6fd",fontSize:10,textAlign:"center"}}>A+</div>}
                                    </div>
                                    {/* B슬롯 */}
                                    <div style={{flex:1,borderRadius:3,padding:"1px 2px",minHeight:20,
                                      background:cb?"#e0f2fe":"#f8fafc",
                                      border:isConflictB?"1.5px solid #dc2626":"1px solid #bae6fd",
                                      display:"flex",flexDirection:"column",justifyContent:"center",position:"relative"}}>
                                      {cb?(
                                        <>
                                          <div style={{fontSize:isMobile?10:8,fontWeight:800,color:r.color,lineHeight:1.1,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{cb.patientName}</div>
                                          {cb.roomId&&<div style={{fontSize:7,color:"#64748b"}}>{cb.roomId}-{cb.bedNum}</div>}
                                          <div style={{fontSize:7,color:"#0284c7",fontWeight:700}}>{cb.subTime||"+30m"}</div>
                                          <button onClick={e=>{e.stopPropagation();if(!confirm("삭제?"))return;saveHyper("hyperbaric",dayIdx,time,null,"b");}}
                                            style={{position:"absolute",top:0,right:0,background:"rgba(220,38,38,0.2)",border:"none",color:"#dc2626",borderRadius:2,width:10,height:10,cursor:"pointer",fontSize:6,lineHeight:"10px",textAlign:"center",padding:0}}>✕</button>
                                        </>
                                      ):<div style={{color:"#bae6fd",fontSize:10,textAlign:"center"}}>B+</div>}
                                    </div>
                                  </div>
                                );
                              }

                              const cell=getCell(r.id,dayIdx,time);
                              const isConflict=cell&&!cell.isPending&&conflicts.has(cell.slotKey);
                              const tr2=cell?PHYS_TREATS.find(t=>t.id===cell.treatmentId):null;
                              const bg=cell?(tr2?tr2.bg:r.bg):"#f8fafc";
                              const col=cell?(tr2?tr2.color:r.color):"#d1d5db";
                              return (
                                <div key={r.id} onClick={()=>openModal(r.id,dayIdx,time)}
                                  style={{background:bg,borderRadius:4,cursor:"pointer",padding:"3px 3px",
                                    border:isConflict?"2px solid #dc2626":`1px solid ${col}44`,
                                    display:"flex",flexDirection:"column",justifyContent:"center",
                                    position:"relative",overflow:"hidden",boxSizing:"border-box"}}>
                                  {cell?(
                                    <>
                                      <div style={{fontSize:isMobile?11:9,fontWeight:800,color:col,lineHeight:1.2,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{cell.patientName}</div>
                                      {cell.roomId&&<div style={{fontSize:isMobile?9:7,color:"#64748b",lineHeight:1.2}}>{cell.roomId}-{cell.bedNum}</div>}
                                      {tr2&&<div style={{fontSize:isMobile?9:7,color:tr2.color,fontWeight:800,lineHeight:1.1}}>{tr2.short}</div>}
                                      {cell.isPending&&<div style={{fontSize:7,color:"#f59e0b",fontWeight:700}}>예정</div>}
                                      {isConflict&&<div style={{position:"absolute",top:1,right:1,width:6,height:6,borderRadius:"50%",background:"#dc2626"}}/>}
                                      <button onClick={e=>{e.stopPropagation();doPhysRemove(r.id,dayIdx,time);}}
                                        style={{position:"absolute",bottom:1,right:1,background:"rgba(220,38,38,0.2)",border:"none",color:"#dc2626",borderRadius:2,width:11,height:11,cursor:"pointer",fontSize:7,lineHeight:"11px",textAlign:"center",padding:0}}>✕</button>
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
              });
            })()}
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
              <span style={S.mTitle}>{DAYS[modal.dayIdx]} {fmtDate(weekDates[modal.dayIdx])} {modal.time}</span>
              <button style={S.mClose} onClick={()=>setModal(null)}>✕</button>
            </div>
            <div style={{padding:16}}>
              {/* 고주파 */}
              <div style={{background:"#fef2f2",borderRadius:8,padding:"10px 12px",marginBottom:10}}>
                <label style={{...S.lbl,color:"#dc2626"}}>🔥 고주파 온열치료</label>
                <select style={S.sel} value={selHyper} onChange={e=>{setSelHyper(e.target.value);setPendH("");}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHyper==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendH} onChange={e=>setPendH(e.target.value)} placeholder="환자 이름"/>}
              </div>
              {/* 고압산소 A (정시) */}
              <div style={{background:"#f0f9ff",borderRadius:8,padding:"10px 12px",marginBottom:6}}>
                <label style={{...S.lbl,color:"#0284c7"}}>💨 고압산소 A — {modal.time}</label>
                <select style={S.sel} value={selHBa} onChange={e=>{setSelHBa(e.target.value);setPendHBa("");}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHBa==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendHBa} onChange={e=>setPendHBa(e.target.value)} placeholder="환자 이름"/>}
              </div>
              {/* 고압산소 B (+30분) */}
              <div style={{background:"#e0f2fe",borderRadius:8,padding:"10px 12px",marginBottom:10}}>
                <label style={{...S.lbl,color:"#0284c7"}}>💨 고압산소 B — {`${String(Math.floor((timeVal(modal.time))/60)).padStart(2,"0")}:${String(timeVal(modal.time)%60+30).padStart(2,"0")}`} (+30분)</label>
                <select style={S.sel} value={selHBb} onChange={e=>{setSelHBb(e.target.value);setPendHBb("");}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHBb==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendHBb} onChange={e=>setPendHBb(e.target.value)} placeholder="환자 이름"/>}
              </div>
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>다른 시간으로 등록
              </label>
              {showExtra&&<input style={{...S.inp,marginTop:6}} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800"/>}
              <div style={{display:"flex",gap:8,marginTop:14}}>
                <button style={{...S.btnOk,flex:1,background:"#dc2626"}} onClick={doHyperRegister}>저장</button>
                <button style={S.btnDel} onClick={async()=>{
                  if(!confirm("이 시간 전체 삭제?")) return;
                  await saveHyper("hyperthermia",modal.dayIdx,modal.time,null);
                  await saveHyper("hyperbaric",modal.dayIdx,modal.time,null,"a");
                  await saveHyper("hyperbaric",modal.dayIdx,modal.time,null,"b");
                  setModal(null);
                }}>전체삭제</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 인쇄 전용 */}
      {printMode&&printTab==="physical"  &&<PhysPrint  patients={physPrintPatients}  selected={printSel} weekDates={weekDates}/>}
      {printMode&&printTab==="hyper"     &&<HyperPrint patients={hyperPrintPatients} selected={printSel} weekDates={weekDates}/>}
    </div>
  );
}

function PhysPrint({patients,selected,weekDates}) {
  const list=patients.filter(p=>selected[p.slotKey]); if(!list.length) return null;
  const tName=id=>({pain:"페인스크렘블러",manip2:"도수치료2",manip1:"도수치료1"}[id]||id);
  return (
    <div className="print-only" style={{display:"none"}}>
      <style>{`@media print{@page{size:A4 portrait;margin:7mm}body *{visibility:hidden!important}.print-only,.print-only *{visibility:visible!important}.print-only{position:fixed;top:0;left:0;width:100%;background:#fff;z-index:9999;display:block!important}.pcard{break-inside:avoid;border:1.5px solid #aaa;border-radius:6px;padding:8px 10px;margin-bottom:10mm}}`}</style>
      <div style={{fontFamily:"'Noto Sans KR',sans-serif",columns:2,columnGap:"6mm",fontSize:11}}>
        {list.map(p=>{ const sorted=[...p.entries].sort((a,b)=>a.dayIdx-b.dayIdx||a.time.localeCompare(b.time)); return (
          <div key={p.slotKey} className="pcard" style={{marginBottom:"10mm"}}>
            <div style={{fontWeight:800,fontSize:13,borderBottom:"1px solid #ccc",paddingBottom:4,marginBottom:5}}>{p.name}님</div>
            <div style={{fontSize:9,color:"#666",marginBottom:4}}>물리치료 안내 {weekDates[0].getMonth()+1}/{weekDates[0].getDate()}~{weekDates[6].getMonth()+1}/{weekDates[6].getDate()}</div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{background:"#f0f0f0"}}>{["날짜","요일","치료","시간"].map(h=><th key={h} style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{h}</th>)}</tr></thead>
              <tbody>{sorted.map((e,i)=><tr key={i}><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{weekDates[e.dayIdx].getMonth()+1}/{weekDates[e.dayIdx].getDate()}</td><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{"월화수목금토일"[e.dayIdx]}</td><td style={{border:"1px solid #ddd",padding:"2px 4px"}}>{tName(e.treatmentId)}</td><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center",fontWeight:700}}>{e.time}</td></tr>)}</tbody>
            </table>
            <div style={{marginTop:6,paddingTop:5,borderTop:"1px dashed #ccc",fontSize:9,color:"#555",textAlign:"center"}}>치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.</div>
          </div>
        ); })}
      </div>
    </div>
  );
}

function HyperPrint({patients,selected,weekDates}) {
  const list=patients.filter(p=>selected[p.slotKey]); if(!list.length) return null;
  return (
    <div className="print-only" style={{display:"none"}}>
      <style>{`@media print{@page{size:A4 portrait;margin:7mm}body *{visibility:hidden!important}.print-only,.print-only *{visibility:visible!important}.print-only{position:fixed;top:0;left:0;width:100%;background:#fff;z-index:9999;display:block!important}.pcard{break-inside:avoid;border:1.5px solid #aaa;border-radius:6px;padding:8px 10px;margin-bottom:10mm}}`}</style>
      <div style={{fontFamily:"'Noto Sans KR',sans-serif",columns:2,columnGap:"6mm",fontSize:11}}>
        {list.map(p=>{ const sorted=[...p.entries].sort((a,b)=>a.dayIdx-b.dayIdx||a.time.localeCompare(b.time)); return (
          <div key={p.slotKey} className="pcard" style={{marginBottom:"10mm"}}>
            <div style={{fontWeight:800,fontSize:13,borderBottom:"1px solid #ccc",paddingBottom:4,marginBottom:5}}>{p.name}님 <span style={{fontSize:9,color:"#888"}}>{p.slotKey}</span></div>
            <div style={{fontSize:9,color:"#666",marginBottom:4}}>치료 안내 {weekDates[0].getMonth()+1}/{weekDates[0].getDate()}~{weekDates[6].getMonth()+1}/{weekDates[6].getDate()}</div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{background:"#f0f0f0"}}>{["날짜","요일","치료","시간"].map(h=><th key={h} style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{h}</th>)}</tr></thead>
              <tbody>{sorted.map((e,i)=><tr key={i}><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{weekDates[e.dayIdx].getMonth()+1}/{weekDates[e.dayIdx].getDate()}</td><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center"}}>{"월화수목금토일"[e.dayIdx]}</td><td style={{border:"1px solid #ddd",padding:"2px 4px"}}>{e.treatmentName}</td><td style={{border:"1px solid #ddd",padding:"2px 4px",textAlign:"center",fontWeight:700}}>{e.time}</td></tr>)}</tbody>
            </table>
            <div style={{marginTop:6,paddingTop:5,borderTop:"1px dashed #ccc",fontSize:9,color:"#555",textAlign:"center"}}>치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.</div>
          </div>
        ); })}
      </div>
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
  printBar:{ background:"#faf5ff", borderBottom:"1px solid #e9d5ff", padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", flexShrink:0 },
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

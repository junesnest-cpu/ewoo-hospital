import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";
import PatientSearchModal from "../components/PatientSearchModal";

const DAYS  = ["월","화","수","목","금","토","일"];
const TIMES = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const LUNCH = "12:00";

const PHYS_TREATS = [
  { id:"pain",   name:"페인",  short:"P",  color:"#dc2626", bg:"#fef2f2" },
  { id:"manip2", name:"도수2", short:"D2", color:"#7c3aed", bg:"#faf5ff" },
  { id:"manip1", name:"도수1", short:"D1", color:"#059669", bg:"#f0fdf4" },
];

const VALID_ROOMS = new Set([
  "201","202","203","204","205","206",
  "301","302","303","304","305","306",
  "501","502","503","504","505","506",
  "601","602","603",
]);

// 물리치료는 th1/th2 고정 키로 저장 (치료사 이름 변경해도 일정 유지)
const ROOMS = [
  { id:"th1",          label:"치료사1", color:"#059669", bg:"#f0fdf4", type:"physical" },
  { id:"th2",          label:"치료사2", color:"#1d4ed8", bg:"#eff6ff", type:"physical" },
  { id:"hyperthermia", label:"고주파",  color:"#dc2626", bg:"#fef2f2", type:"hyper"   },
  { id:"hyperbaric",   label:"고압산소",color:"#0284c7", bg:"#f0f9ff", type:"hyper"   },
];

function getWeekStart(d){ const x=new Date(d),dw=x.getDay(); x.setDate(x.getDate()+(dw===0?-6:1-dw)); x.setHours(0,0,0,0); return x; }
function weekKey(ws)  { return ws.toISOString().slice(0,10); }
function addDays(d,n) { const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d)   { return `${d.getMonth()+1}/${d.getDate()}`; }
function toHHMM(t)    { return t?.slice(0,5)||""; }
function timeVal(t)   { const [h,m]=(t||"00:00").split(":").map(Number); return h*60+m; }
function addMinutes(t,m){ const v=timeVal(t)+m; return `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`; }

export default function TherapyPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();
  const todayD   = new Date();

  const [weekStart,   setWeekStart]   = useState(()=>getWeekStart(todayD));
  const [physSched,   setPhysSched]   = useState({});
  const [hyperSched,  setHyperSched]  = useState({});
  const [slots,       setSlots]       = useState({});
  const [treatPlans,  setTreatPlans]  = useState({});
  const [therapists,  setTherapists]  = useState(["치료사1","치료사2"]);

  // 모달 상태
  const [modal,      setModal]     = useState(null);
  // 물리치료 모달
  const [physSlot,   setPhysSlot]  = useState("");
  const [physTreat,  setPhysTreat] = useState("");
  const [physPend,   setPhysPend]  = useState("");
  const [physMemo,   setPhysMemo]  = useState("");
  const [physOuter,  setPhysOuter] = useState(false); // 외래 여부
  const [physSearchOpen, setPhysSearchOpen] = useState(false); // 환자 DB 검색 모달
  const [physDbName,     setPhysDbName]     = useState(""); // DB 검색으로 선택한 환자 이름
  // 고주파/고압 모달
  const [selHyper,   setSelHyper]  = useState("");
  const [hyperMemo,  setHyperMemo] = useState("");
  const [hyperOuter, setHyperOuter]= useState(false);
  const [pendH,      setPendH]     = useState("");
  const [selHBa,     setSelHBa]    = useState("");
  const [pendHBa,    setPendHBa]   = useState("");
  const [selHBb,     setSelHBb]    = useState("");
  const [pendHBb,    setPendHBb]   = useState("");
  const [hyperBMemo, setHyperBMemo]= useState("");
  const [hyperSearchFor, setHyperSearchFor] = useState(null); // "hyper"|"hba"|"hbb"
  const [hyperDbNames,   setHyperDbNames]   = useState({}); // {hyper, hba, hbb} → 환자 이름
  const [extraTime,  setExtraTime] = useState("");
  const [showExtra,  setShowExtra] = useState(false);
  const [mobileDayIdx,setMobileDayIdx]=useState(()=>{ const d=new Date().getDay(); return d===0?6:d-1; });
  // 이동/복사 모드: {type:"move"|"copy", roomId, dayIdx, time, hbSlot, data}
  const [moveMode,   setMoveMode]  = useState(null);

  // 인쇄
  const [printMode, setPrintMode] = useState(false);
  const [printSel,  setPrintSel]  = useState({});
  const [printTab,  setPrintTab]  = useState("physical");

  const physRef=React.useRef({}), hyperRef=React.useRef({}), treatRef=React.useRef({});
  const weeklyPlansRef=React.useRef({});
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
    const u6=onValue(ref(db,"weeklyPlans"),         s=>{ weeklyPlansRef.current=s.val()||{}; });
    return ()=>{ u1();u2();u3();u4();u5();u6(); };
  },[]);

  // ── 셀 조회 (th1/th2 고정 키) ─────────────────────────────────────────────
  const getCell=useCallback((roomId,dayIdx,time)=>{
    const di=String(dayIdx);
    if(roomId==="th1"||roomId==="th2") return physSched[wk]?.[roomId]?.[di]?.[time]||null;
    if(roomId==="hyperbaric") return null;
    return hyperSched[wk]?.[roomId]?.[di]?.[time]||null;
  },[physSched,hyperSched,wk]);

  const getHBCell=useCallback((dayIdx,time,slot)=>
    hyperSched[wk]?.["hyperbaric"]?.[String(dayIdx)]?.[time]?.[slot]||null,
  [hyperSched,wk]);

  // ── 동적 시간 목록 ────────────────────────────────────────────────────────
  const getAllTimes=useCallback((dayIdx)=>{
    const di=String(dayIdx), s=new Set(TIMES);
    ["th1","th2"].forEach(th=>Object.keys(physSched[wk]?.[th]?.[di]||{}).forEach(t=>s.add(t)));
    ["hyperthermia","hyperbaric"].forEach(rt=>Object.keys(hyperSched[wk]?.[rt]?.[di]||{}).forEach(t=>s.add(t)));
    return Array.from(s).sort((a,b)=>timeVal(a)-timeVal(b));
  },[physSched,hyperSched,wk]);

  // ── treatmentPlan 동기화 ──────────────────────────────────────────────────
  const syncTreat=useCallback(async(slotKey,dayIdx,treatmentId,action)=>{
    if(!slotKey||slotKey.startsWith("pending_")||slotKey==="__pending__"||slotKey.startsWith("db_")) return;
    const date=addDays(weekStartRef.current,parseInt(dayIdx));
    const mKey=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey=String(date.getDate());
    const tp=JSON.parse(JSON.stringify(treatRef.current));
    if(!tp[slotKey])       tp[slotKey]={};
    if(!tp[slotKey][mKey]) tp[slotKey][mKey]={};
    const ex=tp[slotKey][mKey][dKey]||[];
    tp[slotKey][mKey][dKey]=action==="add"?ex.some(e=>e.id===treatmentId)?ex:[...ex,{id:treatmentId,qty:"1"}]:ex.filter(e=>e.id!==treatmentId);
    treatRef.current=tp; setTreatPlans(tp);
    await set(ref(db,`treatmentPlans/${slotKey}/${mKey}/${dKey}`),tp[slotKey][mKey][dKey]);

    // 주N회 계획에서 차감: 치료 추가 시 weeklyPlan의 해당 항목 count -1, 0되면 삭제
    if(action==="add"){
      const wp=weeklyPlansRef.current[slotKey];
      if(wp&&wp[treatmentId]&&wp[treatmentId].count>0){
        const newCount=wp[treatmentId].count-1;
        const newWp={...wp};
        if(newCount<=0) delete newWp[treatmentId];
        else newWp[treatmentId]={...wp[treatmentId],count:newCount};
        weeklyPlansRef.current={...weeklyPlansRef.current,[slotKey]:newWp};
        await set(ref(db,`weeklyPlans/${slotKey}`),newWp);
      }
    }
  },[]);

  // ── 물리치료 저장 (th1/th2 고정 키) ─────────────────────────────────────
  const savePhys=useCallback(async(roomId,dayIdx,time,data)=>{
    const cWk=weekKey(weekStartRef.current), di=String(dayIdx);
    const old=physRef.current[cWk]?.[roomId]?.[di]?.[time]||null;
    const nxt=JSON.parse(JSON.stringify(physRef.current));
    if(!nxt[cWk])           nxt[cWk]={};
    if(!nxt[cWk][roomId])   nxt[cWk][roomId]={};
    if(!nxt[cWk][roomId][di])nxt[cWk][roomId][di]={};
    if(data===null){ delete nxt[cWk][roomId][di][time]; if(!Object.keys(nxt[cWk][roomId][di]).length) delete nxt[cWk][roomId][di]; }
    else nxt[cWk][roomId][di][time]=data;
    physRef.current=nxt; setPhysSched(nxt);
    await set(ref(db,`physicalSchedule/${cWk}`),nxt[cWk]||{});
    if(data?.slotKey&&data?.treatmentId){
      if(old?.slotKey&&old?.treatmentId&&(old.slotKey!==data.slotKey||old.treatmentId!==data.treatmentId)) await syncTreat(old.slotKey,di,old.treatmentId,"remove");
      await syncTreat(data.slotKey,di,data.treatmentId,"add");
    } else if(data===null&&old?.slotKey&&old?.treatmentId) await syncTreat(old.slotKey,di,old.treatmentId,"remove");
  },[syncTreat]);

  // ── 고주파/고압산소 저장 (독립적으로 각각 저장) ──────────────────────────
  const saveHyper=useCallback(async(roomType,dayIdx,time,data,hbSlot)=>{
    const cWk=weekKey(weekStartRef.current), di=String(dayIdx);
    const nxt=JSON.parse(JSON.stringify(hyperRef.current));
    if(!nxt[cWk])              nxt[cWk]={};
    if(!nxt[cWk][roomType])    nxt[cWk][roomType]={};
    if(!nxt[cWk][roomType][di])nxt[cWk][roomType][di]={};
    let old=null;
    if(roomType==="hyperbaric"&&hbSlot){
      old=hyperRef.current[cWk]?.[roomType]?.[di]?.[time]?.[hbSlot]||null;
      if(!nxt[cWk][roomType][di][time]) nxt[cWk][roomType][di][time]={};
      if(data===null) delete nxt[cWk][roomType][di][time][hbSlot];
      else nxt[cWk][roomType][di][time][hbSlot]=data;
      if(!Object.keys(nxt[cWk][roomType][di][time]||{}).length) delete nxt[cWk][roomType][di][time];
    } else {
      old=hyperRef.current[cWk]?.[roomType]?.[di]?.[time]||null;
      if(data===null) delete nxt[cWk][roomType][di][time];
      else nxt[cWk][roomType][di][time]=data;
    }
    if(!Object.keys(nxt[cWk]?.[roomType]?.[di]||{}).length) delete nxt[cWk][roomType][di];
    hyperRef.current=nxt; setHyperSched(nxt);
    // 고주파와 고압산소를 별도 경로에 저장 (서로 독립)
    await set(ref(db,`hyperthermiaSchedule/${cWk}/${roomType}`),nxt[cWk]?.[roomType]||{});
    const tid=roomType==="hyperthermia"?"hyperthermia":"hyperbaric";
    if(data?.slotKey){ if(old?.slotKey&&old.slotKey!==data.slotKey) await syncTreat(old.slotKey,di,tid,"remove"); await syncTreat(data.slotKey,di,tid,"add"); }
    else if(data===null&&old?.slotKey) await syncTreat(old.slotKey,di,tid,"remove");
  },[syncTreat]);

  // ── 모달 열기 ────────────────────────────────────────────────────────────
  const openModal=(roomId,dayIdx,time)=>{
    if(roomId==="th1"||roomId==="th2"){
      const ex=getCell(roomId,dayIdx,time);
      const isPend=ex?.isPending||ex?.slotKey?.startsWith("pending_");
      setPhysSlot(isPend?"__pending__":(ex?.slotKey||""));
      setPhysTreat(ex?.treatmentId||"");
      setPhysMemo(ex?.memo||""); setPhysOuter(ex?.isOuter||false);
      setPhysPend(isPend?(ex?.patientName||"):"");
      setPhysDbName((!isPend&&ex?.slotKey?.startsWith("db_"))?(ex.patientName||""):"");
    } else {
      const exH=getCell("hyperthermia",dayIdx,time);
      const exHBa=getHBCell(dayIdx,time,"a"), exHBb=getHBCell(dayIdx,time,"b");
      const isHPend=exH?.isPending||exH?.slotKey?.startsWith("pending_");
      const isHBaPend=exHBa?.isPending||exHBa?.slotKey?.startsWith("pending_");
      const isHBbPend=exHBb?.isPending||exHBb?.slotKey?.startsWith("pending_");
      setSelHyper(isHPend?"__pending__":(exH?.slotKey||""));
      setHyperMemo(exH?.memo||""); setHyperOuter(exH?.isOuter||false);
      setPendH(isHPend?(exH?.patientName||"):"");
      setSelHBa(isHBaPend?"__pending__":(exHBa?.slotKey||""));
      setPendHBa(isHBaPend?(exHBa?.patientName||"):"");
      setSelHBb(isHBbPend?"__pending__":(exHBb?.slotKey||""));
      setPendHBb(isHBbPend?(exHBb?.patientName||"):"");
      setHyperBMemo("");
      setHyperDbNames({
        hyper: (!isHPend&&exH?.slotKey?.startsWith("db_"))?(exH.patientName||""):"",
        hba:   (!isHBaPend&&exHBa?.slotKey?.startsWith("db_"))?(exHBa.patientName||""):"",
        hbb:   (!isHBbPend&&exHBb?.slotKey?.startsWith("db_"))?(exHBb.patientName||""):"",
      });
    }
    setShowExtra(false); setExtraTime(""); setModal({roomId,dayIdx,time});
  };

  // ── 물리치료 등록 ────────────────────────────────────────────────────────
  const doPhysRegister=async()=>{
    if(!modal||!physTreat) return;
    const {roomId,dayIdx,time:base}=modal;
    const time=showExtra&&extraTime?toHHMM(extraTime):base;
    let slotKey=physSlot,name="",roomI="",bedNum="";
    if(physSlot==="__pending__"){ if(!physPend.trim()) return; slotKey=`pending_${Date.now()}`; name=physPend.trim(); }
    else if(physSlot.startsWith("db_")){ name=physDbName; }
    else { name=slots[physSlot]?.current?.name||""; roomI=physSlot.split("-")[0]; bedNum=physSlot.split("-")[1]; }
    if(!slotKey) return;
    await savePhys(roomId,dayIdx,time,{slotKey,patientName:name,treatmentId:physTreat,isPending:physSlot==="__pending__",isOuter:physOuter,memo:physMemo,roomId:roomI,bedNum});
    setModal(null);
  };

  const doPhysRemove=async(roomId,dayIdx,time)=>{
    if(!confirm("삭제하시겠습니까?")) return;
    const di=String(dayIdx), cWk=weekKey(weekStartRef.current);
    const old=physRef.current[cWk]?.[roomId]?.[di]?.[time];
    if(old?.slotKey&&old?.treatmentId) await syncTreat(old.slotKey,di,old.treatmentId,"remove");
    await savePhys(roomId,di,time,null);
  };

  // ── 이동/복사 실행 ─────────────────────────────────────────────────────────
  const doMoveOrCopy=useCallback(async(targetRoomId,targetDayIdx,targetTime)=>{
    if(!moveMode) return;
    const {type,roomId,dayIdx,time,hbSlot,data}=moveMode;
    setMoveMode(null);
    setModal(null);

    const isPhys=roomId==="th1"||roomId==="th2";
    const isHB=roomId==="hyperbaric";

    // 목적지에 이미 데이터가 있으면 경고
    let destOccupied=false;
    if(targetRoomId==="th1"||targetRoomId==="th2") destOccupied=!!getCell(targetRoomId,targetDayIdx,targetTime);
    else if(targetRoomId==="hyperbaric") destOccupied=!!getHBCell(targetDayIdx,targetTime,hbSlot||"a");
    else destOccupied=!!getCell(targetRoomId,targetDayIdx,targetTime);
    if(destOccupied&&!window.confirm("해당 칸에 이미 입력된 내용이 있습니다. 덮어쓰시겠습니까?")) return;

    // 목적지에 저장
    if(targetRoomId==="th1"||targetRoomId==="th2"){
      await savePhys(targetRoomId,targetDayIdx,targetTime,{...data});
    } else if(targetRoomId==="hyperbaric"){
      await saveHyper("hyperbaric",targetDayIdx,targetTime,{...data},hbSlot||"a");
    } else {
      await saveHyper(targetRoomId,targetDayIdx,targetTime,{...data});
    }

    // 이동이면 원본 삭제
    if(type==="move"){
      if(isPhys) await savePhys(roomId,dayIdx,time,null);
      else if(isHB) await saveHyper("hyperbaric",dayIdx,time,null,hbSlot);
      else await saveHyper(roomId,dayIdx,time,null);
    }
  },[moveMode,getCell,getHBCell,savePhys,saveHyper]);

  // ── 고주파/고압산소 등록 (변경된 항목만 저장) ───────────────────────────
  const doHyperRegister=async()=>{
    if(!modal) return;
    const {dayIdx,time:base}=modal;
    const time=showExtra&&extraTime?toHHMM(extraTime):base;

    // 고주파: selHyper가 초기값과 다를 때만 저장
    const prevH=getCell("hyperthermia",dayIdx,time);
    const prevHKey=prevH?.slotKey||"";
    if(selHyper!==prevHKey || (selHyper&&hyperMemo!==prevH?.memo) || (selHyper&&hyperOuter!==prevH?.isOuter)){
      if(selHyper==="__pending__"){ if(pendH.trim()) await saveHyper("hyperthermia",dayIdx,time,{slotKey:`pending_${Date.now()}`,patientName:pendH.trim(),memo:hyperMemo,isOuter:hyperOuter,roomId:"",bedNum:"",isPending:true}); else await saveHyper("hyperthermia",dayIdx,time,null); }
      else if(selHyper?.startsWith("db_")){ const name=hyperDbNames.hyper||""; await saveHyper("hyperthermia",dayIdx,time,{slotKey:selHyper,patientName:name,memo:hyperMemo,isOuter:hyperOuter,roomId:"",bedNum:""}); }
      else if(selHyper){ const name=slots[selHyper]?.current?.name||""; await saveHyper("hyperthermia",dayIdx,time,{slotKey:selHyper,patientName:name,memo:hyperMemo,isOuter:hyperOuter,roomId:selHyper.split("-")[0],bedNum:selHyper.split("-")[1]}); }
      else await saveHyper("hyperthermia",dayIdx,time,null);
    }

    // 고압산소 a슬롯
    const prevHBa=getHBCell(dayIdx,time,"a"); const prevHBaKey=prevHBa?.slotKey||"";
    if(selHBa!==prevHBaKey){
      if(selHBa==="__pending__"){ if(pendHBa.trim()) await saveHyper("hyperbaric",dayIdx,time,{slotKey:`pending_${Date.now()}a`,patientName:pendHBa.trim(),roomId:"",bedNum:"",isPending:true,subTime:time},"a"); else await saveHyper("hyperbaric",dayIdx,time,null,"a"); }
      else if(selHBa?.startsWith("db_")){ const name=hyperDbNames.hba||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBa,patientName:name,roomId:"",bedNum:"",subTime:time},"a"); }
      else if(selHBa){ const name=slots[selHBa]?.current?.name||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBa,patientName:name,roomId:selHBa.split("-")[0],bedNum:selHBa.split("-")[1],subTime:time},"a"); }
      else await saveHyper("hyperbaric",dayIdx,time,null,"a");
    }

    // 고압산소 b슬롯 (+30분)
    const timeB=addMinutes(time,30);
    const prevHBb=getHBCell(dayIdx,time,"b"); const prevHBbKey=prevHBb?.slotKey||"";
    if(selHBb!==prevHBbKey){
      if(selHBb==="__pending__"){ if(pendHBb.trim()) await saveHyper("hyperbaric",dayIdx,time,{slotKey:`pending_${Date.now()}b`,patientName:pendHBb.trim(),roomId:"",bedNum:"",isPending:true,subTime:timeB},"b"); else await saveHyper("hyperbaric",dayIdx,time,null,"b"); }
      else if(selHBb?.startsWith("db_")){ const name=hyperDbNames.hbb||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBb,patientName:name,roomId:"",bedNum:"",subTime:timeB},"b"); }
      else if(selHBb){ const name=slots[selHBb]?.current?.name||""; await saveHyper("hyperbaric",dayIdx,time,{slotKey:selHBb,patientName:name,roomId:selHBb.split("-")[0],bedNum:selHBb.split("-")[1],subTime:timeB},"b"); }
      else await saveHyper("hyperbaric",dayIdx,time,null,"b");
    }

    setModal(null);
  };

  // ── db_ 환자 → 현재 입원 병실 역매핑 (patientId → slotKey) ────────────────
  const patientToSlot=Object.entries(slots).reduce((acc,[sk,sd])=>{
    if(sd?.current?.patientId) acc[sd.current.patientId]=sk;
    return acc;
  },{});

  // db_ 슬롯키에서 현재 병실 정보를 동적으로 가져오는 헬퍼
  const getRoomFromCell=(cell)=>{
    if(!cell?.slotKey?.startsWith("db_")) return {roomId:cell?.roomId||"",bedNum:cell?.bedNum||""};
    const internalId=cell.slotKey.slice(3);
    const currentSlot=patientToSlot[internalId];
    if(!currentSlot) return {roomId:"",bedNum:""};
    const [r,b]=currentSlot.split("-");
    return {roomId:r||"",bedNum:b||""};
  };

  // ── 환자 목록 ─────────────────────────────────────────────────────────────
  const allPatients=Object.entries(slots)
    .filter(([sk,sd])=>{ if(!sd?.current?.name) return false; return VALID_ROOMS.has(sk.split("-")[0]); })
    .map(([sk,sd])=>({slotKey:sk,name:sd.current.name}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||"","ko"));

  // 물리치료 환자 목록: 치료계획 연동(즐겨찾기) 제거 → 가나다순 전체 입원환자
  const physModalPatients=Object.entries(slots)
    .filter(([sk,sd])=>sd?.current?.name&&VALID_ROOMS.has(sk.split("-")[0]))
    .map(([sk,sd])=>({slotKey:sk,name:sd.current.name}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||"","ko"));

  // ── 충돌 감지 ─────────────────────────────────────────────────────────────
  const getConflicts=useCallback((dayIdx,time)=>{
    const seen=new Set(), dups=new Set();
    ["th1","th2"].forEach(r=>{ const c=getCell(r,dayIdx,time); if(c?.slotKey&&!c.isPending){ if(seen.has(c.slotKey)) dups.add(c.slotKey); else seen.add(c.slotKey); } });
    const ht=getCell("hyperthermia",dayIdx,time); if(ht?.slotKey&&!ht.isPending){ if(seen.has(ht.slotKey)) dups.add(ht.slotKey); else seen.add(ht.slotKey); }
    ["a","b"].forEach(s=>{ const c=getHBCell(dayIdx,time,s); if(c?.slotKey&&!c.isPending){ if(seen.has(c.slotKey)) dups.add(c.slotKey); else seen.add(c.slotKey); } });
    return dups;
  },[getCell,getHBCell]);

  // ── 인쇄용 데이터 (예정 환자 포함) ──────────────────────────────────────
  const physPrintPatients=(()=>{
    const map={};
    ["th1","th2"].forEach(rid=>{ Object.entries(physSched[wk]?.[rid]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,data])=>{ if(!data?.slotKey) return; const k=data.slotKey.startsWith("pending_")||data.slotKey==="__pending__"?`__ph_${rid}_${di}_${time}`:data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,isOuter:data.isOuter,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time,treatmentId:data.treatmentId,memo:data.memo||"",therapistId:rid}); }); }); });
    return Object.values(map).sort((a,b)=>(a.name||"").localeCompare(b.name||"","ko"));
  })();

  const hyperPrintPatients=(()=>{
    const map={};
    // __pending__은 저장위치(type_di_time_slot)를 고유키로 사용
    Object.entries(hyperSched[wk]?.["hyperthermia"]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,data])=>{ if(!data?.slotKey) return; const k=data.slotKey.startsWith("pending_")||data.slotKey==="__pending__"?`__ht_${di}_${time}`:data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,isOuter:data.isOuter,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time,treatmentName:"고주파 온열치료",memo:data.memo||""}); }); });
    Object.entries(hyperSched[wk]?.["hyperbaric"]||{}).forEach(([di,times])=>{ Object.entries(times||{}).forEach(([time,hbSlots])=>{ ["a","b"].forEach(s=>{ const data=hbSlots?.[s]; if(!data?.slotKey) return; const k=data.slotKey.startsWith("pending_")||data.slotKey==="__pending__"?`__hb_${di}_${time}_${s}`:data.slotKey; if(!map[k]) map[k]={name:data.patientName,slotKey:k,entries:[]}; map[k].entries.push({dayIdx:parseInt(di),time:data.subTime||time,treatmentName:"고압산소치료",memo:""}); }); }); });
    return Object.values(map).sort((a,b)=>(a.name||"").localeCompare(b.name||"","ko"));
  })();

  const curPrintPatients=printTab==="physical"?physPrintPatients:hyperPrintPatients;
  const modalRoom=modal?ROOMS.find(r=>r.id===modal.roomId):null;
  const isPhysModal=modalRoom?.type==="physical";
  // 데스크탑: 월~금 기본, 토~일 스크롤
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
          <button style={{...S.btnW,background:printMode?"#7c3aed":"rgba(255,255,255,0.15)"}}
            onClick={()=>{setPrintMode(p=>!p);setPrintSel({});}}>
            {printMode?"✕ 취소":"🖨 인쇄"}
          </button>
        </div>
      </header>

      {/* 범례 */}
      <div style={S.legend}>
        {ROOMS.map(r=>(
          <span key={r.id} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,fontWeight:700}}>
            <span style={{width:11,height:11,borderRadius:3,background:r.color,display:"inline-block"}}/>
            {r.id==="th1"?therapists[0]:r.id==="th2"?therapists[1]:r.label}
          </span>
        ))}
        <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,color:"#dc2626",fontWeight:700,marginLeft:8}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#dc2626",display:"inline-block"}}/>겹침
        </span>
        <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,color:"#d97706",fontWeight:700}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#d97706",display:"inline-block"}}/>외래
        </span>
      </div>

      {/* 인쇄 선택 바 */}
      {printMode&&(
        <div style={{...S.printBar,flexDirection:"column",gap:8,alignItems:"stretch"}}>
          {/* 1행: 탭 + 전체선택/해제 + 인쇄 버튼 */}
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:0,borderRadius:7,overflow:"hidden",border:"1px solid #e9d5ff",flexShrink:0}}>
              <button style={{padding:"6px 16px",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",background:printTab==="physical"?"#059669":"#f8fafc",color:printTab==="physical"?"#fff":"#475569"}}
                onClick={()=>{setPrintTab("physical");setPrintSel({});}}>🏃 물리치료</button>
              <button style={{padding:"6px 16px",fontSize:12,fontWeight:700,border:"none",cursor:"pointer",background:printTab==="hyper"?"#dc2626":"#f8fafc",color:printTab==="hyper"?"#fff":"#475569"}}
                onClick={()=>{setPrintTab("hyper");setPrintSel({});}}>⚡ 고주파/고압</button>
            </div>
            {/* 전체선택 / 전체해제 */}
            <button style={{background:"#e0f2fe",color:"#0369a1",border:"1px solid #7dd3fc",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:12,fontWeight:700}}
              onClick={()=>{
                const valid=curPrintPatients.filter(p=>p.name&&p.name.trim());
                const allSel=valid.every(p=>printSel[p.slotKey]);
                const next={};
                if(!allSel) valid.forEach(p=>{next[p.slotKey]=true;});
                setPrintSel(next);
              }}>
              {curPrintPatients.filter(p=>p.name&&p.name.trim()).every(p=>printSel[p.slotKey])?"☑ 전체해제":"☐ 전체선택"}
            </button>
            {/* 물리치료 탭일 때 치료사별 선택 버튼 */}
            {printTab==="physical"&&therapists.map((th,idx)=>{
              const rid=idx===0?"th1":"th2";
              const thPatients=physPrintPatients.filter(p=>p.name&&p.name.trim()&&p.entries.some(e=>e.therapistId===rid));
              if(!thPatients.length) return null;
              const allSel=thPatients.every(p=>printSel[p.slotKey]);
              return (
                <button key={rid}
                  style={{background:rid==="th1"?"#dcfce7":"#eff6ff",
                    color:rid==="th1"?"#166534":"#1e40af",
                    border:`1px solid ${rid==="th1"?"#86efac":"#93c5fd"}`,
                    borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:12,fontWeight:700}}
                  onClick={()=>{
                    const next={...printSel};
                    thPatients.forEach(p=>{next[p.slotKey]=!allSel;});
                    setPrintSel(next);
                  }}>
                  {allSel?"✓":"○"} {th}
                </button>
              );
            })}
            <div style={{flex:1}}/>
            <button style={{background:"#7c3aed",color:"#fff",border:"none",borderRadius:8,padding:"6px 18px",cursor:"pointer",fontSize:13,fontWeight:700,flexShrink:0}}
              onClick={()=>window.print()}>
              🖨 {Object.values(printSel).filter(Boolean).length}명 인쇄
            </button>
          </div>
          {/* 2행: 환자 체크박스 목록 */}
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {(()=>{
              const valid=curPrintPatients.filter(p=>p.name&&p.name.trim());
              // 물리치료: 치료사별 그룹으로 표시
              if(printTab==="physical"){
                return therapists.map((th,idx)=>{
                  const rid=idx===0?"th1":"th2";
                  const grpPatients=valid.filter(p=>p.entries.some(e=>e.therapistId===rid));
                  if(!grpPatients.length) return null;
                  return (
                    <div key={rid} style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap",
                      background:rid==="th1"?"#f0fdf4":"#eff6ff",
                      borderRadius:7,padding:"4px 8px",border:`1px solid ${rid==="th1"?"#86efac":"#93c5fd"}`}}>
                      <span style={{fontSize:11,fontWeight:800,color:rid==="th1"?"#166534":"#1e40af",marginRight:4,whiteSpace:"nowrap"}}>{th}</span>
                      {grpPatients.map(p=>(
                        <label key={p.slotKey} style={{display:"flex",alignItems:"center",fontSize:12,cursor:"pointer",
                          background:printSel[p.slotKey]?"#fff":"rgba(255,255,255,0.6)",
                          border:printSel[p.slotKey]?"1.5px solid #7c3aed":"1px solid #e2e8f0",
                          borderRadius:5,padding:"2px 8px",gap:3}}>
                          <input type="checkbox" checked={!!printSel[p.slotKey]}
                            onChange={e=>setPrintSel(prev=>({...prev,[p.slotKey]:e.target.checked}))}/>
                          {p.name}{p.isOuter&&<span style={{fontSize:10,color:"#d97706",fontWeight:700}}>(외)</span>}
                        </label>
                      ))}
                    </div>
                  );
                });
              }
              // 고주파/고압: 단순 목록
              return valid.map(p=>(
                <label key={p.slotKey} style={{display:"flex",alignItems:"center",fontSize:12,cursor:"pointer",
                  background:printSel[p.slotKey]?"#fff":"rgba(255,255,255,0.6)",
                  border:printSel[p.slotKey]?"1.5px solid #7c3aed":"1px solid #e9d5ff",
                  borderRadius:5,padding:"2px 8px",gap:3}}>
                  <input type="checkbox" checked={!!printSel[p.slotKey]}
                    onChange={e=>setPrintSel(prev=>({...prev,[p.slotKey]:e.target.checked}))}/>
                  {p.name}{p.isOuter&&<span style={{fontSize:10,color:"#d97706",fontWeight:700}}>(외)</span>}
                </label>
              ));
            })()}
          </div>
        </div>
      )}

      {/* 이동/복사 모드 배너 */}
      {moveMode&&(
        <div style={{background:moveMode.type==="move"?"#0f2744":"#6d28d9",color:"#fff",padding:"10px 16px",
          display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,
          boxShadow:"0 2px 8px rgba(0,0,0,0.2)",zIndex:10}}>
          <div style={{fontSize:13,fontWeight:700}}>
            {moveMode.type==="move"?"✂️ 이동":"📋 복사"} 모드 —
            <span style={{color:"#fbbf24",marginLeft:6}}>{moveMode.data?.patientName}님</span>
            <span style={{fontSize:11,opacity:0.8,marginLeft:6}}>
              ({DAYS[moveMode.dayIdx]} {moveMode.time} → 목적지 칸을 클릭하세요)
            </span>
          </div>
          <button onClick={()=>setMoveMode(null)}
            style={{background:"rgba(255,255,255,0.2)",border:"none",color:"#fff",borderRadius:6,
              padding:"4px 12px",cursor:"pointer",fontSize:12,fontWeight:700}}>취소</button>
        </div>
      )}

      {/* 모바일 요일 탭 */}
      {isMobile&&(
        <div style={{display:"flex",background:"#fff",borderBottom:"1px solid #e2e8f0",flexShrink:0}}>
          {DAYS.map((day,di)=>{
            const date=weekDates[di]; const isWe=di>=5; const isSel=mobileDayIdx===di;
            const allT=getAllTimes(di);
            const has=allT.some(t=>["th1","th2"].some(r=>getCell(r,di,t))||getCell("hyperthermia",di,t)||getHBCell(di,t,"a")||getHBCell(di,t,"b"));
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
            <col style={{width:50}}/>
            {dayCols.map(di=><col key={di} style={{minWidth:isMobile?340:190}}/>)}
          </colgroup>
          <thead>
            <tr>
              <th style={S.thTime} rowSpan={2}>시간</th>
              {dayCols.map(di=>{
                const date=weekDates[di]; const isWe=di>=5;
                const isToday=isThisWeek&&new Date().getDay()===(di===6?0:di+1);
                return (
                  <th key={di} style={{...S.thDay,background:isToday?"#fef3c7":isWe?"#dbeafe":"#f1f5f9",color:isToday?"#92400e":isWe?"#1d4ed8":"#0f2744",padding:"7px 4px",borderLeft:"2px solid #94a3b8"}}>
                    <div style={{fontSize:14,fontWeight:800}}>{DAYS[di]}</div>
                    <div style={{fontSize:12,color:isToday?"#b45309":isWe?"#3b82f6":"#64748b"}}>{date?fmtDate(date):""}</div>
                  </th>
                );
              })}
            </tr>
            <tr>
              {dayCols.map(di=>(
                <th key={di} style={{padding:"5px 4px",background:"#fff",borderBottom:"2px solid #e2e8f0",borderLeft:"2px solid #94a3b8"}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3}}>
                    {ROOMS.map(r=>(
                      <div key={r.id} style={{background:r.color,color:"#fff",borderRadius:4,padding:"5px 0",
                        fontSize:isMobile?13:12,fontWeight:800,textAlign:"center",lineHeight:1.4}}>
                        {r.id==="th1"?therapists[0]:r.id==="th2"?therapists[1]:r.label}
                      </div>
                    ))}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(()=>{
              const allTimesUnion=isMobile?getAllTimes(mobileDayIdx):(()=>{
                const s=new Set(TIMES);
                Array.from({length:7},(_,di)=>getAllTimes(di)).forEach(ts=>ts.forEach(t=>s.add(t)));
                return Array.from(s).sort((a,b)=>timeVal(a)-timeVal(b));
              })();

              // 점심시간은 해당 주에 데이터가 하나라도 있을 때만 표시
              const lunchHasData=(()=>{
                for(let di=0;di<7;di++){
                  const dis=String(di);
                  if(physSched[wk]?.th1?.[dis]?.[LUNCH]||physSched[wk]?.th2?.[dis]?.[LUNCH]) return true;
                  if(hyperSched[wk]?.hyperthermia?.[dis]?.[LUNCH]||hyperSched[wk]?.hyperbaric?.[dis]?.[LUNCH]) return true;
                }
                return false;
              })();

              return allTimesUnion.map(time=>{
                const isLunch=time===LUNCH;
                if(isLunch&&!lunchHasData) return null;
                const isCustom=!TIMES.includes(time);
                return (
                  <tr key={time} style={{borderBottom:"1px solid #e2e8f0"}}>
                    <td style={{...S.tdTime,background:isLunch?"#f8fafc":isCustom?"#fefce8":"#fff",
                      color:isLunch?"#94a3b8":isCustom?"#854d0e":"#0f2744",
                      height:isLunch?24:64}}>
                      <div style={{fontWeight:800,fontSize:12}}>{toHHMM(time)}</div>
                      {isLunch&&<div style={{fontSize:8,color:"#94a3b8"}}>점심</div>}
                      {isCustom&&<div style={{fontSize:8,color:"#d97706"}}>추가</div>}
                    </td>
                    {dayCols.map(dayIdx=>{
                      if(isLunch) return <td key={dayIdx} style={{background:"#f8fafc",textAlign:"center",color:"#cbd5e1",fontSize:12}}>—</td>;
                      const conflicts=getConflicts(dayIdx,time);
                      return (
                        <td key={dayIdx} style={{padding:"3px 4px",verticalAlign:"top",background:isCustom?"#fefce8":"#fff",borderLeft:"2px solid #cbd5e1"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:3,height:90}}>
                            {ROOMS.map(r=>{
                              // ── 고압산소 칸: A(정시)/B(+30분) ────────────────
                              if(r.id==="hyperbaric"){
                                const ca=getHBCell(dayIdx,time,"a"), cb=getHBCell(dayIdx,time,"b");
                                const icA=ca&&!ca.isPending&&conflicts.has(ca.slotKey);
                                const icB=cb&&!cb.isPending&&conflicts.has(cb.slotKey);
                                return (
                                  <div key={r.id}
                                    onClick={()=>{
                                      if(moveMode){ doMoveOrCopy("hyperbaric",dayIdx,time); return; }
                                      openModal(r.id,dayIdx,time);
                                    }}
                                    style={{background:moveMode?"#e0f2fe":r.bg,
                                      borderRadius:5,cursor:moveMode?"crosshair":"pointer",padding:"2px",
                                      border:moveMode?"2px dashed #f59e0b":`1px solid ${r.color}33`,
                                      display:"flex",flexDirection:"column",gap:2,
                                      overflow:"hidden",boxSizing:"border-box"}}>
                                    {/* A슬롯 정시 */}
                                    <div style={{flex:1,borderRadius:3,padding:"2px 3px",
                                      background:ca?"#bae6fd":"#f0f9ff",
                                      border:icA?"1.5px solid #dc2626":"1px solid #7dd3fc",
                                      display:"flex",flexDirection:"column",justifyContent:"center",position:"relative",minHeight:24}}>
                                      {ca?(()=>{const {roomId:caR,bedNum:caB}=getRoomFromCell(ca);const caNL=(ca.patientName||"").length;return(
                                        <>
                                          <div style={{fontSize:isMobile?13:11,fontWeight:800,color:"#1e293b",lineHeight:1.3,overflow:"hidden",whiteSpace:"nowrap",textOverflow:caNL>5?"ellipsis":"clip"}}>
                                            {ca.patientName}
                                          </div>
                                          {ca.isOuter
                                            ?<div style={{fontSize:8,fontWeight:700}}><span style={{background:"#fef3c7",color:"#d97706",borderRadius:3,padding:"0 3px"}}>외래</span></div>
                                            :caR?<div style={{fontSize:isMobile?11:10,color:"#0369a1",fontWeight:600,lineHeight:1.2}}>{caR}-{caB}</div>:null}
                                          <div style={{display:"flex",gap:3,flexWrap:"wrap",marginTop:1}}>
                                            {ca.isPending&&<span style={{fontSize:8,color:"#f59e0b",fontWeight:700,background:"#fff7ed",borderRadius:3,padding:"0 3px"}}>예정</span>}
                                          </div>
                                          <button onClick={e=>{e.stopPropagation();if(!confirm("삭제?"))return;saveHyper("hyperbaric",dayIdx,time,null,"a");}}
                                            style={{position:"absolute",top:0,right:0,background:"rgba(220,38,38,0.2)",border:"none",color:"#dc2626",borderRadius:2,width:12,height:12,cursor:"pointer",fontSize:8,lineHeight:"12px",textAlign:"center",padding:0}}>✕</button>
                                        </>
                                      );})():<div style={{color:"#7dd3fc",fontSize:11,textAlign:"center",fontWeight:700}}>A+</div>}
                                    </div>
                                    {/* B슬롯 +30분 */}
                                    <div style={{flex:1,borderRadius:3,padding:"2px 3px",
                                      background:cb?"#e0f2fe":"#f0f9ff",
                                      border:icB?"1.5px solid #dc2626":"1px solid #7dd3fc",
                                      display:"flex",flexDirection:"column",justifyContent:"center",position:"relative",minHeight:24}}>
                                      {cb?(()=>{const {roomId:cbR,bedNum:cbB}=getRoomFromCell(cb);const cbNL=(cb.patientName||"").length;return(
                                        <>
                                          <div style={{fontSize:isMobile?13:11,fontWeight:800,color:"#1e293b",lineHeight:1.3,overflow:"hidden",whiteSpace:"nowrap",textOverflow:cbNL>5?"ellipsis":"clip"}}>
                                            {cb.patientName}
                                          </div>
                                          {cb.isOuter
                                            ?<div style={{fontSize:8,fontWeight:700}}><span style={{background:"#fef3c7",color:"#d97706",borderRadius:3,padding:"0 3px"}}>외래</span></div>
                                            :cbR?<div style={{fontSize:isMobile?11:10,color:"#0369a1",fontWeight:600,lineHeight:1.2}}>{cbR}-{cbB}</div>:null}
                                          <div style={{display:"flex",gap:3,flexWrap:"wrap",marginTop:1}}>
                                            {cb.isPending&&<span style={{fontSize:8,color:"#f59e0b",fontWeight:700,background:"#fff7ed",borderRadius:3,padding:"0 3px"}}>예정</span>}
                                          </div>
                                          <button onClick={e=>{e.stopPropagation();if(!confirm("삭제?"))return;saveHyper("hyperbaric",dayIdx,time,null,"b");}}
                                            style={{position:"absolute",top:0,right:0,background:"rgba(220,38,38,0.2)",border:"none",color:"#dc2626",borderRadius:2,width:12,height:12,cursor:"pointer",fontSize:8,lineHeight:"12px",textAlign:"center",padding:0}}>✕</button>
                                        </>
                                      );})():<div style={{color:"#7dd3fc",fontSize:11,textAlign:"center",fontWeight:700}}>B+</div>}
                                    </div>
                                  </div>
                                );
                              }

                              // ── 물리치료 / 고주파 칸 ────────────────────────
                              const cell=getCell(r.id,dayIdx,time);
                              const isConflict=cell&&!cell.isPending&&conflicts.has(cell.slotKey);
                              const tr2=cell?PHYS_TREATS.find(t=>t.id===cell.treatmentId):null;
                              const bg=cell?(tr2?tr2.bg:r.bg):"#f8fafc";
                              const col=cell?(tr2?tr2.color:r.color):"#d1d5db";
                              return (
                                <div key={r.id}
                                  onClick={()=>{
                                    if(moveMode){ doMoveOrCopy(r.id,dayIdx,time); return; }
                                    openModal(r.id,dayIdx,time);
                                  }}
                                  style={{background:moveMode?(moveMode.roomId===r.id&&moveMode.dayIdx===dayIdx&&moveMode.time===time?"#fef3c7":"#fff7ed"):bg,
                                    borderRadius:5,cursor:moveMode?"crosshair":"pointer",padding:"5px 6px",
                                    border:moveMode?"2px dashed #f59e0b":isConflict?"2px solid #dc2626":`1px solid ${col}44`,
                                    display:"flex",flexDirection:"column",justifyContent:"center",
                                    position:"relative",overflow:"hidden",boxSizing:"border-box"}}>
                                  {cell?(()=>{
                                    const {roomId:cRoomId,bedNum:cBedNum}=getRoomFromCell(cell);
                                    const nameLen=(cell.patientName||"").length;
                                    return (
                                    <>
                                      <div style={{fontSize:isMobile?14:13,fontWeight:800,color:"#1e293b",lineHeight:1.4,overflow:"hidden",whiteSpace:"nowrap",textOverflow:nameLen>5?"ellipsis":"clip"}}>
                                        {cell.patientName}
                                      </div>
                                      {cell.isOuter
                                        ?<div style={{fontSize:isMobile?11:10,lineHeight:1.2,fontWeight:700}}><span style={{background:"#fef3c7",color:"#d97706",borderRadius:3,padding:"0 3px",fontSize:isMobile?10:9}}>외래</span></div>
                                        :cRoomId?<div style={{fontSize:isMobile?12:11,color:"#64748b",lineHeight:1.2,fontWeight:600}}>{cRoomId}-{cBedNum}</div>:null}
                                      {tr2&&<div style={{fontSize:isMobile?12:11,color:tr2.color,fontWeight:800,lineHeight:1.3}}>{tr2.short}</div>}
                                      {cell.memo&&<div style={{fontSize:isMobile?10:9,color:"#475569",lineHeight:1.3,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",maxWidth:"100%",marginTop:1}}>💬 {cell.memo}</div>}
                                      {cell.isPending&&<div style={{fontSize:8,color:"#f59e0b",fontWeight:700}}>예정</div>}
                                      {isConflict&&<div style={{position:"absolute",top:2,right:2,width:7,height:7,borderRadius:"50%",background:"#dc2626"}}/>}
                                      <button onClick={e=>{e.stopPropagation();r.id==="hyperthermia"?(!confirm("삭제하시겠습니까?")||saveHyper("hyperthermia",dayIdx,time,null)):doPhysRemove(r.id,dayIdx,time);}}
                                        style={{position:"absolute",bottom:1,right:1,background:"rgba(220,38,38,0.15)",border:"none",color:"#dc2626",borderRadius:2,width:13,height:13,cursor:"pointer",fontSize:8,lineHeight:"13px",textAlign:"center",padding:0}}>✕</button>
                                    </>
                                    );
                                  })():(
                                    <div style={{color:"#d1d5db",fontSize:20,textAlign:"center",userSelect:"none",lineHeight:1}}>+</div>
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
              <select style={S.sel} value={physSlot.startsWith("db_")?"":physSlot} onChange={e=>{setPhysSlot(e.target.value);setPhysTreat("");setPhysPend("");setPhysDbName("");}}>
                <option value="">— 선택 —</option>
                <option value="__pending__">✏️ 예정 환자 (이름 직접 입력)</option>
                {physModalPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
              </select>
              {physSlot==="__pending__"&&<input style={{...S.inp,marginTop:8}} value={physPend} onChange={e=>setPhysPend(e.target.value)} placeholder="환자 이름 입력"/>}
              {physSlot.startsWith("db_")&&(
                <div style={{marginTop:6,padding:"6px 10px",background:"#f0f9ff",borderRadius:7,border:"1px solid #7dd3fc",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontWeight:700,fontSize:14,color:"#0369a1"}}>👤 {physDbName}</span>
                  <button onClick={()=>{setPhysSlot("");setPhysDbName("");}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:14,lineHeight:1}}>✕</button>
                </div>
              )}
              <button onClick={()=>setPhysSearchOpen(true)} style={{marginTop:6,width:"100%",background:"#f8fafc",border:"1.5px solid #cbd5e1",borderRadius:7,padding:"7px 0",cursor:"pointer",fontSize:12,fontWeight:700,color:"#475569"}}>
                🔍 기존 환자 검색 (DB)
              </button>
              {/* placeholder to avoid duplicate closing brace */}
              {false&&null}

              <label style={S.lbl} className="mt-3">치료 종류</label>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
                {PHYS_TREATS.map(t=>(
                  <button key={t.id} onClick={()=>setPhysTreat(t.id)}
                    style={{border:`1.5px solid ${t.color}`,borderRadius:7,padding:"6px 14px",cursor:"pointer",fontSize:13,fontWeight:700,
                      background:physTreat===t.id?t.color:t.bg,color:physTreat===t.id?"#fff":t.color}}>
                    {t.name}
                  </button>
                ))}
              </div>

              <label style={{...S.lbl,marginTop:12}}>메모 (선택)</label>
              <input style={S.inp} value={physMemo} onChange={e=>setPhysMemo(e.target.value)} placeholder="치료 관련 메모"/>

              <div style={{display:"flex",alignItems:"center",gap:16,marginTop:10}}>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",fontWeight:600}}>
                  <input type="checkbox" checked={physOuter} onChange={e=>setPhysOuter(e.target.checked)}/>
                  <span style={{color:"#d97706"}}>🏥 외래 환자</span>
                </label>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}>
                  <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>다른 시간으로 등록
                </label>
              </div>
              {showExtra&&<input style={{...S.inp,marginTop:6}} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800"/>}

              <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
                <button style={{...S.btnOk,flex:1,background:modalRoom.color}} onClick={doPhysRegister}
                  disabled={!physSlot||(physSlot==="__pending__"&&!physPend.trim())||!physTreat}>등록</button>
                {getCell(modal.roomId,modal.dayIdx,modal.time)&&(<>
                  <button style={{...S.btnOk,background:"#0f2744"}} onClick={()=>{
                    const d=getCell(modal.roomId,modal.dayIdx,modal.time);
                    setMoveMode({type:"move",roomId:modal.roomId,dayIdx:modal.dayIdx,time:modal.time,data:d});
                    setModal(null);
                  }}>✂️ 이동</button>
                  <button style={{...S.btnOk,background:"#7c3aed"}} onClick={()=>{
                    const d=getCell(modal.roomId,modal.dayIdx,modal.time);
                    setMoveMode({type:"copy",roomId:modal.roomId,dayIdx:modal.dayIdx,time:modal.time,data:d});
                    setModal(null);
                  }}>📋 복사</button>
                  <button style={S.btnDel} onClick={()=>{doPhysRemove(modal.roomId,modal.dayIdx,modal.time);setModal(null);}}>삭제</button>
                </>)}
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
              <div style={{background:"#fef2f2",borderRadius:8,padding:"10px 12px",marginBottom:10,border:"1px solid #fca5a5"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#dc2626",marginBottom:6}}>🔥 고주파 온열치료</div>
                <select style={S.sel} value={selHyper?.startsWith("db_")?"":selHyper} onChange={e=>{setSelHyper(e.target.value);setPendH("");setHyperDbNames(p=>({...p,hyper:""}));}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHyper==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendH} onChange={e=>setPendH(e.target.value)} placeholder="환자 이름"/>}
                {selHyper?.startsWith("db_")&&(
                  <div style={{marginTop:6,padding:"5px 10px",background:"#fff7ed",borderRadius:7,border:"1px solid #fed7aa",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#9a3412"}}>👤 {hyperDbNames.hyper}</span>
                    <button onClick={()=>{setSelHyper("");setHyperDbNames(p=>({...p,hyper:""}));}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:13}}>✕</button>
                  </div>
                )}
                <button onClick={()=>setHyperSearchFor("hyper")} style={{marginTop:4,width:"100%",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:6,padding:"5px 0",cursor:"pointer",fontSize:11,fontWeight:700,color:"#9a3412"}}>🔍 기존 환자 검색</button>
                {selHyper&&<>
                  <input style={{...S.inp,marginTop:6}} value={hyperMemo} onChange={e=>setHyperMemo(e.target.value)} placeholder="메모 (선택)"/>
                  <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer",marginTop:6}}>
                    <input type="checkbox" checked={hyperOuter} onChange={e=>setHyperOuter(e.target.checked)}/>
                    <span style={{color:"#d97706",fontWeight:600}}>외래 환자</span>
                  </label>
                </>}
              </div>
              {/* 고압산소 A */}
              <div style={{background:"#f0f9ff",borderRadius:8,padding:"10px 12px",marginBottom:6,border:"1px solid #7dd3fc"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#0284c7",marginBottom:6}}>💨 고압산소 A — {modal.time} (정시)</div>
                <select style={S.sel} value={selHBa?.startsWith("db_")?"":selHBa} onChange={e=>{setSelHBa(e.target.value);setPendHBa("");setHyperDbNames(p=>({...p,hba:""}));}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHBa==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendHBa} onChange={e=>setPendHBa(e.target.value)} placeholder="환자 이름"/>}
                {selHBa?.startsWith("db_")&&(
                  <div style={{marginTop:6,padding:"5px 10px",background:"#f0f9ff",borderRadius:7,border:"1px solid #7dd3fc",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#075985"}}>👤 {hyperDbNames.hba}</span>
                    <button onClick={()=>{setSelHBa("");setHyperDbNames(p=>({...p,hba:""}));}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:13}}>✕</button>
                  </div>
                )}
                <button onClick={()=>setHyperSearchFor("hba")} style={{marginTop:4,width:"100%",background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:6,padding:"5px 0",cursor:"pointer",fontSize:11,fontWeight:700,color:"#075985"}}>🔍 기존 환자 검색</button>
              </div>
              {/* 고압산소 B */}
              <div style={{background:"#e0f2fe",borderRadius:8,padding:"10px 12px",marginBottom:10,border:"1px solid #7dd3fc"}}>
                <div style={{fontSize:13,fontWeight:800,color:"#0284c7",marginBottom:6}}>💨 고압산소 B — {addMinutes(modal.time,30)} (+30분)</div>
                <select style={S.sel} value={selHBb?.startsWith("db_")?"":selHBb} onChange={e=>{setSelHBb(e.target.value);setPendHBb("");setHyperDbNames(p=>({...p,hbb:""}));}}>
                  <option value="">— 없음 —</option><option value="__pending__">✏️ 예정 환자</option>
                  {allPatients.map(p=><option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>)}
                </select>
                {selHBb==="__pending__"&&<input style={{...S.inp,marginTop:6}} value={pendHBb} onChange={e=>setPendHBb(e.target.value)} placeholder="환자 이름"/>}
                {selHBb?.startsWith("db_")&&(
                  <div style={{marginTop:6,padding:"5px 10px",background:"#e0f2fe",borderRadius:7,border:"1px solid #7dd3fc",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <span style={{fontWeight:700,fontSize:13,color:"#075985"}}>👤 {hyperDbNames.hbb}</span>
                    <button onClick={()=>{setSelHBb("");setHyperDbNames(p=>({...p,hbb:""}));}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:13}}>✕</button>
                  </div>
                )}
                <button onClick={()=>setHyperSearchFor("hbb")} style={{marginTop:4,width:"100%",background:"#e0f2fe",border:"1px solid #bae6fd",borderRadius:6,padding:"5px 0",cursor:"pointer",fontSize:11,fontWeight:700,color:"#075985"}}>🔍 기존 환자 검색</button>
              </div>

              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer"}}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>다른 시간으로 등록
              </label>
              {showExtra&&<input style={{...S.inp,marginTop:6}} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800"/>}

              {/* 고주파 이동/복사 */}
              {getCell("hyperthermia",modal.dayIdx,modal.time)&&(
                <div style={{display:"flex",gap:6,marginTop:6,marginBottom:4}}>
                  <span style={{fontSize:11,color:"#64748b",alignSelf:"center"}}>고주파:</span>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#0f2744"}} onClick={()=>{
                    const d=getCell("hyperthermia",modal.dayIdx,modal.time);
                    setMoveMode({type:"move",roomId:"hyperthermia",dayIdx:modal.dayIdx,time:modal.time,data:d});
                    setModal(null);
                  }}>✂️ 이동</button>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#7c3aed"}} onClick={()=>{
                    const d=getCell("hyperthermia",modal.dayIdx,modal.time);
                    setMoveMode({type:"copy",roomId:"hyperthermia",dayIdx:modal.dayIdx,time:modal.time,data:d});
                    setModal(null);
                  }}>📋 복사</button>
                </div>
              )}
              {/* 고압산소 A 이동/복사 */}
              {getHBCell(modal.dayIdx,modal.time,"a")&&(
                <div style={{display:"flex",gap:6,marginTop:4,marginBottom:4}}>
                  <span style={{fontSize:11,color:"#64748b",alignSelf:"center"}}>고압A:</span>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#0f2744"}} onClick={()=>{
                    const d=getHBCell(modal.dayIdx,modal.time,"a");
                    setMoveMode({type:"move",roomId:"hyperbaric",dayIdx:modal.dayIdx,time:modal.time,hbSlot:"a",data:d});
                    setModal(null);
                  }}>✂️ 이동</button>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#7c3aed"}} onClick={()=>{
                    const d=getHBCell(modal.dayIdx,modal.time,"a");
                    setMoveMode({type:"copy",roomId:"hyperbaric",dayIdx:modal.dayIdx,time:modal.time,hbSlot:"a",data:d});
                    setModal(null);
                  }}>📋 복사</button>
                </div>
              )}
              {/* 고압산소 B 이동/복사 */}
              {getHBCell(modal.dayIdx,modal.time,"b")&&(
                <div style={{display:"flex",gap:6,marginTop:4,marginBottom:8}}>
                  <span style={{fontSize:11,color:"#64748b",alignSelf:"center"}}>고압B:</span>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#0f2744"}} onClick={()=>{
                    const d=getHBCell(modal.dayIdx,modal.time,"b");
                    setMoveMode({type:"move",roomId:"hyperbaric",dayIdx:modal.dayIdx,time:modal.time,hbSlot:"b",data:d});
                    setModal(null);
                  }}>✂️ 이동</button>
                  <button style={{...S.btnOk,padding:"4px 10px",fontSize:11,background:"#7c3aed"}} onClick={()=>{
                    const d=getHBCell(modal.dayIdx,modal.time,"b");
                    setMoveMode({type:"copy",roomId:"hyperbaric",dayIdx:modal.dayIdx,time:modal.time,hbSlot:"b",data:d});
                    setModal(null);
                  }}>📋 복사</button>
                </div>
              )}
              <div style={{display:"flex",gap:8,marginTop:4}}>
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
      {printMode&&printTab==="physical"&&<PhysPrint patients={physPrintPatients} selected={printSel} weekDates={weekDates} therapists={therapists}/>}
      {printMode&&printTab==="hyper"   &&<HyperPrint patients={hyperPrintPatients} selected={printSel} weekDates={weekDates}/>}

      {/* 물리치료 환자 DB 검색 */}
      {physSearchOpen&&(
        <PatientSearchModal
          onClose={()=>setPhysSearchOpen(false)}
          onSelect={(patient)=>{
            setPhysSlot(`db_${patient.internalId}`);
            setPhysDbName(patient.name);
            setPhysSearchOpen(false);
          }}
        />
      )}

      {/* 고주파/고압 환자 DB 검색 */}
      {hyperSearchFor&&(
        <PatientSearchModal
          onClose={()=>setHyperSearchFor(null)}
          onSelect={(patient)=>{
            const key=`db_${patient.internalId}`;
            if(hyperSearchFor==="hyper"){ setSelHyper(key); setHyperDbNames(p=>({...p,hyper:patient.name})); }
            else if(hyperSearchFor==="hba"){ setSelHBa(key); setHyperDbNames(p=>({...p,hba:patient.name})); }
            else if(hyperSearchFor==="hbb"){ setSelHBb(key); setHyperDbNames(p=>({...p,hbb:patient.name})); }
            setHyperSearchFor(null);
          }}
        />
      )}
    </div>
  );
}

// ── 공통 인쇄 CSS (한 번만 선언) ──────────────────────────────────────────────
const PRINT_CSS=`@media print{
  @page{size:A4 portrait;margin:10mm}
  html,body{height:auto!important;overflow:visible!important}
  body *{visibility:hidden!important;height:auto!important}
  .therapy-print-area,.therapy-print-area *{visibility:visible!important}
  .therapy-print-area{
    position:absolute;top:0;left:0;width:100%;
    background:#fff;z-index:9999;display:block!important;
    box-sizing:border-box;
  }
  .print-col-wrap{
    columns:2;column-gap:5mm;column-fill:balance;
    orphans:1;widows:1;
  }
  .pcard{break-inside:avoid;border:1.5px solid #bbb;border-radius:6px;padding:8px 10px;margin-bottom:4mm;display:inline-block;width:100%}
  .no-print{display:none!important}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
@media screen{.therapy-print-area{display:none!important}}`;

// ── 물리치료 인쇄 ──────────────────────────────────────────────────────────────
function PhysPrint({patients,selected,weekDates,therapists}){
  // 이름 있는 환자만 (이름 없는 예정 제외)
  const list=patients.filter(p=>selected[p.slotKey]&&p.name&&p.name.trim()); if(!list.length) return null;
  const tName=id=>({pain:"페인스크렘블러",manip2:"도수치료2",manip1:"도수치료1"}[id]||id);
  const thName=id=>id==="th1"?therapists[0]:therapists[1];
  return (
    <div className="therapy-print-area" style={{display:"none"}}>
      <style>{PRINT_CSS}</style>
      <div className="print-col-wrap" style={{fontFamily:"'Noto Sans KR',sans-serif"}}>
        {list.map(p=>{ const sorted=[...p.entries].sort((a,b)=>a.dayIdx-b.dayIdx||a.time.localeCompare(b.time)); return (
          <div key={p.slotKey} className="pcard">
            <div style={{fontWeight:900,fontSize:32,borderBottom:"2px solid #ccc",paddingBottom:6,marginBottom:8,display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
              <span>{p.name}님</span>
              {p.isOuter&&<span style={{fontSize:22,color:"#d97706"}}>(외래)</span>}
              {p.slotKey&&!p.slotKey.startsWith("__")&&!p.slotKey.startsWith("pending_")&&!p.slotKey.startsWith("db_")&&(
                <span style={{fontSize:24,fontWeight:700,color:"#64748b"}}>
                  {p.slotKey.split("-")[0]} - {p.slotKey.split("-")[1]}
                </span>
              )}
            </div>
            <div style={{fontSize:22,color:"#555",marginBottom:6}}>물리치료 안내 · {weekDates[0].getMonth()+1}/{weekDates[0].getDate()}~{weekDates[6].getMonth()+1}/{weekDates[6].getDate()}</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:24}}>
              <thead><tr style={{background:"#f0f0f0"}}>{["날짜","요일","치료","담당","시간"].map(h=><th key={h} style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{h}</th>)}</tr></thead>
              <tbody>{sorted.map((e,i)=><tr key={i}>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{weekDates[e.dayIdx].getMonth()+1}/{weekDates[e.dayIdx].getDate()}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{"월화수목금토일"[e.dayIdx]}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px"}}>{tName(e.treatmentId)}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{thName(e.therapistId)}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center",fontWeight:700}}>{e.time.slice(0,5)}</td>
              </tr>)}</tbody>
            </table>
            <div style={{marginTop:8,paddingTop:6,borderTop:"1px dashed #ccc",fontSize:20,color:"#666",textAlign:"center"}}>치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.</div>
          </div>
        );})}
      </div>
    </div>
  );
}

// ── 고주파/고압 인쇄 ───────────────────────────────────────────────────────────
function HyperPrint({patients,selected,weekDates}){
  // 이름 있는 환자만 (이름 없는 예정 제외)
  const list=patients.filter(p=>selected[p.slotKey]&&p.name&&p.name.trim()); if(!list.length) return null;
  return (
    <div className="therapy-print-area" style={{display:"none"}}>
      <style>{PRINT_CSS}</style>
      <div className="print-col-wrap" style={{fontFamily:"'Noto Sans KR',sans-serif"}}>
        {list.map(p=>{ const sorted=[...p.entries].sort((a,b)=>a.dayIdx-b.dayIdx||a.time.localeCompare(b.time)); return (
          <div key={p.slotKey} className="pcard">
            <div style={{fontWeight:900,fontSize:32,borderBottom:"2px solid #ccc",paddingBottom:6,marginBottom:8,display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
              <span>{p.name}님</span>
              {p.isOuter&&<span style={{fontSize:22,color:"#d97706"}}>(외래)</span>}
              {p.slotKey&&!p.slotKey.startsWith("__")&&!p.slotKey.startsWith("pending_")&&!p.slotKey.startsWith("db_")&&(
                <span style={{fontSize:24,fontWeight:700,color:"#64748b"}}>
                  {p.slotKey.split("-")[0]} - {p.slotKey.split("-")[1]}
                </span>
              )}
            </div>
            <div style={{fontSize:22,color:"#555",marginBottom:6}}>치료 안내 · {weekDates[0].getMonth()+1}/{weekDates[0].getDate()}~{weekDates[6].getMonth()+1}/{weekDates[6].getDate()}</div>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:24}}>
              <thead><tr style={{background:"#f0f0f0"}}>{["날짜","요일","치료","시간"].map(h=><th key={h} style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{h}</th>)}</tr></thead>
              <tbody>{sorted.map((e,i)=><tr key={i}>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{weekDates[e.dayIdx].getMonth()+1}/{weekDates[e.dayIdx].getDate()}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center"}}>{"월화수목금토일"[e.dayIdx]}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px"}}>{e.treatmentName}</td>
                <td style={{border:"1px solid #ddd",padding:"4px 8px",textAlign:"center",fontWeight:700}}>{e.time.slice(0,5)}</td>
              </tr>)}</tbody>
            </table>
            <div style={{marginTop:8,paddingTop:6,borderTop:"1px dashed #ccc",fontSize:20,color:"#666",textAlign:"center"}}>치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.</div>
          </div>
        );})}
      </div>
    </div>
  );
}

const S={
  page:    {fontFamily:"'Noto Sans KR','Pretendard',sans-serif",background:"#f0f4f8",minHeight:"100vh",display:"flex",flexDirection:"column"},
  header:  {background:"#0f2744",color:"#fff",display:"flex",alignItems:"center",gap:12,padding:"10px 16px",boxShadow:"0 2px 8px rgba(0,0,0,0.15)",flexShrink:0,flexWrap:"wrap"},
  btnBack: {background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",borderRadius:7,padding:"5px 12px",cursor:"pointer",fontSize:12,fontWeight:600},
  hcenter: {flex:1,textAlign:"center"},
  htitle:  {fontSize:16,fontWeight:800},
  hsub:    {fontSize:10,color:"#94a3b8",marginTop:1},
  hright:  {display:"flex",gap:6,flexWrap:"wrap"},
  btnW:    {background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,fontWeight:600},
  legend:  {background:"#fff",borderBottom:"1px solid #e2e8f0",padding:"7px 16px",display:"flex",gap:14,alignItems:"center",flexShrink:0,flexWrap:"wrap"},
  printBar:{background:"#faf5ff",borderBottom:"1px solid #e9d5ff",padding:"8px 16px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",flexShrink:0},
  tableWrap:{flex:1,overflowX:"auto",overflowY:"auto"},
  tbl:     {width:"100%",borderCollapse:"collapse",tableLayout:"fixed"},
  thTime:  {background:"#0f2744",color:"#fff",fontSize:11,fontWeight:700,textAlign:"center",border:"1px solid #1e3a5f",padding:"4px 2px",verticalAlign:"middle",width:54},
  thDay:   {fontSize:12,fontWeight:800,textAlign:"center",border:"1px solid #e2e8f0",padding:"5px 2px"},
  tdTime:  {fontSize:12,fontWeight:700,textAlign:"center",border:"1px solid #e2e8f0",padding:"2px",whiteSpace:"nowrap",verticalAlign:"middle",width:54},
  overlay: {position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16},
  modal:   {background:"#fff",borderRadius:12,width:"100%",maxWidth:460,boxShadow:"0 8px 40px rgba(0,0,0,0.2)",overflow:"hidden",maxHeight:"92vh",overflowY:"auto"},
  mHead:   {color:"#fff",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px"},
  mTitle:  {fontSize:13,fontWeight:800},
  mClose:  {background:"none",border:"none",color:"rgba(255,255,255,0.7)",fontSize:18,cursor:"pointer"},
  lbl:     {display:"block",fontSize:12,fontWeight:700,color:"#64748b",marginBottom:4,marginTop:10},
  inp:     {width:"100%",border:"1.5px solid #e2e8f0",borderRadius:7,padding:"8px 10px",fontSize:13,outline:"none",boxSizing:"border-box",fontFamily:"inherit"},
  sel:     {width:"100%",border:"1.5px solid #e2e8f0",borderRadius:7,padding:"8px 10px",fontSize:13,outline:"none",fontFamily:"inherit"},
  btnOk:   {background:"#059669",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",cursor:"pointer",fontSize:13,fontWeight:700},
  btnDel:  {background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:8,padding:"9px 14px",cursor:"pointer",fontSize:13,fontWeight:700},
};

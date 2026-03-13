import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

const DAYS  = ["월","화","수","목","금","토","일"];
const TIMES = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const LUNCH = "12:00";

// 두 치료를 같은 슬롯에 각각 독립 관리
const ROOM_TYPES = [
  { id:"hyperthermia", name:"고주파 온열치료", color:"#dc2626", bg:"#fef2f2", linked:true },
  { id:"hyperbaric",   name:"고압산소치료",    color:"#0ea5e9", bg:"#f0f9ff", linked:false },
];

function getWeekStart(d) {
  const date = new Date(d);
  const dow  = date.getDay();
  date.setDate(date.getDate() + (dow === 0 ? -6 : 1 - dow));
  date.setHours(0,0,0,0);
  return date;
}
function weekKey(ws)  { return ws.toISOString().slice(0,10); }
function addDays(d,n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d)   { return `${d.getMonth()+1}/${d.getDate()}`; }

export default function HyperthermiaPage() {
  const router = useRouter();
  const today  = new Date();

  const [weekStart,    setWeekStart]    = useState(() => getWeekStart(today));
  const [schedule,     setSchedule]     = useState({});
  const [slots,        setSlots]        = useState({});
  const [treatPlans,   setTreatPlans]   = useState({});
  const [operatorName, setOperatorName] = useState("운용기사");
  const scheduleRef   = React.useRef({});
  const treatPlansRef = React.useRef({});

  // 모달: 클릭한 셀 (dayIdx, time) — 두 치료 동시 편집
  const [modal,     setModal]     = useState(null);
  const [selHyper,  setSelHyper]  = useState("");   // 고주파 환자 slotKey
  const [selHyperB, setSelHyperB] = useState("");   // 고압산소 환자 slotKey
  const [showExtra, setShowExtra] = useState(false);
  const [extraTime, setExtraTime] = useState("");

  // 인쇄
  const [printMode, setPrintMode] = useState(false);
  const [printSel,  setPrintSel]  = useState({});

  const wk        = weekKey(weekStart);
  const weekStartRef = React.useRef(weekStart);
  React.useEffect(() => { weekStartRef.current = weekStart; }, [weekStart]);
  const weekDates = Array.from({length:7}, (_,i) => addDays(weekStart, i));

  useEffect(() => {
    const u1 = onValue(ref(db,"slots"),                 s => setSlots(s.val()||{}));
    const u2 = onValue(ref(db,"treatmentPlans"), s => {
      const v = s.val()||{};
      setTreatPlans(v);
      treatPlansRef.current = v;
    });
    const u3 = onValue(ref(db,"hyperthermiaSchedule"), s => {
      const v = s.val()||{};
      setSchedule(v);
      scheduleRef.current = v;
    });
    const u4 = onValue(ref(db,"settings"), s => {
      const v = s.val()||{};
      if (v.hyperOperator) setOperatorName(v.hyperOperator);
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  // 셀 데이터: schedule[wk][roomType][dayIdx][time]
  const getCell = useCallback((roomType, dayIdx, time) =>
    schedule[wk]?.[roomType]?.[dayIdx]?.[time] || null,
  [schedule, wk]);

  const saveCell = useCallback(async (roomType, dayIdx, time, data) => {
    const currentWk = weekKey(weekStartRef.current);

    // 1. 삭제 전 기존 셀 저장
    const oldCell = scheduleRef.current[currentWk]?.[roomType]?.[dayIdx]?.[time] || null;

    // 2. hyperthermiaSchedule 업데이트
    const nxt = JSON.parse(JSON.stringify(scheduleRef.current));
    if (!nxt[currentWk])                        nxt[currentWk]={};
    if (!nxt[currentWk][roomType])              nxt[currentWk][roomType]={};
    if (!nxt[currentWk][roomType][dayIdx])      nxt[currentWk][roomType][dayIdx]={};
    if (data===null) delete nxt[currentWk][roomType][dayIdx][time];
    else             nxt[currentWk][roomType][dayIdx][time]=data;
    scheduleRef.current = nxt;
    setSchedule(nxt);
    await set(ref(db,`hyperthermiaSchedule/${currentWk}`), nxt[currentWk]||{});

    // 3. treatmentPlans 역방향 연동
    // roomType별 치료 ID 매핑
    const treatId = roomType === "hyperthermia" ? "hyperthermia" : "hyperbaric";

    if (data?.slotKey) {
      // 기존에 다른 환자가 있었다면 제거
      if (oldCell?.slotKey && oldCell.slotKey !== data.slotKey) {
        await syncToTreatmentPlan(oldCell.slotKey, dayIdx, treatId, "remove");
      }
      await syncToTreatmentPlan(data.slotKey, dayIdx, treatId, "add");
    } else if (data === null && oldCell?.slotKey) {
      await syncToTreatmentPlan(oldCell.slotKey, dayIdx, treatId, "remove");
    }
  }, []);

  const syncToTreatmentPlan = useCallback(async (slotKey, dayIdx, treatmentId, action) => {
    const date = addDays(weekStartRef.current, dayIdx);
    const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey = String(date.getDate());
    const tp   = JSON.parse(JSON.stringify(treatPlansRef.current));
    if (!tp[slotKey])       tp[slotKey] = {};
    if (!tp[slotKey][mKey]) tp[slotKey][mKey] = {};
    const existing = tp[slotKey][mKey][dKey] || [];
    if (action === "add") {
      if (!existing.some(e => e.id === treatmentId)) {
        tp[slotKey][mKey][dKey] = [...existing, { id: treatmentId, qty: "1" }];
      }
    } else {
      tp[slotKey][mKey][dKey] = existing.filter(e => e.id !== treatmentId);
    }
    treatPlansRef.current = tp;
    setTreatPlans(tp);
    await set(ref(db, `treatmentPlans/${slotKey}/${mKey}/${dKey}`), tp[slotKey][mKey][dKey]);
  }, []);

  // 모달 열기 — 두 치료 현재값 로드
  const openModal = (dayIdx, time) => {
    const exH  = getCell("hyperthermia", dayIdx, time);
    const exHB = getCell("hyperbaric",   dayIdx, time);
    setModal({ dayIdx, time });
    setSelHyper(exH?.slotKey   || "");
    setSelHyperB(exHB?.slotKey || "");
    setShowExtra(false);
    setExtraTime("");
  };

  // 저장
  const doRegister = async () => {
    if (!modal) return;
    const { dayIdx, time: base } = modal;
    const time = showExtra && extraTime ? extraTime : base;

    // 고주파
    if (selHyper) {
      const name = slots[selHyper]?.current?.name || "";
      const room = selHyper.split("-")[0];
      const bed  = selHyper.split("-")[1];
      await saveCell("hyperthermia", dayIdx, time, { slotKey:selHyper, patientName:name, roomId:room, bedNum:bed });
    } else {
      await saveCell("hyperthermia", dayIdx, time, null);
    }
    // 고압산소
    if (selHyperB) {
      const name = slots[selHyperB]?.current?.name || "";
      const room = selHyperB.split("-")[0];
      const bed  = selHyperB.split("-")[1];
      await saveCell("hyperbaric", dayIdx, time, { slotKey:selHyperB, patientName:name, roomId:room, bedNum:bed });
    } else {
      await saveCell("hyperbaric", dayIdx, time, null);
    }
    setModal(null);
  };

  const doRemoveAll = async (dayIdx, time) => {
    if (!confirm("이 시간의 모든 예약을 삭제하시겠습니까?")) return;
    await saveCell("hyperthermia", dayIdx, time, null);
    await saveCell("hyperbaric",   dayIdx, time, null);
  };

  // 대기 환자 (고주파 치료계획 연동)
  const pendingPatients = (() => {
    const res = [];
    weekDates.forEach((date, dayIdx) => {
      const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
      const dKey = String(date.getDate());
      Object.entries(treatPlans).forEach(([slotKey, months]) => {
        const items = months?.[mKey]?.[dKey]||[];
        if (!items.some(e => e.id==="hyperthermia")) return;
        const name = slots[slotKey]?.current?.name;
        if (!name) return;
        const assigned = Object.values(schedule[wk]?.["hyperthermia"]?.[dayIdx]||{}).some(c=>c.slotKey===slotKey);
        if (!assigned) res.push({ slotKey, name, dayIdx });
      });
    });
    return res;
  })();

  // 전체 입원 환자 목록 (모달용)
  const allPatients = Object.entries(slots)
    .filter(([,sd]) => sd?.current?.name)
    .map(([slotKey, sd]) => ({
      slotKey,
      name: sd.current.name,
      roomId: slotKey.split("-")[0],
      bedNum: slotKey.split("-")[1],
    }))
    .sort((a,b) => a.slotKey.localeCompare(b.slotKey));

  // 인쇄용 환자 목록
  const printPatients = (() => {
    const map = {};
    ROOM_TYPES.forEach(rt => {
      Object.entries(schedule[wk]?.[rt.id]||{}).forEach(([di, times]) => {
        Object.entries(times||{}).forEach(([time, data]) => {
          if (!data?.slotKey) return;
          const k = data.slotKey;
          if (!map[k]) map[k] = { name:data.patientName, slotKey:k, roomId:data.roomId, bedNum:data.bedNum, entries:[] };
          map[k].entries.push({ dayIdx:parseInt(di), time, treatmentId:rt.id, treatmentName:rt.name });
        });
      });
    });
    return Object.values(map).sort((a,b)=>a.name?.localeCompare(b.name,"ko"));
  })();

  const isThisWeek = weekKey(getWeekStart(today)) === wk;

  return (
    <div style={S.page}>
      <header style={S.header}>
        <button style={S.btnBack} onClick={()=>router.push("/")}>← 현황판</button>
        <div style={S.hcenter}>
          <div style={S.htitle}>⚡ 고주파치료실 주간 계획표</div>
          <div style={S.hsub}>{fmtDate(weekDates[0])} ~ {fmtDate(weekDates[6])} &nbsp;|&nbsp; {operatorName}</div>
        </div>
        <div style={S.hright}>
          <button style={S.btnW} onClick={()=>setWeekStart(w=>addDays(w,-7))}>‹ 전주</button>
          {!isThisWeek && <button style={{...S.btnW, background:"#065f46", color:"#6ee7b7"}} onClick={()=>setWeekStart(getWeekStart(today))}>이번 주</button>}
          <button style={S.btnW} onClick={()=>setWeekStart(w=>addDays(w,7))}>다음 주 ›</button>
          <button style={S.btnW} onClick={()=>router.push("/settings")}>⚙️ 설정</button>
          <button style={{...S.btnW, background:printMode?"#7c3aed":"rgba(255,255,255,0.15)"}}
            onClick={()=>{ setPrintMode(p=>!p); setPrintSel({}); }}>
            {printMode?"✕ 취소":"🖨 인쇄"}
          </button>
        </div>
      </header>

      {/* 인쇄 선택 바 */}
      {printMode && (
        <div style={S.printBar}>
          <span style={{fontSize:13, fontWeight:700, color:"#7c3aed"}}>인쇄할 환자 선택</span>
          <div style={{display:"flex", gap:8, flex:1, flexWrap:"wrap"}}>
            {printPatients.map(p=>(
              <label key={p.slotKey} style={S.pCheck}>
                <input type="checkbox" checked={!!printSel[p.slotKey]}
                  onChange={e=>setPrintSel(prev=>({...prev,[p.slotKey]:e.target.checked}))}/>
                <span style={{marginLeft:5}}>{p.name}님</span>
              </label>
            ))}
          </div>
          <button style={S.btnOk} onClick={()=>window.print()}>선택 인쇄</button>
        </div>
      )}

      <div style={S.body}>
        {/* 대기 사이드바 */}
        <div style={S.sidebar}>
          <div style={S.sbTitle}>📋 배정 대기</div>
          <div style={{fontSize:10, color:"#94a3b8", marginBottom:6}}>고주파 치료계획 연동</div>
          {pendingPatients.length===0
            ? <div style={{color:"#94a3b8", fontSize:11}}>없음</div>
            : pendingPatients.map((p,i)=>(
                <div key={i} style={S.pendCard}>
                  <div style={{fontWeight:700, fontSize:12}}>{p.name}</div>
                  <div style={{fontSize:10, color:"#64748b"}}>{DAYS[p.dayIdx]}</div>
                  <span style={{fontSize:9, color:"#dc2626"}}>고주파 온열</span>
                </div>
              ))
          }
        </div>

        {/* 시간표 — 두 치료 나란히 */}
        <div style={S.tableArea}>
          <table style={S.tbl}>
            <colgroup>
              <col style={{width:52}}/>
              {weekDates.map((_,i)=><col key={`a${i}`}/>)}
              <col style={{width:6}}/>
              {weekDates.map((_,i)=><col key={`b${i}`}/>)}
            </colgroup>
            <thead>
              <tr>
                <th style={S.thTime} rowSpan={2}>시간</th>
                <th colSpan={7} style={{...S.thTh, background:"#991b1b"}}>⚡ 고주파 온열치료</th>
                <th rowSpan={2} style={S.thDiv}/>
                <th colSpan={7} style={{...S.thTh, background:"#0c4a6e"}}>🫧 고압산소치료</th>
              </tr>
              <tr>
                {[0,1].map(ti=>
                  weekDates.map((date,di)=>(
                    <th key={`${ti}-${di}`} style={{...S.thDay, color:di>=5?"#2563eb":"#374151", background:di>=5?"#eff6ff":"#f8fafc"}}>
                      <div style={{fontSize:11}}>{DAYS[di]}</div>
                      <div style={{fontSize:9, color:"#94a3b8", fontWeight:400}}>{fmtDate(date)}</div>
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {TIMES.map(time=>{
                const isLunch = time===LUNCH;
                return (
                  <tr key={time} style={{height:isLunch?26:54}}>
                    <td style={{...S.tdTime, color:isLunch?"#94a3b8":"#0f2744", background:isLunch?"#f8fafc":"#fff"}}>
                      {time}
                      {isLunch && <span style={{fontSize:8, display:"block", color:"#94a3b8"}}>점심</span>}
                    </td>
                    {ROOM_TYPES.map((rt, ti)=>(
                      <React.Fragment key={rt.id}>
                        {ti===1 && <td style={S.tdDiv}/>}
                        {weekDates.map((_,dayIdx)=>{
                          if (isLunch) return <td key={`${ti}-${dayIdx}`} style={S.tdLunch}>—</td>;
                          const cell = getCell(rt.id, dayIdx, time);
                          return (
                            <td key={`${ti}-${dayIdx}`}
                              style={{...S.tdCell, background:cell?rt.bg:"#fff"}}
                              onClick={()=>openModal(dayIdx, time)}>
                              {cell ? (
                                <div style={{...S.cellIn, position:"relative"}}>
                                  <div style={{fontWeight:700, fontSize:11, color:rt.color, lineHeight:1.2}}>
                                    {cell.patientName}
                                  </div>
                                  <div style={{fontSize:9, color:"#64748b"}}>
                                    {cell.roomId}호 {cell.bedNum}번
                                  </div>
                                  <button style={S.xBtn}
                                    onClick={e=>{ e.stopPropagation(); saveCell(rt.id, dayIdx, time, null); }}>✕</button>
                                </div>
                              ):(
                                <div style={S.plusCell}>+</div>
                              )}
                            </td>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 등록 모달 — 두 치료 동시 */}
      {modal && (
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={S.mHead}>
              <span style={S.mTitle}>
                {DAYS[modal.dayIdx]} {fmtDate(weekDates[modal.dayIdx])} {modal.time}
              </span>
              <button style={S.mClose} onClick={()=>setModal(null)}>✕</button>
            </div>
            <div style={{padding:16}}>
              {/* 고주파 온열 */}
              <div style={S.treatSection}>
                <div style={{...S.treatLabel, color:"#dc2626"}}>⚡ 고주파 온열치료</div>
                <select style={{...S.sel, borderColor:"#fca5a5"}} value={selHyper} onChange={e=>setSelHyper(e.target.value)}>
                  <option value="">— 없음 —</option>
                  {allPatients.map(p=>(
                    <option key={p.slotKey} value={p.slotKey}>
                      {p.name} ({p.roomId}호 {p.bedNum}번)
                    </option>
                  ))}
                </select>
              </div>

              {/* 고압산소 */}
              <div style={{...S.treatSection, marginTop:14}}>
                <div style={{...S.treatLabel, color:"#0ea5e9"}}>🫧 고압산소치료</div>
                <select style={{...S.sel, borderColor:"#7dd3fc"}} value={selHyperB} onChange={e=>setSelHyperB(e.target.value)}>
                  <option value="">— 없음 —</option>
                  {allPatients.map(p=>(
                    <option key={p.slotKey} value={p.slotKey}>
                      {p.name} ({p.roomId}호 {p.bedNum}번)
                    </option>
                  ))}
                </select>
              </div>

              <label style={{display:"flex", alignItems:"center", gap:6, marginTop:14, fontSize:13, cursor:"pointer"}}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)}/>
                다른 시간으로 등록
              </label>
              {showExtra && (
                <input style={{...S.inp, marginTop:6}} type="time" value={extraTime}
                  onChange={e=>setExtraTime(e.target.value)} step="1800"/>
              )}

              <div style={{display:"flex", gap:8, marginTop:16}}>
                <button style={{...S.btnOk, flex:1}} onClick={doRegister}>저장</button>
                {(getCell("hyperthermia",modal.dayIdx,modal.time)||getCell("hyperbaric",modal.dayIdx,modal.time)) && (
                  <button style={S.btnDel} onClick={()=>{ doRemoveAll(modal.dayIdx,modal.time); setModal(null); }}>삭제</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 인쇄 전용 */}
      <HyperPrintCards patients={printPatients} selected={printSel} weekDates={weekDates}/>
    </div>
  );
}

function HyperPrintCards({ patients, selected, weekDates }) {
  const list = patients.filter(p=>selected[p.slotKey]);
  if (!list.length) return null;
  return (
    <div className="print-only" style={{display:"none"}}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 7mm; }
          body * { visibility: hidden !important; }
          .print-only, .print-only * { visibility: visible !important; }
          .print-only { position:fixed; top:0; left:0; width:100%; background:#fff; z-index:9999; display:block !important; }
          .pcard { break-inside:avoid; border:1.5px solid #aaa; border-radius:6px; padding:8px 10px; margin-bottom:10mm; }
        }
      `}</style>
      <div style={{fontFamily:"'Noto Sans KR',sans-serif", columns:2, columnGap:"6mm", fontSize:11}}>
        {list.map(p=>{
          const sorted=[...p.entries].sort((a,b)=>a.dayIdx-b.dayIdx||a.time.localeCompare(b.time));
          return (
            <div key={p.slotKey} className="pcard">
              <div style={{fontWeight:800, fontSize:13, borderBottom:"1px solid #ccc", paddingBottom:4, marginBottom:5}}>
                {p.name}님
                <span style={{fontSize:10, color:"#555", fontWeight:400, marginLeft:6}}>
                  {p.roomId}호 {p.bedNum}번 병상
                </span>
              </div>
              <div style={{fontSize:9, color:"#666", marginBottom:4}}>
                치료 안내 &nbsp;{fmtDate(weekDates[0])} ~ {fmtDate(weekDates[6])}
              </div>
              <table style={{width:"100%", borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:"#f0f0f0"}}>
                    {["날짜","요일","치료","시간"].map(h=>(
                      <th key={h} style={{border:"1px solid #ddd", padding:"2px 4px", textAlign:"center"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e,i)=>(
                    <tr key={i}>
                      <td style={{border:"1px solid #ddd", padding:"2px 4px", textAlign:"center"}}>{fmtDate(weekDates[e.dayIdx])}</td>
                      <td style={{border:"1px solid #ddd", padding:"2px 4px", textAlign:"center"}}>{"월화수목금토일"[e.dayIdx]}</td>
                      <td style={{border:"1px solid #ddd", padding:"2px 4px"}}>{e.treatmentName}</td>
                      <td style={{border:"1px solid #ddd", padding:"2px 4px", textAlign:"center", fontWeight:700}}>{e.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{marginTop:6, paddingTop:5, borderTop:"1px dashed #ccc", fontSize:9, color:"#555", textAlign:"center"}}>
                치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


const S = {
  page:    {fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", display:"flex", flexDirection:"column"},
  header:  {background:"#dc2626", color:"#fff", display:"flex", alignItems:"center", gap:12, padding:"10px 16px", boxShadow:"0 2px 8px rgba(0,0,0,0.15)", flexShrink:0, flexWrap:"wrap"},
  btnBack: {background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600},
  hcenter: {flex:1, textAlign:"center"},
  htitle:  {fontSize:16, fontWeight:800},
  hsub:    {fontSize:10, color:"#fca5a5", marginTop:1},
  hright:  {display:"flex", gap:6, flexWrap:"wrap"},
  btnW:    {background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:11, fontWeight:600},
  printBar:{background:"#faf5ff", borderBottom:"1px solid #e9d5ff", padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap", flexShrink:0},
  pCheck:  {display:"flex", alignItems:"center", fontSize:12, cursor:"pointer", background:"#fff", border:"1px solid #e9d5ff", borderRadius:6, padding:"2px 8px"},
  body:    {display:"flex", flex:1, overflow:"hidden"},
  sidebar: {width:155, flexShrink:0, background:"#fff", borderRight:"1px solid #e2e8f0", padding:"10px", overflowY:"auto"},
  sbTitle: {fontSize:12, fontWeight:800, color:"#dc2626", marginBottom:6},
  pendCard:{background:"#fef2f2", border:"1px solid #fecaca", borderRadius:7, padding:"7px", marginBottom:5},
  tableArea:{flex:1, overflowX:"auto", overflowY:"auto"},
  tbl:     {width:"100%", borderCollapse:"collapse", tableLayout:"fixed", minWidth:900},
  thTime:  {background:"#0f2744", color:"#fff", fontSize:10, fontWeight:700, textAlign:"center", border:"1px solid #1e3a5f", padding:"4px 2px", verticalAlign:"middle"},
  thTh:    {color:"#fff", fontSize:12, fontWeight:800, textAlign:"center", padding:"6px 4px", border:"1px solid rgba(255,255,255,0.2)"},
  thDiv:   {background:"#cbd5e1", border:"none", width:6},
  thDay:   {fontSize:10, fontWeight:700, textAlign:"center", border:"1px solid #e2e8f0", padding:"3px 2px"},
  tdTime:  {fontSize:10, fontWeight:700, textAlign:"center", border:"1px solid #e2e8f0", padding:"2px", whiteSpace:"nowrap", verticalAlign:"middle"},
  tdLunch: {background:"#f8fafc", border:"1px solid #e2e8f0", textAlign:"center", color:"#cbd5e1", fontSize:11},
  tdDiv:   {background:"#e2e8f0", border:"none", width:6},
  tdCell:  {border:"1px solid #e2e8f0", cursor:"pointer", verticalAlign:"top", transition:"background 0.12s"},
  cellIn:  {padding:"3px 5px", minHeight:40},
  plusCell:{color:"#e2e8f0", fontSize:18, textAlign:"center", padding:"6px 0", userSelect:"none"},
  overlay: {position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000},
  modal:   {background:"#fff", borderRadius:12, width:"100%", maxWidth:420, boxShadow:"0 8px 40px rgba(0,0,0,0.2)", overflow:"hidden"},
  mHead:   {background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"11px 16px"},
  mTitle:  {fontSize:13, fontWeight:800},
  mClose:  {background:"none", border:"none", color:"rgba(255,255,255,0.7)", fontSize:18, cursor:"pointer"},
  treatSection:{},
  treatLabel:  {fontSize:12, fontWeight:800, marginBottom:5},
  inp:     {width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", boxSizing:"border-box", fontFamily:"inherit"},
  sel:     {width:"100%", border:"1.5px solid", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", fontFamily:"inherit"},
  btnOk:   {background:"#dc2626", color:"#fff", border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontSize:13, fontWeight:700},
  btnDel:  {background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:8, padding:"8px 14px", cursor:"pointer", fontSize:13, fontWeight:700},
  xBtn:    {position:"absolute", top:1, right:1, background:"#fee2e2", border:"none", color:"#dc2626", borderRadius:3, width:14, height:14, cursor:"pointer", fontSize:8, lineHeight:"14px", textAlign:"center", padding:0},
};

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

const DAYS = ["월","화","수","목","금","토","일"];
const TIMES = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const LUNCH = "12:00";

const ROOM_TYPES = [
  { id:"hyperthermia", name:"고주파 온열치료", color:"#dc2626", bg:"#fef2f2", linked: true },
  { id:"hyperbaric",   name:"고압산소치료",    color:"#0ea5e9", bg:"#f0f9ff", linked: false },
];

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0,0,0,0);
  return d;
}
function getWeekKey(ws) { return ws.toISOString().slice(0,10); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate()+n); return d; }
function formatDate(date) { return `${date.getMonth()+1}/${date.getDate()}`; }

export default function HyperthermiaPage() {
  const router = useRouter();
  const today  = new Date();

  const [weekStart,  setWeekStart]  = useState(getWeekStart(today));
  const [schedule,   setSchedule]   = useState({});
  const [slots,      setSlots]      = useState({});
  const [treatPlans, setTreatPlans] = useState({});
  const [activeRoom, setActiveRoom] = useState("hyperthermia"); // 현재 보는 치료 종류
  const [modal,      setModal]      = useState(null);
  const [selSlotKey, setSelSlotKey] = useState("");
  const [selTreat,   setSelTreat]   = useState("hyperthermia");
  const [extraTime,  setExtraTime]  = useState("");
  const [showExtra,  setShowExtra]  = useState(false);
  const [printMode,  setPrintMode]  = useState(false);
  const [printSel,   setPrintSel]   = useState({});
  const [operatorName, setOperatorName] = useState("운용기사");

  const weekKey   = getWeekKey(weekStart);
  const weekDates = Array.from({length:7}, (_,i) => addDays(weekStart, i));

  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), s => setSlots(s.val()||{}));
    const u2 = onValue(ref(db,"treatmentPlans"), s => setTreatPlans(s.val()||{}));
    const u3 = onValue(ref(db,"hyperthermiaSchedule"), s => setSchedule(s.val()||{}));
    const u4 = onValue(ref(db,"settings"), s => {
      const v = s.val()||{};
      if (v.hyperOperator) setOperatorName(v.hyperOperator);
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const saveCell = useCallback(async (roomType, dayIdx, time, data) => {
    const newSch = JSON.parse(JSON.stringify(schedule));
    if (!newSch[weekKey]) newSch[weekKey] = {};
    if (!newSch[weekKey][roomType]) newSch[weekKey][roomType] = {};
    if (!newSch[weekKey][roomType][dayIdx]) newSch[weekKey][roomType][dayIdx] = {};
    if (data === null) delete newSch[weekKey][roomType][dayIdx][time];
    else newSch[weekKey][roomType][dayIdx][time] = data;
    setSchedule(newSch);
    await set(ref(db, `hyperthermiaSchedule/${weekKey}`), newSch[weekKey]||{});
  }, [schedule, weekKey]);

  const getCell = (roomType, dayIdx, time) =>
    schedule[weekKey]?.[roomType]?.[dayIdx]?.[time] || null;

  const openModal = (roomType, dayIdx, time) => {
    const ex = getCell(roomType, dayIdx, time);
    setModal({ roomType, dayIdx, time });
    setSelSlotKey(ex?.slotKey||"");
    setSelTreat(roomType);
    setShowExtra(false); setExtraTime("");
  };

  const registerCell = async () => {
    if (!modal || !selSlotKey) return;
    const { roomType, dayIdx, time: baseTime } = modal;
    const time = showExtra && extraTime ? extraTime : baseTime;
    const patientName = slots[selSlotKey]?.current?.name || "";
    await saveCell(roomType, dayIdx, time, { slotKey: selSlotKey, patientName, treatmentId: selTreat });
    setModal(null);
  };

  const removeCell = async (roomType, dayIdx, time) => {
    if (!window.confirm("삭제하시겠습니까?")) return;
    await saveCell(roomType, dayIdx, time, null);
  };

  // 치료계획에서 고주파 대기 환자
  const pendingLinked = (() => {
    const result = [];
    weekDates.forEach((date, dayIdx) => {
      const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
      const dKey = String(date.getDate());
      Object.entries(treatPlans).forEach(([slotKey, months]) => {
        const items = months?.[mKey]?.[dKey] || [];
        if (!items.some(e => e.id === "hyperthermia")) return;
        const patientName = slots[slotKey]?.current?.name;
        if (!patientName) return;
        result.push({ slotKey, patientName, dayIdx, date });
      });
    });
    return result;
  })();

  // 배정된 환자 (인쇄용)
  const scheduledPatients = (() => {
    const map = {};
    ROOM_TYPES.forEach(rt => {
      Object.entries(schedule[weekKey]?.[rt.id]||{}).forEach(([dayIdx, times]) => {
        Object.entries(times||{}).forEach(([time, data]) => {
          if (!data?.slotKey) return;
          if (!map[data.slotKey]) map[data.slotKey] = { patientName: data.patientName, slotKey: data.slotKey, entries:[] };
          map[data.slotKey].entries.push({ dayIdx:parseInt(dayIdx), time, treatmentId: data.treatmentId });
        });
      });
    });
    return Object.values(map);
  })();

  const availablePatients = modal ? (() => {
    const { dayIdx } = modal;
    const date = weekDates[dayIdx];
    const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey = String(date.getDate());
    const result = [];
    // 치료계획 연동 환자 먼저
    Object.entries(treatPlans).forEach(([slotKey, months]) => {
      const items = months?.[mKey]?.[dKey] || [];
      if (!items.some(e => e.id === "hyperthermia") && modal.roomType === "hyperthermia") return;
      const patientName = slots[slotKey]?.current?.name;
      if (!patientName) return;
      result.push({ slotKey, patientName });
    });
    // 전체 입원 환자
    Object.entries(slots).forEach(([slotKey, sd]) => {
      if (!sd?.current?.name) return;
      if (result.find(r => r.slotKey === slotKey)) return;
      result.push({ slotKey, patientName: sd.current.name });
    });
    return result;
  })() : [];

  const isCurrentWeek = getWeekKey(getWeekStart(today)) === weekKey;
  const roomInfo = ROOM_TYPES.find(r => r.id === activeRoom);

  return (
    <div style={HS.page}>
      <header style={HS.header}>
        <button style={HS.btnBack} onClick={() => router.push("/")}>← 현황판</button>
        <div style={HS.headerCenter}>
          <div style={HS.headerTitle}>⚡ 고주파치료실 주간 계획표</div>
          <div style={HS.headerSub}>{formatDate(weekDates[0])} ~ {formatDate(weekDates[6])} &nbsp;|&nbsp; {operatorName}</div>
        </div>
        <div style={HS.headerRight}>
          <button style={HS.btnWeek} onClick={() => setWeekStart(w => addDays(w,-7))}>‹ 전주</button>
          {!isCurrentWeek && <button style={{ ...HS.btnWeek, background:"#065f46", color:"#6ee7b7" }} onClick={() => setWeekStart(getWeekStart(today))}>이번 주</button>}
          <button style={HS.btnWeek} onClick={() => setWeekStart(w => addDays(w,7))}>다음 주 ›</button>
          <button style={HS.btnWeek} onClick={() => router.push("/settings")}>⚙️ 설정</button>
          <button style={{ ...HS.btnWeek, background: printMode?"#7c3aed":"rgba(255,255,255,0.15)" }} onClick={() => { setPrintMode(p=>!p); setPrintSel({}); }}>
            {printMode ? "✕ 인쇄 취소" : "🖨 인쇄"}
          </button>
        </div>
      </header>

      {printMode && (
        <div style={HS.printBar}>
          <span style={{ fontSize:13, fontWeight:700, color:"#7c3aed" }}>인쇄할 환자 선택</span>
          {scheduledPatients.map(p => (
            <label key={p.slotKey} style={HS.printCheckLabel}>
              <input type="checkbox" checked={!!printSel[p.slotKey]} onChange={e => setPrintSel(prev=>({...prev,[p.slotKey]:e.target.checked}))} />
              <span style={{ marginLeft:4 }}>{p.patientName}님</span>
            </label>
          ))}
          <button style={HS.btnPrimary} onClick={() => window.print()}>선택 인쇄</button>
        </div>
      )}

      {/* 탭 */}
      <div style={HS.tabs}>
        {ROOM_TYPES.map(rt => (
          <button key={rt.id}
            style={{ ...HS.tab, background: activeRoom===rt.id ? rt.color : "#f1f5f9", color: activeRoom===rt.id ? "#fff" : rt.color, borderColor: rt.color }}
            onClick={() => setActiveRoom(rt.id)}>
            {rt.name}
          </button>
        ))}
      </div>

      <div style={HS.body}>
        {/* 대기 환자 (고주파 연동만) */}
        {activeRoom === "hyperthermia" && (
          <div style={HS.pendingWrap}>
            <div style={HS.pendingTitle}>📋 대기 (치료계획 연동)</div>
            {pendingLinked.length === 0
              ? <div style={{ color:"#94a3b8", fontSize:11 }}>없음</div>
              : pendingLinked.map((p,i) => (
                  <div key={i} style={HS.pendingCard}>
                    <div style={{ fontWeight:700, fontSize:12 }}>{p.patientName}</div>
                    <div style={{ fontSize:10, color:"#64748b" }}>{DAYS[p.dayIdx]}</div>
                  </div>
                ))
            }
          </div>
        )}

        {/* 시간표 */}
        <div style={{ flex:1, overflowX:"auto" }}>
          <table style={HS.table}>
            <thead>
              <tr>
                <th style={HS.thTime}>시간</th>
                {weekDates.map((date, di) => (
                  <th key={di} style={{ ...HS.thDay, color:di>=5?"#2563eb":"#0f2744", background:di>=5?"#eff6ff":"#f8fafc" }}>
                    <div>{DAYS[di]}</div>
                    <div style={{ fontSize:11, fontWeight:400, color:"#64748b" }}>{formatDate(date)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TIMES.map(time => {
                const isLunch = time === LUNCH;
                return (
                  <tr key={time}>
                    <td style={{ ...HS.tdTime, color:isLunch?"#94a3b8":"#0f2744", background:isLunch?"#f8fafc":"#fff" }}>
                      {time}{isLunch && <span style={{ fontSize:9, display:"block", color:"#94a3b8" }}>점심</span>}
                    </td>
                    {weekDates.map((_, dayIdx) => {
                      if (isLunch) return <td key={dayIdx} style={HS.tdLunch}>—</td>;
                      const cell = getCell(activeRoom, dayIdx, time);
                      return (
                        <td key={dayIdx} style={{ ...HS.tdCell, background: cell ? roomInfo?.bg : "#fff" }}
                          onClick={() => openModal(activeRoom, dayIdx, time)}>
                          {cell ? (
                            <div style={HS.cellContent}>
                              <div style={{ fontWeight:700, fontSize:12, color:roomInfo?.color }}>{cell.patientName}</div>
                              <button style={HS.btnRemoveCell} onClick={e=>{ e.stopPropagation(); removeCell(activeRoom, dayIdx, time); }}>✕</button>
                            </div>
                          ) : (
                            <div style={HS.emptyCell}>+</div>
                          )}
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

      {/* 등록 모달 */}
      {modal && (
        <div style={HS.overlay} onClick={() => setModal(null)}>
          <div style={HS.modal} onClick={e=>e.stopPropagation()}>
            <div style={{ ...HS.modalHeader, background: roomInfo?.color }}>
              <span style={HS.modalTitle}>{roomInfo?.name} · {DAYS[modal.dayIdx]} {formatDate(weekDates[modal.dayIdx])} {modal.time}</span>
              <button style={HS.btnClose} onClick={() => setModal(null)}>✕</button>
            </div>
            <div style={{ padding:"16px" }}>
              <label style={HS.label}>환자 선택</label>
              <select style={HS.select} value={selSlotKey} onChange={e=>setSelSlotKey(e.target.value)}>
                <option value="">— 환자 선택 —</option>
                {availablePatients.map(p => (
                  <option key={p.slotKey} value={p.slotKey}>{p.patientName} ({p.slotKey})</option>
                ))}
              </select>
              <label style={{ display:"flex", alignItems:"center", gap:6, marginTop:12, fontSize:13, cursor:"pointer" }}>
                <input type="checkbox" checked={showExtra} onChange={e=>setShowExtra(e.target.checked)} />
                다른 시간으로 등록
              </label>
              {showExtra && <input style={{ ...HS.input, marginTop:6 }} type="time" value={extraTime} onChange={e=>setExtraTime(e.target.value)} step="1800" />}
              <div style={{ display:"flex", gap:8, marginTop:16 }}>
                <button style={{ ...HS.btnPrimary, flex:1, background:roomInfo?.color }} onClick={registerCell} disabled={!selSlotKey}>등록</button>
                {getCell(modal.roomType, modal.dayIdx, modal.time) && (
                  <button style={HS.btnDanger} onClick={() => { removeCell(modal.roomType, modal.dayIdx, modal.time); setModal(null); }}>삭제</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 인쇄 */}
      <HyperPrintCards selected={printSel} scheduledPatients={scheduledPatients} weekDates={weekDates} />
    </div>
  );
}

function HyperPrintCards({ selected, scheduledPatients, weekDates }) {
  const list = scheduledPatients.filter(p => selected[p.slotKey]);
  if (list.length === 0) return null;
  const treatName = id => ({ hyperthermia:"고주파 온열치료", hyperbaric:"고압산소치료" }[id]||id);
  return (
    <div className="print-only" style={{ display:"none" }}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 8mm; }
          body * { visibility: hidden !important; }
          .print-only, .print-only * { visibility: visible !important; }
          .print-only { position:fixed; top:0; left:0; width:100%; background:white; z-index:9999; display:block !important; }
          .patient-card { page-break-inside:avoid; border:1px solid #ccc; border-radius:6px; padding:10px 12px; margin-bottom:6px; }
        }
      `}</style>
      <div style={{ fontFamily:"'Noto Sans KR',sans-serif", columns:2, columnGap:"8mm" }}>
        {list.map(p => {
          const sorted = [...p.entries].sort((a,b) => a.dayIdx-b.dayIdx||a.time.localeCompare(b.time));
          return (
            <div key={p.slotKey} className="patient-card" style={{ breakInside:"avoid" }}>
              <div style={{ fontWeight:800, fontSize:13, borderBottom:"1px solid #ccc", paddingBottom:5, marginBottom:6 }}>
                {p.patientName}님 <span style={{ fontSize:10, color:"#666", fontWeight:400 }}>{p.slotKey}</span>
              </div>
              <div style={{ fontSize:10, color:"#666", marginBottom:5 }}>
                {formatDate(weekDates[0])} ~ {formatDate(weekDates[6])} 치료 안내
              </div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                <thead>
                  <tr style={{ background:"#f0f0f0" }}>
                    <th style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center" }}>날짜</th>
                    <th style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center" }}>요일</th>
                    <th style={{ border:"1px solid #ddd", padding:"3px 5px" }}>치료</th>
                    <th style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center" }}>시간</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e,i) => (
                    <tr key={i}>
                      <td style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center" }}>{formatDate(weekDates[e.dayIdx])}</td>
                      <td style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center" }}>{"월화수목금토일"[e.dayIdx]}</td>
                      <td style={{ border:"1px solid #ddd", padding:"3px 5px" }}>{treatName(e.treatmentId)}</td>
                      <td style={{ border:"1px solid #ddd", padding:"3px 5px", textAlign:"center", fontWeight:700 }}>{e.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HS = {
  page: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh" },
  header: { background:"#dc2626", color:"#fff", display:"flex", alignItems:"center", gap:12, padding:"12px 20px", boxShadow:"0 2px 12px rgba(0,0,0,0.15)", flexWrap:"wrap" },
  btnBack: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 },
  headerCenter: { flex:1, textAlign:"center" },
  headerTitle: { fontSize:17, fontWeight:800 },
  headerSub: { fontSize:11, color:"#fca5a5", marginTop:2 },
  headerRight: { display:"flex", gap:8, flexWrap:"wrap" },
  btnWeek: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600 },
  printBar: { background:"#faf5ff", borderBottom:"1px solid #e9d5ff", padding:"10px 20px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" },
  printCheckLabel: { display:"flex", alignItems:"center", fontSize:13, cursor:"pointer", background:"#fff", border:"1px solid #e9d5ff", borderRadius:6, padding:"3px 10px" },
  tabs: { display:"flex", gap:8, padding:"12px 20px", background:"#fff", borderBottom:"1px solid #e2e8f0" },
  tab: { border:"2px solid", borderRadius:8, padding:"6px 18px", cursor:"pointer", fontSize:13, fontWeight:700 },
  body: { display:"flex", gap:0 },
  pendingWrap: { width:160, background:"#fff", borderRight:"1px solid #e2e8f0", padding:"12px", flexShrink:0 },
  pendingTitle: { fontSize:11, fontWeight:800, color:"#dc2626", marginBottom:8 },
  pendingCard: { background:"#fef2f2", border:"1px solid #fecaca", borderRadius:7, padding:"7px", marginBottom:5 },
  table: { width:"100%", borderCollapse:"collapse", tableLayout:"fixed" },
  thTime: { width:60, padding:"6px 4px", background:"#0f2744", color:"#fff", fontSize:11, fontWeight:700, textAlign:"center", border:"1px solid #1e3a5f" },
  thDay: { padding:"6px 4px", fontSize:12, fontWeight:700, textAlign:"center", border:"1px solid #e2e8f0" },
  tdTime: { padding:"4px", fontSize:11, fontWeight:700, textAlign:"center", border:"1px solid #e2e8f0", width:60 },
  tdLunch: { background:"#f8fafc", border:"1px solid #e2e8f0", textAlign:"center", color:"#cbd5e1", fontSize:12 },
  tdCell: { border:"1px solid #e2e8f0", cursor:"pointer", verticalAlign:"top", minHeight:48, transition:"background 0.15s" },
  cellContent: { padding:"4px 6px", position:"relative" },
  emptyCell: { color:"#e2e8f0", fontSize:20, textAlign:"center", padding:"8px 0", userSelect:"none" },
  btnRemoveCell: { position:"absolute", top:2, right:2, background:"#fee2e2", border:"none", color:"#dc2626", borderRadius:4, width:16, height:16, cursor:"pointer", fontSize:9 },
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:14, width:"100%", maxWidth:400, boxShadow:"0 8px 40px rgba(0,0,0,0.22)", overflow:"hidden" },
  modalHeader: { color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 16px" },
  modalTitle: { fontSize:14, fontWeight:800 },
  btnClose: { background:"none", border:"none", color:"rgba(255,255,255,0.7)", fontSize:18, cursor:"pointer" },
  label: { display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:4 },
  input: { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  select: { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7, padding:"7px 10px", fontSize:13, outline:"none", fontFamily:"inherit" },
  btnPrimary: { color:"#fff", border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontSize:13, fontWeight:700 },
  btnDanger: { background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:8, padding:"8px 14px", cursor:"pointer", fontSize:13, fontWeight:700 },
};

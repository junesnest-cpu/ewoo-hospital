import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];
const THERAPY_SLOTS = ["09:00~10:00","10:00~11:00","11:00~12:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];
const TREAT_NAMES = { pain:"페인", manip2:"도수2", manip1:"도수1" };
const VALID_ROOMS = new Set([
  "201","202","203","204","205","206",
  "301","302","303","304","305","306",
  "501","502","503","504","505","506",
  "601","602","603",
]);

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function uid() { return Math.random().toString(36).slice(2,9); }
function toYM(dateStr) { return dateStr.slice(0,7); }
function normName(n) { return (n||"").replace(/^신\)/,"").replace(/\d+$/,"").trim().toLowerCase(); }
function getWeekKey(dateStr) {
  const d = new Date(dateStr), dow = d.getDay();
  const monday = new Date(d); monday.setDate(d.getDate() + (dow===0?-6:1-dow)); monday.setHours(0,0,0,0);
  return monday.toISOString().slice(0,10);
}
function getDayIdx(dateStr) { const dow = new Date(dateStr).getDay(); return dow===0?6:dow-1; }
function parseMD(str, year) {
  if (!str||str==="미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return `${year}-${String(parseInt(m[1])).padStart(2,"0")}-${String(parseInt(m[2])).padStart(2,"0")}`;
}
function buildCellText(cell, useTreatNames) {
  if (!cell) return "";
  const name = cell.patientName || cell.name || "";
  if (!name) return "";
  // slotKey에서 병실 추출 (roomId 필드가 없을 경우)
  let room = "";
  if (cell.slotKey && !cell.slotKey.startsWith("pending_") && !cell.slotKey.startsWith("db_") && !cell.slotKey.startsWith("__")) {
    room = cell.slotKey;
  }
  const treatName = useTreatNames ? (TREAT_NAMES[cell.treatmentId]||"") : "";
  const line1 = room ? `${name}(${room})` : name;
  return treatName ? `${line1}\n${treatName}` : line1;
}

export default function DailyBoard() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const boardRef = useRef(null);
  const [date, setDate] = useState(todayStr());
  const [editMode, setEditMode] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // 데이터 소스
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});
  const [monthlyBoard, setMonthlyBoard] = useState({});
  const [physSched, setPhysSched] = useState({});
  const [hyperSched, setHyperSched] = useState({});
  const [therapists, setTherapists] = useState(["치료사1","치료사2"]);

  // 수동 편집 (오버라이드)
  const [overrides, setOverrides] = useState(null);
  const [filterName, setFilterName] = useState("");

  const wk = useMemo(() => getWeekKey(date), [date]);
  const dayIdx = useMemo(() => getDayIdx(date), [date]);
  const ym = useMemo(() => toYM(date), [date]);
  const dateYear = parseInt(date.slice(0,4));

  // ── Firebase 구독 ──
  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), s => setSlots(s.val()||{}));
    const u2 = onValue(ref(db,"consultations"), s => setConsultations(s.val()||{}));
    const u3 = onValue(ref(db,"settings"), s => {
      const v = s.val()||{};
      setTherapists([v.therapist1||"치료사1", v.therapist2||"치료사2"]);
    });
    return () => { u1(); u2(); u3(); };
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
    const u = onValue(ref(db, `dailyBoards/${date}`), s => setOverrides(s.val()||null));
    return () => u();
  }, [date]);

  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) setFilterName(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  // ── 연동 데이터 계산 ──

  // 이름→슬롯 매핑 (환자 정보 보강용)
  const patientInfo = useMemo(() => {
    const map = {};
    Object.entries(slots).forEach(([sk, slot]) => {
      if (!slot?.current?.name) return;
      const n = normName(slot.current.name);
      if (n) map[n] = { slotKey:sk, doctor:slot.current.doctor||"", note:slot.current.note||"", room:sk };
    });
    return map;
  }, [slots]);

  // 입원 (월간보드 + slots + consultations 병합)
  const syncedAdmissions = useMemo(() => {
    const list = [];
    const seen = new Set();

    // 1. 월간보드에서
    (monthlyBoard.admissions||[]).forEach(a => {
      if (!a?.name) return;
      const n = normName(a.name);
      if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      list.push({ id:a.id||uid(), name:a.name, room:info?.room||a.room||"",
        doctor:info?.doctor||"", time:a.time||"", note:info?.note||a.note||"",
        isNew:!!a.isNew });
    });

    // 2. slots에서 당일 입원자 추가
    Object.entries(slots).forEach(([sk, slot]) => {
      const cur = slot?.current;
      if (!cur?.name) return;
      const admitKey = parseMD(cur.admitDate, dateYear);
      if (admitKey !== date) return;
      const n = normName(cur.name);
      if (seen.has(n)) return; seen.add(n);
      list.push({ id:uid(), name:cur.name, room:sk, doctor:cur.doctor||"", time:"", note:cur.note||"", isNew:false });
    });

    // 3. 상담일지에서 신환 추가
    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status==="취소"||c.status==="입원완료") return;
      if (c.admitDate !== date) return;
      const n = normName(c.name);
      if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      const noteFields = [];
      if (c.birthYear) noteFields.push(`${new Date().getFullYear()-parseInt(c.birthYear)}세`);
      if (c.diagnosis) noteFields.push(c.diagnosis);
      if (c.hospital) noteFields.push(c.hospital);
      list.push({ id:uid(), name:c.name, room:info?.room||c.roomTypes?.join("/")||"",
        doctor:info?.doctor||"", time:"", note:noteFields.join(" · "), isNew:true });
    });

    return list;
  }, [monthlyBoard, slots, consultations, date, dateYear, patientInfo]);

  // 퇴원
  const syncedDischarges = useMemo(() => {
    const list = [];
    const seen = new Set();

    (monthlyBoard.discharges||[]).forEach(d => {
      if (!d?.name) return;
      const n = normName(d.name);
      if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      list.push({ id:d.id||uid(), name:d.name, room:info?.room||d.room||"", time:d.time||"", note:d.note||"" });
    });

    Object.entries(slots).forEach(([sk, slot]) => {
      const cur = slot?.current;
      if (!cur?.name) return;
      const disKey = parseMD(cur.discharge, dateYear);
      if (disKey !== date) return;
      const n = normName(cur.name);
      if (seen.has(n)) return; seen.add(n);
      list.push({ id:uid(), name:cur.name, room:sk, time:"", note:"" });
    });

    return list;
  }, [monthlyBoard, slots, date, dateYear, patientInfo]);

  // 자리보존: 같은 병상에서 퇴원 후 7일 이내 재입원 예약이 있는 경우
  const syncedReserved = useMemo(() => {
    const list = [];
    const seen = new Set();
    Object.entries(slots).forEach(([sk, slot]) => {
      const roomId = sk.split("-")[0];
      if (!VALID_ROOMS.has(roomId)) return;
      const cur = slot?.current;
      const reservations = slot?.reservations || [];
      if (!cur?.name || !reservations.length) return;
      const curDis = parseMD(cur.discharge, dateYear);
      if (!curDis) return;
      reservations.forEach(r => {
        if (!r?.name) return;
        const readmit = parseMD(r.admitDate, dateYear);
        if (!readmit) return;
        // 퇴원일과 재입원일 사이가 7일 이내인지 확인
        const disDate = new Date(curDis);
        const readmitDate = new Date(readmit);
        const diffDays = (readmitDate - disDate) / (1000*60*60*24);
        if (diffDays < 0 || diffDays > 7) return;
        // 현재 날짜가 퇴원일~재입원일 범위에 포함되는지 확인
        const today = new Date(date);
        if (today < disDate || today > readmitDate) return;
        const n = normName(r.name);
        if (seen.has(n)) return; seen.add(n);
        list.push({ id:uid(), name:r.name, room:sk, dischargeDate:cur.discharge||"", readmitDate:r.admitDate||"" });
      });
    });
    return list;
  }, [slots, date, dateYear]);

  // 치료실
  const autoTherapy = useMemo(() => {
    const t = {};
    const di = String(dayIdx); // Firebase 키는 문자열
    THERAPY_SLOTS.forEach(slot => {
      const st = slot.split("~")[0];
      t[slot] = {
        highFreq: buildCellText(hyperSched?.["hyperthermia"]?.[di]?.[st], false),
        physio1: buildCellText(physSched?.["th1"]?.[di]?.[st], true),
        physio2: buildCellText(physSched?.["th2"]?.[di]?.[st], true),
        hyperbaric: buildCellText(hyperSched?.["hyperbaric"]?.[di]?.[st], false),
      };
    });
    return t;
  }, [physSched, hyperSched, dayIdx]);

  const therapyCols = useMemo(() => [
    { key:"highFreq", label:"고주파", color:"#dc2626" },
    { key:"physio1", label:therapists[0], color:"#059669" },
    { key:"physio2", label:therapists[1], color:"#1d4ed8" },
    { key:"hyperbaric", label:"고압산소", color:"#0284c7" },
  ], [therapists]);

  // ── 표시 데이터 (연동 + 오버라이드 병합) ──
  const admissions = overrides?.admissions || syncedAdmissions;
  const discharges = overrides?.discharges || syncedDischarges;
  const transfers = overrides?.transfers || [];
  const reservedBeds = overrides?.reservedBeds || syncedReserved;
  const therapy = overrides?.therapy || {};

  // ── 수정 모드 함수 ──
  function startEdit() {
    // 현재 표시 데이터를 오버라이드로 복사
    const ov = {
      admissions: [...(overrides?.admissions || syncedAdmissions)],
      discharges: [...(overrides?.discharges || syncedDischarges)],
      transfers: [...(overrides?.transfers || [{ id:uid(), name:"", fromRoom:"", toRoom:"", time:"" }])],
      reservedBeds: [...(overrides?.reservedBeds || syncedReserved)],
      therapy: { ...therapy },
    };
    setOverrides(ov);
    setEditMode(true);
  }

  async function saveEdit() {
    await set(ref(db, `dailyBoards/${date}`), overrides);
    setEditMode(false);
  }

  function cancelEdit() {
    // Firebase에서 다시 로드됨
    setEditMode(false);
  }

  function updateRow(section, id, field, val) {
    setOverrides(ov => ({
      ...ov,
      [section]: (ov[section]||[]).map(r => r.id===id ? {...r,[field]:val} : r),
    }));
  }
  function addRow(section, empty) {
    setOverrides(ov => ({ ...ov, [section]: [...(ov[section]||[]), empty()] }));
  }
  function deleteRow(section, id) {
    setOverrides(ov => ({ ...ov, [section]: (ov[section]||[]).filter(r => r.id!==id) }));
  }
  function updateTherapy(slot, col, val) {
    setOverrides(ov => ({ ...ov, therapy: { ...(ov?.therapy||{}), [slot]: { ...(ov?.therapy||{})[slot], [col]:val } } }));
  }

  // ── 공지 (스크린샷 → 클립보드) ──
  const captureToClipboard = useCallback(async () => {
    if (!boardRef.current) return;
    setCapturing(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(boardRef.current, {
        scale: 2, useCORS: true, backgroundColor: "#ffffff",
        width: 794, // A4 width at 96dpi
        windowWidth: 794,
      });
      canvas.toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          alert("클립보드에 복사되었습니다!");
        } catch { alert("클립보드 복사 실패. 브라우저 권한을 확인하세요."); }
        setCapturing(false);
      }, "image/png");
    } catch (err) {
      console.error(err);
      alert("스크린샷 생성 실패");
      setCapturing(false);
    }
  }, []);

  // ── 날짜 ──
  function changeDate(delta) {
    const d = new Date(date); d.setDate(d.getDate()+delta);
    setDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
    setEditMode(false);
  }

  const dateObj = new Date(date);
  const dow = DOW[dateObj.getDay()];
  const isWeekend = dateObj.getDay()===0||dateObj.getDay()===6;

  return (
    <div style={{ minHeight:"100vh", background:"#f0f2f5", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>

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
          {editMode ? (
            <>
              <button onClick={saveEdit} style={{ ...S.headerBtn, background:"rgba(5,150,105,0.3)", border:"1px solid rgba(5,150,105,0.5)" }}>💾 저장</button>
              <button onClick={cancelEdit} style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)" }}>취소</button>
            </>
          ) : (
            <>
              <button onClick={startEdit} style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.2)" }}>✏️ 수정</button>
              <button onClick={captureToClipboard} disabled={capturing}
                style={{ ...S.headerBtn, background:"rgba(14,165,233,0.25)", border:"1px solid rgba(14,165,233,0.4)" }}>
                {capturing ? "캡처 중..." : "📋 공지"}
              </button>
            </>
          )}
        </div>
      </header>

      {/* ── 본문 (캡처 대상) ── */}
      <div ref={boardRef} style={{ padding: isMobile?"10px":"12px 16px", display:"flex", flexDirection:"column", gap:12,
        background:"#f0f2f5", maxWidth:794 }}>

        {/* 캡처용 제목 */}
        <div style={{ textAlign:"center", padding:"6px 0 2px", fontWeight:900, fontSize:20, color:"#0f2744",
          borderBottom:"2px solid #0f2744", marginBottom:2 }}>
          {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 ({dow}) 현황판
        </div>

        {/* ── 입원 / 퇴원 ── */}
        <div style={{ display:"flex", gap:10, flexWrap: isMobile?"wrap":"nowrap" }}>
          {/* 입원 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="↑" label="입원" count={admissions.filter(r=>r.name).length} color="#059669" bg="#ecfdf5" border="#a7f3d0" />
            <div style={{ background:"#fff", border:"1px solid #d1fae5", borderTop:"none", borderRadius:"0 0 8px 8px" }}>
              {admissions.length===0 && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
              {admissions.map(row => (
                <div key={row.id} style={{ display:"flex", gap:4, padding:"5px 8px", borderBottom:"1px solid #f0fdf4",
                  alignItems:"center", background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                  <span style={{ fontWeight:800, color:"#059669", fontSize:14, width:65, textAlign:"center", flexShrink:0 }}>
                    {editMode ? <Field w={60} value={row.room} onChange={v=>updateRow("admissions",row.id,"room",v)} placeholder="호실" style={{textAlign:"center",fontWeight:800,color:"#059669"}} />
                      : row.room||"-"}
                  </span>
                  <div style={{ display:"flex", alignItems:"center", gap:3, minWidth:100, flex:"0 0 auto" }}>
                    {row.isNew && <span style={{ fontSize:10, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"0 3px", fontWeight:800 }}>★</span>}
                    {editMode ? <Field w={65} value={row.name} onChange={v=>updateRow("admissions",row.id,"name",v)} placeholder="이름" style={{fontWeight:700}} />
                      : <span style={{ fontWeight:700, fontSize:14 }}>{row.name}</span>}
                    {row.doctor && <span style={{ fontSize:12, color:"#64748b" }}>/{row.doctor}</span>}
                    {editMode && <>
                      <Field w={35} value={row.doctor} onChange={v=>updateRow("admissions",row.id,"doctor",v)} placeholder="Dr" style={{color:"#64748b",fontSize:12}} />
                      <button onClick={()=>updateRow("admissions",row.id,"isNew",!row.isNew)}
                        style={{ fontSize:10, background:row.isNew?"#fef08a":"#f8fafc", border:"1px solid", borderColor:row.isNew?"#fcd34d":"#e2e8f0",
                          borderRadius:3, padding:"0 3px", cursor:"pointer", color:row.isNew?"#713f12":"#cbd5e1", fontWeight:800 }}>★</button>
                    </>}
                  </div>
                  {row.time && <span style={{ fontSize:12, color:"#0891b2", fontWeight:600, flexShrink:0 }}>{row.time}</span>}
                  {editMode && <Field w={55} value={row.time} onChange={v=>updateRow("admissions",row.id,"time",v)} placeholder="시간" style={{color:"#0891b2",fontSize:12,textAlign:"center"}} />}
                  <span style={{ fontSize:12, color:"#64748b", flex:1, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                    {editMode ? <Field flex={1} value={row.note} onChange={v=>updateRow("admissions",row.id,"note",v)} placeholder="비고" style={{color:"#64748b",fontSize:12}} />
                      : row.note}
                  </span>
                  {editMode && <DelBtn onClick={()=>deleteRow("admissions",row.id)} />}
                </div>
              ))}
              {editMode && <AddBtn onClick={()=>addRow("admissions",()=>({id:uid(),room:"",name:"",doctor:"",time:"",note:"",isNew:false}))} />}
            </div>
          </div>

          {/* 퇴원 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="↓" label="퇴원" count={discharges.filter(r=>r.name).length} color="#dc2626" bg="#fef2f2" border="#fecaca" />
            <div style={{ background:"#fff", border:"1px solid #fecaca", borderTop:"none", borderRadius:"0 0 8px 8px" }}>
              {discharges.length===0 && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
              {discharges.map(row => (
                <div key={row.id} style={{ display:"flex", gap:4, padding:"5px 8px", borderBottom:"1px solid #fff5f5",
                  alignItems:"center", background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                  <span style={{ fontWeight:800, color:"#dc2626", fontSize:14, width:65, textAlign:"center", flexShrink:0 }}>
                    {editMode ? <Field w={60} value={row.room} onChange={v=>updateRow("discharges",row.id,"room",v)} placeholder="호실" style={{textAlign:"center",fontWeight:800,color:"#dc2626"}} />
                      : row.room||"-"}
                  </span>
                  {editMode ? <Field w={65} value={row.name} onChange={v=>updateRow("discharges",row.id,"name",v)} placeholder="이름" style={{fontWeight:700}} />
                    : <span style={{ fontWeight:700, fontSize:14, flexShrink:0 }}>{row.name}</span>}
                  {row.time && <span style={{ fontSize:12, color:"#0891b2", fontWeight:600, flexShrink:0,
                    background:"#ecfeff", borderRadius:3, padding:"0 4px" }}>{row.time}</span>}
                  {editMode && <Field w={60} value={row.time} onChange={v=>updateRow("discharges",row.id,"time",v)} placeholder="시간" style={{color:"#0891b2",fontSize:12,textAlign:"center"}} />}
                  <span style={{ fontSize:12, color:"#64748b", flex:1, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                    {editMode ? <Field flex={1} value={row.note} onChange={v=>updateRow("discharges",row.id,"note",v)} placeholder="재입원 등" style={{color:"#64748b",fontSize:12}} />
                      : row.note}
                  </span>
                  {editMode && <DelBtn onClick={()=>deleteRow("discharges",row.id)} />}
                </div>
              ))}
              {editMode && <AddBtn onClick={()=>addRow("discharges",()=>({id:uid(),room:"",name:"",time:"",note:""}))} />}
            </div>
          </div>
        </div>

        {/* ── 전실 / 자리보존 ── */}
        <div style={{ display:"flex", gap:10, flexWrap: isMobile?"wrap":"nowrap" }}>
          {/* 전실 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="⇄" label="전실" count={transfers.filter(r=>r.name).length} color="#0369a1" bg="#f0f9ff" border="#bae6fd" />
            <div style={{ background:"#fff", border:"1px solid #bae6fd", borderTop:"none", borderRadius:"0 0 8px 8px" }}>
              {transfers.length===0 && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
              {transfers.map(row => (
                <div key={row.id} style={{ display:"flex", gap:4, padding:"5px 8px", borderBottom:"1px solid #f0f9ff", alignItems:"center",
                  background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                  {editMode ? <Field w={65} value={row.name} onChange={v=>updateRow("transfers",row.id,"name",v)} placeholder="이름" style={{fontWeight:700}} />
                    : <span style={{ fontWeight:700, fontSize:14, flexShrink:0 }}>{row.name}</span>}
                  <span style={{ fontSize:13, color:"#64748b", flexShrink:0 }}>
                    {editMode ? <Field w={50} value={row.fromRoom} onChange={v=>updateRow("transfers",row.id,"fromRoom",v)} placeholder="기존" style={{textAlign:"center",color:"#64748b"}} />
                      : row.fromRoom}
                  </span>
                  <span style={{ color:"#0369a1", fontWeight:800, fontSize:14, flexShrink:0 }}>→</span>
                  <span style={{ fontSize:13, color:"#0369a1", fontWeight:700, flexShrink:0 }}>
                    {editMode ? <Field w={50} value={row.toRoom} onChange={v=>updateRow("transfers",row.id,"toRoom",v)} placeholder="이동" style={{textAlign:"center",color:"#0369a1",fontWeight:700}} />
                      : row.toRoom}
                  </span>
                  {row.time && <span style={{ fontSize:12, color:"#64748b" }}>{row.time}</span>}
                  {editMode && <Field flex={1} value={row.time} onChange={v=>updateRow("transfers",row.id,"time",v)} placeholder="시간" style={{color:"#64748b",fontSize:12}} />}
                  {editMode && <DelBtn onClick={()=>deleteRow("transfers",row.id)} />}
                </div>
              ))}
              {editMode && <AddBtn onClick={()=>addRow("transfers",()=>({id:uid(),name:"",fromRoom:"",toRoom:"",time:""}))} />}
            </div>
          </div>

          {/* 자리보존 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="🔒" label="자리 보존" count={reservedBeds.filter(r=>r.name).length} color="#7c3aed" bg="#faf5ff" border="#ddd6fe" />
            <div style={{ background:"#fff", border:"1px solid #ddd6fe", borderTop:"none", borderRadius:"0 0 8px 8px" }}>
              {reservedBeds.length===0 && <div style={{ padding:"8px 12px", color:"#94a3b8", fontSize:13 }}>해당 없음</div>}
              {reservedBeds.map(row => (
                <div key={row.id} style={{ display:"flex", gap:4, padding:"5px 8px", borderBottom:"1px solid #faf5ff", alignItems:"center",
                  background:(filterName&&row.name?.includes(filterName))?"#fef3c7":"transparent" }}>
                  {editMode ? <Field w={65} value={row.name} onChange={v=>updateRow("reservedBeds",row.id,"name",v)} placeholder="이름" style={{fontWeight:700}} />
                    : <span style={{ fontWeight:700, fontSize:14, flexShrink:0 }}>{row.name}</span>}
                  <span style={{ fontSize:13, color:"#7c3aed", flexShrink:0 }}>
                    {editMode ? <Field w={50} value={row.room} onChange={v=>updateRow("reservedBeds",row.id,"room",v)} placeholder="병실" style={{textAlign:"center",color:"#7c3aed"}} />
                      : row.room}
                  </span>
                  {row.dischargeDate && <span style={{ fontSize:12, color:"#64748b" }}>퇴원:{row.dischargeDate}</span>}
                  {row.readmitDate && <span style={{ fontSize:12, color:"#7c3aed" }}>재입원:{row.readmitDate}</span>}
                  {editMode && <>
                    <Field w={50} value={row.dischargeDate} onChange={v=>updateRow("reservedBeds",row.id,"dischargeDate",v)} placeholder="퇴원일" style={{fontSize:12,color:"#64748b",textAlign:"center"}} />
                    <Field w={55} value={row.readmitDate} onChange={v=>updateRow("reservedBeds",row.id,"readmitDate",v)} placeholder="재입원" style={{fontSize:12,color:"#7c3aed",textAlign:"center"}} />
                  </>}
                  {editMode && <DelBtn onClick={()=>deleteRow("reservedBeds",row.id)} />}
                </div>
              ))}
              {editMode && <AddBtn onClick={()=>addRow("reservedBeds",()=>({id:uid(),name:"",room:"",dischargeDate:"",readmitDate:""}))} />}
            </div>
          </div>
        </div>

        {/* ── 치료실 이용계획 ── */}
        <div>
          <SectionHeader icon="💊" label="치료실 이용계획" color="#92400e" bg="#fffbeb" border="#fde68a" />
          <div style={{ background:"#fff", border:"1px solid #fde68a", borderTop:"none", borderRadius:"0 0 8px 8px", overflowX:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%", minWidth:500 }}>
              <thead>
                <tr>
                  <th style={{ ...S.thTh, width:90, background:"#fefce8" }}>시간</th>
                  {therapyCols.map(c => (
                    <th key={c.key} style={S.thTh}>
                      <span style={{ display:"inline-block", width:7, height:7, borderRadius:"50%", background:c.color, marginRight:4, verticalAlign:"middle" }}/>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {THERAPY_SLOTS.map(slot => {
                  const auto = autoTherapy[slot]||{};
                  const isAft = slot.startsWith("13");
                  return (
                    <tr key={slot}>
                      <td style={{ padding:"3px 4px", borderBottom:"1px solid #f5f5f4", borderRight:"1px solid #f5f5f4",
                        fontWeight:800, fontSize:12, textAlign:"center", color:"#78350f",
                        background:isAft?"#fefce8":"#fafaf9", whiteSpace:"nowrap" }}>{slot}</td>
                      {therapyCols.map(c => {
                        const manual = therapy[slot]?.[c.key];
                        const autoVal = auto[c.key]||"";
                        const display = manual || autoVal;
                        return (
                          <td key={c.key} style={{ padding:2, borderBottom:"1px solid #f5f5f4", borderRight:"1px solid #f5f5f4",
                            verticalAlign:"top", background:isAft?"#fffef5":"#fff" }}>
                            {editMode ? (
                              <textarea value={manual||""} onChange={e=>updateTherapy(slot,c.key,e.target.value)}
                                rows={2} placeholder={autoVal||"-"}
                                style={{ width:"100%", border:manual?"1px solid #fcd34d":"1px solid transparent",
                                  background:manual?"#fffbeb":"transparent", resize:"vertical", fontSize:12,
                                  fontFamily:"inherit", padding:"2px 4px", minHeight:36, outline:"none",
                                  lineHeight:1.4, borderRadius:3 }} />
                            ) : display ? (
                              <div style={{ fontSize:12, color:"#374151", whiteSpace:"pre-wrap", lineHeight:1.4, padding:"2px 4px",
                                background: manual ? "#fffbeb" : autoVal ? "#f0f9ff" : "transparent",
                                borderRadius:3 }}>{display}</div>
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
  );
}

/* ── 서브 컴포넌트 ── */
function SectionHeader({ icon, label, count, color, bg, border }) {
  return (
    <div style={{ background:bg, border:`1px solid ${border}`, borderBottom:"none",
      borderRadius:"8px 8px 0 0", padding:"5px 12px", display:"flex", alignItems:"center", gap:6 }}>
      <span style={{ fontSize:14 }}>{icon}</span>
      <span style={{ fontWeight:900, fontSize:15, color, letterSpacing:1 }}>{label}</span>
      {count > 0 && <span style={{ fontSize:12, fontWeight:800, color, background:"rgba(255,255,255,0.7)",
        borderRadius:10, padding:"0 7px" }}>{count}</span>}
    </div>
  );
}

function Field({ value, onChange, placeholder, w, flex, style: ext }) {
  return <input value={value||""} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
    style={{ border:"none", outline:"none", background:"transparent", fontSize:14, padding:"2px 3px",
      fontFamily:"inherit", color:"#1e293b", width:w||"auto", flex:flex||undefined, minWidth:0, ...ext }} />;
}

function DelBtn({ onClick }) {
  return <button className="no-print" onClick={onClick} style={{ background:"none", border:"none",
    cursor:"pointer", color:"#d1d5db", fontSize:14, lineHeight:1, padding:"0 2px", flexShrink:0 }}
    onMouseEnter={e=>e.target.style.color="#ef4444"} onMouseLeave={e=>e.target.style.color="#d1d5db"}>✕</button>;
}

function AddBtn({ onClick }) {
  return <div className="no-print" style={{ padding:"3px 8px" }}>
    <button onClick={onClick} style={{ background:"none", border:"1px dashed #e2e8f0", borderRadius:5,
      color:"#94a3b8", cursor:"pointer", fontSize:12, padding:"2px 12px", width:"100%", fontWeight:600 }}>+ 추가</button>
  </div>;
}

const S = {
  navArrow: { background:"rgba(255,255,255,0.1)", color:"#fff", border:"1px solid rgba(255,255,255,0.2)",
    borderRadius:8, padding:"4px 12px", cursor:"pointer", fontSize:18, fontWeight:700, lineHeight:1 },
  headerBtn: { color:"#e2e8f0", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:700, fontFamily:"inherit" },
  thTh: { background:"#fafaf9", borderBottom:"2px solid #e7e5e4", borderRight:"1px solid #f5f5f4",
    padding:"5px 6px", fontSize:12, fontWeight:700, color:"#44403c", textAlign:"center" },
};

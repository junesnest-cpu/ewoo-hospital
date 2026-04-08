import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];
const THERAPY_SLOTS = ["09:00~10:00","10:00~11:00","11:00~12:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];
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
function normName(n) { return (n||"").replace(/^신\)/,"").replace(/\d+$/,"").trim().toLowerCase(); }
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
function buildCellText(cell, useTreatNames) {
  if (!cell) return "";
  const name = cell.patientName || cell.name || "";
  if (!name) return "";
  let room = "";
  if (cell.slotKey && !cell.slotKey.startsWith("pending_") && !cell.slotKey.startsWith("db_") && !cell.slotKey.startsWith("__"))
    room = cell.slotKey;
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
    Object.entries(slots).forEach(([sk, slot]) => {
      if (!slot?.current?.name) return;
      const n = normName(slot.current.name);
      if (n) map[n] = { room:sk, doctor:slot.current.doctor||"", note:slot.current.note||"" };
    });
    return map;
  }, [slots]);

  // ── 연동 데이터 계산 ──
  const syncedAdmissions = useMemo(() => {
    const list = [], seen = new Set();
    (monthlyBoard.admissions||[]).forEach(a => {
      if (!a?.name) return;
      const n = normName(a.name); if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      list.push({ id:a.id||uid(), name:a.name, room:info?.room||a.room||"",
        doctor:info?.doctor||"", time:a.time||"", note:info?.note||a.note||"", isNew:!!a.isNew });
    });
    Object.entries(slots).forEach(([sk, slot]) => {
      const cur = slot?.current; if (!cur?.name) return;
      if (parseMD(cur.admitDate, dateYear) !== date) return;
      const n = normName(cur.name); if (seen.has(n)) return; seen.add(n);
      list.push({ id:uid(), name:cur.name, room:sk, doctor:cur.doctor||"", time:"", note:cur.note||"", isNew:false });
    });
    Object.values(consultations).forEach(c => {
      if (!c?.name||!c.admitDate) return;
      if (c.status==="취소"||c.status==="입원완료") return;
      if (c.admitDate!==date) return;
      const n = normName(c.name); if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      const notes = [c.birthYear?`${new Date().getFullYear()-parseInt(c.birthYear)}세`:null,c.diagnosis,c.hospital].filter(Boolean);
      list.push({ id:uid(), name:c.name, room:info?.room||c.roomTypes?.join("/")||"",
        doctor:info?.doctor||"", time:"", note:notes.join(" · "), isNew:true });
    });
    return list;
  }, [monthlyBoard, slots, consultations, date, dateYear, patientInfo]);

  const syncedDischarges = useMemo(() => {
    const list = [], seen = new Set();
    (monthlyBoard.discharges||[]).forEach(d => {
      if (!d?.name) return;
      const n = normName(d.name); if (seen.has(n)) return; seen.add(n);
      const info = patientInfo[n];
      list.push({ id:d.id||uid(), name:d.name, room:info?.room||d.room||"", time:d.time||"", note:d.note||"" });
    });
    Object.entries(slots).forEach(([sk, slot]) => {
      const cur = slot?.current; if (!cur?.name) return;
      if (parseMD(cur.discharge, dateYear) !== date) return;
      const n = normName(cur.name); if (seen.has(n)) return; seen.add(n);
      list.push({ id:uid(), name:cur.name, room:sk, time:"", note:"" });
    });
    return list;
  }, [monthlyBoard, slots, date, dateYear, patientInfo]);

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
        if (!r?.name) return;
        const readmit = parseMD(r.admitDate, dateYear);
        if (!readmit) return;
        const diffDays = (new Date(readmit)-new Date(curDis))/(1000*60*60*24);
        if (diffDays<0||diffDays>7) return;
        const today = new Date(date);
        if (today<new Date(curDis)||today>new Date(readmit)) return;
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
        highFreq: buildCellText(hyperSched?.["hyperthermia"]?.[di]?.[st], false),
        physio1: buildCellText(physSched?.["th1"]?.[di]?.[st], true),
        physio2: buildCellText(physSched?.["th2"]?.[di]?.[st], true),
        hyperbaric: buildCellText(hyperSched?.["hyperbaric"]?.[di]?.[st], false),
      };
    });
    return t;
  }, [physSched, hyperSched, dayIdx]);

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
    await set(ref(db, `dailyBoards/${date}`), {
      admissions: editAdm, discharges: editDis, transfers: editTrn, reservedBeds: editRes, therapy: editTherapy,
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
      const canvas = await html2canvas(boardRef.current, { scale:2, useCORS:true, backgroundColor:"#ffffff" });
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

  const printStyle = `@media print {
    @page { size: A4 portrait; margin: 8mm; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 12px; }
    .no-print { display: none !important; }
    .section-card { break-inside: avoid; margin-bottom: 6mm; }
    input, textarea { border: none !important; background: transparent !important; padding: 0 !important; }
  }`;

  return (
    <div style={{ minHeight:"100vh", background:"#f1f5f9", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{printStyle}</style>

      {/* 헤더 */}
      <header className="no-print" style={{ background:"#0f2744", color:"#fff", padding:"12px 20px",
        display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 8px rgba(0,0,0,0.18)", flexWrap:"wrap" }}>
        <span style={{ fontWeight:800, fontSize:16 }}>일일 현황판</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center" }}>
          {filterName && (
            <span style={{ display:"inline-flex", alignItems:"center", gap:4,
              background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"3px 10px", fontSize:12, fontWeight:700 }}>
              "{filterName}" 하이라이트
              <button onClick={() => setFilterName("")} style={{ background:"none", border:"none", cursor:"pointer",
                color:"#92400e", fontSize:13, padding:0, lineHeight:1, fontWeight:800 }}>✕</button>
            </span>
          )}
          {editMode ? (
            <>
              <button onClick={saveEdit} disabled={saving}
                style={{ ...S.actionBtn, background:"#059669", color:"#fff" }}>
                {saving ? "저장 중..." : "💾 저장"}
              </button>
              <button onClick={cancelEdit}
                style={{ ...S.actionBtn, background:"#64748b", color:"#fff" }}>취소</button>
            </>
          ) : (
            <>
              <button onClick={startEdit} style={{ ...S.navBtn, background:"#1e3a5f" }}>✏️ 수정</button>
              <button onClick={captureToClipboard} disabled={capturing}
                style={{ ...S.navBtn, background:"#0ea5e9" }}>
                {capturing ? "캡처 중..." : "📋 공지"}
              </button>
              <button onClick={() => window.print()} style={{ ...S.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
            </>
          )}
        </div>
      </header>

      {/* 날짜 바 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0",
        padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <button onClick={() => changeDate(-1)} style={S.dayBtn}>◀</button>
        <input type="date" value={date} onChange={e => { setDate(e.target.value); setEditMode(false); }}
          style={{ border:"1px solid #e2e8f0", borderRadius:6, padding:"5px 12px",
            fontSize:16, fontWeight:700, color:"#0f2744" }} />
        <button onClick={() => changeDate(1)} style={S.dayBtn}>▶</button>
        <span style={{ fontSize:18, fontWeight:800, color:"#0f2744" }}>{dateLabel}</span>
        {editMode && <span style={{ fontSize:13, color:"#0ea5e9", fontWeight:700 }}>— 수정 모드</span>}
        {!editMode && savedOverride && <span style={{ fontSize:12, color:"#64748b" }}>✓ 수정됨</span>}
      </div>

      {/* 본문 (캡처 대상) */}
      <div ref={boardRef}>
        {/* 인쇄용 제목 */}
        <div style={{ textAlign:"center", padding:"6px 0 2px", fontWeight:900, fontSize:20, color:"#0f2744" }}>
          {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 현황판
        </div>

        <div style={{ padding: isMobile ? "10px" : "14px 18px", display:"flex", flexDirection:"column", gap:14 }}>

          {/* 입원 */}
          <Section title="입   원" titleBg="#fef08a" titleColor="#78350f">
            <Table cols={[
              { label:"호  실", width:100 },
              { label:"이름 (주치의)", width:160 },
              { label:"입/퇴원 시간", width:130 },
              { label:"기   타", flex:1 },
            ]}>
              {dAdm.map(row => (
                <EditRow key={row.id} onDelete={editMode ? () => deleteRow(setEditAdm, row.id) : null}
                  highlight={filterName && row.name?.includes(filterName)}>
                  <EditCell width={100} value={row.room} placeholder="예: 306-1"
                    onChange={editMode ? v => updateRow(setEditAdm, row.id, "room", v) : null} />
                  <td style={{ padding:"4px 6px", borderRight:"1px solid #e2e8f0", minWidth:160, verticalAlign:"middle" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:4, flexWrap:"wrap" }}>
                      {row.isNew && <span style={{ fontSize:13, background:"#fef08a", color:"#713f12",
                        borderRadius:4, padding:"1px 5px", fontWeight:800, flexShrink:0 }}>★신환</span>}
                      <input value={row.name} readOnly={!editMode}
                        onChange={editMode ? e => updateRow(setEditAdm, row.id, "name", e.target.value) : undefined}
                        placeholder="이름" style={{ ...S.cell, flex:1, minWidth:60 }} />
                      <span style={{ color:"#94a3b8", fontSize:14 }}>(</span>
                      <input value={row.doctor} readOnly={!editMode}
                        onChange={editMode ? e => updateRow(setEditAdm, row.id, "doctor", e.target.value) : undefined}
                        placeholder="주치의" style={{ ...S.cell, width:44 }} />
                      <span style={{ color:"#94a3b8", fontSize:14 }}>)</span>
                      {editMode && (
                        <button onClick={() => updateRow(setEditAdm, row.id, "isNew", !row.isNew)} title="신환 토글"
                          style={{ fontSize:12, background: row.isNew?"#fef08a":"#f1f5f9",
                            border:"1px solid", borderColor: row.isNew?"#fcd34d":"#e2e8f0",
                            borderRadius:4, padding:"1px 6px", cursor:"pointer",
                            color: row.isNew?"#713f12":"#94a3b8", flexShrink:0, fontWeight:700 }}>★</button>
                      )}
                    </div>
                  </td>
                  <EditCell width={130} value={row.time} placeholder="18:30/저녁식사"
                    onChange={editMode ? v => updateRow(setEditAdm, row.id, "time", v) : null} />
                  <EditCell flex={1} value={row.note} placeholder="나이·진단명·치료병원·치료단계"
                    onChange={editMode ? v => updateRow(setEditAdm, row.id, "note", v) : null} />
                </EditRow>
              ))}
            </Table>
            {editMode && <AddRowBtn onClick={() => addRow(setEditAdm, EMPTY_ADM)} />}
          </Section>

          {/* 퇴원 */}
          <Section title="퇴   원" titleBg="#bfdbfe" titleColor="#1e3a5f">
            <Table cols={[
              { label:"호  실", width:100 },
              { label:"이   름", width:140 },
              { label:"입/퇴원 시간", width:130 },
              { label:"기   타 (재입원 일정 등)", flex:1 },
            ]}>
              {dDis.map(row => (
                <EditRow key={row.id} onDelete={editMode ? () => deleteRow(setEditDis, row.id) : null}
                  highlight={filterName && row.name?.includes(filterName)}>
                  <EditCell width={100} value={row.room} placeholder="예: 505"
                    onChange={editMode ? v => updateRow(setEditDis, row.id, "room", v) : null} />
                  <EditCell width={140} value={row.name} placeholder="이름"
                    onChange={editMode ? v => updateRow(setEditDis, row.id, "name", v) : null} />
                  <EditCell width={130} value={row.time} placeholder="오전 / 점심 후"
                    onChange={editMode ? v => updateRow(setEditDis, row.id, "time", v) : null} />
                  <EditCell flex={1} value={row.note} placeholder="3/28 재입원 등"
                    onChange={editMode ? v => updateRow(setEditDis, row.id, "note", v) : null} />
                </EditRow>
              ))}
            </Table>
            {editMode && <AddRowBtn onClick={() => addRow(setEditDis, EMPTY_DIS)} />}
          </Section>

          {/* 하단 2열 */}
          <div style={{ display:"flex", gap:14, alignItems:"flex-start", flexWrap: isMobile?"wrap":"nowrap" }}>

            {/* 좌: 전실 + 자리보존 */}
            <div style={{ display:"flex", flexDirection:"column", gap:14,
              flex:"0 0 auto", minWidth: isMobile?"100%":380 }}>

              <Section title="<전  실>" titleBg="#d1fae5" titleColor="#065f46">
                <Table cols={[
                  { label:"이   름", width:100 },
                  { label:"기존 병실", width:90 },
                  { label:"이동 병실", width:90 },
                  { label:"이동 시간", flex:1 },
                ]}>
                  {dTrn.map(row => (
                    <EditRow key={row.id} onDelete={editMode ? () => deleteRow(setEditTrn, row.id) : null}
                      highlight={filterName && row.name?.includes(filterName)}>
                      <EditCell width={100} value={row.name} placeholder="이름"
                        onChange={editMode ? v => updateRow(setEditTrn, row.id, "name", v) : null} />
                      <EditCell width={90} value={row.fromRoom} placeholder="201-1"
                        onChange={editMode ? v => updateRow(setEditTrn, row.id, "fromRoom", v) : null} />
                      <EditCell width={90} value={row.toRoom} placeholder="501-4"
                        onChange={editMode ? v => updateRow(setEditTrn, row.id, "toRoom", v) : null} />
                      <EditCell flex={1} value={row.time} placeholder="아침식사후"
                        onChange={editMode ? v => updateRow(setEditTrn, row.id, "time", v) : null} />
                    </EditRow>
                  ))}
                </Table>
                {editMode && <AddRowBtn onClick={() => addRow(setEditTrn, EMPTY_TRN)} />}
              </Section>

              <Section title="<자리 보존>" titleBg="#ede9fe" titleColor="#4c1d95">
                <Table cols={[
                  { label:"이   름", width:100 },
                  { label:"병   실", width:80 },
                  { label:"퇴원 날짜", width:95 },
                  { label:"재입원", flex:1 },
                ]}>
                  {dRes.map(row => (
                    <EditRow key={row.id} onDelete={editMode ? () => deleteRow(setEditRes, row.id) : null}
                      highlight={filterName && row.name?.includes(filterName)}>
                      <EditCell width={100} value={row.name} placeholder="이름"
                        onChange={editMode ? v => updateRow(setEditRes, row.id, "name", v) : null} />
                      <EditCell width={80} value={row.room} placeholder="306-1"
                        onChange={editMode ? v => updateRow(setEditRes, row.id, "room", v) : null} />
                      <EditCell width={95} value={row.dischargeDate} placeholder="3/21"
                        onChange={editMode ? v => updateRow(setEditRes, row.id, "dischargeDate", v) : null} />
                      <EditCell flex={1} value={row.readmitDate} placeholder="3/28 재입원"
                        onChange={editMode ? v => updateRow(setEditRes, row.id, "readmitDate", v) : null} />
                    </EditRow>
                  ))}
                </Table>
                {editMode && <AddRowBtn onClick={() => addRow(setEditRes, EMPTY_RES)} />}
              </Section>
            </div>

            {/* 우: 치료실 이용계획 */}
            <Section title="<치료실 이용계획>" titleBg="#fef3c7" titleColor="#92400e" style={{ flex:1 }}>
              <div className="no-print" style={{ padding:"4px 12px", fontSize:13, color:"#92400e",
                background:"#fffbeb", borderBottom:"1px solid #fde68a" }}>
                치료사: {therapists[0]} / {therapists[1]} &nbsp;
                <span style={{ color:"#a16207", fontSize:12 }}>(치료실 스케줄 자동 연동)</span>
              </div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%", minWidth:500 }}>
                  <thead>
                    <tr>
                      <th style={{ ...S.th, width:110, background:"#fef3c7", color:"#92400e" }}>시간</th>
                      {therapyCols.map(c => (
                        <th key={c.key} style={{ ...S.th, background:"#fef3c7", color:"#92400e", whiteSpace:"pre-line" }}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {THERAPY_SLOTS.map(slot => {
                      const auto = autoTherapy[slot] || {};
                      return (
                        <tr key={slot} style={{ background: slot.startsWith("13") ? "#fffbeb":"#fff" }}>
                          <td style={{ ...S.td, background:"#fef9c3", fontWeight:700, fontSize:15,
                            textAlign:"center", color:"#78350f", whiteSpace:"nowrap" }}>{slot}</td>
                          {therapyCols.map(c => {
                            const manual = dTher[slot]?.[c.key];
                            const autoVal = auto[c.key] || "";
                            const display = manual || autoVal;
                            return (
                              <td key={c.key} style={{ ...S.td, verticalAlign:"top", padding:3, position:"relative" }}>
                                {editMode ? (
                                  <>
                                    {autoVal && !manual && (
                                      <div style={{ fontSize:14, color:"#4b5563", whiteSpace:"pre-wrap",
                                        lineHeight:1.5, padding:"2px 4px", background:"#f0f9ff",
                                        borderRadius:4, border:"1px solid #bae6fd" }}>{autoVal}</div>
                                    )}
                                    <textarea value={manual||""} onChange={e => updateTherapy(slot, c.key, e.target.value)}
                                      rows={2} placeholder={autoVal ? "" : "이름(병실)"}
                                      style={{ width:"100%", border: manual ? "1px solid #fcd34d" : "1px dashed #e2e8f0",
                                        background: manual ? "#fffbeb" : "transparent",
                                        resize:"vertical", fontSize:14, fontFamily:"inherit",
                                        padding:3, minHeight:44, outline:"none", lineHeight:1.6,
                                        borderRadius:4, marginTop: autoVal && !manual ? 3 : 0 }} />
                                  </>
                                ) : display ? (
                                  <div style={{ fontSize:14, color:"#4b5563", whiteSpace:"pre-wrap",
                                    lineHeight:1.5, padding:"2px 4px",
                                    background: manual ? "#fffbeb" : autoVal ? "#f0f9ff" : "transparent",
                                    borderRadius:4, border: autoVal && !manual ? "1px solid #bae6fd" : "none" }}>
                                    {display}
                                  </div>
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
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 서브 컴포넌트 ── */
function Section({ title, titleBg, titleColor, children, style }) {
  return (
    <div className="section-card" style={{ background:"#fff", borderRadius:10,
      border:"1px solid #e2e8f0", overflow:"hidden", ...style }}>
      <div style={{ background:titleBg, color:titleColor, fontWeight:900,
        fontSize:18, padding:"8px 16px", letterSpacing:2 }}>{title}</div>
      {children}
    </div>
  );
}

function Table({ cols, children }) {
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ borderCollapse:"collapse", width:"100%" }}>
        <thead>
          <tr>
            {cols.map((c,i) => <th key={i} style={{ ...S.th, width:c.width }}>{c.label}</th>)}
            <th style={{ ...S.th, width:32 }} className="no-print" />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function EditRow({ children, onDelete, highlight }) {
  return (
    <tr style={{ borderBottom:"1px solid #e2e8f0", background: highlight ? "#fef3c7" : "transparent" }}>
      {children}
      <td className="no-print" style={{ padding:"2px 4px", textAlign:"center", width:32 }}>
        {onDelete && (
          <button onClick={onDelete} title="삭제"
            style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444",
              fontSize:18, lineHeight:1 }}>✕</button>
        )}
      </td>
    </tr>
  );
}

function EditCell({ value, onChange, placeholder, width, flex }) {
  return (
    <td style={{ padding:"3px 4px", borderRight:"1px solid #e2e8f0", width, verticalAlign:"middle" }}>
      <input value={value||""} readOnly={!onChange}
        onChange={onChange ? e => onChange(e.target.value) : undefined}
        placeholder={placeholder}
        style={{ ...S.cell, width:"100%" }} />
    </td>
  );
}

function AddRowBtn({ onClick }) {
  return (
    <div className="no-print" style={{ padding:"5px 8px" }}>
      <button onClick={onClick}
        style={{ background:"none", border:"1px dashed #cbd5e1", borderRadius:6, color:"#64748b",
          cursor:"pointer", fontSize:15, padding:"4px 14px", width:"100%", fontWeight:600 }}>
        + 행 추가
      </button>
    </div>
  );
}

const S = {
  navBtn: {
    background:"rgba(255,255,255,0.1)", color:"#e2e8f0", border:"1px solid rgba(255,255,255,0.2)",
    borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600,
  },
  dayBtn: {
    background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:6,
    padding:"5px 12px", cursor:"pointer", fontSize:16, fontWeight:700,
  },
  actionBtn: {
    border:"none", borderRadius:6, padding:"7px 16px", cursor:"pointer", fontSize:15, fontWeight:700,
  },
  th: {
    background:"#f8fafc", borderBottom:"2px solid #e2e8f0", borderRight:"1px solid #e2e8f0",
    padding:"7px 8px", fontSize:15, fontWeight:700, color:"#374151",
    textAlign:"center", whiteSpace:"nowrap",
  },
  td: {
    border:"1px solid #e2e8f0", padding:"5px 7px", fontSize:15,
  },
  cell: {
    border:"none", outline:"none", background:"transparent", fontSize:16,
    padding:"2px 4px", fontFamily:"inherit", color:"#1e293b", width:"100%",
  },
};

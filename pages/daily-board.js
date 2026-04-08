import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];
const THERAPY_SLOTS = ["09:00~10:00","10:00~11:00","11:00~12:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];
const TREAT_NAMES = { pain:"페인", manip2:"도수2", manip1:"도수1" };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function parseMD(str, refDate) {
  if (!str || str==="미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const year = refDate ? new Date(refDate).getFullYear() : new Date().getFullYear();
  return `${year}-${String(parseInt(m[1])).padStart(2,"0")}-${String(parseInt(m[2])).padStart(2,"0")}`;
}
function uid() { return Math.random().toString(36).slice(2,9); }
function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + offset);
  monday.setHours(0,0,0,0);
  return monday.toISOString().slice(0,10);
}
function getDayIdx(dateStr) {
  const dow = new Date(dateStr).getDay();
  return dow === 0 ? 6 : dow - 1;
}
function buildCellText(cell, useTreatNames) {
  if (!cell) return "";
  const name = cell.isPending ? (cell.patientName || "") : (cell.name || "");
  if (!name) return "";
  const room = cell.roomId || "";
  const treatName = useTreatNames ? (TREAT_NAMES[cell.treatmentId] || "") : "";
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
  const [date, setDate] = useState(todayStr());
  const [admissions,  setAdmissions]  = useState([EMPTY_ADM()]);
  const [discharges,  setDischarges]  = useState([EMPTY_DIS()]);
  const [transfers,   setTransfers]   = useState([EMPTY_TRN()]);
  const [reservedBeds,setReservedBeds]= useState([EMPTY_RES()]);
  const [therapy,     setTherapy]     = useState(EMPTY_THERAPY());
  const [saving,      setSaving]      = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [lastSaved,   setLastSaved]   = useState(null);
  const [filterName,  setFilterName]  = useState("");

  const [physSched,   setPhysSched]   = useState({});
  const [hyperSched,  setHyperSched]  = useState({});
  const [therapists,  setTherapists]  = useState(["치료사1", "치료사2"]);

  const wk     = useMemo(() => getWeekKey(date), [date]);
  const dayIdx = useMemo(() => getDayIdx(date), [date]);

  useEffect(() => {
    const u = onValue(ref(db, `dailyBoards/${date}`), snap => {
      const v = snap.val();
      if (!v) {
        setAdmissions([EMPTY_ADM()]); setDischarges([EMPTY_DIS()]);
        setTransfers([EMPTY_TRN()]); setReservedBeds([EMPTY_RES()]);
        setTherapy(EMPTY_THERAPY());
        return;
      }
      setAdmissions(v.admissions?.length ? v.admissions : [EMPTY_ADM()]);
      setDischarges(v.discharges?.length ? v.discharges : [EMPTY_DIS()]);
      setTransfers(v.transfers?.length   ? v.transfers  : [EMPTY_TRN()]);
      setReservedBeds(v.reservedBeds?.length ? v.reservedBeds : [EMPTY_RES()]);
      setTherapy({ ...EMPTY_THERAPY(), ...(v.therapy || {}) });
    });
    return () => u();
  }, [date]);

  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) setFilterName(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  useEffect(() => {
    const u1 = onValue(ref(db, `physicalSchedule/${wk}`),      snap => setPhysSched(snap.val()||{}));
    const u2 = onValue(ref(db, `hyperthermiaSchedule/${wk}`),  snap => setHyperSched(snap.val()||{}));
    const u3 = onValue(ref(db, "settings"), snap => {
      const v = snap.val()||{};
      setTherapists([v.therapist1||"치료사1", v.therapist2||"치료사2"]);
    });
    return () => { u1(); u2(); u3(); };
  }, [wk]);

  const autoTherapy = useMemo(() => {
    const t = {};
    THERAPY_SLOTS.forEach(slot => {
      const st = slot.split("~")[0];
      t[slot] = {
        highFreq:   buildCellText(hyperSched?.["hyperthermia"]?.[dayIdx]?.[st], false),
        physio1:    buildCellText(physSched?.[therapists[0]]?.[dayIdx]?.[st],   true),
        physio2:    buildCellText(physSched?.[therapists[1]]?.[dayIdx]?.[st],   true),
        hyperbaric: buildCellText(hyperSched?.["hyperbaric"]?.[dayIdx]?.[st],   false),
      };
    });
    return t;
  }, [physSched, hyperSched, therapists, dayIdx]);

  const therapyCols = useMemo(() => [
    { key:"highFreq",   label:"고주파", color:"#dc2626" },
    { key:"physio1",    label:therapists[0], color:"#059669" },
    { key:"physio2",    label:therapists[1], color:"#1d4ed8" },
    { key:"hyperbaric", label:"고압산소", color:"#0284c7" },
  ], [therapists]);

  const save = useCallback(async (adm, dis, trn, res, ther) => {
    setSaving(true);
    await set(ref(db, `dailyBoards/${date}`), {
      admissions: adm, discharges: dis, transfers: trn, reservedBeds: res, therapy: ther,
    });
    setSaving(false);
    setLastSaved(new Date());
  }, [date]);

  const autoFill = useCallback(async () => {
    setAutoFilling(true);
    const [slotsSnap, consSnap, pendingSnap] = await Promise.all([
      get(ref(db,"slots")), get(ref(db,"consultations")), get(ref(db,"pendingChanges")),
    ]);
    const slots = slotsSnap.val() || {};
    const consultations = consSnap.val() || {};
    const pending = pendingSnap.val() || {};

    const newAdm = [], newDis = [], newTrn = [];

    Object.entries(slots).forEach(([slotKey, slot]) => {
      const [roomId, bedNum] = slotKey.split("-");
      const roomLabel = `${roomId}-${bedNum}`;
      const cur = slot?.current;
      if (cur?.name) {
        if (parseMD(cur.admitDate, date) === date)
          newAdm.push({ id:uid(), room:roomLabel, name:cur.name, doctor:"", time:"", note:cur.note||"", isNew:false });
        if (parseMD(cur.discharge, date) === date)
          newDis.push({ id:uid(), room:roomLabel, name:cur.name, time:"", note:"" });
      }
      (slot?.reservations||[]).forEach(r => {
        if (!r?.name) return;
        if (parseMD(r.admitDate, date) === date)
          newAdm.push({ id:uid(), room:roomLabel, name:r.name, doctor:"", time:"", note:r.note||"", isNew:false });
        if (parseMD(r.discharge, date) === date)
          newDis.push({ id:uid(), room:roomLabel, name:r.name, time:"", note:"" });
      });
    });

    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      if (c.admitDate !== date) return;
      if (newAdm.some(a => a.name === c.name)) return;
      const noteFields = [];
      if (c.birthYear) noteFields.push(`${new Date().getFullYear()-parseInt(c.birthYear)}세`);
      if (c.diagnosis) noteFields.push(c.diagnosis);
      if (c.hospital)  noteFields.push(c.hospital);
      if (c.surgery)   noteFields.push(c.surgeryDate ? `수술후(${c.surgeryDate})` : "수술후");
      if (c.chemo)     noteFields.push(c.chemoDate   ? `항암(${c.chemoDate})`     : "항암중");
      if (c.radiation) noteFields.push("방사선");
      newAdm.push({ id:uid(), room:c.roomTypes?.join("/")||"", name:c.name, doctor:"", time:"",
        note: noteFields.join(" · "), isNew:true });
    });

    Object.values(pending).forEach(p => {
      if (!p?.parsed || p.parsed.action !== "transfer") return;
      if (!p.ts || p.ts.slice(0,10) !== date) return;
      if (!p.parsed.name) return;
      const fromRoom = p.suggestedSlotKey || p.parsed.slotKey || "";
      const toRoom   = p.parsed.transferToRoom || "";
      if (fromRoom || toRoom) newTrn.push({ id:uid(), name:p.parsed.name, fromRoom, toRoom, time:"" });
    });

    setAdmissions(newAdm.length ? newAdm : [EMPTY_ADM()]);
    setDischarges(newDis.length ? newDis : [EMPTY_DIS()]);
    if (newTrn.length) setTransfers(newTrn);
    setTherapy(autoTherapy);
    setAutoFilling(false);
  }, [date, autoTherapy]);

  function changeDate(delta) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  }

  function updateRow(setter, id, field, val) {
    setter(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function addRow(setter, empty) { setter(rows => [...rows, empty()]); }
  function deleteRow(setter, id) { setter(rows => rows.filter(r => r.id !== id)); }
  function updateTherapy(slot, col, val) {
    setTherapy(t => ({ ...t, [slot]: { ...t[slot], [col]:val } }));
  }

  const dateObj   = new Date(date);
  const dow       = DOW[dateObj.getDay()];
  const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

  return (
    <div style={{ minHeight:"100vh", background:"#f0f2f5", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{PRINT_CSS}</style>

      {/* ── 헤더 ── */}
      <header className="no-print" style={{ background:"linear-gradient(135deg,#0f2744 0%,#1e3a5f 100%)",
        color:"#fff", padding:"10px 20px", display:"flex", alignItems:"center", gap:12,
        position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 12px rgba(0,0,0,0.2)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={() => changeDate(-1)} style={S.navArrow}>‹</button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
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
          <span style={{ fontSize:11, color:"#94a3b8" }}>일일 현황판</span>
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
          {lastSaved && <span style={{ fontSize:11, color:"#94a3b8" }}>✓ {lastSaved.toLocaleTimeString("ko")}</span>}
          <button onClick={autoFill} disabled={autoFilling}
            style={{ ...S.headerBtn, background:"rgba(14,165,233,0.2)", border:"1px solid rgba(14,165,233,0.4)" }}>
            {autoFilling ? "..." : "⚡ 자동채우기"}
          </button>
          <button onClick={() => save(admissions, discharges, transfers, reservedBeds, therapy)} disabled={saving}
            style={{ ...S.headerBtn, background:"rgba(5,150,105,0.25)", border:"1px solid rgba(5,150,105,0.5)" }}>
            {saving ? "..." : "💾 저장"}
          </button>
          <button onClick={() => window.print()}
            style={{ ...S.headerBtn, background:"rgba(255,255,255,0.08)", border:"1px solid rgba(255,255,255,0.15)" }}>🖨</button>
        </div>
      </header>

      {/* 인쇄용 제목 */}
      <div className="print-title" style={{ display:"none", textAlign:"center", padding:"8px 0 4px",
        fontWeight:900, fontSize:22, color:"#0f2744", borderBottom:"2px solid #0f2744", marginBottom:8 }}>
        {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 ({dow}) 현황판
      </div>

      <div style={{ padding: isMobile ? "10px" : "12px 16px", display:"flex", flexDirection:"column", gap:12 }}>

        {/* ── 입원 / 퇴원 2열 ── */}
        <div style={{ display:"flex", gap:12, flexWrap: isMobile?"wrap":"nowrap" }}>

          {/* 입원 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="↑" label="입원" count={admissions.filter(r=>r.name).length}
              color="#059669" bg="#ecfdf5" borderColor="#a7f3d0" />
            <div style={{ background:"#fff", border:"1px solid #d1fae5", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
              {admissions.map(row => (
                <div key={row.id} style={{ display:"flex", gap:6, padding:"6px 10px",
                  borderBottom:"1px solid #f0fdf4", alignItems:"center",
                  background: (filterName && row.name?.includes(filterName)) ? "#fef3c7" : "transparent" }}>
                  <Field w={75} value={row.room} onChange={v => updateRow(setAdmissions, row.id, "room", v)}
                    placeholder="호실" style={{ fontWeight:800, color:"#059669", textAlign:"center" }} />
                  <div style={{ display:"flex", alignItems:"center", gap:3, minWidth:120 }}>
                    {row.isNew && <span style={{ fontSize:11, background:"#fef08a", color:"#713f12",
                      borderRadius:3, padding:"0 4px", fontWeight:800, flexShrink:0 }}>★</span>}
                    <Field w={70} value={row.name} onChange={v => updateRow(setAdmissions, row.id, "name", v)}
                      placeholder="이름" style={{ fontWeight:700 }} />
                    <span style={{ color:"#d1d5db", fontSize:12 }}>/</span>
                    <Field w={40} value={row.doctor} onChange={v => updateRow(setAdmissions, row.id, "doctor", v)}
                      placeholder="Dr" style={{ color:"#64748b", fontSize:13 }} />
                    <button className="no-print" onClick={() => updateRow(setAdmissions, row.id, "isNew", !row.isNew)}
                      style={{ fontSize:11, background:row.isNew?"#fef08a":"#f8fafc", border:"1px solid",
                        borderColor:row.isNew?"#fcd34d":"#e2e8f0", borderRadius:3, padding:"0 4px",
                        cursor:"pointer", color:row.isNew?"#713f12":"#cbd5e1", flexShrink:0, fontWeight:800, lineHeight:"18px" }}>★</button>
                  </div>
                  <Field w={80} value={row.time} onChange={v => updateRow(setAdmissions, row.id, "time", v)}
                    placeholder="시간" style={{ color:"#0891b2", textAlign:"center" }} />
                  <Field flex={1} value={row.note} onChange={v => updateRow(setAdmissions, row.id, "note", v)}
                    placeholder="비고" style={{ color:"#64748b", fontSize:13 }} />
                  <DelBtn onClick={() => deleteRow(setAdmissions, row.id)} />
                </div>
              ))}
              <AddBtn onClick={() => addRow(setAdmissions, EMPTY_ADM)} />
            </div>
          </div>

          {/* 퇴원 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="↓" label="퇴원" count={discharges.filter(r=>r.name).length}
              color="#dc2626" bg="#fef2f2" borderColor="#fecaca" />
            <div style={{ background:"#fff", border:"1px solid #fecaca", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
              {discharges.map(row => (
                <div key={row.id} style={{ display:"flex", gap:6, padding:"6px 10px",
                  borderBottom:"1px solid #fff5f5", alignItems:"center",
                  background: (filterName && row.name?.includes(filterName)) ? "#fef3c7" : "transparent" }}>
                  <Field w={75} value={row.room} onChange={v => updateRow(setDischarges, row.id, "room", v)}
                    placeholder="호실" style={{ fontWeight:800, color:"#dc2626", textAlign:"center" }} />
                  <Field w={90} value={row.name} onChange={v => updateRow(setDischarges, row.id, "name", v)}
                    placeholder="이름" style={{ fontWeight:700 }} />
                  <Field w={80} value={row.time} onChange={v => updateRow(setDischarges, row.id, "time", v)}
                    placeholder="시간" style={{ color:"#0891b2", textAlign:"center" }} />
                  <Field flex={1} value={row.note} onChange={v => updateRow(setDischarges, row.id, "note", v)}
                    placeholder="재입원 일정 등" style={{ color:"#64748b", fontSize:13 }} />
                  <DelBtn onClick={() => deleteRow(setDischarges, row.id)} />
                </div>
              ))}
              <AddBtn onClick={() => addRow(setDischarges, EMPTY_DIS)} />
            </div>
          </div>
        </div>

        {/* ── 전실 / 자리보존 2열 ── */}
        <div style={{ display:"flex", gap:12, flexWrap: isMobile?"wrap":"nowrap" }}>

          {/* 전실 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="⇄" label="전실" count={transfers.filter(r=>r.name).length}
              color="#0369a1" bg="#f0f9ff" borderColor="#bae6fd" />
            <div style={{ background:"#fff", border:"1px solid #bae6fd", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
              {transfers.map(row => (
                <div key={row.id} style={{ display:"flex", gap:6, padding:"6px 10px",
                  borderBottom:"1px solid #f0f9ff", alignItems:"center",
                  background: (filterName && row.name?.includes(filterName)) ? "#fef3c7" : "transparent" }}>
                  <Field w={80} value={row.name} onChange={v => updateRow(setTransfers, row.id, "name", v)}
                    placeholder="이름" style={{ fontWeight:700 }} />
                  <Field w={65} value={row.fromRoom} onChange={v => updateRow(setTransfers, row.id, "fromRoom", v)}
                    placeholder="기존" style={{ textAlign:"center", color:"#64748b" }} />
                  <span style={{ color:"#0369a1", fontWeight:800, fontSize:14, flexShrink:0 }}>→</span>
                  <Field w={65} value={row.toRoom} onChange={v => updateRow(setTransfers, row.id, "toRoom", v)}
                    placeholder="이동" style={{ textAlign:"center", color:"#0369a1", fontWeight:700 }} />
                  <Field flex={1} value={row.time} onChange={v => updateRow(setTransfers, row.id, "time", v)}
                    placeholder="시간" style={{ color:"#64748b", fontSize:13 }} />
                  <DelBtn onClick={() => deleteRow(setTransfers, row.id)} />
                </div>
              ))}
              <AddBtn onClick={() => addRow(setTransfers, EMPTY_TRN)} />
            </div>
          </div>

          {/* 자리보존 */}
          <div style={{ flex:1, minWidth: isMobile?"100%":0 }}>
            <SectionHeader icon="🔒" label="자리 보존" count={reservedBeds.filter(r=>r.name).length}
              color="#7c3aed" bg="#faf5ff" borderColor="#ddd6fe" />
            <div style={{ background:"#fff", border:"1px solid #ddd6fe", borderTop:"none", borderRadius:"0 0 10px 10px" }}>
              {reservedBeds.map(row => (
                <div key={row.id} style={{ display:"flex", gap:6, padding:"6px 10px",
                  borderBottom:"1px solid #faf5ff", alignItems:"center",
                  background: (filterName && row.name?.includes(filterName)) ? "#fef3c7" : "transparent" }}>
                  <Field w={80} value={row.name} onChange={v => updateRow(setReservedBeds, row.id, "name", v)}
                    placeholder="이름" style={{ fontWeight:700 }} />
                  <Field w={65} value={row.room} onChange={v => updateRow(setReservedBeds, row.id, "room", v)}
                    placeholder="병실" style={{ textAlign:"center", color:"#7c3aed" }} />
                  <Field w={70} value={row.dischargeDate} onChange={v => updateRow(setReservedBeds, row.id, "dischargeDate", v)}
                    placeholder="퇴원일" style={{ textAlign:"center", color:"#64748b", fontSize:13 }} />
                  <Field flex={1} value={row.readmitDate} onChange={v => updateRow(setReservedBeds, row.id, "readmitDate", v)}
                    placeholder="재입원 일정" style={{ color:"#64748b", fontSize:13 }} />
                  <DelBtn onClick={() => deleteRow(setReservedBeds, row.id)} />
                </div>
              ))}
              <AddBtn onClick={() => addRow(setReservedBeds, EMPTY_RES)} />
            </div>
          </div>
        </div>

        {/* ── 치료실 이용계획 ── */}
        <div>
          <SectionHeader icon="💊" label="치료실 이용계획" color="#92400e" bg="#fffbeb" borderColor="#fde68a"
            right={<span className="no-print" style={{ fontSize:11, color:"#a16207", fontWeight:500 }}>치료실 스케줄 자동 연동</span>} />
          <div style={{ background:"#fff", border:"1px solid #fde68a", borderTop:"none",
            borderRadius:"0 0 10px 10px", overflowX:"auto" }}>
            <table style={{ borderCollapse:"collapse", width:"100%", minWidth:520 }}>
              <thead>
                <tr>
                  <th style={{ ...S.thTh, width:100, background:"#fefce8" }}>시간</th>
                  {therapyCols.map(c => (
                    <th key={c.key} style={{ ...S.thTh }}>
                      <span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%",
                        background:c.color, marginRight:5, verticalAlign:"middle" }}/>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {THERAPY_SLOTS.map(slot => {
                  const auto = autoTherapy[slot] || {};
                  const isAfternoon = slot.startsWith("13");
                  return (
                    <tr key={slot}>
                      <td style={{ padding:"4px 6px", borderBottom:"1px solid #f5f5f4", borderRight:"1px solid #f5f5f4",
                        fontWeight:800, fontSize:13, textAlign:"center", color:"#78350f",
                        background: isAfternoon ? "#fefce8" : "#fafaf9", whiteSpace:"nowrap" }}>
                        {slot}
                      </td>
                      {therapyCols.map(c => {
                        const manual = therapy[slot]?.[c.key];
                        const autoVal = auto[c.key] || "";
                        return (
                          <td key={c.key} style={{ padding:3, borderBottom:"1px solid #f5f5f4",
                            borderRight:"1px solid #f5f5f4", verticalAlign:"top",
                            background: isAfternoon ? "#fffef5" : "#fff" }}>
                            {autoVal && !manual && (
                              <div style={{ fontSize:13, color:"#374151", whiteSpace:"pre-wrap",
                                lineHeight:1.5, padding:"2px 5px", background:"#f0f9ff",
                                borderRadius:4, border:"1px solid #dbeafe" }}>
                                {autoVal}
                              </div>
                            )}
                            <textarea value={manual || ""} onChange={e => updateTherapy(slot, c.key, e.target.value)}
                              rows={2} placeholder={autoVal ? "" : "-"}
                              style={{ width:"100%", border: manual ? "1px solid #fcd34d" : "1px solid transparent",
                                background: manual ? "#fffbeb" : "transparent",
                                resize:"vertical", fontSize:13, fontFamily:"inherit",
                                padding:"2px 5px", minHeight:40, outline:"none", lineHeight:1.5,
                                borderRadius:4, marginTop: autoVal && !manual ? 2 : 0 }} />
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
function SectionHeader({ icon, label, count, color, bg, borderColor, right }) {
  return (
    <div style={{ background:bg, border:`1px solid ${borderColor}`, borderBottom:"none",
      borderRadius:"10px 10px 0 0", padding:"7px 14px",
      display:"flex", alignItems:"center", gap:8 }}>
      <span style={{ fontSize:16 }}>{icon}</span>
      <span style={{ fontWeight:900, fontSize:16, color, letterSpacing:1 }}>{label}</span>
      {count > 0 && <span style={{ fontSize:13, fontWeight:800, color,
        background:"rgba(255,255,255,0.7)", borderRadius:10, padding:"1px 8px" }}>{count}</span>}
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

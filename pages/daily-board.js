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
  const dow = new Date(dateStr).getDay(); // 0=Sun
  return dow === 0 ? 6 : dow - 1; // 0=Mon...6=Sun
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

  // 치료실 스케줄 (선택 날짜 기준 주)
  const [physSched,   setPhysSched]   = useState({});
  const [hyperSched,  setHyperSched]  = useState({});
  const [therapists,  setTherapists]  = useState(["치료사1", "치료사2"]);

  const wk     = useMemo(() => getWeekKey(date), [date]);
  const dayIdx = useMemo(() => getDayIdx(date), [date]);

  // Firebase 보드 데이터 로드
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

  // 치료실 스케줄 + 설정 로드
  useEffect(() => {
    const u1 = onValue(ref(db, `physicalSchedule/${wk}`),      snap => setPhysSched(snap.val()||{}));
    const u2 = onValue(ref(db, `hyperthermiaSchedule/${wk}`),  snap => setHyperSched(snap.val()||{}));
    const u3 = onValue(ref(db, "settings"), snap => {
      const v = snap.val()||{};
      setTherapists([v.therapist1||"치료사1", v.therapist2||"치료사2"]);
    });
    return () => { u1(); u2(); u3(); };
  }, [wk]);

  // 스케줄에서 자동 계산된 치료 그리드
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

  // 치료 컬럼 (therapist 이름 동적 반영)
  const therapyCols = useMemo(() => [
    { key:"highFreq",   label:"고주파 치료" },
    { key:"physio1",    label:`물리치료실\n(${therapists[0]})` },
    { key:"physio2",    label:`물리치료실\n(${therapists[1]})` },
    { key:"hyperbaric", label:"고압산소" },
  ], [therapists]);

  // 저장
  const save = useCallback(async (adm, dis, trn, res, ther) => {
    setSaving(true);
    await set(ref(db, `dailyBoards/${date}`), {
      admissions: adm, discharges: dis, transfers: trn, reservedBeds: res, therapy: ther,
    });
    setSaving(false);
    setLastSaved(new Date());
  }, [date]);

  // 자동 채우기
  const autoFill = useCallback(async () => {
    setAutoFilling(true);
    const [slotsSnap, consSnap, pendingSnap] = await Promise.all([
      get(ref(db,"slots")),
      get(ref(db,"consultations")),
      get(ref(db,"pendingChanges")),
    ]);
    const slots        = slotsSnap.val() || {};
    const consultations= consSnap.val()  || {};
    const pending      = pendingSnap.val()|| {};

    const newAdm = [], newDis = [], newTrn = [];

    // slots 스캔 → 입퇴원
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

    // consultations 스캔 → 신환 (상담일지에서 관련 정보만 선별)
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
      const roomLabel = c.roomTypes?.join("/") || "";
      newAdm.push({ id:uid(), room:roomLabel, name:c.name, doctor:"", time:"",
        note: noteFields.join(" · "), isNew:true });
    });

    // pendingChanges 스캔 → 전실 (해당 날짜 메시지에서 transfer action)
    Object.values(pending).forEach(p => {
      if (!p?.parsed || p.parsed.action !== "transfer") return;
      if (!p.ts || p.ts.slice(0,10) !== date) return;
      if (!p.parsed.name) return;
      const fromRoom = p.suggestedSlotKey || p.parsed.slotKey || "";
      const toRoom   = p.parsed.transferToRoom || "";
      if (fromRoom || toRoom) {
        newTrn.push({ id:uid(), name:p.parsed.name, fromRoom, toRoom, time:"" });
      }
    });

    setAdmissions(newAdm.length ? newAdm : [EMPTY_ADM()]);
    setDischarges(newDis.length ? newDis : [EMPTY_DIS()]);
    if (newTrn.length) setTransfers(newTrn);

    // 치료 스케줄 자동 반영
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
  function addRow(setter, empty)  { setter(rows => [...rows, empty()]); }
  function deleteRow(setter, id)  { setter(rows => rows.filter(r => r.id !== id)); }
  function updateTherapy(slot, col, val) {
    setTherapy(t => ({ ...t, [slot]: { ...t[slot], [col]:val } }));
  }

  const dateObj   = new Date(date);
  const dateLabel = `${dateObj.getFullYear()}년 ${dateObj.getMonth()+1}월 ${dateObj.getDate()}일 (${DOW[dateObj.getDay()]})`;

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
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={() => window.print()} style={{ ...S.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
        </div>
      </header>

      {/* 날짜 바 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0",
        padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <button onClick={() => changeDate(-1)} style={S.dayBtn}>◀</button>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ border:"1px solid #e2e8f0", borderRadius:6, padding:"5px 12px",
            fontSize:16, fontWeight:700, color:"#0f2744" }} />
        <button onClick={() => changeDate(1)} style={S.dayBtn}>▶</button>
        <span style={{ fontSize:18, fontWeight:800, color:"#0f2744" }}>{dateLabel}</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center" }}>
          {lastSaved && <span style={{ fontSize:13, color:"#64748b" }}>✓ {lastSaved.toLocaleTimeString("ko")} 저장됨</span>}
          <button onClick={autoFill} disabled={autoFilling}
            style={{ ...S.actionBtn, background:"#0ea5e9", color:"#fff" }}>
            {autoFilling ? "불러오는 중..." : "⚡ 자동 채우기"}
          </button>
          <button onClick={() => save(admissions, discharges, transfers, reservedBeds, therapy)} disabled={saving}
            style={{ ...S.actionBtn, background:"#059669", color:"#fff" }}>
            {saving ? "저장 중..." : "💾 저장"}
          </button>
        </div>
      </div>

      {/* 인쇄용 제목 */}
      <div style={{ textAlign:"center", padding:"6px 0 2px", fontWeight:900, fontSize:20, color:"#0f2744" }}>
        {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 현황판
      </div>

      <div style={{ padding: isMobile ? "10px" : "14px 18px", display:"flex", flexDirection:"column", gap:14 }}>

        {/* 입원 */}
        <Section title="입   원" titleBg="#fef08a" titleColor="#78350f">
          <Table cols={[
            { label:"호  실",   width:100 },
            { label:"이름 (주치의)", width:160 },
            { label:"입/퇴원 시간", width:130 },
            { label:"기   타", flex:1 },
          ]}>
            {admissions.map(row => (
              <EditRow key={row.id} onDelete={() => deleteRow(setAdmissions, row.id)}>
                <EditCell width={100} value={row.room} placeholder="예: 306-1" onChange={v => updateRow(setAdmissions, row.id, "room", v)} />
                <td style={{ padding:"4px 6px", borderRight:"1px solid #e2e8f0", minWidth:160, verticalAlign:"middle" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4, flexWrap:"wrap" }}>
                    {row.isNew && <span style={{ fontSize:13, background:"#fef08a", color:"#713f12",
                      borderRadius:4, padding:"1px 5px", fontWeight:800, flexShrink:0 }}>★신환</span>}
                    <input value={row.name} onChange={e => updateRow(setAdmissions, row.id, "name", e.target.value)}
                      placeholder="이름" style={{ ...S.cell, flex:1, minWidth:60 }} />
                    <span style={{ color:"#94a3b8", fontSize:14 }}>(</span>
                    <input value={row.doctor} onChange={e => updateRow(setAdmissions, row.id, "doctor", e.target.value)}
                      placeholder="주치의" style={{ ...S.cell, width:44 }} />
                    <span style={{ color:"#94a3b8", fontSize:14 }}>)</span>
                    <button onClick={() => updateRow(setAdmissions, row.id, "isNew", !row.isNew)} title="신환 토글"
                      style={{ fontSize:12, background: row.isNew?"#fef08a":"#f1f5f9",
                        border:"1px solid", borderColor: row.isNew?"#fcd34d":"#e2e8f0",
                        borderRadius:4, padding:"1px 6px", cursor:"pointer",
                        color: row.isNew?"#713f12":"#94a3b8", flexShrink:0, fontWeight:700 }}>
                      ★
                    </button>
                  </div>
                </td>
                <EditCell width={130} value={row.time} placeholder="18:30/저녁식사" onChange={v => updateRow(setAdmissions, row.id, "time", v)} />
                <EditCell flex={1} value={row.note} placeholder="나이·진단명·치료병원·치료단계" onChange={v => updateRow(setAdmissions, row.id, "note", v)} />
              </EditRow>
            ))}
          </Table>
          <AddRowBtn onClick={() => addRow(setAdmissions, EMPTY_ADM)} />
        </Section>

        {/* 퇴원 */}
        <Section title="퇴   원" titleBg="#bfdbfe" titleColor="#1e3a5f">
          <Table cols={[
            { label:"호  실",   width:100 },
            { label:"이   름",  width:140 },
            { label:"입/퇴원 시간", width:130 },
            { label:"기   타 (재입원 일정 등)", flex:1 },
          ]}>
            {discharges.map(row => (
              <EditRow key={row.id} onDelete={() => deleteRow(setDischarges, row.id)}>
                <EditCell width={100} value={row.room}  placeholder="예: 505" onChange={v => updateRow(setDischarges, row.id, "room", v)} />
                <EditCell width={140} value={row.name}  placeholder="이름"    onChange={v => updateRow(setDischarges, row.id, "name", v)} />
                <EditCell width={130} value={row.time}  placeholder="오전 / 점심 후" onChange={v => updateRow(setDischarges, row.id, "time", v)} />
                <EditCell flex={1}    value={row.note}  placeholder="3/28 재입원 등" onChange={v => updateRow(setDischarges, row.id, "note", v)} />
              </EditRow>
            ))}
          </Table>
          <AddRowBtn onClick={() => addRow(setDischarges, EMPTY_DIS)} />
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
                {transfers.map(row => (
                  <EditRow key={row.id} onDelete={() => deleteRow(setTransfers, row.id)}>
                    <EditCell width={100} value={row.name}     placeholder="이름"   onChange={v => updateRow(setTransfers, row.id, "name",     v)} />
                    <EditCell width={90}  value={row.fromRoom} placeholder="201-1"  onChange={v => updateRow(setTransfers, row.id, "fromRoom", v)} />
                    <EditCell width={90}  value={row.toRoom}   placeholder="501-4"  onChange={v => updateRow(setTransfers, row.id, "toRoom",   v)} />
                    <EditCell flex={1}    value={row.time}     placeholder="아침식사후" onChange={v => updateRow(setTransfers, row.id, "time",     v)} />
                  </EditRow>
                ))}
              </Table>
              <AddRowBtn onClick={() => addRow(setTransfers, EMPTY_TRN)} />
            </Section>

            <Section title="<자리 보존>" titleBg="#ede9fe" titleColor="#4c1d95">
              <Table cols={[
                { label:"이   름", width:100 },
                { label:"병   실",  width:80 },
                { label:"퇴원 날짜", width:95 },
                { label:"재입원", flex:1 },
              ]}>
                {reservedBeds.map(row => (
                  <EditRow key={row.id} onDelete={() => deleteRow(setReservedBeds, row.id)}>
                    <EditCell width={100} value={row.name}         placeholder="이름"   onChange={v => updateRow(setReservedBeds, row.id, "name",          v)} />
                    <EditCell width={80}  value={row.room}         placeholder="306-1"  onChange={v => updateRow(setReservedBeds, row.id, "room",          v)} />
                    <EditCell width={95}  value={row.dischargeDate}placeholder="3/21"   onChange={v => updateRow(setReservedBeds, row.id, "dischargeDate", v)} />
                    <EditCell flex={1}    value={row.readmitDate}  placeholder="3/28 재입원" onChange={v => updateRow(setReservedBeds, row.id, "readmitDate",  v)} />
                  </EditRow>
                ))}
              </Table>
              <AddRowBtn onClick={() => addRow(setReservedBeds, EMPTY_RES)} />
            </Section>
          </div>

          {/* 우: 치료실 이용계획 */}
          <Section title="<치료실 이용계획>" titleBg="#fef3c7" titleColor="#92400e" style={{ flex:1 }}>
            {/* 치료사 이름 표시 */}
            <div className="no-print" style={{ padding:"4px 12px", fontSize:13, color:"#92400e",
              background:"#fffbeb", borderBottom:"1px solid #fde68a" }}>
              치료사: {therapists[0]} / {therapists[1]} &nbsp;
              <span style={{ color:"#a16207", fontSize:12 }}>(치료실 스케줄에서 자동 연동)</span>
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
                          const manual = therapy[slot]?.[c.key];
                          const autoVal = auto[c.key] || "";
                          return (
                            <td key={c.key} style={{ ...S.td, verticalAlign:"top", padding:3, position:"relative" }}>
                              {/* 자동 연동 내용 (배경 표시) */}
                              {autoVal && !manual && (
                                <div style={{ fontSize:14, color:"#4b5563", whiteSpace:"pre-wrap",
                                  lineHeight:1.5, padding:"2px 4px", background:"#f0f9ff",
                                  borderRadius:4, border:"1px solid #bae6fd" }}>
                                  {autoVal}
                                </div>
                              )}
                              {/* 수동 입력 */}
                              <textarea
                                value={manual || ""}
                                onChange={e => updateTherapy(slot, c.key, e.target.value)}
                                rows={2}
                                placeholder={autoVal ? "" : "이름(병실)"}
                                style={{ width:"100%", border: manual ? "1px solid #fcd34d" : "1px dashed #e2e8f0",
                                  background: manual ? "#fffbeb" : "transparent",
                                  resize:"vertical", fontSize:14, fontFamily:"inherit",
                                  padding:3, minHeight:44, outline:"none", lineHeight:1.6,
                                  borderRadius:4, marginTop: autoVal && !manual ? 3 : 0 }}
                              />
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
            {cols.map((c,i) => (
              <th key={i} style={{ ...S.th, width:c.width }}>{c.label}</th>
            ))}
            <th style={{ ...S.th, width:32 }} className="no-print" />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function EditRow({ children, onDelete }) {
  return (
    <tr style={{ borderBottom:"1px solid #e2e8f0" }}>
      {children}
      <td className="no-print" style={{ padding:"2px 4px", textAlign:"center", width:32 }}>
        <button onClick={onDelete} title="삭제"
          style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444",
            fontSize:18, lineHeight:1 }}>✕</button>
      </td>
    </tr>
  );
}

function EditCell({ value, onChange, placeholder, width, flex }) {
  return (
    <td style={{ padding:"3px 4px", borderRight:"1px solid #e2e8f0", width, verticalAlign:"middle" }}>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
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

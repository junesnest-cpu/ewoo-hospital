import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];
const THERAPY_SLOTS = ["09:00~10:00","10:00~11:00","11:00~12:00","13:00~14:00","14:00~15:00","15:00~16:00","16:00~17:00","17:00~18:00"];
const THERAPY_COLS = [
  { key:"highFreq",  label:"고주파 치료" },
  { key:"physio1",   label:"물리치료실 (양수빈)" },
  { key:"physio2",   label:"물리치료실 (손은경)" },
  { key:"hyperbaric",label:"고압산소" },
];

const WARD_STRUCTURE = {
  2: { rooms:[{id:"201",cap:4},{id:"202",cap:1},{id:"203",cap:4},{id:"204",cap:2},{id:"205",cap:6},{id:"206",cap:6}] },
  3: { rooms:[{id:"301",cap:4},{id:"302",cap:1},{id:"303",cap:4},{id:"304",cap:2},{id:"305",cap:2},{id:"306",cap:6}] },
  5: { rooms:[{id:"501",cap:4},{id:"502",cap:1},{id:"503",cap:4},{id:"504",cap:2},{id:"505",cap:6},{id:"506",cap:6}] },
  6: { rooms:[{id:"601",cap:6},{id:"602",cap:1},{id:"603",cap:6}] },
};

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
function fmtDisp(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return `${d.getMonth()+1}/${d.getDate()} (${DOW[d.getDay()]})`;
}
function uid() { return Math.random().toString(36).slice(2,9); }

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
  const [admissions, setAdmissions] = useState([EMPTY_ADM()]);
  const [discharges, setDischarges] = useState([EMPTY_DIS()]);
  const [transfers, setTransfers] = useState([EMPTY_TRN()]);
  const [reservedBeds, setReservedBeds] = useState([EMPTY_RES()]);
  const [therapy, setTherapy] = useState(EMPTY_THERAPY());
  const [saving, setSaving] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);

  // Firebase 로드
  useEffect(() => {
    const r = ref(db, `dailyBoards/${date}`);
    const unsub = onValue(r, snap => {
      const v = snap.val();
      if (!v) {
        setAdmissions([EMPTY_ADM()]);
        setDischarges([EMPTY_DIS()]);
        setTransfers([EMPTY_TRN()]);
        setReservedBeds([EMPTY_RES()]);
        setTherapy(EMPTY_THERAPY());
        return;
      }
      setAdmissions(v.admissions?.length ? v.admissions : [EMPTY_ADM()]);
      setDischarges(v.discharges?.length ? v.discharges : [EMPTY_DIS()]);
      setTransfers(v.transfers?.length ? v.transfers : [EMPTY_TRN()]);
      setReservedBeds(v.reservedBeds?.length ? v.reservedBeds : [EMPTY_RES()]);
      setTherapy({ ...EMPTY_THERAPY(), ...(v.therapy || {}) });
    });
    return () => unsub();
  }, [date]);

  // 저장
  const save = useCallback(async (adm, dis, trn, res, ther) => {
    setSaving(true);
    await set(ref(db, `dailyBoards/${date}`), {
      admissions: adm, discharges: dis, transfers: trn, reservedBeds: res, therapy: ther,
    });
    setSaving(false);
    setLastSaved(new Date());
  }, [date]);

  // 자동 채우기: slots + consultations에서 해당 날짜 입퇴원 추출
  const autoFill = useCallback(async () => {
    setAutoFilling(true);
    const [slotsSnap, consSnap] = await Promise.all([
      get(ref(db,"slots")),
      get(ref(db,"consultations")),
    ]);
    const slots = slotsSnap.val() || {};
    const consultations = consSnap.val() || {};

    const newAdm = [];
    const newDis = [];

    // slots 스캔
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const [roomId, bedNum] = slotKey.split("-");
      const roomLabel = `${roomId}-${bedNum}`;

      const cur = slot?.current;
      if (cur?.name) {
        const aDate = parseMD(cur.admitDate, date);
        const dDate = parseMD(cur.discharge, date);
        if (aDate === date) {
          newAdm.push({ id:uid(), room:roomLabel, name:cur.name, doctor:"", time:"", note:cur.note||"", isNew:false });
        }
        if (dDate === date) {
          newDis.push({ id:uid(), room:roomLabel, name:cur.name, time:"", note:"" });
        }
      }
      (slot?.reservations||[]).forEach(r => {
        if (!r?.name) return;
        const aDate = parseMD(r.admitDate, date);
        const dDate = parseMD(r.discharge, date);
        if (aDate === date) {
          newAdm.push({ id:uid(), room:roomLabel, name:r.name, doctor:"", time:"", note:r.note||"", isNew:false });
        }
        if (dDate === date) {
          newDis.push({ id:uid(), room:roomLabel, name:r.name, time:"", note:"" });
        }
      });
    });

    // consultations 스캔 (신환)
    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      if (c.admitDate !== date) return;
      const already = newAdm.some(a => a.name === c.name);
      if (!already) {
        const roomLabel = c.roomTypes?.join("/") || "";
        const parts = [
          c.birthYear ? `${new Date().getFullYear()-parseInt(c.birthYear)}세` : "",
          c.diagnosis || "",
          c.hospital || "",
          c.surgery && c.surgeryDate ? `수술후(${c.surgeryDate})` : c.surgery ? "수술후" : "",
          c.chemo && c.chemoDate ? `항암(${c.chemoDate})` : c.chemo ? "항암중" : "",
          c.radiation ? "방사선" : "",
          c.memo || "",
        ].filter(Boolean).join(" / ");
        newAdm.push({ id:uid(), room:roomLabel, name:c.name, doctor:"", time:"", note:parts, isNew:true });
      }
    });

    if (newAdm.length === 0 && newDis.length === 0) {
      alert("해당 날짜에 입퇴원 예정 데이터가 없습니다.");
      setAutoFilling(false);
      return;
    }

    const mergedAdm = newAdm.length ? newAdm : [EMPTY_ADM()];
    const mergedDis = newDis.length ? newDis : [EMPTY_DIS()];
    setAdmissions(mergedAdm);
    setDischarges(mergedDis);
    setAutoFilling(false);
  }, [date]);

  function changeDate(delta) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  }

  // 행 수정 헬퍼
  function updateRow(setter, id, field, val) {
    setter(rows => rows.map(r => r.id === id ? {...r, [field]:val} : r));
  }
  function addRow(setter, empty) { setter(rows => [...rows, empty()]); }
  function deleteRow(setter, id) { setter(rows => rows.filter(r => r.id !== id)); }

  function updateTherapy(slot, col, val) {
    setTherapy(t => ({ ...t, [slot]: { ...t[slot], [col]:val } }));
  }

  const dateObj = new Date(date);
  const dateLabel = `${dateObj.getFullYear()}년 ${dateObj.getMonth()+1}월 ${dateObj.getDate()}일 (${DOW[dateObj.getDay()]})`;

  const printStyle = `@media print {
    @page { size: A4 portrait; margin: 10mm; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; font-size: 10px; }
    .no-print { display: none !important; }
    .section-card { break-inside: avoid; margin-bottom: 8mm; }
    input, textarea { border: none !important; background: transparent !important; padding: 0 !important; }
  }`;

  return (
    <div style={{ minHeight:"100vh", background:"#f1f5f9", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{printStyle}</style>

      {/* 헤더 */}
      <header className="no-print" style={{ background:"#0f2744", color:"#fff", padding:"8px 16px",
        display:"flex", alignItems:"center", gap:10, position:"sticky", top:0, zIndex:30,
        flexWrap:"wrap" }}>
        <button onClick={() => router.push("/")} style={S.navBtn}>🏠 홈</button>
        <span style={{ fontWeight:800, fontSize:15 }}>📋 일일 현황판</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={() => router.push("/monthly")} style={S.navBtn}>📅 월간 예정표</button>
          <button onClick={() => router.push("/consultation")} style={S.navBtn}>📋 상담일지</button>
          <button onClick={() => window.print()} style={{ ...S.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
        </div>
      </header>

      {/* 날짜 바 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0",
        padding:"8px 16px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
        <button onClick={() => changeDate(-1)} style={S.dayBtn}>◀</button>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ border:"1px solid #e2e8f0", borderRadius:6, padding:"4px 10px", fontSize:14, fontWeight:700, color:"#0f2744" }} />
        <button onClick={() => changeDate(1)} style={S.dayBtn}>▶</button>
        <span style={{ fontSize:15, fontWeight:800, color:"#0f2744" }}>{dateLabel}</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8, alignItems:"center" }}>
          {lastSaved && <span style={{ fontSize:11, color:"#64748b" }}>✓ {lastSaved.toLocaleTimeString("ko")} 저장됨</span>}
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
      <div style={{ textAlign:"center", padding:"8px 0 4px", fontWeight:900, fontSize:17, color:"#0f2744" }}
        className="print-title">
        {dateObj.getFullYear()}년 {dateObj.getMonth()+1}월 {dateObj.getDate()}일 현황판
      </div>

      <div style={{ padding: isMobile ? "10px" : "16px 20px", display:"flex", flexDirection:"column", gap:16 }}>

        {/* 입원 */}
        <Section title="입   원" titleBg="#fef08a" titleColor="#78350f">
          <Table
            cols={[
              { label:"호  실", width:90 },
              { label:"이름 (주치의)", width:140 },
              { label:"입/퇴원 시간", width:120 },
              { label:"기   타 (신환: 나이·진단·병원·치료단계)", flex:1 },
            ]}
          >
            {admissions.map(row => (
              <EditRow key={row.id} onDelete={() => deleteRow(setAdmissions, row.id)}>
                <EditCell width={90} value={row.room} placeholder="병실-번호" onChange={v => updateRow(setAdmissions, row.id, "room", v)} />
                <td style={{ padding:"4px 6px", borderRight:"1px solid #e2e8f0", minWidth:140 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    {row.isNew && <span style={{ fontSize:9, background:"#fef08a", color:"#713f12",
                      borderRadius:3, padding:"0 4px", fontWeight:800, flexShrink:0 }}>★신환</span>}
                    <input value={row.name} onChange={e => updateRow(setAdmissions, row.id, "name", e.target.value)}
                      placeholder="이름" style={{ ...S.cell, flex:1, minWidth:60 }} />
                    <span style={{ color:"#94a3b8", fontSize:11 }}>(</span>
                    <input value={row.doctor} onChange={e => updateRow(setAdmissions, row.id, "doctor", e.target.value)}
                      placeholder="주치의" style={{ ...S.cell, width:40 }} />
                    <span style={{ color:"#94a3b8", fontSize:11 }}>)</span>
                    <button onClick={() => updateRow(setAdmissions, row.id, "isNew", !row.isNew)}
                      title="신환 토글"
                      style={{ fontSize:10, background: row.isNew?"#fef08a":"#f1f5f9", border:"1px solid #e2e8f0",
                        borderRadius:4, padding:"1px 5px", cursor:"pointer", color: row.isNew?"#713f12":"#94a3b8", flexShrink:0 }}>
                      ★
                    </button>
                  </div>
                </td>
                <EditCell width={120} value={row.time} placeholder="예: 18:30/저녁식사" onChange={v => updateRow(setAdmissions, row.id, "time", v)} />
                <EditCell flex={1} value={row.note} placeholder="나이, 진단명, 치료 중인 병원, 치료 단계 등" onChange={v => updateRow(setAdmissions, row.id, "note", v)} />
              </EditRow>
            ))}
          </Table>
          <AddRowBtn onClick={() => addRow(setAdmissions, EMPTY_ADM)} />
        </Section>

        {/* 퇴원 */}
        <Section title="퇴   원" titleBg="#bfdbfe" titleColor="#1e3a5f">
          <Table
            cols={[
              { label:"호  실", width:90 },
              { label:"이   름", width:140 },
              { label:"입/퇴원 시간", width:120 },
              { label:"기   타 (재입원 일정 등)", flex:1 },
            ]}
          >
            {discharges.map(row => (
              <EditRow key={row.id} onDelete={() => deleteRow(setDischarges, row.id)}>
                <EditCell width={90} value={row.room} placeholder="병실-번호" onChange={v => updateRow(setDischarges, row.id, "room", v)} />
                <EditCell width={140} value={row.name} placeholder="이름" onChange={v => updateRow(setDischarges, row.id, "name", v)} />
                <EditCell width={120} value={row.time} placeholder="예: 오전 / 점심 후" onChange={v => updateRow(setDischarges, row.id, "time", v)} />
                <EditCell flex={1} value={row.note} placeholder="재입원: 3/21 재입원 등" onChange={v => updateRow(setDischarges, row.id, "note", v)} />
              </EditRow>
            ))}
          </Table>
          <AddRowBtn onClick={() => addRow(setDischarges, EMPTY_DIS)} />
        </Section>

        {/* 하단 2열: 전실+자리보존  |  치료실 이용계획 */}
        <div style={{ display:"flex", gap:16, alignItems:"flex-start", flexWrap: isMobile ? "wrap" : "nowrap" }}>

          {/* 좌: 전실 + 자리보존 */}
          <div style={{ display:"flex", flexDirection:"column", gap:16, flex:"0 0 auto", minWidth: isMobile?"100%":360 }}>

            {/* 전실 */}
            <Section title="<전  실>" titleBg="#d1fae5" titleColor="#065f46">
              <Table
                cols={[
                  { label:"이   름", width:90 },
                  { label:"기존 병실", width:80 },
                  { label:"이동 병실", width:80 },
                  { label:"이동 시간", flex:1 },
                ]}
              >
                {transfers.map(row => (
                  <EditRow key={row.id} onDelete={() => deleteRow(setTransfers, row.id)}>
                    <EditCell width={90} value={row.name} placeholder="이름" onChange={v => updateRow(setTransfers, row.id, "name", v)} />
                    <EditCell width={80} value={row.fromRoom} placeholder="201-1" onChange={v => updateRow(setTransfers, row.id, "fromRoom", v)} />
                    <EditCell width={80} value={row.toRoom} placeholder="501-4" onChange={v => updateRow(setTransfers, row.id, "toRoom", v)} />
                    <EditCell flex={1} value={row.time} placeholder="아침식사후" onChange={v => updateRow(setTransfers, row.id, "time", v)} />
                  </EditRow>
                ))}
              </Table>
              <AddRowBtn onClick={() => addRow(setTransfers, EMPTY_TRN)} />
            </Section>

            {/* 자리 보존 */}
            <Section title="<자리 보존>" titleBg="#ede9fe" titleColor="#4c1d95">
              <Table
                cols={[
                  { label:"이   름", width:90 },
                  { label:"병   실", width:80 },
                  { label:"퇴원 날짜", width:90 },
                  { label:"재입원", flex:1 },
                ]}
              >
                {reservedBeds.map(row => (
                  <EditRow key={row.id} onDelete={() => deleteRow(setReservedBeds, row.id)}>
                    <EditCell width={90} value={row.name} placeholder="이름" onChange={v => updateRow(setReservedBeds, row.id, "name", v)} />
                    <EditCell width={80} value={row.room} placeholder="306-1" onChange={v => updateRow(setReservedBeds, row.id, "room", v)} />
                    <EditCell width={90} value={row.dischargeDate} placeholder="3/21" onChange={v => updateRow(setReservedBeds, row.id, "dischargeDate", v)} />
                    <EditCell flex={1} value={row.readmitDate} placeholder="3/28 재입원" onChange={v => updateRow(setReservedBeds, row.id, "readmitDate", v)} />
                  </EditRow>
                ))}
              </Table>
              <AddRowBtn onClick={() => addRow(setReservedBeds, EMPTY_RES)} />
            </Section>
          </div>

          {/* 우: 치료실 이용계획 */}
          <Section title="<치료실 이용계획>" titleBg="#fef3c7" titleColor="#92400e" style={{ flex:1 }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"collapse", width:"100%", minWidth:500 }}>
                <thead>
                  <tr>
                    <th style={{ ...S.th, width:100, background:"#fef3c7", color:"#92400e" }}>시간</th>
                    {THERAPY_COLS.map(c => (
                      <th key={c.key} style={{ ...S.th, background:"#fef3c7", color:"#92400e" }}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {THERAPY_SLOTS.map(slot => (
                    <tr key={slot} style={{ background: slot.startsWith("13") ? "#fffbeb" : "#fff" }}>
                      <td style={{ ...S.td, background:"#fef9c3", fontWeight:700, fontSize:12, textAlign:"center",
                        color:"#78350f", whiteSpace:"nowrap" }}>{slot}</td>
                      {THERAPY_COLS.map(c => (
                        <td key={c.key} style={{ ...S.td, verticalAlign:"top", padding:3 }}>
                          <textarea
                            value={therapy[slot]?.[c.key] || ""}
                            onChange={e => updateTherapy(slot, c.key, e.target.value)}
                            rows={2}
                            placeholder="이름(병실)"
                            style={{ width:"100%", border:"none", background:"transparent", resize:"vertical",
                              fontSize:11, fontFamily:"inherit", padding:2, minHeight:38, outline:"none",
                              lineHeight:1.5 }}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
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
        fontSize:14, padding:"6px 14px", letterSpacing:2 }}>{title}</div>
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
              <th key={i} style={{ ...S.th, width:c.width, flex:c.flex }}>{c.label}</th>
            ))}
            <th style={{ ...S.th, width:28 }} className="no-print" />
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
      <td className="no-print" style={{ padding:"2px 4px", textAlign:"center", width:28 }}>
        <button onClick={onDelete} title="삭제"
          style={{ background:"none", border:"none", cursor:"pointer", color:"#ef4444", fontSize:14, lineHeight:1 }}>✕</button>
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
    <div className="no-print" style={{ padding:"4px 8px" }}>
      <button onClick={onClick}
        style={{ background:"none", border:"1px dashed #cbd5e1", borderRadius:6, color:"#64748b",
          cursor:"pointer", fontSize:12, padding:"3px 14px", width:"100%", fontWeight:600 }}>
        + 행 추가
      </button>
    </div>
  );
}

const S = {
  navBtn: {
    background:"transparent", color:"#fff", border:"1px solid rgba(255,255,255,0.3)",
    borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:13, fontWeight:600,
  },
  dayBtn: {
    background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:6,
    padding:"4px 10px", cursor:"pointer", fontSize:14, fontWeight:700,
  },
  actionBtn: {
    border:"none", borderRadius:6, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:700,
  },
  th: {
    background:"#f8fafc", borderBottom:"2px solid #e2e8f0", borderRight:"1px solid #e2e8f0",
    padding:"5px 8px", fontSize:12, fontWeight:700, color:"#374151", textAlign:"center",
    whiteSpace:"nowrap",
  },
  td: {
    border:"1px solid #e2e8f0", padding:"4px 6px", fontSize:12,
  },
  cell: {
    border:"none", outline:"none", background:"transparent", fontSize:12,
    padding:"2px 4px", fontFamily:"inherit", color:"#1e293b", width:"100%",
  },
};

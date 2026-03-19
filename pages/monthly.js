import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];

function parseMD(str, year, month) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
}
function parseISO(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}
function toYM(year, month) {
  return `${year}-${String(month).padStart(2,"0")}`;
}
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}
function slotKeyToRoom(slotKey) {
  const [roomId, bedNum] = slotKey.split("-");
  return roomId ? `${roomId}-${bedNum}` : slotKey;
}
function dateKey(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function uid() { return Math.random().toString(36).slice(2,9); }

const EMPTY_ADM = () => ({ id:uid(), name:"", room:"", isNew:false, isReserved:false, note:"" });
const EMPTY_DIS = () => ({ id:uid(), name:"", room:"", note:"" });

export default function MonthlySchedule() {
  const router = useRouter();
  const isMobile = useIsMobile();

  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});

  // 공지/메모
  const [memo, setMemo] = useState("");
  const [memoEdit, setMemoEdit] = useState("");
  const [memoEditing, setMemoEditing] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);

  // 편집된 월간 데이터 (Firebase monthlyBoards/{YYYY-MM})
  const [boardData, setBoardData] = useState({});

  // 날짜 편집 모달
  const [editModal, setEditModal] = useState(null); // "YYYY-MM-DD" | null
  const [editAdm, setEditAdm] = useState([]);
  const [editDis, setEditDis] = useState([]);
  const [editSaving, setEditSaving] = useState(false);
  const [autoFilling, setAutoFilling] = useState(false);

  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), snap => setSlots(snap.val() || {}));
    const u2 = onValue(ref(db,"consultations"), snap => setConsultations(snap.val() || {}));
    return () => { u1(); u2(); };
  }, []);

  // 월간 보드 데이터 로드
  useEffect(() => {
    const u = onValue(ref(db, `monthlyBoards/${toYM(year, month)}`), snap => {
      setBoardData(snap.val() || {});
    });
    return () => u();
  }, [year, month]);

  // 메모 로드
  const memoKey = toYM(year, month);
  useEffect(() => {
    const u = onValue(ref(db, `monthlyMemos/${memoKey}`), snap => {
      const val = snap.val() || "";
      setMemo(val);
      setMemoEdit(val);
      setMemoEditing(false);
    });
    return () => u();
  }, [memoKey]);

  async function saveMemo() {
    setMemoSaving(true);
    await set(ref(db, `monthlyMemos/${memoKey}`), memoEdit);
    setMemoSaving(false);
    setMemoEditing(false);
  }

  // slots + consultations에서 자동 계산된 데이터
  const calendarData = useMemo(() => {
    const data = {};
    const ensure = (key) => { if (!data[key]) data[key] = { admissions:[], discharges:[] }; };

    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomLabel = slotKeyToRoom(slotKey);
      const cur = slot?.current;
      if (cur?.name) {
        const aKey = dateKey(parseMD(cur.admitDate, year, month));
        const dKey = dateKey(parseMD(cur.discharge, year, month));
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ id:uid(), name:cur.name, room:roomLabel, note:cur.note||"", isNew:false, isReserved:false }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ id:uid(), name:cur.name, room:roomLabel, note:cur.discharge||"" }); }
      }
      (slot?.reservations || []).forEach(r => {
        if (!r?.name) return;
        const aKey = dateKey(parseMD(r.admitDate, year, month));
        const dKey = dateKey(parseMD(r.discharge, year, month));
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ id:uid(), name:r.name, room:roomLabel, note:r.note||"", isNew:false, isReserved:true }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ id:uid(), name:r.name, room:roomLabel, note:r.discharge||"" }); }
      });
    });

    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      const admitD = parseISO(c.admitDate);
      if (!admitD) return;
      const aKey = dateKey(admitD);
      if (!aKey) return;
      ensure(aKey);
      if (!data[aKey].admissions.some(a => a.name === c.name)) {
        data[aKey].admissions.push({
          id: uid(),
          name: c.name,
          room: c.roomTypes?.join("/") || "",
          note: [c.diagnosis, c.hospital, c.memo].filter(Boolean).join(" "),
          isNew: true,
          isReserved: true,
        });
      }
    });
    return data;
  }, [slots, consultations, year, month]);

  // 표시 데이터: boardData 우선, 없으면 calendarData
  function getDisplayData(key) {
    if (boardData[key]) return { ...boardData[key], isManual: true };
    return { ...(calendarData[key] || { admissions:[], discharges:[] }), isManual: false };
  }

  // 편집 모달 열기
  function openEdit(key) {
    const base = boardData[key] || calendarData[key] || { admissions:[], discharges:[] };
    setEditAdm((base.admissions || []).map(a => ({ ...a, id: a.id || uid() })));
    setEditDis((base.discharges || []).map(d => ({ ...d, id: d.id || uid() })));
    setEditModal(key);
  }

  // 편집 저장
  async function saveEdit() {
    setEditSaving(true);
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${editModal}`), {
      admissions: editAdm,
      discharges: editDis,
    });
    setEditSaving(false);
    setEditModal(null);
  }

  // 해당 날짜 보드 데이터 삭제 (자동 데이터로 복원)
  async function clearEdit(key) {
    if (!confirm("수동 편집 내용을 삭제하고 자동 데이터로 되돌리시겠습니까?")) return;
    await set(ref(db, `monthlyBoards/${toYM(year, month)}/${key}`), null);
  }

  // 이번 달 전체 자동 채우기
  async function autoFillMonth() {
    if (!confirm(`${year}년 ${month}월 전체를 자동 데이터로 채웁니다. 기존 수동 편집 내용은 덮어씌워집니다.`)) return;
    setAutoFilling(true);
    const obj = {};
    Object.entries(calendarData).forEach(([key, val]) => {
      obj[key] = {
        admissions: val.admissions.map(a => ({ ...a, id: a.id || uid() })),
        discharges: val.discharges.map(d => ({ ...d, id: d.id || uid() })),
      };
    });
    await set(ref(db, `monthlyBoards/${toYM(year, month)}`), Object.keys(obj).length ? obj : null);
    setAutoFilling(false);
  }

  // 달력 격자
  const calendarGrid = useMemo(() => {
    const total = daysInMonth(year, month);
    const firstDow = new Date(year, month - 1, 1).getDay();
    const weeks = [];
    let week = Array(firstDow).fill(null);
    for (let d = 1; d <= total; d++) {
      week.push(d);
      if (week.length === 7) { weeks.push(week); week = []; }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }
    return weeks;
  }, [year, month]);

  function prevMonth() {
    if (month === 1) { setYear(y => y-1); setMonth(12); }
    else setMonth(m => m-1);
  }
  function nextMonth() {
    if (month === 12) { setYear(y => y+1); setMonth(1); }
    else setMonth(m => m+1);
  }

  // 요약 통계 (boardData + calendarData 통합)
  const summaryStats = useMemo(() => {
    let totalAdmit = 0, totalDischarge = 0, totalNew = 0;
    const total = daysInMonth(year, month);
    for (let d = 1; d <= total; d++) {
      const key = `${year}-${String(month).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const dd = getDisplayData(key);
      totalAdmit += (dd.admissions||[]).length;
      totalDischarge += (dd.discharges||[]).length;
      totalNew += (dd.admissions||[]).filter(a => a.isNew).length;
    }
    return { totalAdmit, totalDischarge, totalNew };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardData, calendarData, year, month]);

  const printStyle = `
    @media print {
      @page { size: A4 landscape; margin: 8mm; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .print-grid { font-size: 9px !important; }
      .print-title { display: block !important; }
    }
  `;

  const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(new Date().getDate()).padStart(2,"0")}`;

  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{printStyle}</style>

      {/* 헤더 */}
      <header className="no-print" style={{ background:"#0f2744", color:"#fff", padding:"10px 20px",
        display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:30 }}>
        <button onClick={() => router.push("/")} style={NS.navBtn}>🏠 홈</button>
        <span style={{ fontWeight:800, fontSize:16 }}>📅 월간 입퇴원 예정표</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={() => router.push("/consultation")} style={NS.navBtn}>📋 상담일지</button>
          <button onClick={() => router.push("/patients")} style={NS.navBtn}>👤 환자조회</button>
          <button onClick={() => window.print()} style={{ ...NS.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
        </div>
      </header>

      {/* 월 네비게이션 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0",
        padding:"8px 16px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <button onClick={prevMonth} style={NS.monthBtn}>◀</button>
        <span style={{ fontSize:22, fontWeight:900, color:"#0f2744", minWidth:120, textAlign:"center" }}>
          {year}년 {month}월
        </span>
        <button onClick={nextMonth} style={NS.monthBtn}>▶</button>
        <div style={{ display:"flex", gap:8, fontSize:14, marginLeft:8 }}>
          <span style={{ background:"#dcfce7", color:"#166534", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>↑ 입원</span>
          <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>↓ 퇴원</span>
          <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>★ 신환</span>
          <span style={{ background:"#e0f2fe", color:"#0369a1", borderRadius:4, padding:"3px 10px", fontWeight:700 }}>✏ 수동편집</span>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={autoFillMonth} disabled={autoFilling}
            style={{ ...NS.monthBtn, background:"#0ea5e9", color:"#fff", border:"none", fontSize:12 }}>
            {autoFilling ? "채우는 중..." : "⚡ 자동채우기"}
          </button>
        </div>
      </div>

      {/* 공지/메모 */}
      <div style={{ background:"#fffbeb", borderBottom:"1px solid #fde68a", padding:"8px 20px", display:"flex", alignItems:"flex-start", gap:10 }}>
        <span style={{ fontSize:14, flexShrink:0, marginTop:2 }}>📌</span>
        {memoEditing ? (
          <div style={{ flex:1, display:"flex", gap:8, alignItems:"flex-start" }}>
            <textarea value={memoEdit} onChange={e => setMemoEdit(e.target.value)}
              placeholder={`${year}년 ${month}월 공지 및 메모를 입력하세요...`}
              rows={3}
              style={{ flex:1, border:"1px solid #fcd34d", borderRadius:6, padding:"6px 10px",
                fontSize:13, resize:"vertical", fontFamily:"inherit", background:"#fff" }} />
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              <button onClick={saveMemo} disabled={memoSaving}
                style={{ background:"#d97706", color:"#fff", border:"none", borderRadius:6,
                  padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                {memoSaving ? "저장 중..." : "저장"}
              </button>
              <button onClick={() => { setMemoEditing(false); setMemoEdit(memo); }}
                style={{ background:"#e5e7eb", color:"#374151", border:"none", borderRadius:6,
                  padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 }}>
                취소
              </button>
            </div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", alignItems:"flex-start", gap:8 }}>
            <span style={{ flex:1, fontSize:13, color: memo ? "#78350f" : "#a16207",
              whiteSpace:"pre-wrap", lineHeight:1.6, minHeight:20 }}>
              {memo || <span style={{ color:"#d97706", fontStyle:"italic" }}>이번 달 공지/메모 없음</span>}
            </span>
            <button className="no-print" onClick={() => setMemoEditing(true)}
              style={{ flexShrink:0, background:"#fef3c7", color:"#92400e", border:"1px solid #fcd34d",
                borderRadius:6, padding:"4px 12px", cursor:"pointer", fontSize:12, fontWeight:700 }}>
              ✏️ 편집
            </button>
          </div>
        )}
      </div>

      {/* 인쇄용 제목 */}
      <div style={{ display:"none" }} className="print-title">
        <h2 style={{ textAlign:"center", margin:"4mm 0 2mm", fontSize:14 }}>{year}년 {month}월 입퇴원 예정표</h2>
        {memo && <p style={{ textAlign:"center", fontSize:10, color:"#78350f", margin:"0 0 2mm" }}>📌 {memo}</p>}
      </div>

      {/* 달력 */}
      <div style={{ padding: isMobile ? "8px" : "16px 20px", overflowX:"auto" }}>
        <table className="print-grid" style={{ width:"100%", borderCollapse:"collapse",
          tableLayout:"fixed", minWidth: isMobile ? 700 : "auto" }}>
          <thead>
            <tr>
              {DOW.map((d, i) => (
                <th key={i} style={{
                  background: i===0 ? "#fef2f2" : i===6 ? "#eff6ff" : "#1e3a5f",
                  color: i===0 ? "#dc2626" : i===6 ? "#2563eb" : "#fff",
                  padding:"6px 4px", textAlign:"center", fontSize:13, fontWeight:800,
                  border:"1px solid #cbd5e1", width:"14.28%",
                }}>{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendarGrid.map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => {
                  if (!day) return <td key={di} style={{ border:"1px solid #e2e8f0", background:"#f8fafc", verticalAlign:"top", minHeight:90 }} />;
                  const key = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                  const dayData = getDisplayData(key);
                  const isManual = dayData.isManual;
                  const isToday = key === todayKey;
                  const isSun = di === 0, isSat = di === 6;
                  const hasData = (dayData.admissions||[]).length > 0 || (dayData.discharges||[]).length > 0;

                  return (
                    <td key={di} style={{
                      border: isManual ? "2px solid #bae6fd" : "1px solid #e2e8f0",
                      verticalAlign:"top", padding:0,
                      background: isToday ? "#fffbeb" : "#fff",
                      minHeight:120, position:"relative",
                    }}>
                      {/* 날짜 헤더 */}
                      <div style={{
                        padding:"4px 6px", fontWeight:900,
                        fontSize: isMobile ? 16 : 18,
                        color: isToday ? "#d97706" : isSun ? "#dc2626" : isSat ? "#2563eb" : "#1e293b",
                        background: isToday ? "#fef3c7" : isSun ? "#fff5f5" : isSat ? "#eff6ff" : "#f8fafc",
                        borderBottom:"1px solid #e2e8f0",
                        display:"flex", alignItems:"center", gap:3,
                      }}>
                        <span>{day}</span>
                        {isToday && <span style={{ fontSize:11, background:"#f59e0b", color:"#fff", borderRadius:3, padding:"0 4px", fontWeight:700 }}>오늘</span>}
                        {isManual && <span style={{ fontSize:10, background:"#bae6fd", color:"#0369a1", borderRadius:3, padding:"0 4px", fontWeight:700 }}>✏</span>}
                        {/* 편집 버튼 */}
                        <button className="no-print" onClick={() => openEdit(key)}
                          title="이 날 편집"
                          style={{ marginLeft:"auto", background:"none", border:"none", cursor:"pointer",
                            fontSize:11, color:"#64748b", padding:"0 2px", lineHeight:1 }}>
                          ✏️
                        </button>
                        {isManual && (
                          <button className="no-print" onClick={() => clearEdit(key)}
                            title="수동 편집 취소 (자동 데이터로 복원)"
                            style={{ background:"none", border:"none", cursor:"pointer",
                              fontSize:11, color:"#94a3b8", padding:"0 2px", lineHeight:1 }}>
                            ↺
                          </button>
                        )}
                      </div>

                      {/* 입원 섹션 */}
                      {(dayData.admissions||[]).length > 0 && (
                        <div style={{ borderBottom:(dayData.discharges||[]).length > 0 ? "1px dashed #bbf7d0":"none",
                          padding:"4px 5px", background:"#f0fdf4" }}>
                          <div style={{ fontSize:13, fontWeight:800, color:"#166534", marginBottom:3 }}>
                            ↑ 입원 {(dayData.admissions||[]).length}
                          </div>
                          {(dayData.admissions||[]).map((p, pi) => (
                            <PatientChip key={p.id||pi} p={p} type="admission" />
                          ))}
                        </div>
                      )}

                      {/* 퇴원 섹션 */}
                      {(dayData.discharges||[]).length > 0 && (
                        <div style={{ padding:"4px 5px", background:"#fff5f5" }}>
                          <div style={{ fontSize:13, fontWeight:800, color:"#991b1b", marginBottom:3 }}>
                            ↓ 퇴원 {(dayData.discharges||[]).length}
                          </div>
                          {(dayData.discharges||[]).map((p, pi) => (
                            <PatientChip key={p.id||pi} p={p} type="discharge" />
                          ))}
                        </div>
                      )}

                      {/* 빈 공간 + 빠른 추가 버튼 */}
                      {!hasData && (
                        <div style={{ minHeight:70, display:"flex", alignItems:"flex-end", justifyContent:"center", paddingBottom:5 }}>
                          <button className="no-print" onClick={() => openEdit(key)}
                            style={{ background:"none", border:"1px dashed #cbd5e1", borderRadius:4,
                              color:"#cbd5e1", cursor:"pointer", fontSize:13, padding:"2px 10px" }}>
                            + 추가
                          </button>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 하단 요약 */}
      <div className="no-print" style={{ padding:"10px 20px", background:"#fff",
        borderTop:"1px solid #e2e8f0", display:"flex", gap:20, fontSize:13, color:"#64748b" }}>
        <span style={{ fontSize:15 }}>이번 달 입원 예정: <strong style={{color:"#166534", fontSize:17}}>{summaryStats.totalAdmit}명</strong></span>
        <span style={{ fontSize:15 }}>퇴원 예정: <strong style={{color:"#991b1b", fontSize:17}}>{summaryStats.totalDischarge}명</strong></span>
        <span style={{ fontSize:15 }}>신환: <strong style={{color:"#854d0e", fontSize:17}}>{summaryStats.totalNew}명</strong></span>
      </div>

      {/* 날짜 편집 모달 */}
      {editModal && (
        <DayEditModal
          dateKey={editModal}
          admissions={editAdm}
          discharges={editDis}
          onChangeAdm={setEditAdm}
          onChangeDis={setEditDis}
          onSave={saveEdit}
          onClose={() => setEditModal(null)}
          saving={editSaving}
          slots={slots}
          consultations={consultations}
        />
      )}
    </div>
  );
}

/* ── 날짜 편집 모달 ── */
function DayEditModal({ dateKey, admissions, discharges, onChangeAdm, onChangeDis, onSave, onClose, saving, slots, consultations }) {
  const d = new Date(dateKey);
  const label = `${d.getMonth()+1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;

  // slots + consultations → 자동완성용 환자 목록
  const allPatients = useMemo(() => {
    const list = [];
    const seen = new Set();
    const add = (p) => {
      const key = `${p.source}::${p.name}::${p.room}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(p);
    };

    // 현재 입원 환자
    Object.entries(slots || {}).forEach(([slotKey, slot]) => {
      const [roomId, bedNum] = slotKey.split("-");
      const room = `${roomId}-${bedNum}`;
      if (slot?.current?.name) {
        add({ name: slot.current.name, room, note: slot.current.note || "",
          isNew: false, isReserved: false, source:"current", sourceBadge:"입원중",
          doctor: slot.current.doctor || "" });
      }
      (slot?.reservations || []).forEach(r => {
        if (r?.name) add({ name: r.name, room, note: r.note || "",
          isNew: false, isReserved: true, source:"reservation", sourceBadge:"예약",
          doctor: "" });
      });
    });

    // 상담일지 환자
    Object.values(consultations || {}).forEach(c => {
      if (!c?.name) return;
      const noteFields = [];
      if (c.birthYear) noteFields.push(`${new Date().getFullYear()-parseInt(c.birthYear)}세`);
      if (c.diagnosis) noteFields.push(c.diagnosis);
      if (c.hospital)  noteFields.push(c.hospital);
      if (c.surgery)   noteFields.push(c.surgeryDate ? `수술후(${c.surgeryDate})` : "수술후");
      if (c.chemo)     noteFields.push(c.chemoDate   ? `항암(${c.chemoDate})`     : "항암중");
      if (c.radiation) noteFields.push("방사선");
      add({ name: c.name, room: c.roomTypes?.join("/") || "",
        note: noteFields.join(" · "),
        isNew: true, isReserved: c.status === "예약완료",
        source:"consultation", sourceBadge:"상담",
        doctor: "" });
    });

    return list;
  }, [slots, consultations]);

  function updateAdm(id, field, val) {
    onChangeAdm(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function updateDis(id, field, val) {
    onChangeDis(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function selectAdm(id, p) {
    onChangeAdm(rows => rows.map(r => r.id!==id ? r : {
      ...r,
      name: p.name,
      room: r.room || p.room,
      note: r.note || p.note,
      isNew: p.isNew,
      isReserved: p.isReserved,
    }));
  }
  function selectDis(id, p) {
    onChangeDis(rows => rows.map(r => r.id!==id ? r : {
      ...r,
      name: p.name,
      room: r.room || p.room,
    }));
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:200,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:12, width:"100%", maxWidth:660,
        maxHeight:"92vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" }}
        onClick={e => e.stopPropagation()}>

        {/* 모달 헤더 */}
        <div style={{ background:"#0f2744", color:"#fff", padding:"12px 20px",
          display:"flex", alignItems:"center", gap:10, borderRadius:"12px 12px 0 0" }}>
          <span style={{ fontWeight:800, fontSize:18 }}>📅 {label} 편집</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none",
            color:"#94a3b8", cursor:"pointer", fontSize:20, lineHeight:1 }}>✕</button>
        </div>

        <div style={{ padding:16, display:"flex", flexDirection:"column", gap:16 }}>

          {/* 입원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:17, color:"#166534" }}>↑ 입원</span>
              <button onClick={() => onChangeAdm(r => [...r, EMPTY_ADM()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {admissions.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>입원 항목 없음</div>
            )}
            {admissions.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"flex-start",
                marginBottom:8, background:"#f0fdf4", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6 }}>
                  {/* 이름 자동완성 + 호실 */}
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <PatientAutocomplete
                      value={row.name}
                      patients={allPatients}
                      onChange={v => updateAdm(row.id, "name", v)}
                      onSelect={p => selectAdm(row.id, p)}
                      placeholder="이름 검색 또는 직접 입력"
                      inputStyle={{ ...MS.input, width:180 }}
                    />
                    <input value={row.room} onChange={e => updateAdm(row.id,"room",e.target.value)}
                      placeholder="호실" style={{ ...MS.input, width:90 }} />
                  </div>
                  {/* 비고 + 뱃지 */}
                  <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
                    <input value={row.note} onChange={e => updateAdm(row.id,"note",e.target.value)}
                      placeholder="비고 (나이, 진단, 병원 등)" style={{ ...MS.input, flex:1, minWidth:140 }} />
                    <label style={{ display:"flex", alignItems:"center", gap:3, fontSize:13, cursor:"pointer",
                      background: row.isNew ? "#fef08a":"#f1f5f9", borderRadius:5, padding:"3px 9px",
                      border:"1px solid", borderColor: row.isNew?"#fcd34d":"#e2e8f0",
                      color: row.isNew?"#713f12":"#64748b", fontWeight: row.isNew?700:500, whiteSpace:"nowrap" }}>
                      <input type="checkbox" checked={!!row.isNew}
                        onChange={e => updateAdm(row.id,"isNew",e.target.checked)} style={{ margin:0 }} />
                      ★신환
                    </label>
                  </div>
                </div>
                <button onClick={() => onChangeAdm(r => r.filter(x => x.id !== row.id))}
                  style={{ ...MS.delBtn, marginTop:6 }}>✕</button>
              </div>
            ))}
          </div>

          {/* 퇴원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:17, color:"#991b1b" }}>↓ 퇴원</span>
              <button onClick={() => onChangeDis(r => [...r, EMPTY_DIS()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {discharges.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>퇴원 항목 없음</div>
            )}
            {discharges.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"flex-start",
                marginBottom:8, background:"#fff5f5", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6 }}>
                  <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                    <PatientAutocomplete
                      value={row.name}
                      patients={allPatients}
                      onChange={v => updateDis(row.id, "name", v)}
                      onSelect={p => selectDis(row.id, p)}
                      placeholder="이름 검색 또는 직접 입력"
                      inputStyle={{ ...MS.input, width:180 }}
                    />
                    <input value={row.room} onChange={e => updateDis(row.id,"room",e.target.value)}
                      placeholder="호실" style={{ ...MS.input, width:90 }} />
                  </div>
                  <input value={row.note} onChange={e => updateDis(row.id,"note",e.target.value)}
                    placeholder="비고 (재입원: 3/28 재입원 등)" style={{ ...MS.input, width:"100%" }} />
                </div>
                <button onClick={() => onChangeDis(r => r.filter(x => x.id !== row.id))}
                  style={{ ...MS.delBtn, marginTop:6 }}>✕</button>
              </div>
            ))}
          </div>

          {/* 버튼 */}
          <div style={{ display:"flex", justifyContent:"flex-end", gap:10, paddingTop:4 }}>
            <button onClick={onClose}
              style={{ background:"#f1f5f9", color:"#374151", border:"none", borderRadius:8,
                padding:"8px 20px", cursor:"pointer", fontSize:14, fontWeight:600 }}>
              취소
            </button>
            <button onClick={onSave} disabled={saving}
              style={{ background:"#059669", color:"#fff", border:"none", borderRadius:8,
                padding:"8px 24px", cursor:"pointer", fontSize:14, fontWeight:700 }}>
              {saving ? "저장 중..." : "💾 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PatientChip({ p, type }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:3, flexWrap:"wrap", marginBottom:3, lineHeight:1.4 }}>
      {p.isNew && <span style={{ fontSize:12, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"1px 5px", fontWeight:800, flexShrink:0 }}>★신</span>}
      <span style={{ fontSize:16, fontWeight:700, color: type==="admission" ? "#065f46" : "#991b1b" }}>{p.name}</span>
      {p.room && <span style={{ fontSize:13, color:"#64748b" }}>({p.room})</span>}
    </div>
  );
}

/* ── 환자 이름 자동완성 ── */
function PatientAutocomplete({ value, onChange, onSelect, patients, placeholder, inputStyle }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef(null);

  const filtered = useMemo(() => {
    if (!value.trim()) return [];
    const q = value.toLowerCase();
    return patients.filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [value, patients]);

  // 필터 결과 바뀔 때 드롭다운 열기
  useEffect(() => {
    setOpen(filtered.length > 0);
    setActiveIdx(0);
  }, [filtered.length]);

  function select(p) {
    onChange(p.name);
    onSelect(p);
    setOpen(false);
  }

  function handleKey(e) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i+1, filtered.length-1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(i-1, 0)); }
    else if (e.key === "Enter")     { e.preventDefault(); if (filtered[activeIdx]) select(filtered[activeIdx]); }
    else if (e.key === "Escape")    { setOpen(false); }
  }

  const SOURCE_STYLE = {
    current:      { bg:"#d1fae5", color:"#065f46" },
    reservation:  { bg:"#ede9fe", color:"#5b21b6" },
    consultation: { bg:"#fef9c3", color:"#854d0e" },
  };

  return (
    <div ref={wrapRef} style={{ position:"relative" }}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onFocus={() => { if (filtered.length > 0) setOpen(true); }}
        placeholder={placeholder}
        style={inputStyle}
        autoComplete="off"
      />
      {open && (
        <div style={{ position:"absolute", top:"calc(100% + 3px)", left:0, zIndex:400,
          background:"#fff", border:"1px solid #e2e8f0", borderRadius:10,
          boxShadow:"0 8px 28px rgba(0,0,0,0.14)", minWidth:260, maxWidth:360, overflow:"hidden" }}>
          {filtered.map((p, i) => {
            const ss = SOURCE_STYLE[p.source] || SOURCE_STYLE.consultation;
            return (
              <div key={i} onMouseDown={() => select(p)}
                style={{ padding:"9px 14px", cursor:"pointer",
                  borderBottom:"1px solid #f1f5f9",
                  background: i === activeIdx ? "#eff6ff" : "#fff",
                  display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontWeight:700, fontSize:16, color:"#1e293b" }}>{p.name}</span>
                    {p.room && <span style={{ fontSize:13, color:"#64748b" }}>({p.room})</span>}
                  </div>
                  {p.note && (
                    <div style={{ fontSize:12, color:"#94a3b8", marginTop:2,
                      whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:220 }}>
                      {p.note}
                    </div>
                  )}
                </div>
                <span style={{ fontSize:11, borderRadius:4, padding:"2px 7px", fontWeight:700,
                  flexShrink:0, background:ss.bg, color:ss.color }}>
                  {p.sourceBadge}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const NS = {
  navBtn: { background:"transparent", color:"#fff", border:"1px solid rgba(255,255,255,0.3)",
    borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:13, fontWeight:600 },
  monthBtn: { background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:6,
    padding:"4px 12px", cursor:"pointer", fontSize:14, fontWeight:700, color:"#374151" },
};
const MS = {
  input: { border:"1px solid #e2e8f0", borderRadius:6, padding:"7px 10px", fontSize:16,
    fontFamily:"inherit", outline:"none", background:"#fff" },
  addBtn: { background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0",
    borderRadius:6, padding:"5px 14px", cursor:"pointer", fontSize:15, fontWeight:700 },
  delBtn: { background:"none", border:"none", cursor:"pointer", color:"#ef4444",
    fontSize:20, lineHeight:1, flexShrink:0, padding:"0 4px" },
};

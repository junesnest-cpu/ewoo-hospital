import { useState, useEffect, useMemo } from "react";
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
        <span style={{ fontSize:20, fontWeight:900, color:"#0f2744", minWidth:110, textAlign:"center" }}>
          {year}년 {month}월
        </span>
        <button onClick={nextMonth} style={NS.monthBtn}>▶</button>
        <div style={{ display:"flex", gap:8, fontSize:12, marginLeft:8 }}>
          <span style={{ background:"#dcfce7", color:"#166534", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>↑ 입원</span>
          <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>↓ 퇴원</span>
          <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>★ 신환</span>
          <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>◎ 예약</span>
          <span style={{ background:"#e0f2fe", color:"#0369a1", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>✏ 수동편집</span>
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
                      minHeight:90, position:"relative",
                    }}>
                      {/* 날짜 헤더 */}
                      <div style={{
                        padding:"3px 5px", fontWeight:900,
                        fontSize: isMobile ? 12 : 13,
                        color: isToday ? "#d97706" : isSun ? "#dc2626" : isSat ? "#2563eb" : "#1e293b",
                        background: isToday ? "#fef3c7" : isSun ? "#fff5f5" : isSat ? "#eff6ff" : "#f8fafc",
                        borderBottom:"1px solid #e2e8f0",
                        display:"flex", alignItems:"center", gap:3,
                      }}>
                        <span>{day}</span>
                        {isToday && <span style={{ fontSize:9, background:"#f59e0b", color:"#fff", borderRadius:3, padding:"0 3px", fontWeight:700 }}>오늘</span>}
                        {isManual && <span style={{ fontSize:8, background:"#bae6fd", color:"#0369a1", borderRadius:3, padding:"0 3px", fontWeight:700 }}>✏</span>}
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
                          padding:"3px 4px", background:"#f0fdf4" }}>
                          <div style={{ fontSize:9, fontWeight:800, color:"#166534", marginBottom:2 }}>
                            ↑ 입원 {(dayData.admissions||[]).length}
                          </div>
                          {(dayData.admissions||[]).map((p, pi) => (
                            <PatientChip key={p.id||pi} p={p} type="admission" />
                          ))}
                        </div>
                      )}

                      {/* 퇴원 섹션 */}
                      {(dayData.discharges||[]).length > 0 && (
                        <div style={{ padding:"3px 4px", background:"#fff5f5" }}>
                          <div style={{ fontSize:9, fontWeight:800, color:"#991b1b", marginBottom:2 }}>
                            ↓ 퇴원 {(dayData.discharges||[]).length}
                          </div>
                          {(dayData.discharges||[]).map((p, pi) => (
                            <PatientChip key={p.id||pi} p={p} type="discharge" />
                          ))}
                        </div>
                      )}

                      {/* 빈 공간 + 빠른 추가 버튼 */}
                      {!hasData && (
                        <div style={{ minHeight:55, display:"flex", alignItems:"flex-end", justifyContent:"center", paddingBottom:4 }}>
                          <button className="no-print" onClick={() => openEdit(key)}
                            style={{ background:"none", border:"1px dashed #cbd5e1", borderRadius:4,
                              color:"#cbd5e1", cursor:"pointer", fontSize:10, padding:"1px 8px" }}>
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
        <span>이번 달 입원 예정: <strong style={{color:"#166534"}}>{summaryStats.totalAdmit}명</strong></span>
        <span>퇴원 예정: <strong style={{color:"#991b1b"}}>{summaryStats.totalDischarge}명</strong></span>
        <span>신환: <strong style={{color:"#854d0e"}}>{summaryStats.totalNew}명</strong></span>
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
        />
      )}
    </div>
  );
}

/* ── 날짜 편집 모달 ── */
function DayEditModal({ dateKey, admissions, discharges, onChangeAdm, onChangeDis, onSave, onClose, saving }) {
  const d = new Date(dateKey);
  const label = `${d.getMonth()+1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;

  function updateAdm(id, field, val) {
    onChangeAdm(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }
  function updateDis(id, field, val) {
    onChangeDis(rows => rows.map(r => r.id===id ? {...r, [field]:val} : r));
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:200,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={onClose}>
      <div style={{ background:"#fff", borderRadius:12, width:"100%", maxWidth:600,
        maxHeight:"90vh", overflow:"auto", boxShadow:"0 20px 60px rgba(0,0,0,0.3)" }}
        onClick={e => e.stopPropagation()}>

        {/* 모달 헤더 */}
        <div style={{ background:"#0f2744", color:"#fff", padding:"12px 20px",
          display:"flex", alignItems:"center", gap:10, borderRadius:"12px 12px 0 0" }}>
          <span style={{ fontWeight:800, fontSize:16 }}>📅 {label} 편집</span>
          <button onClick={onClose} style={{ marginLeft:"auto", background:"none", border:"none",
            color:"#94a3b8", cursor:"pointer", fontSize:20, lineHeight:1 }}>✕</button>
        </div>

        <div style={{ padding:16, display:"flex", flexDirection:"column", gap:16 }}>

          {/* 입원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:14, color:"#166534" }}>↑ 입원</span>
              <button onClick={() => onChangeAdm(r => [...r, EMPTY_ADM()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {admissions.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>입원 항목 없음</div>
            )}
            {admissions.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"center",
                marginBottom:8, background:"#f0fdf4", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", gap:6, flexWrap:"wrap" }}>
                  <input value={row.name} onChange={e => updateAdm(row.id,"name",e.target.value)}
                    placeholder="이름" style={{ ...MS.input, width:90 }} />
                  <input value={row.room} onChange={e => updateAdm(row.id,"room",e.target.value)}
                    placeholder="호실" style={{ ...MS.input, width:80 }} />
                  <input value={row.note} onChange={e => updateAdm(row.id,"note",e.target.value)}
                    placeholder="비고 (나이, 진단, 병원 등)" style={{ ...MS.input, flex:1, minWidth:120 }} />
                  <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                    <label style={{ display:"flex", alignItems:"center", gap:3, fontSize:12, cursor:"pointer",
                      background: row.isNew ? "#fef08a":"#f1f5f9", borderRadius:5, padding:"2px 8px",
                      border:"1px solid", borderColor: row.isNew?"#fcd34d":"#e2e8f0",
                      color: row.isNew?"#713f12":"#64748b", fontWeight: row.isNew?700:500 }}>
                      <input type="checkbox" checked={!!row.isNew}
                        onChange={e => updateAdm(row.id,"isNew",e.target.checked)}
                        style={{ margin:0 }} />
                      ★신환
                    </label>
                    <label style={{ display:"flex", alignItems:"center", gap:3, fontSize:12, cursor:"pointer",
                      background: row.isReserved ? "#ede9fe":"#f1f5f9", borderRadius:5, padding:"2px 8px",
                      border:"1px solid", borderColor: row.isReserved?"#c4b5fd":"#e2e8f0",
                      color: row.isReserved?"#5b21b6":"#64748b", fontWeight: row.isReserved?700:500 }}>
                      <input type="checkbox" checked={!!row.isReserved}
                        onChange={e => updateAdm(row.id,"isReserved",e.target.checked)}
                        style={{ margin:0 }} />
                      ◎예약
                    </label>
                  </div>
                </div>
                <button onClick={() => onChangeAdm(r => r.filter(x => x.id !== row.id))}
                  style={MS.delBtn}>✕</button>
              </div>
            ))}
          </div>

          {/* 퇴원 섹션 */}
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
              <span style={{ fontWeight:800, fontSize:14, color:"#991b1b" }}>↓ 퇴원</span>
              <button onClick={() => onChangeDis(r => [...r, EMPTY_DIS()])}
                style={MS.addBtn}>+ 추가</button>
            </div>
            {discharges.length === 0 && (
              <div style={{ color:"#94a3b8", fontSize:13, padding:"8px 0" }}>퇴원 항목 없음</div>
            )}
            {discharges.map(row => (
              <div key={row.id} style={{ display:"flex", gap:6, alignItems:"center",
                marginBottom:8, background:"#fff5f5", borderRadius:8, padding:"8px 10px" }}>
                <div style={{ flex:1, display:"flex", gap:6, flexWrap:"wrap" }}>
                  <input value={row.name} onChange={e => updateDis(row.id,"name",e.target.value)}
                    placeholder="이름" style={{ ...MS.input, width:100 }} />
                  <input value={row.room} onChange={e => updateDis(row.id,"room",e.target.value)}
                    placeholder="호실" style={{ ...MS.input, width:80 }} />
                  <input value={row.note} onChange={e => updateDis(row.id,"note",e.target.value)}
                    placeholder="비고 (재입원: 3/28 재입원 등)" style={{ ...MS.input, flex:1, minWidth:120 }} />
                </div>
                <button onClick={() => onChangeDis(r => r.filter(x => x.id !== row.id))}
                  style={MS.delBtn}>✕</button>
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
    <div style={{ display:"flex", alignItems:"center", gap:2, flexWrap:"wrap", marginBottom:2, lineHeight:1.3 }}>
      {p.isNew && <span style={{ fontSize:8, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"0 3px", fontWeight:800, flexShrink:0 }}>★신</span>}
      {p.isReserved && !p.isNew && <span style={{ fontSize:8, background:"#ede9fe", color:"#5b21b6", borderRadius:3, padding:"0 3px", fontWeight:800, flexShrink:0 }}>◎</span>}
      <span style={{ fontSize:11, fontWeight:700, color: type==="admission" ? "#065f46" : "#991b1b" }}>{p.name}</span>
      {p.room && <span style={{ fontSize:9, color:"#64748b" }}>({p.room})</span>}
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
  input: { border:"1px solid #e2e8f0", borderRadius:6, padding:"5px 8px", fontSize:12,
    fontFamily:"inherit", outline:"none", background:"#fff" },
  addBtn: { background:"#f0fdf4", color:"#166534", border:"1px solid #bbf7d0",
    borderRadius:6, padding:"3px 10px", cursor:"pointer", fontSize:12, fontWeight:700 },
  delBtn: { background:"none", border:"none", cursor:"pointer", color:"#ef4444",
    fontSize:16, lineHeight:1, flexShrink:0, padding:"0 4px" },
};

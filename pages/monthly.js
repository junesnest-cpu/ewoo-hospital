import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DOW = ["일","월","화","수","목","금","토"];

// M/D 형식 → Date (주어진 year/month 기준)
function parseMD(str, year, month) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
}

// YYYY-MM-DD → Date
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

// 슬롯 키에서 병실 정보 추출
function slotKeyToRoom(slotKey) {
  const [roomId, bedNum] = slotKey.split("-");
  return roomId ? `${roomId}호 ${bedNum}번` : slotKey;
}

// 날짜를 "YYYY-MM-DD" 키로 변환
function dateKey(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default function MonthlySchedule() {
  const router = useRouter();
  const isMobile = useIsMobile();

  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [slots, setSlots] = useState({});
  const [consultations, setConsultations] = useState({});
  const [memo, setMemo] = useState("");
  const [memoEdit, setMemoEdit] = useState("");
  const [memoEditing, setMemoEditing] = useState(false);
  const [memoSaving, setMemoSaving] = useState(false);

  useEffect(() => {
    const u1 = onValue(ref(db,"slots"), snap => setSlots(snap.val() || {}));
    const u2 = onValue(ref(db,"consultations"), snap => setConsultations(snap.val() || {}));
    return () => { u1(); u2(); };
  }, []);

  const memoKey = `${year}-${String(month).padStart(2,"0")}`;
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

  // 해당 월의 날짜별 입원/퇴원 명단 계산
  const calendarData = useMemo(() => {
    const data = {}; // key: "YYYY-MM-DD" → { admissions: [], discharges: [] }

    const ensure = (key) => {
      if (!data[key]) data[key] = { admissions: [], discharges: [] };
    };

    // slots → 현재 환자 + 예약 환자
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomLabel = slotKeyToRoom(slotKey);

      // 현재 입원 환자
      const cur = slot?.current;
      if (cur?.name) {
        const admitD = parseMD(cur.admitDate, year, month);
        const dischargeD = parseMD(cur.discharge, year, month);
        const aKey = dateKey(admitD);
        const dKey = dateKey(dischargeD);
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ name: cur.name, room: roomLabel, note: cur.note||"", isNew: false, isReadmit: false }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ name: cur.name, room: roomLabel, note: cur.discharge||"", isNew: false }); }
      }

      // 예약 환자
      (slot?.reservations || []).forEach(r => {
        if (!r?.name) return;
        const admitD = parseMD(r.admitDate, year, month);
        const dischargeD = parseMD(r.discharge, year, month);
        const aKey = dateKey(admitD);
        const dKey = dateKey(dischargeD);
        if (aKey) { ensure(aKey); data[aKey].admissions.push({ name: r.name, room: roomLabel, note: r.note||"", isNew: false, isReadmit: false, isReserved: true }); }
        if (dKey) { ensure(dKey); data[dKey].discharges.push({ name: r.name, room: roomLabel, note: r.discharge||"", isNew: false }); }
      });
    });

    // consultations → 신환 예정 환자 (예약완료 상태이고 admitDate 있는 것)
    Object.values(consultations).forEach(c => {
      if (!c?.name || !c.admitDate) return;
      if (c.status === "취소" || c.status === "입원완료") return;
      const admitD = parseISO(c.admitDate);
      if (!admitD) return;
      const aKey = dateKey(admitD);
      if (!aKey) return;
      ensure(aKey);
      // 이미 slots에 같은 이름이 있으면 중복 제거
      const alreadyIn = data[aKey].admissions.some(a => a.name === c.name);
      if (!alreadyIn) {
        data[aKey].admissions.push({
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

  // 달력 격자 생성
  const calendarGrid = useMemo(() => {
    const total = daysInMonth(year, month);
    const firstDow = new Date(year, month - 1, 1).getDay(); // 0=일
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

  const printStyle = `
    @media print {
      @page { size: A4 landscape; margin: 8mm; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
      .print-grid { font-size: 9px !important; }
      .print-title { display: block !important; }
      .print-memo { display: block !important; }
    }
  `;

  return (
    <div style={{ minHeight:"100vh", background:"#f8fafc", fontFamily:"'Pretendard','Noto Sans KR',sans-serif" }}>
      <style>{printStyle}</style>

      {/* 헤더 */}
      <header className="no-print" style={{ background:"#0f2744", color:"#fff", padding:"10px 20px", display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:30 }}>
        <button onClick={() => router.push("/")} style={NS.navBtn}>🏠 홈</button>
        <span style={{ fontWeight:800, fontSize:16 }}>📅 월간 입퇴원 예정표</span>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <button onClick={() => router.push("/consultation")} style={NS.navBtn}>📋 상담일지</button>
          <button onClick={() => router.push("/patients")} style={NS.navBtn}>👤 환자조회</button>
          <button onClick={() => window.print()} style={{ ...NS.navBtn, background:"#1e3a5f" }}>🖨 인쇄</button>
        </div>
      </header>

      {/* 월 네비게이션 */}
      <div className="no-print" style={{ background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"10px 20px", display:"flex", alignItems:"center", gap:16 }}>
        <button onClick={prevMonth} style={NS.monthBtn}>◀</button>
        <span style={{ fontSize:20, fontWeight:900, color:"#0f2744", minWidth:120, textAlign:"center" }}>
          {year}년 {month}월
        </span>
        <button onClick={nextMonth} style={NS.monthBtn}>▶</button>
        <div style={{ marginLeft:16, display:"flex", gap:10, fontSize:12 }}>
          <span style={{ background:"#dcfce7", color:"#166534", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>↑ 입원</span>
          <span style={{ background:"#fee2e2", color:"#991b1b", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>↓ 퇴원</span>
          <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>★ 신환</span>
          <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:4, padding:"2px 8px", fontWeight:700 }}>◎ 예약대기</span>
        </div>
      </div>

      {/* 공지/메모 */}
      <div style={{ background:"#fffbeb", borderBottom:"1px solid #fde68a", padding:"8px 20px", display:"flex", alignItems:"flex-start", gap:10 }}>
        <span style={{ fontSize:14, flexShrink:0, marginTop:2 }}>📌</span>
        {memoEditing ? (
          <div style={{ flex:1, display:"flex", gap:8, alignItems:"flex-start" }}>
            <textarea
              value={memoEdit}
              onChange={e => setMemoEdit(e.target.value)}
              placeholder={`${year}년 ${month}월 공지 및 메모를 입력하세요...`}
              rows={3}
              style={{ flex:1, border:"1px solid #fcd34d", borderRadius:6, padding:"6px 10px",
                fontSize:13, resize:"vertical", fontFamily:"inherit", background:"#fff" }}
            />
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
            <span style={{ flex:1, fontSize:13, color: memo ? "#78350f" : "#a16207", whiteSpace:"pre-wrap", lineHeight:1.6,
              minHeight:20 }}>
              {memo || <span style={{ color:"#d97706", fontStyle:"italic" }}>이번 달 공지/메모 없음 — 편집 버튼을 눌러 추가</span>}
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
        <table className="print-grid" style={{ width:"100%", borderCollapse:"collapse", tableLayout:"fixed", minWidth: isMobile ? 700 : "auto" }}>
          <thead>
            <tr>
              {DOW.map((d, i) => (
                <th key={i} style={{
                  background: i===0 ? "#fef2f2" : i===6 ? "#eff6ff" : "#1e3a5f",
                  color: i===0 ? "#dc2626" : i===6 ? "#2563eb" : "#fff",
                  padding:"6px 4px", textAlign:"center", fontSize:13, fontWeight:800,
                  border:"1px solid #cbd5e1", width:"14.28%",
                }}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calendarGrid.map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => {
                  if (!day) return <td key={di} style={{ border:"1px solid #e2e8f0", background:"#f8fafc", verticalAlign:"top", minHeight:90 }} />;
                  const key = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                  const dayData = calendarData[key] || { admissions: [], discharges: [] };
                  const isToday = key === `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,"0")}-${String(new Date().getDate()).padStart(2,"0")}`;
                  const isSun = di === 0, isSat = di === 6;

                  return (
                    <td key={di} style={{
                      border:"1px solid #e2e8f0",
                      verticalAlign:"top",
                      padding:0,
                      background: isToday ? "#fffbeb" : "#fff",
                      minHeight:90,
                    }}>
                      {/* 날짜 헤더 */}
                      <div style={{
                        padding:"3px 6px", fontWeight:900,
                        fontSize: isMobile ? 13 : 14,
                        color: isToday ? "#d97706" : isSun ? "#dc2626" : isSat ? "#2563eb" : "#1e293b",
                        background: isToday ? "#fef3c7" : isSun ? "#fff5f5" : isSat ? "#eff6ff" : "#f8fafc",
                        borderBottom:"1px solid #e2e8f0",
                        display:"flex", alignItems:"center", gap:4,
                      }}>
                        {day}
                        {isToday && <span style={{ fontSize:10, background:"#f59e0b", color:"#fff", borderRadius:3, padding:"0 4px", fontWeight:700 }}>오늘</span>}
                      </div>

                      {/* 입원 섹션 */}
                      {dayData.admissions.length > 0 && (
                        <div style={{ borderBottom: dayData.discharges.length > 0 ? "1px dashed #bbf7d0" : "none", padding:"3px 4px 3px", background:"#f0fdf4" }}>
                          <div style={{ fontSize:9, fontWeight:800, color:"#166534", marginBottom:2 }}>↑ 입원 {dayData.admissions.length}</div>
                          {dayData.admissions.map((p, pi) => (
                            <PatientChip key={pi} p={p} type="admission" />
                          ))}
                        </div>
                      )}

                      {/* 퇴원 섹션 */}
                      {dayData.discharges.length > 0 && (
                        <div style={{ padding:"3px 4px 3px", background:"#fff5f5" }}>
                          <div style={{ fontSize:9, fontWeight:800, color:"#991b1b", marginBottom:2 }}>↓ 퇴원 {dayData.discharges.length}</div>
                          {dayData.discharges.map((p, pi) => (
                            <PatientChip key={pi} p={p} type="discharge" />
                          ))}
                        </div>
                      )}

                      {/* 둘 다 없으면 빈 공간 */}
                      {dayData.admissions.length === 0 && dayData.discharges.length === 0 && (
                        <div style={{ minHeight:60 }} />
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
      <div className="no-print" style={{ padding:"12px 20px", background:"#fff", borderTop:"1px solid #e2e8f0", display:"flex", gap:20, fontSize:13, color:"#64748b" }}>
        {(() => {
          let totalAdmit = 0, totalDischarge = 0, totalNew = 0;
          Object.values(calendarData).forEach(d => {
            totalAdmit += d.admissions.length;
            totalDischarge += d.discharges.length;
            totalNew += d.admissions.filter(a => a.isNew).length;
          });
          return <>
            <span>이번 달 입원 예정: <strong style={{color:"#166534"}}>{totalAdmit}명</strong></span>
            <span>퇴원 예정: <strong style={{color:"#991b1b"}}>{totalDischarge}명</strong></span>
            <span>신환: <strong style={{color:"#854d0e"}}>{totalNew}명</strong></span>
          </>;
        })()}
      </div>
    </div>
  );
}

function PatientChip({ p, type }) {
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:2, flexWrap:"wrap",
      marginBottom:2, lineHeight:1.3,
    }}>
      {/* 신환 배지 */}
      {p.isNew && (
        <span style={{ fontSize:8, background:"#fef08a", color:"#713f12", borderRadius:3, padding:"0 3px", fontWeight:800, flexShrink:0 }}>★신</span>
      )}
      {/* 예약 배지 */}
      {p.isReserved && !p.isNew && (
        <span style={{ fontSize:8, background:"#ede9fe", color:"#5b21b6", borderRadius:3, padding:"0 3px", fontWeight:800, flexShrink:0 }}>◎</span>
      )}
      {/* 이름 */}
      <span style={{ fontSize:11, fontWeight:700, color: type==="admission" ? "#065f46" : "#991b1b" }}>
        {p.name}
      </span>
      {/* 병실 */}
      {p.room && (
        <span style={{ fontSize:9, color:"#64748b" }}>({p.room})</span>
      )}
    </div>
  );
}

const NS = {
  navBtn: {
    background:"transparent", color:"#fff", border:"1px solid rgba(255,255,255,0.3)",
    borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:13, fontWeight:600,
  },
  monthBtn: {
    background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:6,
    padding:"4px 12px", cursor:"pointer", fontSize:14, fontWeight:700, color:"#374151",
  },
};

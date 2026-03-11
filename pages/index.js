import { useState, useEffect, useCallback, useRef } from "react";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";

const WARD_STRUCTURE = {
  2: { name: "2병동", rooms: [
    { id: "201", type: "4인실", capacity: 4 }, { id: "202", type: "1인실", capacity: 1 },
    { id: "203", type: "4인실", capacity: 4 }, { id: "204", type: "2인실", capacity: 2 },
    { id: "205", type: "6인실", capacity: 6 }, { id: "206", type: "6인실", capacity: 6 },
  ]},
  3: { name: "3병동", rooms: [
    { id: "301", type: "4인실", capacity: 4 }, { id: "302", type: "1인실", capacity: 1 },
    { id: "303", type: "4인실", capacity: 4 }, { id: "304", type: "2인실", capacity: 2 },
    { id: "305", type: "2인실", capacity: 2 }, { id: "306", type: "6인실", capacity: 6 },
  ]},
  5: { name: "5병동", rooms: [
    { id: "501", type: "4인실", capacity: 4 }, { id: "502", type: "1인실", capacity: 1 },
    { id: "503", type: "4인실", capacity: 4 }, { id: "504", type: "2인실", capacity: 2 },
    { id: "505", type: "6인실", capacity: 6 }, { id: "506", type: "6인실", capacity: 6 },
  ]},
  6: { name: "6병동", rooms: [
    { id: "601", type: "6인실", capacity: 6 }, { id: "602", type: "1인실", capacity: 1 },
    { id: "603", type: "6인실", capacity: 6 },
  ]},
};

const TYPE_COLOR = { "1인실": "#6366f1", "2인실": "#0ea5e9", "4인실": "#10b981", "6인실": "#f59e0b" };
const TYPE_BG    = { "1인실": "#eef2ff", "2인실": "#e0f2fe", "4인실": "#d1fae5", "6인실": "#fef3c7" };

// ── 날짜 유틸 ──────────────────────────────────────────────────────────────────
function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const year = new Date().getFullYear();
  return new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function toInputValue(date) { return date.toISOString().slice(0, 10); }
function toKoreanDate(date) {
  return `${date.getMonth()+1}월 ${date.getDate()}일 (${["일","월","화","수","목","금","토"][date.getDay()]})`;
}
function todayDate() { return dateOnly(new Date()); }

function getDdayLabel(discharge) {
  const d = parseDateStr(discharge);
  if (!d) return null;
  const diff = Math.round((dateOnly(d) - todayDate()) / 86400000);
  if (diff === 0) return { text: "D-Day", color: "#dc2626", bg: "#fee2e2" };
  if (diff > 0)   return { text: `D-${diff}`, color: diff <= 3 ? "#d97706":"#64748b", bg: diff <= 3 ? "#fef3c7":"#f1f5f9" };
  return { text: `D+${Math.abs(diff)}`, color: "#9ca3af", bg: "#f3f4f6" };
}

// ── 핵심: viewDate 기준으로 병상에 누가 있는지 반환 ────────────────────────────
// 슬롯 데이터 구조:
//   patients["201-1"] = {
//     current: { name, discharge, note, bedPosition, scheduleAlert },  // 현재 입원 환자 (없으면 null)
//     reservations: [                                                    // 예약 목록 (없으면 [])
//       { name, admitDate, discharge, note, bedPosition, scheduleAlert }
//     ]
//   }
//
// getSlotOccupant(slot, viewDate) → 해당 날짜에 이 병상에 있는 사람 반환
//   반환: { person, type }
//   type: "current" | "reserved" | "discharging_today" | "admitting_today" | null

function getSlotOccupant(slot, viewDate) {
  if (!slot) return { person: null, type: null };
  const vd = dateOnly(viewDate);
  const today = todayDate();
  const isToday = vd.getTime() === today.getTime();

  // 현재 환자가 viewDate에도 입원 중인지 확인
  if (slot.current) {
    const dischargeD = parseDateStr(slot.current.discharge);
    const stillHere = !dischargeD || dateOnly(dischargeD) >= vd;
    if (stillHere) {
      const dischargingToday = dischargeD && dateOnly(dischargeD).getTime() === vd.getTime();
      return { person: slot.current, type: dischargingToday ? "discharging_today" : "current" };
    }
  }

  // 현재 환자가 없거나 이미 퇴원 → 예약자 중 viewDate에 입원 중인 사람 찾기
  const reservations = slot.reservations || [];
  for (const r of reservations) {
    const admitD    = parseDateStr(r.admitDate);
    const dischargeD = parseDateStr(r.discharge);
    if (!admitD) continue;
    const admitDO = dateOnly(admitD);
    const stillHere = !dischargeD || dateOnly(dischargeD) >= vd;
    if (admitDO <= vd && stillHere) {
      const admittingToday = admitDO.getTime() === vd.getTime();
      return { person: r, type: admittingToday ? "admitting_today" : "reserved" };
    }
  }

  return { person: null, type: null };
}

// 오늘 기준으로 이 병상에 미래 예약이 있는지 확인
function hasUpcomingReservation(slot) {
  if (!slot?.reservations?.length) return false;
  const today = todayDate();
  return slot.reservations.some(r => {
    const d = parseDateStr(r.admitDate);
    return d && dateOnly(d) > today;
  });
}

// ── 초기 데이터 ────────────────────────────────────────────────────────────────
const INIT_SLOTS = {
  "201-1": {
    current: { name: "임순태", bedPosition: 1, discharge: "미정", note: "이뮤알파·이스카도(월수금)", scheduleAlert: true },
    reservations: []
  },
  "201-2": {
    current: { name: "황세영", bedPosition: 2, discharge: "3/17 점심후", note: "페인 2-3회, 퇴원약 메시마", scheduleAlert: true },
    reservations: [
      { name: "김예약", admitDate: "3/18", discharge: "3/25", note: "예약 입원 샘플", scheduleAlert: false, bedPosition: 2 }
    ]
  },
};

// Anthropic 공식 브라우저 직접 호출 방식 (dangerous-direct-browser-access 헤더 사용)

// Next.js API Route를 통해 서버에서 Anthropic API 호출 (CORS 문제 없음)
async function analyzeMessengerText(text) {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ════════════════════════════════════════════════════════════════════════════════
export default function HospitalWardManager() {
  const [slots,          setSlots]          = useState({});  // 병상 데이터 { "201-1": { current, reservations } }
  const [view,           setView]           = useState("ward");
  const [selectedRoom,   setSelectedRoom]   = useState(null);
  const [editingSlot,    setEditingSlot]    = useState(null); // { slotKey, mode: "current"|"reservation", resIndex }
  const [addingTo,       setAddingTo]       = useState(null); // { slotKey, mode: "current"|"reservation" }
  const [uploading,      setUploading]      = useState(false);
  const [jsonPasteOpen,  setJsonPasteOpen]  = useState(false);
  const [jsonPasteText,  setJsonPasteText]  = useState("");
  const [uploadResult,   setUploadResult]   = useState(null);
  const [logs,           setLogs]           = useState([]);
  const [lastSync,       setLastSync]       = useState(null);
  const [syncing,        setSyncing]        = useState(true);
  const [previewDate,    setPreviewDate]    = useState(null);
  const [previewInput,   setPreviewInput]   = useState(toInputValue(todayDate()));
  const [showReserved,   setShowReserved]   = useState(true); // 통계에 예약 포함 여부
  const fileInputRef = useRef();

  const isPreview = previewDate !== null;
  const viewDate  = previewDate || todayDate();

  // ── Firebase ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setSyncing(true);
    const sRef = ref(db, "slots");
    const unsubS = onValue(sRef, snap => {
      const val = snap.val();
      if (val) setSlots(val);
      else { set(sRef, INIT_SLOTS); setSlots(INIT_SLOTS); }
      setLastSync(new Date()); setSyncing(false);
    }, () => setSyncing(false));
    const unsubL = onValue(ref(db, "logs"), snap => {
      const val = snap.val();
      if (val) setLogs(Array.isArray(val) ? val : Object.values(val));
    });
    return () => { unsubS(); unsubL(); };
  }, []);

  const saveSlots = useCallback(async (newS) => {
    setSlots(newS);
    await set(ref(db, "slots"), newS);
  }, []);

  const addLog = useCallback(async (entry) => {
    const newLog = { ...entry, ts: new Date().toISOString() };
    setLogs(prev => {
      const updated = [newLog, ...prev].slice(0, 100);
      set(ref(db, "logs"), updated).catch(console.error);
      return updated;
    });
  }, []);

  const manualRefresh = useCallback(async () => {
    setSyncing(true);
    const snap = await get(ref(db, "slots"));
    if (snap.val()) setSlots(snap.val());
    setLastSync(new Date()); setSyncing(false);
  }, []);

  // ── 미리보기 ──────────────────────────────────────────────────────────────
  const applyPreview = () => { setPreviewDate(new Date(previewInput + "T00:00:00")); setView("ward"); setSelectedRoom(null); };
  const clearPreview = () => { setPreviewDate(null); setPreviewInput(toInputValue(todayDate())); };

  // ── 병실 통계 ─────────────────────────────────────────────────────────────
  const getRoomStats = useCallback((roomId, capacity) => {
    const roomSlots = Array.from({ length: capacity }, (_, i) => {
      const key = `${roomId}-${i+1}`;
      return { key, slot: slots[key] || null };
    });

    const bedList = roomSlots.map(({ key, slot }) => {
      const { person, type } = getSlotOccupant(slot, viewDate);
      const hasReserve = !isPreview && hasUpcomingReservation(slot);
      return { slotKey: key, person, type, hasReserve, slot };
    });

    // 통계: 오늘 현황에서 showReserved=true면 예약 포함 계산
    const occupied = bedList.filter(b => {
      if (b.person) return true; // 해당 날짜에 사람 있음
      if (!isPreview && showReserved && b.hasReserve) return true; // 예약 포함 계산
      return false;
    }).length;

    return { occupied, available: capacity - occupied, bedList };
  }, [slots, viewDate, isPreview, showReserved]);

  const totalStats = useCallback(() => {
    let occ = 0;
    Object.values(WARD_STRUCTURE).forEach(ward =>
      ward.rooms.forEach(r => { occ += getRoomStats(r.id, r.capacity).occupied; })
    );
    return { total: 78, occupied: occ, available: 78 - occ };
  }, [getRoomStats]);

  // ── CRUD ─────────────────────────────────────────────────────────────────
  // 현재 환자 저장
  const saveCurrentPatient = async (slotKey, data) => {
    const newSlots = { ...slots, [slotKey]: { ...(slots[slotKey] || { reservations: [] }), current: data } };
    await saveSlots(newSlots);
    await addLog({ type: "edit", msg: `${slotKey} ${data.name} 정보 수정` });
    setEditingSlot(null); setAddingTo(null);
  };

  // 현재 환자 퇴원
  const dischargeCurrentPatient = async (slotKey) => {
    if (!window.confirm("퇴원 처리하시겠습니까?")) return;
    const name = slots[slotKey]?.current?.name;
    const newSlot = { ...(slots[slotKey] || {}), current: null };
    // 예약자 중 오늘 이후 입원 예정자가 있으면 첫번째를 current로 승격
    const reservations = newSlot.reservations || [];
    const today = todayDate();
    const nextIdx = reservations.findIndex(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) <= today; });
    if (nextIdx >= 0) {
      newSlot.current = { ...reservations[nextIdx] };
      delete newSlot.current.admitDate;
      newSlot.reservations = reservations.filter((_, i) => i !== nextIdx);
    }
    await saveSlots({ ...slots, [slotKey]: newSlot });
    await addLog({ type: "discharge", msg: `${slotKey} ${name} 퇴원 처리` });
    setEditingSlot(null);
  };

  // 예약 저장 (신규/수정)
  const saveReservation = async (slotKey, resData, resIndex) => {
    const oldSlot = slots[slotKey] || { current: null, reservations: [] };
    const reservations = [...(oldSlot.reservations || [])];
    if (resIndex !== undefined) reservations[resIndex] = resData;
    else reservations.push(resData);
    // admitDate 기준 정렬
    reservations.sort((a, b) => {
      const da = parseDateStr(a.admitDate), db2 = parseDateStr(b.admitDate);
      if (!da) return 1; if (!db2) return -1;
      return da - db2;
    });
    await saveSlots({ ...slots, [slotKey]: { ...oldSlot, reservations } });
    await addLog({ type: "reserve", msg: `${slotKey} ${resData.name} ${resIndex !== undefined ? "예약 수정" : "예약 입원 등록"} (${resData.admitDate})` });
    setEditingSlot(null); setAddingTo(null);
  };

  // 예약 취소
  const cancelReservation = async (slotKey, resIndex) => {
    if (!window.confirm("예약을 취소하시겠습니까?")) return;
    const oldSlot = slots[slotKey] || { current: null, reservations: [] };
    const name = oldSlot.reservations?.[resIndex]?.name;
    const reservations = (oldSlot.reservations || []).filter((_, i) => i !== resIndex);
    await saveSlots({ ...slots, [slotKey]: { ...oldSlot, reservations } });
    await addLog({ type: "reserve", msg: `${slotKey} ${name} 예약 취소` });
    setEditingSlot(null);
  };

  // 메신저 분석
  const handleFileUpload = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    setUploading(true); setUploadResult(null);
    try { setUploadResult({ results: await analyzeMessengerText(await file.text()) }); }
    catch (err) { setUploadResult({ error: "분석 실패: " + err.message }); }
    setUploading(false); e.target.value = "";
  };

  const applyAnalysis = async (results) => {
    const newSlots = { ...slots }; let applied = 0;
    results.forEach(r => {
      if (!r.room || !r.name) return;
      let cap = 4;
      for (const ward of Object.values(WARD_STRUCTURE)) { const rm = ward.rooms.find(x => x.id === r.room); if (rm) { cap = rm.capacity; break; } }
      // 이미 있는 환자면 업데이트
      for (let i = 1; i <= cap; i++) {
        const key = `${r.room}-${i}`;
        if (newSlots[key]?.current?.name === r.name) {
          newSlots[key] = { ...newSlots[key], current: { ...newSlots[key].current, discharge: r.discharge, note: r.note, scheduleAlert: r.scheduleAlert } };
          applied++; return;
        }
      }
      // 없으면 빈 슬롯에 추가
      for (let i = 1; i <= cap; i++) {
        const key = `${r.room}-${i}`;
        if (!newSlots[key]?.current) {
          newSlots[key] = { current: { name: r.name, bedPosition: i, discharge: r.discharge || "미정", note: r.note || "", scheduleAlert: r.scheduleAlert || false }, reservations: [] };
          applied++; return;
        }
      }
    });
    await saveSlots(newSlots);
    await addLog({ type: "upload", msg: `메신저 분석 완료: ${applied}명 반영` });
    setUploadResult(null);
  };

  const stats = totalStats();

  if (syncing && Object.keys(slots).length === 0) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:16, background:"#f0f4f8" }}>
      <div style={{ fontSize:40 }}>🏥</div>
      <div style={{ fontSize:16, fontWeight:700, color:"#0f2744" }}>병동 현황 불러오는 중...</div>
    </div>
  );

  return (
    <div style={S.app}>
      {/* 헤더 */}
      <header style={{ ...S.header, background: isPreview ? "#0d3320":"#0f2744" }}>
        <div style={S.headerLeft}>
          <div style={S.logoMark}>🏥</div>
          <div><div style={S.title}>병동 현황 관리</div><div style={S.subtitle}>Ward Management System</div></div>
        </div>
        <div style={S.headerCenter}>
          <StatPill label="전체 병상"  value={stats.total}     color="#64748b" />
          <StatPill label="사용 중"    value={stats.occupied}  color={isPreview ? "#34d399":"#0ea5e9"} />
          <StatPill label="빈 병상"    value={stats.available} color={isPreview ? "#6ee7b7":"#10b981"} />
          {!isPreview && (
            <button onClick={() => setShowReserved(v => !v)}
              style={{ ...S.reserveToggle, background: showReserved ? "#312e81":"#1e293b", color: showReserved ? "#a5b4fc":"#94a3b8" }}>
              📅 예약 {showReserved ? "포함":"미포함"}
            </button>
          )}
        </div>
        <div style={S.headerRight}>
          <span style={S.syncInfo}>{syncing ? "🔄 동기화 중..." : lastSync ? `✓ ${lastSync.toLocaleTimeString("ko")} 저장됨` : ""}</span>
          <button style={S.btnRefresh} onClick={manualRefresh} title="새로고침">↻</button>
          <button
            style={{ ...S.navBtn, background: view==="ward" && !selectedRoom ? "#1e3a5f":"transparent", display:"flex", alignItems:"center", gap:5 }}
            onClick={() => { setView("ward"); setSelectedRoom(null); clearPreview(); }}
            title="처음 현황판으로">
            🏠 홈
          </button>
          <button style={{ ...S.navBtn, background: view==="ward" && !selectedRoom ? "#1e3a5f":"transparent" }} onClick={() => { setView("ward"); setSelectedRoom(null); }}>병실 현황</button>
          <button style={{ ...S.navBtn, background: view==="log"  ? "#1e3a5f":"transparent" }} onClick={() => setView("log")}>변경 이력</button>
        </div>
      </header>

      {/* 날짜 바 */}
      <div style={{ ...S.datebar, background: isPreview ? "#f0fdf4":"#fff", borderBottom: isPreview ? "2px solid #6ee7b7":"1px solid #e2e8f0" }}>
        <div style={S.datebarLeft}>
          {isPreview ? <span style={S.previewBadge}>🔭 미래 미리보기 중</span> : <span style={S.todayBadge}>📅 오늘 실시간 현황</span>}
          <span style={S.activeDateLabel}>{toKoreanDate(viewDate)}</span>
        </div>
        <div style={S.datebarRight}>
          <span style={{ fontSize:13, color:"#64748b", fontWeight:600 }}>날짜 미리보기:</span>
          <input type="date" style={S.dateInput} value={previewInput} onChange={e => setPreviewInput(e.target.value)} />
          <button style={S.btnPreview} onClick={applyPreview}>미리보기</button>
          {isPreview && <button style={S.btnToday} onClick={clearPreview}>← 오늘로</button>}
        </div>
      </div>

      {/* 업로드 바 */}
      {!isPreview && (
        <div style={S.uploadBar}>
          <span style={S.uploadLabel}>📩 메신저 파일 분석</span>
          <input ref={fileInputRef} type="file" accept=".txt" style={{ display:"none" }} onChange={handleFileUpload} />
          <button style={S.btnUpload} onClick={() => fileInputRef.current.click()} disabled={uploading}>{uploading ? "⏳ 분석 중...":"📂 파일 업로드"}</button>
      {uploadResult?.error && (
        <div style={{ background:"#fef2f2", borderBottom:"1px solid #fecaca", padding:"10px 28px", fontSize:13, color:"#dc2626" }}>
          ❌ {uploadResult.error}
          {uploadResult.error.includes("API Key") && (
            <span style={{ marginLeft:8, color:"#7f1d1d" }}>
              → Vercel 대시보드 › Settings › Environment Variables 에서 <strong>VITE_ANTHROPIC_API_KEY</strong> 를 추가하세요.
            </span>
          )}
        </div>
      )}
        </div>
      )}
      {uploadResult?.results && <AnalysisPreview results={uploadResult.results} onApply={() => applyAnalysis(uploadResult.results)} onDiscard={() => setUploadResult(null)} />}

      {/* 본문 */}
      <main style={S.main}>
        {view === "ward" && <WardView slots={slots} getRoomStats={getRoomStats} isPreview={isPreview} viewDate={viewDate} showReserved={showReserved} onSelectRoom={r => { setSelectedRoom(r); setView("room"); }} />}
        {view === "room" && selectedRoom && (
          <RoomDetailView room={selectedRoom} slots={slots} getRoomStats={getRoomStats} isPreview={isPreview} viewDate={viewDate}
            onEditCurrent={(sk, data) => setEditingSlot({ slotKey: sk, mode: "current", data })}
            onEditReservation={(sk, data, idx) => setEditingSlot({ slotKey: sk, mode: "reservation", data, resIndex: idx })}
            onAddCurrent={sk => setAddingTo({ slotKey: sk, mode: "current" })}
            onAddReservation={sk => setAddingTo({ slotKey: sk, mode: "reservation" })}
            onBack={() => setView("ward")} />
        )}
        {view === "log" && <LogView logs={logs} />}
      </main>

      {/* 현재 환자 수정 모달 */}
      {editingSlot?.mode === "current" && (
        <PatientModal
          title={`${editingSlot.slotKey} 현재 환자 수정`}
          data={editingSlot.data}
          mode="current"
          onSave={data => saveCurrentPatient(editingSlot.slotKey, data)}
          onDelete={() => dischargeCurrentPatient(editingSlot.slotKey)}
          onClose={() => setEditingSlot(null)} />
      )}
      {/* 예약 수정 모달 */}
      {editingSlot?.mode === "reservation" && (
        <PatientModal
          title={`${editingSlot.slotKey} 예약 수정`}
          data={editingSlot.data}
          mode="reservation"
          onSave={data => saveReservation(editingSlot.slotKey, data, editingSlot.resIndex)}
          onDelete={() => cancelReservation(editingSlot.slotKey, editingSlot.resIndex)}
          onClose={() => setEditingSlot(null)} />
      )}
      {/* 신규 현재 환자 추가 */}
      {addingTo?.mode === "current" && (
        <PatientModal
          title={`${addingTo.slotKey} 입원 등록`}
          data={{ name:"", bedPosition:"", discharge:"미정", note:"", scheduleAlert:false }}
          mode="current" isNew
          onSave={data => saveCurrentPatient(addingTo.slotKey, data)}
          onClose={() => setAddingTo(null)} />
      )}
      {/* 신규 예약 추가 */}
      {addingTo?.mode === "reservation" && (
        <PatientModal
          title={`${addingTo.slotKey} 예약 입원 등록`}
          data={{ name:"", bedPosition:"", admitDate:"", discharge:"미정", note:"", scheduleAlert:false }}
          mode="reservation" isNew
          onSave={data => saveReservation(addingTo.slotKey, data, undefined)}
          onClose={() => setAddingTo(null)} />
      )}

      {/* JSON 붙여넣기 모달 */}
      {jsonPasteOpen && (
        <div style={S.modalOverlay}>
          <div style={{ ...S.modal, maxWidth:540 }}>
            <div style={{ ...S.modalTitle, color:"#7c3aed" }}>📋 Claude.ai JSON 붙여넣기</div>
            <div style={{ fontSize:13, color:"#64748b", marginBottom:12, lineHeight:1.7 }}>
              1. <a href="https://claude.ai" target="_blank" rel="noreferrer" style={{ color:"#7c3aed" }}>claude.ai</a> 에서 메신저 내용을 아래 프롬프트와 함께 붙여넣으세요.<br/>
              2. Claude가 반환한 JSON을 아래에 붙여넣고 "반영" 클릭.
            </div>
            <div style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:8, padding:12, fontSize:12, color:"#475569", marginBottom:12, lineHeight:1.8, userSelect:"all" }}>
              아래 병원 메신저 내용을 분석해서 JSON만 출력해줘. 다른 말 없이 JSON만.<br/>
              병실: 2병동(201~206), 3병동(301~306), 5병동(501~506), 6병동(601~603)<br/>
              형식: [{"{"}&#34;room&#34;:&#34;201&#34;,&#34;name&#34;:&#34;홍길동&#34;,&#34;discharge&#34;:&#34;3/20&#34;,&#34;note&#34;:&#34;요약&#34;,&#34;scheduleAlert&#34;:false{"}"}]<br/>
              메신저 내용: (여기에 붙여넣기)
            </div>
            <label style={S.label}>Claude가 반환한 JSON 붙여넣기</label>
            <textarea
              style={{ ...S.input, height:160, resize:"vertical", fontFamily:"monospace", fontSize:12 }}
              value={jsonPasteText}
              onChange={e => setJsonPasteText(e.target.value)}
              placeholder={'[{"room":"201","name":"홍길동","discharge":"3/20","note":"페인2회","scheduleAlert":false}]'}
            />
            <div style={S.modalBtns}>
              <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={() => { setJsonPasteOpen(false); setJsonPasteText(""); }}>취소</button>
              <button style={{ ...S.btnModal, background:"#7c3aed", color:"#fff" }} onClick={async () => {
                try {
                  const results = JSON.parse(jsonPasteText.replace(/```json|```/g, "").trim());
                  if (!Array.isArray(results)) throw new Error("배열 형식이 아닙니다.");
                  setUploadResult({ results });
                  setJsonPasteOpen(false);
                  setJsonPasteText("");
                } catch(e) {
                  alert("JSON 형식 오류: " + e.message + "\nClaude.ai에서 반환한 JSON을 그대로 붙여넣어 주세요.");
                }
              }}>반영하기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── WardView ──────────────────────────────────────────────────────────────────
function WardView({ slots, getRoomStats, isPreview, viewDate, showReserved, onSelectRoom }) {
  return (
    <div style={S.wardGrid}>
      {Object.entries(WARD_STRUCTURE).map(([wardNo, ward]) => (
        <div key={wardNo}>
          <div style={{ ...S.wardTitle, borderLeftColor: isPreview ? "#10b981":"#0ea5e9" }}>{ward.name}</div>
          <div style={S.roomGrid}>
            {ward.rooms.map(room => {
              const { occupied, available, bedList } = getRoomStats(room.id, room.capacity);
              const alertCount = bedList.filter(b => b.person?.scheduleAlert && b.type !== null).length;
              return (
                <div key={room.id} onClick={() => onSelectRoom(room)}
                  style={{ ...S.roomCard, borderTop:`3px solid ${TYPE_COLOR[room.type]}`, background: available===0 ? "#fff5f5":"#fff" }}>
                  <div style={S.roomHeader}>
                    <span style={S.roomNo}>{room.id}호</span>
                    <span style={{ ...S.roomTypeBadge, background:TYPE_BG[room.type], color:TYPE_COLOR[room.type] }}>{room.type}</span>
                  </div>
                  {/* 병상 도트 */}
                  <div style={S.bedBar}>
                    {bedList.map((b, i) => {
                      let bg = "#e2e8f0";
                      if (b.type === "current")          bg = TYPE_COLOR[room.type];
                      else if (b.type === "discharging_today") bg = "#fbbf24";
                      else if (b.type === "admitting_today")   bg = "#93c5fd";
                      else if (b.type === "reserved")    bg = "#a78bfa";
                      else if (!isPreview && b.hasReserve) bg = "#c4b5fd"; // 현재 공석이지만 예약있음
                      return <div key={i} style={{ ...S.bedDot, background: bg }} />;
                    })}
                  </div>
                  {/* 병상 수 */}
                  <div style={S.roomOccupancy}>
                    <span style={{ fontWeight:700 }}>{occupied}</span>
                    <span style={{ color:"#94a3b8" }}>/{room.capacity}</span>
                  </div>
                  {/* 환자 목록 */}
                  <div style={S.patientList}>
                    {bedList.map((b, i) => {
                      if (!b.person && !b.hasReserve) return null;
                      const isDischarging = b.type === "discharging_today";
                      const isAdmitting   = b.type === "admitting_today";
                      const isReservedType= b.type === "reserved";
                      const isCurrentType = b.type === "current";
                      const dday = isCurrentType && !isPreview ? getDdayLabel(b.person?.discharge) : null;
                      const posNum = b.person?.bedPosition ?? (i+1);

                      if (b.person) {
                        return (
                          <div key={i} style={S.patientChip}>
                            {isDischarging && <span style={{ fontSize:10 }}>🚪</span>}
                            {isAdmitting   && <span style={{ fontSize:10 }}>🛏</span>}
                            <span style={{ ...S.bedPositionBadge, background:
                              isAdmitting   ? "#2563eb" :
                              isReservedType? "#7c3aed" :
                              isDischarging ? "#d97706" : "#1e3a5f" }}>{posNum}</span>
                            <span style={{ ...S.patientName, color:
                              isAdmitting   ? "#2563eb" :
                              isReservedType? "#7c3aed" :
                              isDischarging ? "#d97706" : "#1e3a5f" }}>{b.person.name}</span>
                            {b.person.scheduleAlert && <span style={S.alertDot}>!</span>}
                            {b.person.discharge && b.person.discharge !== "미정" && (
                              <span style={S.dischargeDateWrap}>
                                <span style={S.dischargeDate}>{b.person.discharge}</span>
                                {dday && <span style={{ ...S.ddayBadge, color:dday.color, background:dday.bg }}>{dday.text}</span>}
                              </span>
                            )}
                          </div>
                        );
                      }

                      // 현재 공석이지만 예약 있는 경우
                      if (!isPreview && b.hasReserve) {
                        const nextRes = b.slot?.reservations?.find(r => { const d = parseDateStr(r.admitDate); return d && dateOnly(d) > todayDate(); });
                        return (
                          <div key={i} style={S.patientChip}>
                            <span style={{ ...S.bedPositionBadge, background:"#7c3aed" }}>{i+1}</span>
                            <span style={{ color:"#7c3aed", fontSize:12, fontWeight:600 }}>📅 {nextRes?.name} ({nextRes?.admitDate})</span>
                          </div>
                        );
                      }
                      return null;
                    })}
                  </div>
                  {/* 현재 환자에 예약이 있는 경우 알림 */}
                  {!isPreview && bedList.some(b => b.person && b.type === "current" && hasUpcomingReservation(b.slot)) && (
                    <div style={S.reserveBadge}>
                      📅 {bedList.filter(b => b.person && b.type === "current" && hasUpcomingReservation(b.slot)).length}개 병상 예약있음
                    </div>
                  )}
                  {alertCount > 0 && <div style={S.alertBadge}>⚠ {alertCount}건 확인필요</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── RoomDetailView ────────────────────────────────────────────────────────────
function RoomDetailView({ room, slots, getRoomStats, isPreview, viewDate, onEditCurrent, onEditReservation, onAddCurrent, onAddReservation, onBack }) {
  const { occupied, bedList } = getRoomStats(room.id, room.capacity);
  return (
    <div style={S.detailWrap}>
      <div style={S.detailHeader}>
        <button style={S.btnBack} onClick={onBack}>← 병실 현황</button>
        <span style={S.detailRoomNo}>{room.id}호</span>
        <span style={{ ...S.roomTypeBadge, background:TYPE_BG[room.type], color:TYPE_COLOR[room.type] }}>{room.type}</span>
        <span style={{ color:"#64748b", fontSize:14 }}>{occupied}/{room.capacity} 병상 사용</span>
      </div>

      {/* 범례 */}
      <div style={S.legend}>
        <span style={S.legendItem}><span style={{ ...S.legendDot, background:TYPE_COLOR[room.type] }}/>입원 중</span>
        <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#a78bfa" }}/>예약 입원</span>
        {isPreview && <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#93c5fd" }}/>당일 입원</span>}
        {isPreview && <span style={S.legendItem}><span style={{ ...S.legendDot, background:"#fbbf24" }}/>당일 퇴원</span>}
      </div>

      <div style={S.bedGrid}>
        {Array.from({ length: room.capacity }).map((_, i) => {
          const slotKey = `${room.id}-${i+1}`;
          const slot = slots[slotKey] || null;
          const b = bedList[i];
          const reservations = slot?.reservations || [];
          const isDischarging = b.type === "discharging_today";
          const isAdmitting   = b.type === "admitting_today";
          const isReservedType= b.type === "reserved";
          let borderColor = "#e2e8f0";
          if (b.type === "current")          borderColor = TYPE_COLOR[room.type];
          else if (isDischarging)            borderColor = "#fbbf24";
          else if (isAdmitting || isReservedType) borderColor = "#a78bfa";
          else if (!isPreview && b.hasReserve) borderColor = "#c4b5fd";

          return (
            <div key={i} style={{ ...S.bedCard, border:`2px ${b.person ? "solid":"dashed"} ${borderColor}`,
              background: isAdmitting ? "#eff6ff" : isDischarging ? "#fffbeb" : isReservedType ? "#faf5ff" : "#fff" }}>
              <div style={S.bedNum}>
                {i+1}번 병상
                {isDischarging && <span style={{ color:"#d97706", fontWeight:700, marginLeft:4 }}>🚪 당일 퇴원</span>}
                {isAdmitting   && <span style={{ color:"#2563eb", fontWeight:700, marginLeft:4 }}>🛏 당일 입원</span>}
                {isReservedType && <span style={{ color:"#7c3aed", fontWeight:700, marginLeft:4 }}>📅 예약 입원 중</span>}
              </div>

              {/* 현재/예약 환자 정보 */}
              {b.person ? (
                <>
                  <div style={{ ...S.bedPatientName, color: isAdmitting||isReservedType ? "#7c3aed" : isDischarging ? "#d97706":"#0f2744" }}>{b.person.name}</div>
                  {b.person.admitDate && <div style={{ fontSize:12, color:"#7c3aed", marginBottom:4 }}>입원일: {b.person.admitDate}</div>}
                  <div style={S.bedDischarge}>퇴원: {b.person.discharge}</div>
                  {b.person.note && <div style={S.bedNote}>{b.person.note}</div>}
                  {b.person.scheduleAlert && <div style={S.scheduleAlert}>⚠ 스케줄 확인 필요</div>}
                  {!isPreview && b.type === "current" && (
                    <button style={S.btnEdit} onClick={() => onEditCurrent(slotKey, { ...b.person })}>수정</button>
                  )}
                </>
              ) : (
                <div style={S.emptyBed}>
                  <span style={{ color:"#cbd5e1", fontSize:28 }}>+</span>
                  {!isPreview && (
                    <div style={{ display:"flex", flexDirection:"column", gap:6, width:"100%" }}>
                      <button style={S.btnAdmit} onClick={() => onAddCurrent(slotKey)}>입원 등록</button>
                    </div>
                  )}
                  {isPreview && <span style={{ color:"#94a3b8", fontSize:12 }}>입원 가능</span>}
                </div>
              )}

              {/* 예약 목록 (현재 환자 유무와 무관하게 항상 표시) */}
              {!isPreview && reservations.length > 0 && (
                <div style={S.reservationList}>
                  <div style={S.reservationListTitle}>📅 입원 예약</div>
                  {reservations.map((r, ri) => (
                    <div key={ri} style={S.reservationItem}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <span style={{ fontWeight:700, color:"#7c3aed", fontSize:13 }}>{r.name}</span>
                        <button style={S.btnEditSmall} onClick={() => onEditReservation(slotKey, { ...r }, ri)}>수정</button>
                      </div>
                      <div style={{ fontSize:11, color:"#64748b" }}>입원: {r.admitDate} → 퇴원: {r.discharge}</div>
                      {r.note && <div style={{ fontSize:11, color:"#94a3b8" }}>{r.note}</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* 예약 추가 버튼 */}
              {!isPreview && (
                <button style={{ ...S.btnAdmit, background:"#f5f3ff", color:"#7c3aed", marginTop:8 }} onClick={() => onAddReservation(slotKey)}>
                  📅 예약 입원 추가
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── PatientModal ──────────────────────────────────────────────────────────────
function PatientModal({ title, data, mode, isNew, onSave, onDelete, onClose }) {
  const [form, setForm] = useState({ ...data });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isReservation = mode === "reservation";

  const handleSave = () => {
    if (!form.name?.trim()) { alert("환자명을 입력해 주세요."); return; }
    if (isReservation && !form.admitDate?.trim()) { alert("입원 예정일을 입력해 주세요."); return; }
    onSave(form);
  };

  return (
    <div style={S.modalOverlay}>
      <div style={S.modal}>
        <div style={{ ...S.modalTitle, color: isReservation ? "#7c3aed":"#0f2744" }}>{title}</div>

        {isReservation && (
          <>
            <label style={{ ...S.label, color:"#7c3aed" }}>입원 예정일 ★</label>
            <input style={{ ...S.input, borderColor:"#a78bfa" }} value={form.admitDate||""} onChange={e => set("admitDate", e.target.value)} placeholder="예: 3/18" />
            <div style={{ fontSize:11, color:"#94a3b8", marginTop:3 }}>M/D 형식 (예: 3/18) — 미리보기에서 이 날짜부터 표시됩니다</div>
          </>
        )}

        <label style={S.label}>환자명</label>
        <input style={S.input} value={form.name||""} onChange={e => set("name", e.target.value)} placeholder="홍길동" />
        <label style={S.label}>퇴원 예정일</label>
        <input style={S.input} value={form.discharge||""} onChange={e => set("discharge", e.target.value)} placeholder="예: 3/28, 미정" />
        <label style={S.label}>메모</label>
        <textarea style={{ ...S.input, height:80, resize:"vertical" }} value={form.note||""} onChange={e => set("note", e.target.value)} placeholder="치료 내용, 약품, 스케줄 등" />
        <label style={S.labelCheck}>
          <input type="checkbox" checked={!!form.scheduleAlert} onChange={e => set("scheduleAlert", e.target.checked)} />
          <span style={{ marginLeft:6 }}>⚠ 스케줄 확인 필요</span>
        </label>
        <div style={S.modalBtns}>
          {!isNew && onDelete && (
            <button style={{ ...S.btnModal, background:"#fee2e2", color:"#dc2626" }} onClick={onDelete}>
              {isReservation ? "예약 취소":"퇴원 처리"}
            </button>
          )}
          <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={onClose}>취소</button>
          <button style={{ ...S.btnModal, background: isReservation ? "#7c3aed":"#1e3a5f", color:"#fff" }} onClick={handleSave}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ── AnalysisPreview, LogView, StatPill ────────────────────────────────────────
function AnalysisPreview({ results, onApply, onDiscard }) {
  return (
    <div style={S.analysisBar}>
      <div style={S.analysisTitle}>🤖 AI 분석 결과 — {results.length}명 감지됨</div>
      <div style={S.analysisList}>
        {results.map((r, i) => (
          <div key={i} style={S.analysisItem}>
            <strong>{r.room}호 {r.name}</strong><span style={{ color:"#64748b", marginLeft:8 }}>퇴원: {r.discharge}</span>
            {r.scheduleAlert && <span style={{ color:"#f59e0b", marginLeft:6 }}>⚠</span>}
            <div style={{ fontSize:12, color:"#94a3b8" }}>{r.note}</div>
          </div>
        ))}
      </div>
      <div style={S.analysisBtns}>
        <button style={{ ...S.btnModal, background:"#dcfce7", color:"#16a34a" }} onClick={onApply}>✓ 반영</button>
        <button style={{ ...S.btnModal, background:"#f1f5f9", color:"#64748b" }} onClick={onDiscard}>취소</button>
      </div>
    </div>
  );
}

function LogView({ logs }) {
  const ICON = { upload:"📩", edit:"✏️", discharge:"🚪", admit:"🛏", reserve:"📅" };
  return (
    <div style={S.logWrap}>
      <div style={S.detailHeader}><span style={S.detailRoomNo}>변경 이력</span></div>
      {logs.length === 0 && <div style={{ color:"#94a3b8", padding:24 }}>변경 이력이 없습니다.</div>}
      {logs.map((l, i) => (
        <div key={i} style={S.logItem}>
          <span style={S.logIcon}>{ICON[l.type]||"📋"}</span>
          <span style={S.logMsg}>{l.msg}</span>
          <span style={S.logTs}>{new Date(l.ts).toLocaleString("ko")}</span>
        </div>
      ))}
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div style={{ ...S.statPill, borderColor:color }}>
      <span style={{ ...S.statVal, color }}>{value}</span>
      <span style={S.statLabel}>{label}</span>
    </div>
  );
}

const S = {
  app: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { color:"#fff", display:"flex", alignItems:"center", padding:"12px 24px", gap:20, flexWrap:"wrap", boxShadow:"0 2px 12px rgba(0,0,0,0.18)", transition:"background 0.4s" },
  headerLeft: { display:"flex", alignItems:"center", gap:12, minWidth:180 },
  logoMark: { fontSize:28 }, title: { fontSize:18, fontWeight:800, letterSpacing:-0.5 }, subtitle: { fontSize:11, color:"#7dd3fc", letterSpacing:1 },
  headerCenter: { display:"flex", gap:10, flex:1, justifyContent:"center", alignItems:"center" },
  headerRight: { display:"flex", alignItems:"center", gap:8 },
  syncInfo: { fontSize:11, color:"#94a3b8" },
  btnRefresh: { background:"none", border:"1px solid #334155", color:"#94a3b8", borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:16 },
  navBtn: { border:"1px solid #334155", color:"#e2e8f0", borderRadius:6, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 },
  reserveToggle: { border:"none", borderRadius:8, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:700 },
  statPill: { border:"1.5px solid", borderRadius:10, padding:"4px 14px", textAlign:"center", minWidth:70, background:"rgba(255,255,255,0.06)" },
  statVal: { display:"block", fontSize:22, fontWeight:800, lineHeight:1.1 }, statLabel: { display:"block", fontSize:11, color:"#94a3b8" },
  datebar: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 24px", flexWrap:"wrap", gap:10, transition:"background 0.3s" },
  datebarLeft: { display:"flex", alignItems:"center", gap:12 }, datebarRight: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  previewBadge: { background:"#d1fae5", color:"#065f46", borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:800 },
  todayBadge:   { background:"#dbeafe", color:"#1d4ed8", borderRadius:8, padding:"4px 12px", fontSize:13, fontWeight:800 },
  activeDateLabel: { fontSize:15, fontWeight:700, color:"#0f2744" },
  dateInput: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"6px 10px", fontSize:13, outline:"none", fontFamily:"inherit" },
  btnPreview: { background:"#0f2744", color:"#fff", border:"none", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontWeight:700, fontSize:13 },
  btnToday: { background:"#ecfdf5", color:"#065f46", border:"1px solid #6ee7b7", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontWeight:700, fontSize:13 },
  uploadBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", display:"flex", alignItems:"center", gap:14, padding:"10px 28px", flexWrap:"wrap" },
  uploadLabel: { fontSize:13, fontWeight:700, color:"#0f2744" },
  btnUpload: { background:"#0f2744", color:"#fff", border:"none", borderRadius:7, padding:"7px 18px", cursor:"pointer", fontWeight:600, fontSize:13 },
  analysisBar: { background:"#f0fdf4", borderBottom:"1px solid #bbf7d0", padding:"14px 28px" },
  analysisTitle: { fontSize:14, fontWeight:700, color:"#166534", marginBottom:8 },
  analysisList: { display:"flex", flexWrap:"wrap", gap:8, marginBottom:10 },
  analysisItem: { background:"#fff", border:"1px solid #bbf7d0", borderRadius:8, padding:"8px 14px", minWidth:200, maxWidth:320 },
  analysisBtns: { display:"flex", gap:8 },
  main: { padding:"20px" },
  wardGrid: { display:"flex", flexDirection:"column", gap:24 },
  wardTitle: { fontSize:16, fontWeight:800, color:"#0f2744", marginBottom:10, padding:"4px 0 4px 10px", borderLeft:"4px solid" },
  roomGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))", gap:12 },
  roomCard: { borderRadius:12, padding:"14px 14px 10px", cursor:"pointer", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" },
  roomHeader: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:8 },
  roomNo: { fontSize:17, fontWeight:800 },
  roomTypeBadge: { fontSize:11, fontWeight:700, borderRadius:6, padding:"2px 8px" },
  bedBar: { display:"flex", gap:4, marginBottom:6 },
  bedDot: { width:12, height:12, borderRadius:"50%" },
  roomOccupancy: { fontSize:20, fontWeight:800, marginBottom:6 },
  patientList: { display:"flex", flexDirection:"column", gap:4 },
  patientChip: { display:"flex", alignItems:"center", gap:4, fontSize:12, flexWrap:"wrap" },
  bedPositionBadge: { color:"#fff", borderRadius:4, width:16, height:16, fontSize:10, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  patientName: { fontWeight:600 },
  dischargeDateWrap: { display:"flex", alignItems:"center", gap:3, marginLeft:2 },
  dischargeDate: { color:"#64748b", fontSize:10, background:"#f1f5f9", borderRadius:4, padding:"1px 4px" },
  ddayBadge: { fontSize:10, fontWeight:800, borderRadius:4, padding:"1px 5px" },
  alertDot: { background:"#fef3c7", color:"#d97706", borderRadius:"50%", width:16, height:16, fontSize:10, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800 },
  alertBadge: { marginTop:6, background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"3px 8px", fontSize:11, fontWeight:700 },
  reserveBadge: { marginTop:6, background:"#f5f3ff", color:"#6d28d9", borderRadius:6, padding:"3px 8px", fontSize:11, fontWeight:700 },
  detailWrap: { maxWidth:960, margin:"0 auto" },
  detailHeader: { display:"flex", alignItems:"center", gap:14, marginBottom:16, flexWrap:"wrap" },
  btnBack: { background:"#fff", border:"1px solid #e2e8f0", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontWeight:600, fontSize:13 },
  detailRoomNo: { fontSize:22, fontWeight:800, color:"#0f2744" },
  legend: { display:"flex", gap:16, marginBottom:14, background:"#f8fafc", borderRadius:8, padding:"8px 14px", flexWrap:"wrap" },
  legendItem: { display:"flex", alignItems:"center", gap:6, fontSize:12, color:"#475569" },
  legendDot: { width:12, height:12, borderRadius:"50%", display:"inline-block" },
  bedGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))", gap:16 },
  bedCard: { background:"#fff", borderRadius:12, padding:"16px", minHeight:140, display:"flex", flexDirection:"column" },
  bedNum: { fontSize:11, color:"#94a3b8", fontWeight:600, marginBottom:8 },
  bedPatientName: { fontSize:18, fontWeight:800, marginBottom:4 },
  bedDischarge: { fontSize:12, color:"#64748b", marginBottom:6 },
  bedNote: { fontSize:12, color:"#475569", background:"#f8fafc", borderRadius:6, padding:"6px 8px", marginBottom:6, lineHeight:1.5 },
  scheduleAlert: { background:"#fef3c7", color:"#92400e", borderRadius:6, padding:"4px 8px", fontSize:12, fontWeight:700, marginBottom:6 },
  btnEdit: { background:"#0f2744", color:"#fff", border:"none", borderRadius:6, padding:"5px 14px", cursor:"pointer", fontSize:12, fontWeight:600, marginTop:"auto" },
  btnEditSmall: { background:"#f1f5f9", color:"#64748b", border:"none", borderRadius:5, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:600 },
  emptyBed: { flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:6 },
  btnAdmit: { background:"#dcfce7", color:"#166534", border:"none", borderRadius:6, padding:"5px 14px", cursor:"pointer", fontSize:12, fontWeight:600, width:"100%", textAlign:"center" },
  reservationList: { marginTop:10, borderTop:"1px dashed #e2e8f0", paddingTop:8 },
  reservationListTitle: { fontSize:11, fontWeight:700, color:"#7c3aed", marginBottom:6 },
  reservationItem: { background:"#faf5ff", border:"1px solid #e9d5ff", borderRadius:8, padding:"8px", marginBottom:6 },
  modalOverlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 },
  modal: { background:"#fff", borderRadius:14, padding:"28px 28px 20px", width:"100%", maxWidth:420, boxShadow:"0 8px 40px rgba(0,0,0,0.18)", maxHeight:"90vh", overflowY:"auto" },
  modalTitle: { fontSize:17, fontWeight:800, marginBottom:16 },
  label: { display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:4, marginTop:12 },
  labelCheck: { display:"flex", alignItems:"center", fontSize:13, color:"#475569", marginTop:12, cursor:"pointer" },
  input: { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"8px 12px", fontSize:14, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  modalBtns: { display:"flex", gap:8, justifyContent:"flex-end", marginTop:20 },
  btnModal: { border:"none", borderRadius:8, padding:"8px 18px", cursor:"pointer", fontWeight:700, fontSize:13 },
  logWrap: { maxWidth:700, margin:"0 auto" },
  logItem: { background:"#fff", borderRadius:8, padding:"10px 16px", marginBottom:8, display:"flex", alignItems:"center", gap:12, boxShadow:"0 1px 4px rgba(0,0,0,0.05)" },
  logIcon: { fontSize:18 }, logMsg: { flex:1, fontSize:14, fontWeight:500 }, logTs: { fontSize:12, color:"#94a3b8", whiteSpace:"nowrap" },
};

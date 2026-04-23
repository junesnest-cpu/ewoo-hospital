import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import { useWardData } from "../lib/WardDataContext";
import SlotEditModal, { getCardColorBg, CARD_COLORS } from "../components/SlotEditModal";

// ── 룸타입별 섹션 구성 ────────────────────────────────────────────────────
// rowSize: 한 줄에 표시할 병상 수. 해당 크기로 chunk 해서 여러 줄로 배치.
const ROOM_SECTIONS = [
  { type: "1인실", rowSize: 4, hasTypeMemo: true,
    beds: [{room:"202",n:1},{room:"302",n:1},{room:"502",n:1},{room:"602",n:1}] },
  { type: "2인실", rowSize: 4, hasTypeMemo: true,
    beds: [
      {room:"204",n:1},{room:"204",n:2},{room:"304",n:1},{room:"304",n:2},
      {room:"305",n:1},{room:"305",n:2},{room:"504",n:1},{room:"504",n:2},
    ] },
  { type: "4인실", rowSize: 4, hasTypeMemo: true,
    beds: ["201","203","301","303","501","503"].flatMap(r => [1,2,3,4].map(n => ({room:r, n}))) },
  { type: "6인실", rowSize: 6, hasTypeMemo: false,
    beds: ["205","206","306","505","506","601","603"].flatMap(r => [1,2,3,4,5,6].map(n => ({room:r, n}))) },
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const TYPE_COLOR = {"1인실":"#6366f1","2인실":"#0ea5e9","4인실":"#10b981","6인실":"#f59e0b"};
const TYPE_BG    = {"1인실":"#eef2ff","2인실":"#e0f2fe","4인실":"#d1fae5","6인실":"#fef3c7"};

const COL_W  = 200;
const GAP    = 6;
const MEMO_W = 240;

// ── 날짜 유틸 ──────────────────────────────────────────────────────────────
function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  const iso = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(parseInt(iso[1]), parseInt(iso[2])-1, parseInt(iso[3]));
  return null;
}
function fmtDate(str) {
  if (!str) return "";
  if (str === "미정") return "미정";
  const m = String(str).match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return `${parseInt(m[1])}/${parseInt(m[2])}`;
  const iso = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${parseInt(iso[2])}/${parseInt(iso[3])}`;
  return String(str);
}

// ── 카드 (입원/예약 공통) ──────────────────────────────────────────────────
function PatientCard({ person, type, slotKey, resIndex, onClick, onDragStart, onDragEnd, isDragging }) {
  const isCurrent = type === "current";
  const bgColor = getCardColorBg(person.color);
  const hasColor = !!person.color;
  const hasNote = !!(person.note && person.note.trim());
  const admit = fmtDate(person.admitDate);
  const disch = fmtDate(person.discharge) || "미정";
  const dateLine = isCurrent
    ? `${admit || "—"} ~ ${disch}`
    : `${admit || "—"} ~ ${disch}`;

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, { slotKey, type, resIndex, person })}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={{
        border: `1.5px solid ${isCurrent ? "#10b981" : hasColor ? CARD_COLORS.find(c=>c.key===person.color)?.dot : "#cbd5e1"}`,
        borderRadius: 8,
        padding: "6px 8px",
        background: hasColor ? bgColor : (isCurrent ? "#ecfdf5" : "#fff"),
        cursor: "grab",
        userSelect: "none",
        position: "relative",
        boxShadow: isCurrent ? "0 1px 2px rgba(16,185,129,0.15)" : "0 1px 2px rgba(0,0,0,0.05)",
        opacity: isDragging ? 0.4 : 1,
        transition: "opacity 0.1s, box-shadow 0.1s",
      }}
      title={person.note || ""}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        {isCurrent && <span style={{ fontSize: 9, fontWeight: 800, color: "#059669", background: "#d1fae5", padding: "1px 4px", borderRadius: 3, flexShrink: 0 }}>재원</span>}
        {hasNote && <span style={{ fontSize: 11, flexShrink: 0 }}>📝</span>}
        {person.scheduleAlert && <span style={{ fontSize: 11, flexShrink: 0 }} title="스케줄 확인 필요">⚠</span>}
        {person.preserveSeat && <span style={{ fontSize: 11, flexShrink: 0 }} title="자리보존">🛋</span>}
        <span style={{ fontWeight: 700, fontSize: 13, color: "#0f2744", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>
          {person.name}
        </span>
        <span style={{ fontSize: 12, color: "#475569", whiteSpace: "nowrap", flexShrink: 0, fontWeight: 500 }}>{dateLine}</span>
      </div>
    </div>
  );
}

// ── 단일 병상 컬럼 ─────────────────────────────────────────────────────────
function BedColumn({ roomId, bedN, slot, type, openEdit, onDrop, onDragStart, onDragEnd, draggingInfo, isOver, setDragOver }) {
  const slotKey = `${roomId}-${bedN}`;
  const current = slot?.current?.name ? slot.current : null;
  const reservations = (slot?.reservations || [])
    .map((r, i) => ({ r, i }))
    .filter(x => x.r?.name)
    .sort((a, b) => {
      const da = parseDateStr(a.r.admitDate);
      const dbx = parseDateStr(b.r.admitDate);
      if (!da && !dbx) return 0;
      if (!da) return 1;
      if (!dbx) return -1;
      return da - dbx;
    });

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(slotKey); }}
      onDrop={(e) => { e.preventDefault(); onDrop(slotKey); setDragOver(null); }}
      style={{
        minWidth: COL_W,
        width: COL_W,
        flexShrink: 0,
        background: isOver ? "#fef3c7" : "#fff",
        border: `1.5px solid ${isOver ? "#f59e0b" : "#e2e8f0"}`,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        transition: "background 0.15s",
      }}
    >
      <div
        style={{
          background: TYPE_BG[type],
          color: TYPE_COLOR[type],
          fontWeight: 800,
          fontSize: 13,
          padding: "6px 8px",
          borderTopLeftRadius: 9,
          borderTopRightRadius: 9,
          borderBottom: `1px solid ${TYPE_COLOR[type]}33`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{roomId}호 {bedN}번</span>
        <button
          onClick={() => openEdit({ slotKey, mode: "reservation", resIndex: -1,
            data: { name:"", admitDate:"", discharge:"미정", note:"", scheduleAlert:false },
            currentPatient: current })}
          style={{ background: "transparent", border: "none", fontSize: 14, cursor: "pointer", color: TYPE_COLOR[type], fontWeight: 800, padding: "0 2px" }}
          title="예약 추가"
        >
          +
        </button>
      </div>

      <div style={{ padding: 6, display: "flex", flexDirection: "column", gap: 6 }}>
        {current ? (
          <PatientCard
            person={current}
            type="current"
            slotKey={slotKey}
            resIndex={-1}
            onClick={() => openEdit({ slotKey, mode: "current", resIndex: -1, data: { ...current }, currentPatient: null })}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            isDragging={draggingInfo?.slotKey === slotKey && draggingInfo?.type === "current"}
          />
        ) : (
          <div style={{
            border: "1.5px dashed #cbd5e1", borderRadius: 8, padding: "6px 8px",
            background: "#f8fafc", color: "#94a3b8", fontSize: 13, fontWeight: 600,
            display: "flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1.2,
          }}>
            비어있음
          </div>
        )}
        {reservations.map(({ r, i }) => (
          <PatientCard
            key={i}
            person={r}
            type="reservation"
            slotKey={slotKey}
            resIndex={i}
            onClick={() => openEdit({ slotKey, mode: "reservation", resIndex: i, data: { ...r }, currentPatient: current })}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            isDragging={draggingInfo?.slotKey === slotKey && draggingInfo?.type === "reservation" && draggingInfo?.resIndex === i}
          />
        ))}
      </div>
    </div>
  );
}

// ── 룸타입 메모 셀 ─────────────────────────────────────────────────────────
function TypeMemoCell({ type, value, onChange }) {
  return (
    <div style={{
      minWidth: MEMO_W, width: MEMO_W, flexShrink: 0,
      background: "#fffbea", border: "1.5px solid #fcd34d", borderRadius: 10,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ padding: "6px 8px", fontWeight: 800, fontSize: 13, color: "#92400e", borderBottom: "1px solid #fde68a", background: "#fef3c7" }}>
        📝 {type} 메모
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${type} 관련 공용 메모...`}
        style={{ flex: 1, minHeight: 110, border: "none", outline: "none", padding: "8px 10px",
          resize: "vertical", fontFamily: "inherit", fontSize: 12, color: "#334155", background: "transparent", borderBottomLeftRadius: 9, borderBottomRightRadius: 9 }}
      />
    </div>
  );
}

// ── 메인 페이지 ────────────────────────────────────────────────────────────
export default function BedSheet() {
  const { slots, saveSlots, syncConsultationOnSlotChange, slotsLoaded } = useWardData();
  const [editModal, setEditModal] = useState(null);
  const [dragging, setDragging]   = useState(null);  // { slotKey, type, resIndex, person }
  const [dragOver, setDragOver]   = useState(null);

  const [memoSingle, setMemoSingle] = useState("");
  const [memoDouble, setMemoDouble] = useState("");
  const [memoQuad,   setMemoQuad]   = useState("");

  // 룸타입 메모 구독 (타임라인과 동일 경로)
  useEffect(() => {
    const u1 = onValue(ref(db, "roomTypeMemos/1인실"), snap => setMemoSingle(snap.val() || ""));
    const u2 = onValue(ref(db, "roomTypeMemos/2인실"), snap => setMemoDouble(snap.val() || ""));
    const u4 = onValue(ref(db, "roomTypeMemos/4인실"), snap => setMemoQuad(snap.val() || ""));
    return () => { u1(); u2(); u4(); };
  }, []);

  const saveTypeMemo = useCallback(async (type, text) => {
    if (type === "1인실") setMemoSingle(text);
    else setMemoDouble(text);
    await set(ref(db, `roomTypeMemos/${type}`), text);
  }, []);

  const memoDebounce = useRef({});
  const onTypeMemoChange = (type, text) => {
    if      (type === "1인실") setMemoSingle(text);
    else if (type === "2인실") setMemoDouble(text);
    else if (type === "4인실") setMemoQuad(text);
    clearTimeout(memoDebounce.current[type]);
    memoDebounce.current[type] = setTimeout(() => {
      set(ref(db, `roomTypeMemos/${type}`), text).catch(console.error);
    }, 400);
  };

  // ── 드래그 앤 드롭 ────────────────────────────────────────────────────
  const onDragStart = useCallback((e, info) => {
    setDragging(info);
    try { e.dataTransfer.setData("text/plain", info.person?.name || ""); } catch (_) {}
    try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
  }, []);

  const onDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const handleDrop = useCallback(async (targetSlotKey) => {
    if (!dragging) return;
    const { slotKey: fromKey, type, resIndex, person } = dragging;
    if (fromKey === targetSlotKey) { setDragging(null); setDragOver(null); return; }

    const newSlots = JSON.parse(JSON.stringify(slots));
    if (!newSlots[fromKey]) newSlots[fromKey] = { current: null, reservations: [] };
    if (!newSlots[targetSlotKey]) newSlots[targetSlotKey] = { current: null, reservations: [] };

    // 출발 병상에서 제거
    if (type === "current") {
      newSlots[fromKey].current = null;
    } else {
      newSlots[fromKey].reservations = (newSlots[fromKey].reservations || []).filter((_, i) => i !== resIndex);
    }

    // 도착 병상에 추가
    const target = newSlots[targetSlotKey];
    if (type === "current" && !target.current?.name) {
      target.current = { ...person };
    } else {
      if (!target.reservations) target.reservations = [];
      target.reservations.push({ ...person });
    }

    await saveSlots(newSlots, [fromKey, targetSlotKey]);

    // 상담일지 연동 (타임라인과 동일)
    await syncConsultationOnSlotChange(fromKey, person.name, person.consultationId, targetSlotKey, {
      admitDate: person.admitDate || undefined,
      dischargeDate: person.discharge || undefined,
    });

    setDragging(null);
    setDragOver(null);
  }, [dragging, slots, saveSlots, syncConsultationOnSlotChange]);

  const openEdit = useCallback((m) => setEditModal(m), []);

  if (!slotsLoaded) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#f0f4f8", fontFamily:"'Noto Sans KR',sans-serif" }}>
      <div style={{ fontSize:16, fontWeight:700, color:"#0f2744" }}>🛏 병상 시트 불러오는 중...</div>
    </div>
  );

  return (
    <div style={{ fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a", display:"flex", flexDirection:"column" }}>
      <header style={{ background:"#0f2744", color:"#fff", padding:"12px 20px", display:"flex", alignItems:"center", gap:12, flexShrink:0, boxShadow:"0 2px 8px rgba(0,0,0,0.18)", position:"sticky", top:0, zIndex:40 }}>
        <span style={{ fontSize:17, fontWeight:800 }}>🛏 병상 시트</span>
        <span style={{ fontSize:12, color:"#94a3b8" }}>현재 입원 + 예약 환자 한눈에 보기</span>
        <span style={{ marginLeft:"auto", fontSize:11, color:"#cbd5e1" }}>카드 드래그=이동 · 카드 클릭=편집 · +=예약 추가</span>
      </header>

      {dragging && (
        <div style={{ position:"fixed", top:0, left:0, right:0, zIndex:500, background:"#7c3aed", color:"#fff", textAlign:"center", padding:"8px", fontSize:14, fontWeight:700, boxShadow:"0 2px 8px rgba(0,0,0,0.3)" }}>
          🚚 <strong>{dragging.person?.name}</strong> 이동 중 — 이동할 병상 컬럼에 드롭하세요
          <button onClick={() => { setDragging(null); setDragOver(null); }}
            style={{ marginLeft:16, background:"rgba(255,255,255,0.25)", border:"none", color:"#fff", borderRadius:6, padding:"2px 10px", cursor:"pointer", fontSize:13 }}>취소</button>
        </div>
      )}

      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 18 }}>
        {ROOM_SECTIONS.map((section) => {
          const rows = chunk(section.beds, section.rowSize);
          const memoValue = section.type === "1인실" ? memoSingle
                          : section.type === "2인실" ? memoDouble
                          : section.type === "4인실" ? memoQuad
                          : "";
          const occupied = section.beds.filter(b => slots[`${b.room}-${b.n}`]?.current?.name).length;
          const resCount = section.beds.reduce((s, b) =>
            s + ((slots[`${b.room}-${b.n}`]?.reservations || []).filter(r => r?.name).length), 0);
          return (
            <div key={section.type}>
              <div style={{ fontSize: 13, fontWeight: 800, color: TYPE_COLOR[section.type], marginBottom: 6, paddingLeft: 2, letterSpacing: 0.3 }}>
                {section.type} ({occupied}/{section.beds.length}) (총 {resCount}명 예약 중)
              </div>
              <div style={{ overflowX: "auto", paddingBottom: 4 }}>
                <div style={{ display: "flex", gap: GAP, alignItems: "stretch", minWidth: "min-content" }}>
                  {/* 왼쪽: 여러 줄의 병상 그리드 */}
                  <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", gap: GAP }}>
                    {rows.map((bedRow, ri) => (
                      <div key={ri} style={{ display: "flex", gap: GAP, alignItems: "flex-start" }}>
                        {bedRow.map(b => {
                          const slotKey = `${b.room}-${b.n}`;
                          return (
                            <BedColumn
                              key={slotKey}
                              roomId={b.room}
                              bedN={b.n}
                              slot={slots[slotKey]}
                              type={section.type}
                              openEdit={openEdit}
                              onDrop={handleDrop}
                              onDragStart={onDragStart}
                              onDragEnd={onDragEnd}
                              draggingInfo={dragging}
                              isOver={dragOver === slotKey}
                              setDragOver={setDragOver}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {/* 오른쪽: 룸타입 메모 (섹션 전체 높이로 늘어남) */}
                  {section.hasTypeMemo && (
                    <TypeMemoCell
                      type={section.type}
                      value={memoValue}
                      onChange={(v) => onTypeMemoChange(section.type, v)}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editModal && (
        <SlotEditModal
          modal={editModal}
          onClose={() => setEditModal(null)}
        />
      )}
    </div>
  );
}

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const WARD_STRUCTURE = {
  2: { name:"2병동", rooms:[{id:"201",type:"4인실",capacity:4},{id:"202",type:"1인실",capacity:1},{id:"203",type:"4인실",capacity:4},{id:"204",type:"2인실",capacity:2},{id:"205",type:"6인실",capacity:6},{id:"206",type:"6인실",capacity:6}]},
  3: { name:"3병동", rooms:[{id:"301",type:"4인실",capacity:4},{id:"302",type:"1인실",capacity:1},{id:"303",type:"4인실",capacity:4},{id:"304",type:"2인실",capacity:2},{id:"305",type:"2인실",capacity:2},{id:"306",type:"6인실",capacity:6}]},
  5: { name:"5병동", rooms:[{id:"501",type:"4인실",capacity:4},{id:"502",type:"1인실",capacity:1},{id:"503",type:"4인실",capacity:4},{id:"504",type:"2인실",capacity:2},{id:"505",type:"6인실",capacity:6},{id:"506",type:"6인실",capacity:6}]},
  6: { name:"6병동", rooms:[{id:"601",type:"6인실",capacity:6},{id:"602",type:"1인실",capacity:1},{id:"603",type:"6인실",capacity:6}]},
};
const TYPE_COLOR = {"1인실":"#6366f1","2인실":"#0ea5e9","4인실":"#10b981","6인실":"#f59e0b"};
const TYPE_BG    = {"1인실":"#eef2ff","2인실":"#e0f2fe","4인실":"#d1fae5","6인실":"#fef3c7"};
const DAY_KO = ["일","월","화","수","목","금","토"];
const DAY_W    = 58;
const LEFT_W   = 188;
const ROW_H    = 60;   // 메모 2줄 표시를 위해 높임
const DAYS_BACK  = 3;
const DAYS_TOTAL = 21;

// ── 날짜 유틸 ─────────────────────────────────────────────────────────────────
function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  const d = new Date(str); return isNaN(d) ? null : d;
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function todayDate() { return dateOnly(new Date()); }
function toDateStr(d) { return `${d.getMonth()+1}/${d.getDate()}`; }

// ── 타임라인 바 계산 ──────────────────────────────────────────────────────────
function getBars(slot, days) {
  const bars = [];
  const ws  = days[0].getTime();
  const MS  = 86400000;
  const len = days.length;

  const push = (person, type, resIndex) => {
    const admitD = parseDateStr(person.admitDate);
    const disD   = parseDateStr(person.discharge);
    const si = admitD ? Math.round((dateOnly(admitD).getTime() - ws) / MS) : -99;
    const ei = disD   ? Math.round((dateOnly(disD).getTime()   - ws) / MS) : len + 99;
    if (ei < 0 || si >= len) return;
    bars.push({
      type, person, resIndex,
      startDay: Math.max(0, si),
      endDay:   Math.min(len-1, ei),
      overflowLeft:  si < 0,
      overflowRight: ei >= len,
      // 원래 인덱스 (클리핑 전) — 겹침 계산용
      rawStart: si, rawEnd: ei,
    });
  };

  if (slot?.current?.name) push(slot.current, "current", -1);
  (slot?.reservations || []).forEach((r, ri) => { if (r?.name) push(r, "reservation", ri); });
  return bars;
}

// ── 겹침 구간 계산 ────────────────────────────────────────────────────────────
function getOverlaps(bars) {
  const overlaps = [];
  for (let i = 0; i < bars.length; i++) {
    for (let j = i + 1; j < bars.length; j++) {
      const a = bars[i], b = bars[j];
      const start = Math.max(a.rawStart, b.rawStart);
      const end   = Math.min(a.rawEnd,   b.rawEnd);
      if (start <= end) {
        overlaps.push({ startDay: Math.max(0, start), endDay: Math.min(DAYS_TOTAL-1, end) });
      }
    }
  }
  return overlaps;
}

// ── 편집 모달 ─────────────────────────────────────────────────────────────────
function EditModal({ modal, onClose, onSave, onDelete, onConvert, saving }) {
  const [form, setForm] = useState({
    name:          modal.data.name          || "",
    admitDate:     modal.data.admitDate     || "",
    discharge:     modal.data.discharge     || "미정",
    note:          modal.data.note          || "",
    scheduleAlert: modal.data.scheduleAlert || false,
  });
  const isNew         = modal.resIndex === -1;
  const isReservation = modal.mode === "reservation";
  const slotLabel     = modal.slotKey.replace(/(\d+)-(\d+)/, "$1호 $2번");
  const inpStyle = { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"9px 11px", fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:16, padding:"24px 28px", width:"min(92vw,400px)", boxShadow:"0 24px 64px rgba(0,0,0,0.3)" }}>
        <div style={{ fontWeight:800, fontSize:16, color:"#0f2744", marginBottom:4 }}>
          {isNew ? "📅 예약 입원 추가" : isReservation ? "📅 예약 수정" : "🏥 입원 정보 수정"}
        </div>
        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:20 }}>{slotLabel} 병상</div>

        {[
          { label:"환자 이름 *", key:"name", ph:"이름 입력", type:"text" },
          ...(isReservation ? [{ label:"예약 입원일 (예: 4/15)", key:"admitDate", ph:"4/15", type:"text" }] : []),
          { label:"퇴원 예정일 (예: 4/25 또는 미정)", key:"discharge", ph:"4/25 또는 미정", type:"text" },
        ].map(f => (
          <div key={f.key} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>{f.label}</label>
            <input style={inpStyle} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph} autoFocus={f.key==="name"} />
          </div>
        ))}

        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>메모</label>
          <textarea style={{...inpStyle, resize:"vertical", minHeight:72, lineHeight:1.6}} value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} placeholder="치료 내용, 특이사항 등" />
        </div>

        <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20, cursor:"pointer", fontSize:13, color:"#64748b" }}>
          <input type="checkbox" checked={form.scheduleAlert} onChange={e=>setForm(p=>({...p,scheduleAlert:e.target.checked}))} />
          ⚠ 스케줄 확인 필요
        </label>

        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button onClick={() => onSave(form)} disabled={saving || !form.name.trim()}
            style={{ flex:1, background:form.name.trim()?"#0f2744":"#e2e8f0", color:form.name.trim()?"#fff":"#94a3b8", border:"none", borderRadius:9, padding:"11px", fontSize:14, fontWeight:700, cursor:form.name.trim()?"pointer":"default" }}>
            {saving ? "저장 중..." : "저장"}
          </button>
          {!isNew && isReservation && (
            <button onClick={onConvert} disabled={saving}
              style={{ flex:1, background:"#059669", color:"#fff", border:"none", borderRadius:9, padding:"11px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
              🛏 입원 전환
            </button>
          )}
          {!isNew && (
            <button onClick={onDelete} disabled={saving}
              style={{ background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, fontWeight:700, cursor:"pointer" }}>삭제</button>
          )}
          <button onClick={onClose}
            style={{ background:"#f1f5f9", color:"#64748b", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, cursor:"pointer" }}>취소</button>
        </div>
      </div>
    </div>
  );
}

// ── 팝오버 ────────────────────────────────────────────────────────────────────
function Popover({ popover, onClose, onEdit, onDelete, onConvert }) {
  const { bar, slotKey, x, y } = popover;
  const p    = bar.person;
  const isRes = bar.type === "reservation";
  const px = Math.min(x, (typeof window!=="undefined"?window.innerWidth:600) - 290);
  const py = Math.min(y, (typeof window!=="undefined"?window.innerHeight:800) - 310);

  return (
    <div style={{ position:"fixed", inset:0, zIndex:200 }} onClick={onClose}>
      <div style={{ position:"fixed", top:py, left:px, background:"#fff", borderRadius:14, boxShadow:"0 10px 40px rgba(0,0,0,0.22)", padding:"18px 20px", width:272, zIndex:201 }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17, color:"#0f2744" }}>{isRes?"🔵":"🟢"} {p.name}</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginTop:2 }}>{slotKey.replace(/(\d+)-(\d+)/,"$1호 $2번 병상")}</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:18, color:"#94a3b8", cursor:"pointer" }}>✕</button>
        </div>
        <div style={{ background:"#f8fafc", borderRadius:8, padding:"10px 12px", marginBottom:12, fontSize:13, lineHeight:1.9 }}>
          {p.admitDate && <div><span style={{ color:"#94a3b8" }}>입원일:</span> <strong>{p.admitDate}</strong></div>}
          <div><span style={{ color:"#94a3b8" }}>퇴원일:</span> <strong>{p.discharge||"미정"}</strong></div>
          {p.note && <div style={{ marginTop:6, color:"#475569", fontSize:12, lineHeight:1.6, borderTop:"1px solid #e2e8f0", paddingTop:6 }}>{p.note}</div>}
          {p.scheduleAlert && <div style={{ marginTop:6, background:"#fef3c7", borderRadius:5, padding:"3px 7px", fontSize:12, color:"#92400e", fontWeight:700 }}>⚠ 스케줄 확인 필요</div>}
        </div>
        <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
          <button onClick={onEdit}    style={pBtn("#0f2744")}>✏️ 수정</button>
          {isRes && <button onClick={onConvert} style={pBtn("#059669")}>🛏 입원 전환</button>}
          <button onClick={onDelete}  style={pBtn("#dc2626")}>🗑 삭제</button>
        </div>
      </div>
    </div>
  );
}
const pBtn = bg => ({ background:bg, color:"#fff", border:"none", borderRadius:7, padding:"7px 11px", fontSize:12, fontWeight:700, cursor:"pointer" });

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export default function WardTimeline() {
  const router   = useRouter();
  const isMobile = useIsMobile();

  const [slots,      setSlots]      = useState({});
  const [syncing,    setSyncing]    = useState(true);
  const [lastSync,   setLastSync]   = useState(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [collapsed,  setCollapsed]  = useState({});
  const [popover,    setPopover]    = useState(null);
  const [editModal,  setEditModal]  = useState(null);
  const [saving,     setSaving]     = useState(false);

  // ── 드래그 앤 드롭 상태 ──────────────────────────────────────────────────
  const [dragging,   setDragging]   = useState(null);  // { slotKey, bar }
  const [dragOver,   setDragOver]   = useState(null);  // 대상 slotKey

  // ── 병실 타입 필터 ───────────────────────────────────────────────────────
  const [filterType, setFilterType] = useState(null);  // null=전체, "1인실" 등

  const today = useMemo(() => todayDate(), []);

  const days = useMemo(() => {
    const start = new Date(today.getTime() + (weekOffset * 7 - DAYS_BACK) * 86400000);
    start.setHours(0,0,0,0);
    return Array.from({ length: DAYS_TOTAL }, (_, i) => {
      const d = new Date(start.getTime() + i * 86400000);
      d.setHours(0,0,0,0);
      return d;
    });
  }, [today, weekOffset]);

  const todayIdx = useMemo(
    () => days.findIndex(d => d.getTime() === today.getTime()),
    [days, today]
  );

  // Firebase
  useEffect(() => {
    setSyncing(true);
    const unsub = onValue(ref(db, "slots"), snap => {
      setSlots(snap.val() || {});
      setLastSync(new Date());
      setSyncing(false);
    }, () => setSyncing(false));
    return () => unsub();
  }, []);

  const saveSlots = useCallback(async ns => {
    setSlots(ns);
    await set(ref(db, "slots"), ns);
  }, []);

  // ── 드래그 앤 드롭 실행 ──────────────────────────────────────────────────
  const executeDrop = useCallback(async (targetSlotKey) => {
    if (!dragging || dragging.slotKey === targetSlotKey) {
      setDragging(null); setDragOver(null); return;
    }
    const { slotKey: fromKey, bar } = dragging;
    const person = bar.person;

    const newSlots = JSON.parse(JSON.stringify(slots));
    if (!newSlots[fromKey]) newSlots[fromKey] = { current: null, reservations: [] };
    if (!newSlots[targetSlotKey]) newSlots[targetSlotKey] = { current: null, reservations: [] };

    // 출발 병상에서 제거
    if (bar.type === "current") {
      newSlots[fromKey].current = null;
    } else {
      newSlots[fromKey].reservations = (newSlots[fromKey].reservations||[]).filter((_,i)=>i!==bar.resIndex);
    }

    const target = newSlots[targetSlotKey];

    // 도착 병상에 추가
    if (bar.type === "current" && !target.current?.name) {
      // 현재 환자 → 빈 병상: 현재 환자로 이동
      target.current = { ...person };
    } else {
      // 그 외: 예약으로 추가
      if (!target.reservations) target.reservations = [];
      target.reservations.push({ ...person });
    }

    await saveSlots(newSlots);
    setDragging(null);
    setDragOver(null);
  }, [dragging, slots, saveSlots]);


  // 저장 처리
  const handleSave = useCallback(async form => {
    if (!editModal) return;
    setSaving(true);
    try {
      const { slotKey, mode, resIndex } = editModal;
      const ns = JSON.parse(JSON.stringify(slots));
      if (!ns[slotKey]) ns[slotKey] = { current:null, reservations:[] };
      const slot = ns[slotKey];
      if (mode === "current") {
        slot.current = { ...(slot.current||{}), ...form };
      } else {
        if (!slot.reservations) slot.reservations = [];
        if (resIndex >= 0) slot.reservations[resIndex] = { ...(slot.reservations[resIndex]||{}), ...form };
        else slot.reservations.push({ ...form });
      }
      await saveSlots(ns);
      setEditModal(null); setPopover(null);
    } finally { setSaving(false); }
  }, [editModal, slots, saveSlots]);

  const handleDelete = useCallback(async () => {
    if (!editModal) return;
    const { slotKey, mode, resIndex, data } = editModal;
    if (!window.confirm(`${data.name}님의 ${mode==="current"?"입원 정보":"예약"}를 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const ns = JSON.parse(JSON.stringify(slots));
      if (mode === "current") ns[slotKey].current = null;
      else ns[slotKey].reservations = (ns[slotKey].reservations||[]).filter((_,i)=>i!==resIndex);
      await saveSlots(ns);
      setEditModal(null); setPopover(null);
    } finally { setSaving(false); }
  }, [editModal, slots, saveSlots]);

  const handleConvert = useCallback(async () => {
    if (!editModal || editModal.mode !== "reservation") return;
    const { slotKey, resIndex, data } = editModal;
    if (!window.confirm(`${data.name}님을 현재 입원 환자로 전환하시겠습니까?`)) return;
    setSaving(true);
    try {
      const ns = JSON.parse(JSON.stringify(slots));
      ns[slotKey].current = { ...data };
      ns[slotKey].reservations = (ns[slotKey].reservations||[]).filter((_,i)=>i!==resIndex);
      await saveSlots(ns);
      setEditModal(null); setPopover(null);
    } finally { setSaving(false); }
  }, [editModal, slots, saveSlots]);

  const handlePopoverConvert = useCallback(async () => {
    if (!popover) return;
    const { slotKey, bar } = popover;
    if (!window.confirm(`${bar.person.name}님을 현재 입원 환자로 전환하시겠습니까?`)) return;
    const ns = JSON.parse(JSON.stringify(slots));
    ns[slotKey].current = { ...bar.person };
    ns[slotKey].reservations = (ns[slotKey].reservations||[]).filter((_,i)=>i!==bar.resIndex);
    await saveSlots(ns);
    setPopover(null);
  }, [popover, slots, saveSlots]);

  const handlePopoverDelete = useCallback(async () => {
    if (!popover) return;
    const { slotKey, bar } = popover;
    if (!window.confirm(`${bar.person.name}님의 정보를 삭제하시겠습니까?`)) return;
    const ns = JSON.parse(JSON.stringify(slots));
    if (bar.type==="current") ns[slotKey].current = null;
    else ns[slotKey].reservations = (ns[slotKey].reservations||[]).filter((_,i)=>i!==bar.resIndex);
    await saveSlots(ns);
    setPopover(null);
  }, [popover, slots, saveSlots]);

  if (syncing && Object.keys(slots).length === 0) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:16, background:"#f0f4f8", fontFamily:"'Noto Sans KR',sans-serif" }}>
      <div style={{ fontSize:16, fontWeight:700, color:"#0f2744" }}>📊 타임라인 불러오는 중...</div>
    </div>
  );

  return (
    <div style={{ fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a", display:"flex", flexDirection:"column", height:"100vh" }}>

      {/* 드래그 중 안내 배너 */}
      {dragging && (
        <div style={{ position:"fixed", top:0, left:0, right:0, zIndex:500, background:"#7c3aed", color:"#fff", textAlign:"center", padding:"8px", fontSize:14, fontWeight:700, boxShadow:"0 2px 8px rgba(0,0,0,0.3)" }}>
          🚚 <strong>{dragging.bar.person.name}</strong> 이동 중 — 이동할 병상 행에 드롭하세요
          <button onClick={() => { setDragging(null); setDragOver(null); }}
            style={{ marginLeft:16, background:"rgba(255,255,255,0.25)", border:"none", color:"#fff", borderRadius:6, padding:"2px 10px", cursor:"pointer", fontSize:13 }}>취소</button>
        </div>
      )}

      {/* ── 헤더 ── */}
      <header style={{ background:"#0f2744", color:"#fff", padding:"10px 16px", display:"flex", alignItems:"center", gap:10, flexShrink:0, boxShadow:"0 2px 8px rgba(0,0,0,0.18)", flexWrap:"wrap" }}>
        <button onClick={() => router.push("/")} style={hBtn}>← 병실현황</button>
        <span style={{ fontSize:17, fontWeight:800 }}>📊 병동 타임라인</span>
        <span style={{ fontSize:12, color:"#94a3b8" }}>
          {syncing ? "🔄 동기화 중..." : lastSync ? `✓ ${lastSync.toLocaleTimeString("ko")} 저장됨` : ""}
        </span>
        <div style={{ marginLeft:"auto", display:"flex", gap:6, alignItems:"center" }}>
          <span style={{ fontSize:12, color:"#94a3b8" }}>
            {days[0].getMonth()+1}/{days[0].getDate()} – {days[days.length-1].getMonth()+1}/{days[days.length-1].getDate()}
          </span>
          <button onClick={() => setWeekOffset(o=>o-1)} style={hBtn}>‹ 이전 주</button>
          <button onClick={() => setWeekOffset(0)} style={{ ...hBtn, background:weekOffset===0?"#059669":"rgba(255,255,255,0.15)", fontWeight:700 }}>오늘</button>
          <button onClick={() => setWeekOffset(o=>o+1)} style={hBtn}>다음 주 ›</button>
        </div>
      </header>

      {/* ── 범례 바 ── */}
      <div style={{ background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"8px 20px", display:"flex", flexShrink:0, flexWrap:"wrap", alignItems:"center", gap:16 }}>
        {[
          { color:"#10b981", label:"입원 중" },
          { color:"#3b82f6", label:"당일 입원" },
          { color:"#f59e0b", label:"당일 퇴원" },
          { color:"#8b5cf6", label:"예약" },
          { color:"#ef4444", label:"일정 겹침", hatching:true },
        ].map(l => (
          <div key={l.label} style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:14, height:14, borderRadius:3,
              background: l.hatching ? "transparent" : l.color,
              backgroundImage: l.hatching ? "repeating-linear-gradient(45deg, rgba(239,68,68,0.55) 0px, rgba(239,68,68,0.55) 3px, transparent 3px, transparent 10px)" : "none",
              border: l.hatching ? "2px solid #ef4444" : "none" }}/>
            <span style={{ fontSize:12, color:"#64748b" }}>{l.label}</span>
          </div>
        ))}
        <span style={{ fontSize:11, color:"#cbd5e1", marginLeft:"auto" }}>빈 칸 클릭=예약 · 바 드래그=이동</span>
      </div>

      {/* ── 병실 타입 필터 버튼 ── */}
      <div style={{ background:"#fff", borderBottom:"2px solid #e2e8f0", padding:"8px 20px", display:"flex", gap:8, flexShrink:0, alignItems:"center", flexWrap:"wrap" }}>
        <span style={{ fontSize:12, fontWeight:700, color:"#64748b", marginRight:4 }}>병실 필터:</span>
        {[
          { label:"전체",  type:null,    bg:"#0f2744", tc:"#fff" },
          { label:"1인실", type:"1인실", bg:TYPE_BG["1인실"], tc:TYPE_COLOR["1인실"] },
          { label:"2인실", type:"2인실", bg:TYPE_BG["2인실"], tc:TYPE_COLOR["2인실"] },
          { label:"4인실", type:"4인실", bg:TYPE_BG["4인실"], tc:TYPE_COLOR["4인실"] },
          { label:"6인실", type:"6인실", bg:TYPE_BG["6인실"], tc:TYPE_COLOR["6인실"] },
        ].map(({ label, type, bg, tc }) => {
          const active = filterType === type;
          return (
            <button key={label} onClick={() => setFilterType(type)}
              style={{ padding:"5px 16px", borderRadius:20, fontWeight:700, fontSize:13, cursor:"pointer", border:"2px solid", transition:"all 0.15s",
                background:   active ? (type ? TYPE_COLOR[type] : "#0f2744") : "#fff",
                color:        active ? "#fff" : (type ? TYPE_COLOR[type] : "#0f2744"),
                borderColor:  type ? TYPE_COLOR[type] : "#0f2744",
                boxShadow:    active ? "0 2px 8px rgba(0,0,0,0.18)" : "none",
              }}>
              {label}
              {type && (() => {
                let cnt = 0;
                Object.values(WARD_STRUCTURE).forEach(w => w.rooms.forEach(r => { if (r.type===type) cnt+=r.capacity; }));
                return <span style={{ marginLeft:5, fontSize:11, opacity:0.8 }}>({cnt}병상)</span>;
              })()}
            </button>
          );
        })}
        {filterType && (
          <span style={{ fontSize:12, color:"#94a3b8", marginLeft:4 }}>
            — {Object.values(WARD_STRUCTURE).flatMap(w=>w.rooms).filter(r=>r.type===filterType).length}개 병실 표시 중
          </span>
        )}
      </div>

      {/* ── 타임라인 본체 ── */}
      <div style={{ flex:1, overflow:"auto", position:"relative" }}>
        <div style={{ minWidth: LEFT_W + DAY_W * DAYS_TOTAL }}>

          {/* 날짜 헤더 */}
          <div style={{ display:"flex", position:"sticky", top:0, zIndex:30, background:"#fff", borderBottom:"2px solid #cbd5e1", boxShadow:"0 2px 6px rgba(0,0,0,0.07)" }}>
            <div style={{ width:LEFT_W, minWidth:LEFT_W, flexShrink:0, position:"sticky", left:0, zIndex:31, background:"#f8fafc", borderRight:"2px solid #cbd5e1", padding:"8px 12px", fontSize:12, fontWeight:700, color:"#64748b", display:"flex", alignItems:"center" }}>
              병동 / 병실 / 병상
            </div>
            {days.map((day, di) => {
              const isToday   = day.getTime() === today.getTime();
              const isWeekend = day.getDay() === 0 || day.getDay() === 6;
              return (
                <div key={di} style={{ width:DAY_W, minWidth:DAY_W, flexShrink:0, padding:"6px 0", textAlign:"center",
                  background: isToday?"#eff6ff":"transparent",
                  borderRight: isToday?"none":"1px solid #f1f5f9",
                  borderLeft:  isToday?"2px solid #3b82f6":"none" }}>
                  <div style={{ fontSize:11, fontWeight:700, color:isToday?"#2563eb":isWeekend?"#ef4444":"#94a3b8" }}>{DAY_KO[day.getDay()]}</div>
                  <div style={{ fontSize:13, fontWeight:isToday?900:600, color:isToday?"#1d4ed8":isWeekend?"#dc2626":"#334155" }}>
                    {day.getMonth()+1}/{day.getDate()}
                    {isToday && <div style={{ fontSize:9, color:"#3b82f6", fontWeight:800, marginTop:1 }}>TODAY</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 병동별 섹션 */}
          {Object.entries(WARD_STRUCTURE).map(([wardNum, ward]) => {
            const isCollapsed = collapsed[wardNum];
            let wOcc=0, wTotal=0;
            ward.rooms.forEach(room => {
              for (let b=1; b<=room.capacity; b++) {
                wTotal++;
                if (slots[`${room.id}-${b}`]?.current?.name) wOcc++;
              }
            });

            return (
              <div key={wardNum}>
                {/* 병동 헤더 */}
                <div style={{ display:"flex", background:"#1e293b", color:"#e2e8f0", cursor:"pointer", position:"sticky", top:54, zIndex:20 }}
                  onClick={() => setCollapsed(c=>({...c,[wardNum]:!c[wardNum]}))}>
                  <div style={{ width:LEFT_W, minWidth:LEFT_W, flexShrink:0, position:"sticky", left:0, zIndex:21, background:"#1e293b", padding:"7px 14px", display:"flex", alignItems:"center", gap:8, borderRight:"2px solid #334155" }}>
                    <span style={{ fontSize:13, fontWeight:800 }}>{isCollapsed?"▶":"▼"}</span>
                    <span style={{ fontSize:14, fontWeight:800 }}>{ward.name}</span>
                    <span style={{ fontSize:12, background:"rgba(255,255,255,0.12)", borderRadius:5, padding:"1px 7px", color:"#94a3b8" }}>{wOcc}/{wTotal}</span>
                  </div>
                  <div style={{ flex:1 }}/>
                </div>

                {!isCollapsed && ward.rooms.filter(room => !filterType || room.type === filterType).map(room => {
                  let roomOcc=0;
                  for (let b=1; b<=room.capacity; b++) {
                    if (slots[`${room.id}-${b}`]?.current?.name) roomOcc++;
                  }
                  return (
                    <div key={room.id}>
                      {/* 병실 헤더 */}
                      <div style={{ display:"flex", borderBottom:"1px solid #e2e8f0", background:"#f0f4f8" }}>
                        <div style={{ width:LEFT_W, minWidth:LEFT_W, flexShrink:0, position:"sticky", left:0, zIndex:10, background:"#f0f4f8", borderRight:"2px solid #e2e8f0", padding:"5px 14px", display:"flex", alignItems:"center", gap:7 }}>
                          <span style={{ background:TYPE_BG[room.type], color:TYPE_COLOR[room.type], borderRadius:5, padding:"2px 7px", fontSize:11, fontWeight:700 }}>{room.type}</span>
                          <span style={{ fontSize:13, fontWeight:800, color:"#334155" }}>{room.id}호</span>
                          <span style={{ fontSize:11, color:"#94a3b8" }}>{roomOcc}/{room.capacity}</span>
                        </div>
                        <div style={{ display:"flex", flex:1 }}>
                          {days.map((day, di) => (
                            <div key={di} style={{ width:DAY_W, minWidth:DAY_W, flexShrink:0, height:26,
                              background:day.getTime()===today.getTime()?"rgba(59,130,246,0.05)":"transparent",
                              borderRight:"1px solid #e8edf2" }}/>
                          ))}
                        </div>
                      </div>

                      {/* 병상 행들 */}
                      {Array.from({ length: room.capacity }, (_, bi) => {
                        const slotKey  = `${room.id}-${bi+1}`;
                        const slot     = slots[slotKey];
                        const bars     = getBars(slot, days);
                        const overlaps = getOverlaps(bars);
                        const isDragTarget = dragOver === slotKey && dragging?.slotKey !== slotKey;
                        const isDragSource = dragging?.slotKey === slotKey;

                        return (
                          <div key={bi}
                            style={{ display:"flex", height:ROW_H, borderBottom:"1px solid #f1f5f9",
                              background: isDragTarget ? "#f0fdf4" : "#fff",
                              outline: isDragTarget ? "2px solid #059669" : "none",
                              outlineOffset: -2,
                              transition:"background 0.15s" }}
                            onDragOver={e => { e.preventDefault(); setDragOver(slotKey); }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }}
                            onDrop={e => { e.preventDefault(); executeDrop(slotKey); }}>

                            {/* 병상 레이블 */}
                            <div style={{ width:LEFT_W, minWidth:LEFT_W, flexShrink:0, position:"sticky", left:0, zIndex:9,
                              background: isDragTarget?"#f0fdf4": isDragSource?"#faf5ff":"#fff",
                              borderRight:"2px solid #e2e8f0", display:"flex", alignItems:"center", padding:"0 14px", gap:8, cursor:"pointer", transition:"background 0.15s" }}
                              onClick={() => router.push(`/room?id=${room.id}`)}
                              onMouseEnter={e=>{ if(!isDragTarget) e.currentTarget.style.background="#f8fafc"; }}
                              onMouseLeave={e=>{ if(!isDragTarget) e.currentTarget.style.background=isDragSource?"#faf5ff":"#fff"; }}>
                              <span style={{ background:"#1e3a5f", color:"#fff", borderRadius:5, padding:"2px 8px", fontSize:13, fontWeight:800, flexShrink:0 }}>{bi+1}번</span>
                              {isDragTarget && <span style={{ fontSize:11, color:"#059669", fontWeight:700 }}>← 여기에 놓기</span>}
                              {!isDragTarget && (
                                slot?.current?.name
                                  ? <span style={{ fontSize:12, color:"#334155", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:90 }}>{slot.current.name}</span>
                                  : <span style={{ fontSize:11, color:"#cbd5e1" }}>빈 병상</span>
                              )}
                              {!isDragTarget && (slot?.reservations||[]).filter(r=>r?.name).length > 0 && (
                                <span style={{ fontSize:10, background:"#ede9fe", color:"#7c3aed", borderRadius:4, padding:"1px 5px", fontWeight:700, flexShrink:0 }}>
                                  +{(slot.reservations||[]).filter(r=>r?.name).length}예약
                                </span>
                              )}
                            </div>

                            {/* 타임라인 트랙 */}
                            <div style={{ position:"relative", flex:1, minWidth:DAY_W*DAYS_TOTAL, overflow:"hidden" }}>

                              {/* 배경 그리드 & 빈 칸 클릭 */}
                              {days.map((day, di) => (
                                <div key={di}
                                  style={{ position:"absolute", left:di*DAY_W, top:0, width:DAY_W, height:"100%",
                                    background:day.getTime()===today.getTime()?"rgba(59,130,246,0.04)":"transparent",
                                    borderRight:"1px solid #d1d5db", cursor:"pointer" }}
                                  title={`${toDateStr(day)} 예약 추가`}
                                  onClick={() => setEditModal({ slotKey, mode:"reservation", resIndex:-1,
                                    data:{ name:"", admitDate:toDateStr(day), discharge:"미정", note:"", scheduleAlert:false } })}
                                />
                              ))}

                              {/* 오늘 세로선 */}
                              {todayIdx >= 0 && (
                                <div style={{ position:"absolute", left:todayIdx*DAY_W+DAY_W/2-1, top:0, width:2, height:"100%", background:"rgba(59,130,246,0.25)", pointerEvents:"none", zIndex:1 }}/>
                              )}

                              {/* ── 겹침 구간 (빗금 오버레이) ── */}
                              {overlaps.map((ov, oi) => (
                                <div key={oi} style={{ position:"absolute", zIndex:6, pointerEvents:"none",
                                  left: ov.startDay * DAY_W,
                                  top: 0,
                                  width: (ov.endDay - ov.startDay + 1) * DAY_W,
                                  height: "100%",
                                  backgroundImage:"repeating-linear-gradient(45deg, rgba(239,68,68,0.55) 0px, rgba(239,68,68,0.55) 3px, transparent 3px, transparent 10px)",
                                  borderLeft:"2px solid #ef4444",
                                  borderRight:"2px solid #ef4444",
                                }}>
                                  <div style={{ position:"absolute", top:2, left:4, fontSize:10, fontWeight:800, color:"#dc2626", background:"rgba(255,255,255,0.85)", borderRadius:3, padding:"1px 4px" }}>⚠ 겹침</div>
                                </div>
                              ))}

                              {/* ── 환자 바 ── */}
                              {bars.map((bar, bi2) => {
                                const p = bar.person;
                                const disD   = parseDateStr(p.discharge);
                                const admitD = parseDateStr(p.admitDate);
                                const disToday   = disD   && dateOnly(disD).getTime()   === today.getTime();
                                const admitToday = admitD && dateOnly(admitD).getTime() === today.getTime();
                                const isDraggingThis = dragging?.slotKey===slotKey && dragging?.bar?.resIndex===bar.resIndex && dragging?.bar?.type===bar.type;

                                let bg = bar.type==="current" ? "#10b981" : "#8b5cf6";
                                if (bar.type==="current" && disToday)   bg = "#f59e0b";
                                if (bar.type==="current" && admitToday) bg = "#3b82f6";

                                const barLeft  = bar.startDay * DAY_W + (bar.overflowLeft  ? 0 : 3);
                                const barWidth = Math.max(20, (bar.endDay - bar.startDay + 1) * DAY_W - (bar.overflowLeft?0:3) - (bar.overflowRight?0:3));
                                const BAR_H    = ROW_H - 16;

                                return (
                                  <div key={bi2}
                                    draggable
                                    onDragStart={e => {
                                      e.dataTransfer.effectAllowed = "move";
                                      // 드래그 고스트 이미지 제거 (기본 ghost 유지)
                                      setDragging({ slotKey, bar });
                                    }}
                                    onDragEnd={() => { setDragging(null); setDragOver(null); }}
                                    style={{ position:"absolute", left:barLeft, top:8, height:BAR_H, width:barWidth,
                                      background:bg, zIndex:5,
                                      borderRadius:`${bar.overflowLeft?0:7}px ${bar.overflowRight?0:7}px ${bar.overflowRight?0:7}px ${bar.overflowLeft?0:7}px`,
                                      cursor:"grab", overflow:"hidden",
                                      display:"flex", flexDirection:"column", justifyContent:"center", padding:"0 8px",
                                      boxShadow: isDraggingThis ? "none" : "0 2px 6px rgba(0,0,0,0.18)",
                                      opacity: isDraggingThis ? 0.4 : 1,
                                      transition:"opacity 0.15s, box-shadow 0.15s",
                                      userSelect:"none",
                                    }}
                                    onClick={e => { e.stopPropagation(); if (!dragging) setPopover({ slotKey, bar, x:e.clientX+8, y:e.clientY+8 }); }}
                                    onMouseEnter={e=>{ if(!isDraggingThis) e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.28)"; }}
                                    onMouseLeave={e=>{ e.currentTarget.style.boxShadow=isDraggingThis?"none":"0 2px 6px rgba(0,0,0,0.18)"; }}>

                                    {/* 1줄: 이름 + 퇴원일 */}
                                    <div style={{ display:"flex", alignItems:"center", gap:4, overflow:"hidden" }}>
                                      {bar.overflowLeft && <span style={{ color:"rgba(255,255,255,0.7)", fontSize:11, flexShrink:0 }}>‹</span>}
                                      <span style={{ color:"#fff", fontWeight:700, fontSize:13, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flexShrink:1 }}>
                                        {p.name}
                                      </span>
                                      {p.discharge && p.discharge !== "미정" && (
                                        <span style={{ color:"rgba(255,255,255,0.85)", fontSize:11, flexShrink:0, whiteSpace:"nowrap" }}>
                                          ~{p.discharge}
                                        </span>
                                      )}
                                      {bar.overflowRight && <span style={{ color:"rgba(255,255,255,0.7)", fontSize:11, marginLeft:"auto", flexShrink:0 }}>›</span>}
                                    </div>

                                    {/* 2줄: 메모 (바 너비가 충분할 때만) */}
                                    {p.note && barWidth > 80 && (
                                      <div style={{ color:"rgba(255,255,255,0.85)", fontSize:11, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginTop:2, lineHeight:1.3 }}>
                                        {p.note}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}

                              {/* ── 텍스트 오버레이 (빗금 위, z-index 7) ── */}
                              {bars.map((bar, bi2) => {
                                const p = bar.person;
                                const barLeft  = bar.startDay * DAY_W + (bar.overflowLeft  ? 0 : 3);
                                const barWidth = Math.max(20, (bar.endDay - bar.startDay + 1) * DAY_W - (bar.overflowLeft?0:3) - (bar.overflowRight?0:3));
                                const BAR_H    = ROW_H - 16;
                                return (
                                  <div key={`txt-${bi2}`} style={{
                                    position:"absolute", left:barLeft, top:8, height:BAR_H, width:barWidth,
                                    zIndex:7, pointerEvents:"none", overflow:"hidden",
                                    display:"flex", flexDirection:"column", justifyContent:"center", padding:"0 8px",
                                  }}>
                                    <div style={{ display:"flex", alignItems:"center", gap:4, overflow:"hidden" }}>
                                      {bar.overflowLeft && <span style={{ color:"rgba(255,255,255,0.7)", fontSize:11, flexShrink:0 }}>‹</span>}
                                      <span style={{ color:"#fff", fontWeight:700, fontSize:13, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", flexShrink:1 }}>
                                        {p.name}
                                      </span>
                                      {p.discharge && p.discharge !== "미정" && (
                                        <span style={{ color:"rgba(255,255,255,0.9)", fontSize:11, flexShrink:0, whiteSpace:"nowrap" }}>
                                          ~{p.discharge}
                                        </span>
                                      )}
                                      {bar.overflowRight && <span style={{ color:"rgba(255,255,255,0.7)", fontSize:11, marginLeft:"auto", flexShrink:0 }}>›</span>}
                                    </div>
                                    {p.note && barWidth > 80 && (
                                      <div style={{ color:"rgba(255,255,255,0.9)", fontSize:11, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginTop:2, lineHeight:1.3 }}>
                                        {p.note}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}

          <div style={{ height:40 }}/>
        </div>
      </div>

      {/* 팝오버 */}
      {popover && !dragging && (
        <Popover
          popover={popover}
          onClose={() => setPopover(null)}
          onEdit={() => {
            const { bar, slotKey } = popover;
            setEditModal({ slotKey, mode:bar.type==="current"?"current":"reservation", data:{...bar.person}, resIndex:bar.resIndex });
            setPopover(null);
          }}
          onDelete={handlePopoverDelete}
          onConvert={handlePopoverConvert}
        />
      )}

      {/* 편집 모달 */}
      {editModal && (
        <EditModal
          modal={editModal}
          onClose={() => setEditModal(null)}
          onSave={handleSave}
          onDelete={handleDelete}
          onConvert={handleConvert}
          saving={saving}
        />
      )}
    </div>
  );
}

const hBtn = {
  background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)",
  color:"#fff", borderRadius:7, padding:"5px 13px", cursor:"pointer", fontSize:13, fontWeight:600,
};

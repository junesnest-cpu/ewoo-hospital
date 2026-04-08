import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";
import { searchPatientsByName } from "../lib/patientSearch";

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

  // 자리보존 바: 현재 환자 퇴원일 다음날 ~ 예약 환자 입원일 전날
  if (slot?.current?.name) {
    const curDisD = parseDateStr(slot.current.discharge);
    if (curDisD) {
      (slot?.reservations || []).forEach((r, ri) => {
        if (r?.name && r?.preserveSeat && r?.admitDate) {
          const resAdmitD = parseDateStr(r.admitDate);
          if (resAdmitD) {
            const siRaw = Math.round((dateOnly(curDisD).getTime() - ws) / MS) + 1;
            const eiRaw = Math.round((dateOnly(resAdmitD).getTime() - ws) / MS) - 1;
            if (siRaw <= eiRaw && eiRaw >= 0 && siRaw < len) {
              bars.push({
                type: "preserved",
                person: { name: slot.current.name, admitDate: null, discharge: null },
                resIndex: ri,
                startDay: Math.max(0, siRaw),
                endDay:   Math.min(len-1, eiRaw),
                overflowLeft:  siRaw < 0,
                overflowRight: eiRaw >= len,
                rawStart: siRaw, rawEnd: eiRaw,
              });
            }
          }
        }
      });
    }
  }

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
function EditModal({ modal, onClose, onSave, onDelete, onConvert, saving, currentPatient }) {
  const [form, setForm] = useState({
    name:          modal.data.name          || "",
    admitDate:     modal.data.admitDate     || "",
    discharge:     modal.data.discharge     || "미정",
    note:          modal.data.note          || "",
    scheduleAlert: modal.data.scheduleAlert || false,
    patientId:     modal.data.patientId     || "",
    preserveSeat:  modal.data.preserveSeat  || false,
  });
  const [suggestions,     setSuggestions]     = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching,       setSearching]       = useState(false);
  const searchTimer = useRef(null);

  const isNew         = modal.resIndex === -1;
  const isReservation = modal.mode === "reservation";
  const slotLabel     = modal.slotKey.replace(/(\d+)-(\d+)/, "$1호 $2번");

  // 자리보존 조건: 현재 입원 환자 + 퇴원 후 7일 이내 재입원 예약
  const curDisD   = currentPatient?.discharge ? parseDateStr(currentPatient.discharge) : null;
  const frmAdmitD = form.admitDate ? parseDateStr(form.admitDate) : null;
  const diffDays  = (curDisD && frmAdmitD)
    ? Math.round((dateOnly(frmAdmitD).getTime() - dateOnly(curDisD).getTime()) / 86400000)
    : -1;
  const showPreserveSeat = isReservation && !!currentPatient?.name && diffDays >= 1 && diffDays <= 7;
  const inpStyle = { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"9px 11px", fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" };

  const onNameChange = (val) => {
    setForm(p => ({ ...p, name: val, patientId: "" }));
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!val.trim()) { setSuggestions([]); setShowSuggestions(false); setSearching(false); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await searchPatientsByName(val.trim());
        setSuggestions(results);
        setShowSuggestions(results.length > 0);
      } catch(e) {}
      setSearching(false);
    }, 300);
  };

  const selectPatient = (p) => {
    setForm(prev => ({
      ...prev,
      name:      p.name,
      patientId: p.internalId || "",
      note:      prev.note || (p.diagnosis ? `[${p.diagnosis}]` : ""),
    }));
    setSuggestions([]);
    setShowSuggestions(false);
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:16, padding:"24px 28px", width:"min(92vw,400px)", boxShadow:"0 24px 64px rgba(0,0,0,0.3)" }}>
        <div style={{ fontWeight:800, fontSize:16, color:"#0f2744", marginBottom:4 }}>
          {isNew ? "📅 예약 입원 추가" : isReservation ? "📅 예약 수정" : "🏥 입원 정보 수정"}
        </div>
        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:20 }}>{slotLabel} 병상</div>

        {/* 이름 입력 + 환자 자동완성 */}
        <div style={{ marginBottom:14, position:"relative" }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>
            환자 이름 *
            {form.patientId && (
              <span style={{ marginLeft:6, fontSize:11, color:"#059669", fontWeight:700 }}>✓ 기존 환자 연결됨</span>
            )}
          </label>
          <div style={{ position:"relative" }}>
            <input
              style={{ ...inpStyle, borderColor: form.patientId ? "#10b981" : "#e2e8f0", paddingRight: searching ? 80 : 11 }}
              value={form.name}
              onChange={e => onNameChange(e.target.value)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="이름 입력 (기존 환자 자동완성)"
              autoFocus
            />
            {searching && (
              <span style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", fontSize:11, color:"#94a3b8" }}>검색 중…</span>
            )}
          </div>
          {showSuggestions && (
            <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", borderRadius:8,
              boxShadow:"0 8px 24px rgba(0,0,0,0.18)", border:"1px solid #e2e8f0", zIndex:50, maxHeight:220, overflowY:"auto", marginTop:2 }}>
              {suggestions.map((p, i) => (
                <div key={i} onMouseDown={() => selectPatient(p)}
                  style={{ padding:"9px 12px", cursor:"pointer", borderBottom:"1px solid #f1f5f9",
                    display:"flex", flexDirection:"column", gap:2, background:"#fff", transition:"background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f0f9ff"}
                  onMouseLeave={e => e.currentTarget.style.background="#fff"}>
                  <div style={{ fontWeight:700, fontSize:14, color:"#0f2744" }}>{p.name}</div>
                  <div style={{ fontSize:11, color:"#94a3b8", display:"flex", gap:8, flexWrap:"wrap" }}>
                    {p.birthDate  && <span>{p.birthDate}</span>}
                    {p.diagnosis  && <span style={{ color:"#64748b" }}>{p.diagnosis}</span>}
                    {p.chartNo    && <span>차트 {p.chartNo}</span>}
                    {p.doctor     && <span>담당 {p.doctor}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 입원일 / 퇴원일 */}
        {[
          ...(isReservation ? [{ label:"예약 입원일 (예: 4/15)", key:"admitDate", ph:"4/15" }] : []),
          { label:"퇴원 예정일 (예: 4/25 또는 미정)", key:"discharge", ph:"4/25 또는 미정" },
        ].map(f => (
          <div key={f.key} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>{f.label}</label>
            <input style={inpStyle} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph} />
          </div>
        ))}

        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>메모</label>
          <textarea style={{...inpStyle, resize:"vertical", minHeight:72, lineHeight:1.6}} value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} placeholder="치료 내용, 특이사항 등" />
        </div>

        <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:showPreserveSeat?8:20, cursor:"pointer", fontSize:13, color:"#64748b" }}>
          <input type="checkbox" checked={form.scheduleAlert} onChange={e=>setForm(p=>({...p,scheduleAlert:e.target.checked}))} />
          ⚠ 스케줄 확인 필요
        </label>

        {showPreserveSeat && (
          <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20, cursor:"pointer", fontSize:13, color:"#92400e", background:"#fef3c7", borderRadius:8, padding:"10px 12px" }}>
            <input type="checkbox" checked={form.preserveSeat} onChange={e=>setForm(p=>({...p,preserveSeat:e.target.checked}))} />
            🛋 자리보존 서비스 — {currentPatient.name}님 퇴원 후 짐을 두고 재입원까지 병상 유지
          </label>
        )}

        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <button onClick={() => onSave({ ...form, preserveSeat: showPreserveSeat ? form.preserveSeat : false })} disabled={saving || !form.name.trim()}
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

  const [slots,         setSlots]         = useState({});
  const [consultations, setConsultations] = useState({});
  const [roomMemos,     setRoomMemos]     = useState({});
  const [syncing,    setSyncing]    = useState(true);
  const [lastSync,   setLastSync]   = useState(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [collapsed,  setCollapsed]  = useState({});
  const [popover,    setPopover]    = useState(null);
  const [editModal,  setEditModal]  = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [memoOpen,   setMemoOpen]   = useState(true);
  const [localMemos, setLocalMemos] = useState({});  // 입력 중 로컬 상태
  const [memoWidth,  setMemoWidth]  = useState(220);
  const [singleRoomMemoText, setSingleRoomMemoText] = useState("");
  const [localSingleMemo,    setLocalSingleMemo]    = useState("");
  const [singleMemoOpen,     setSingleMemoOpen]     = useState(true);

  // 모바일에서 초기 로드 시 메모 패널 접기
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setMemoOpen(false);
      setSingleMemoOpen(false);
    }
  }, []);
  const [tlSearchQuery,    setTlSearchQuery]    = useState("");
  const [tlSearchResults,  setTlSearchResults]  = useState([]);
  const [tlSearchFocused,  setTlSearchFocused]  = useState(false);
  const [highlightKey,     setHighlightKey]     = useState(null); // { slotKey }
  const [resHighlight,     setResHighlight]     = useState(null); // { slotKey, resIndex } 예약 바 하이라이트
  const resHighlightCursor = useRef({});  // { [slotKey]: number } 순환 커서
  const resHighlightTimer  = useRef(null);
  const tlSearchRef    = useRef(null);
  const hlTimer        = useRef(null);
  const rowRefs        = useRef({});
  const doTlSearchFnRef = useRef(null);
  const isResizing     = useRef(false);
  const timelineScrollRef = useRef(null);
  const memoScrollRef     = useRef(null);
  const isSyncingScroll   = useRef(false);
  const dragMousePos      = useRef({ x: 0, y: 0 });
  const autoScrollRAF     = useRef(null);

  // ── 타임라인 ↔ 메모 패널 세로 스크롤 동기화 ─────────────────────────────
  const onTimelineScroll = useCallback((e) => {
    if (isSyncingScroll.current) return;
    if (memoScrollRef.current) {
      isSyncingScroll.current = true;
      memoScrollRef.current.scrollTop = e.target.scrollTop;
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    }
  }, []);

  const onMemoScroll = useCallback((e) => {
    if (isSyncingScroll.current) return;
    if (timelineScrollRef.current) {
      isSyncingScroll.current = true;
      timelineScrollRef.current.scrollTop = e.target.scrollTop;
      requestAnimationFrame(() => { isSyncingScroll.current = false; });
    }
  }, []);

  // ── 메모 패널 너비 드래그 조절 ──────────────────────────────────────────
  const onResizerMouseDown = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startW = memoWidth;
    const onMove = (ev) => {
      if (!isResizing.current) return;
      const delta = startX - ev.clientX;
      setMemoWidth(Math.max(120, Math.min(900, startW + delta)));
    };
    const onUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [memoWidth]);

  // ── 드래그 앤 드롭 상태 ──────────────────────────────────────────────────
  const [dragging,   setDragging]   = useState(null);  // { slotKey, bar }
  const [dragOver,   setDragOver]   = useState(null);  // 대상 slotKey

  // ── 드래그 중 자동 스크롤 ────────────────────────────────────────────────
  useEffect(() => {
    if (!dragging) {
      if (autoScrollRAF.current) { cancelAnimationFrame(autoScrollRAF.current); autoScrollRAF.current = null; }
      return;
    }
    const THRESHOLD = 80;   // 엣지에서 이 거리(px) 이내면 스크롤 시작
    const MAX_SPEED = 16;   // 프레임당 최대 스크롤 px

    const onDragOver = (e) => { dragMousePos.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener("dragover", onDragOver);

    const tick = () => {
      const el = timelineScrollRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const { x, y } = dragMousePos.current;
        const rightDist  = rect.right  - x;
        const leftDist   = x - rect.left;
        const bottomDist = rect.bottom - y;
        const topDist    = y - rect.top;
        if (rightDist  > 0 && rightDist  < THRESHOLD) el.scrollLeft += MAX_SPEED * (1 - rightDist  / THRESHOLD);
        else if (leftDist  > 0 && leftDist  < THRESHOLD) el.scrollLeft -= MAX_SPEED * (1 - leftDist  / THRESHOLD);
        if (bottomDist > 0 && bottomDist < THRESHOLD) el.scrollTop  += MAX_SPEED * (1 - bottomDist / THRESHOLD);
        else if (topDist   > 0 && topDist   < THRESHOLD) el.scrollTop  -= MAX_SPEED * (1 - topDist   / THRESHOLD);
      }
      autoScrollRAF.current = requestAnimationFrame(tick);
    };
    autoScrollRAF.current = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener("dragover", onDragOver);
      if (autoScrollRAF.current) { cancelAnimationFrame(autoScrollRAF.current); autoScrollRAF.current = null; }
    };
  }, [dragging]);

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

  useEffect(() => {
    const unsub = onValue(ref(db, "consultations"), snap => {
      setConsultations(snap.val() || {});
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onValue(ref(db, "roomMemos"), snap => {
      const val = snap.val() || {};
      setRoomMemos(val);
      setLocalMemos(val);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onValue(ref(db, "roomTypeMemos/1인실"), snap => {
      const val = snap.val() || "";
      setSingleRoomMemoText(val);
      setLocalSingleMemo(val);
    });
    return () => unsub();
  }, []);

  // ── 타임라인 드래그 스크롤 ────────────────────────────────────────────────
  // 환자 바(draggable) · 버튼 · 링크 위에서는 제외, 나머지 어디서든 좌우 드래그 스크롤
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    let startX = 0, startScrollLeft = 0;
    let draggingScroll = false, moved = false;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('[draggable="true"]')) return;
      if (e.target.closest('button, a, input, textarea, select')) return;
      draggingScroll = true;
      moved = false;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
    };
    const onMouseMove = (e) => {
      if (!draggingScroll) return;
      const dx = startX - e.clientX;
      if (Math.abs(dx) > 4) {
        moved = true;
        el.scrollLeft = startScrollLeft + dx;
        el.style.cursor = "grabbing";
        el.style.userSelect = "none";
      }
    };
    const onMouseUp = () => {
      if (moved) { el.style.cursor = ""; el.style.userSelect = ""; }
      draggingScroll = false;
    };
    // 드래그 후 클릭 이벤트가 발화되지 않도록 capture 단계에서 차단
    const onClickCapture = (e) => {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    };

    el.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  // ── 타임라인 검색 ────────────────────────────────────────────────────────
  const doTlSearch = (q) => {
    setTlSearchQuery(q);
    if (!q.trim()) { setTlSearchResults([]); return; }
    const results = [];
    Object.entries(slots).forEach(([slotKey, slot]) => {
      const roomId = slotKey.split("-")[0];
      if (slot?.current?.name?.includes(q.trim()))
        results.push({ slotKey, name: slot.current.name, type: "current", roomId });
      (slot?.reservations || []).forEach(r => {
        if (r.name?.includes(q.trim()))
          results.push({ slotKey, name: r.name, type: "reserved", roomId, admitDate: r.admitDate });
      });
    });
    setTlSearchResults(results);
  };

  // 가용병상조회에서 넘어온 예약 모달 자동 오픈
  useEffect(() => {
    const { openRes, admitDate: qAdmit, discharge: qDischarge } = router.query;
    if (!openRes) return;
    setEditModal({
      slotKey: openRes,
      mode: "reservation",
      resIndex: -1,
      data: { name:"", admitDate: qAdmit || "", discharge: qDischarge || "미정", note:"", scheduleAlert:false },
      currentPatient: slots[openRes]?.current?.name ? slots[openRes].current : null,
    });
    // 해당 병상 행으로 스크롤
    setTimeout(() => scrollToRow(openRes), 300);
    // 쿼리 파라미터 제거 (뒤로 가기 시 재오픈 방지)
    router.replace("/ward-timeline", undefined, { shallow: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.openRes]);

  // 사이드바 검색 이벤트 처리 (stale closure 방지)
  useEffect(() => { doTlSearchFnRef.current = doTlSearch; });
  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) doTlSearchFnRef.current?.(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  const scrollToRow = (slotKey) => {
    if (hlTimer.current) clearTimeout(hlTimer.current);
    const el = rowRefs.current[slotKey];
    const container = timelineScrollRef.current;
    if (el && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect        = el.getBoundingClientRect();
      const relTop        = elRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: relTop - containerRect.height / 2 + ROW_H / 2, behavior: "smooth" });
    }
    // 4회 점멸 후 소멸
    const BLINK_MS = 300;
    const TOTAL    = 8; // on/off × 4회
    let tick = 0;
    setHighlightKey({ slotKey });
    const doBlink = () => {
      tick++;
      if (tick >= TOTAL) { setHighlightKey(null); return; }
      setHighlightKey(tick % 2 === 0 ? { slotKey } : null);
      hlTimer.current = setTimeout(doBlink, BLINK_MS);
    };
    hlTimer.current = setTimeout(doBlink, BLINK_MS);
  };

  // + 예약 버튼: 예약을 입원일 순으로 순환하며 해당 바 하이라이트 + 스크롤
  const cycleReservationHighlight = useCallback((slotKey, slot) => {
    const reservations = (slot?.reservations || [])
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r?.name)
      .sort((a, b) => {
        const da = parseDateStr(a.r.admitDate);
        const db2 = parseDateStr(b.r.admitDate);
        if (!da && !db2) return 0;
        if (!da) return 1;
        if (!db2) return -1;
        return da - db2;
      });
    if (reservations.length === 0) return;

    const cursor = resHighlightCursor.current[slotKey] || 0;
    const next   = cursor % reservations.length;
    resHighlightCursor.current[slotKey] = next + 1;

    const { r, i: resIndex } = reservations[next];
    setResHighlight({ slotKey, resIndex });

    // 세로 스크롤: 해당 행으로
    const el = rowRefs.current[slotKey];
    const container = timelineScrollRef.current;
    if (el && container) {
      const containerRect = container.getBoundingClientRect();
      const elRect        = el.getBoundingClientRect();
      const relTop        = elRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: relTop - containerRect.height / 2 + ROW_H / 2, behavior: "smooth" });
    }

    // 가로 스크롤: 바의 시작 날짜 위치로 (현재 뷰 범위 밖이면 weekOffset 먼저 이동)
    const admitD = parseDateStr(r.admitDate);
    if (admitD && container) {
      const diRelToToday = Math.round((dateOnly(admitD).getTime() - today.getTime()) / 86400000);
      const windowStart  = weekOffset * 7 - DAYS_BACK;
      const windowEnd    = windowStart + DAYS_TOTAL - 1;

      const scrollToX = (diInWindow) => {
        const targetLeft = Math.max(0, diInWindow * DAY_W - DAY_W * 2);
        container.scrollTo({ left: targetLeft, behavior: "smooth" });
      };

      if (diRelToToday >= windowStart && diRelToToday <= windowEnd) {
        // 현재 뷰 안 → 바로 가로 스크롤
        scrollToX(diRelToToday - windowStart);
      } else {
        // 현재 뷰 밖 → weekOffset 변경 후 재렌더링 대기 후 스크롤
        const newWeekOffset = Math.round((diRelToToday + DAYS_BACK - DAYS_TOTAL / 2) / 7);
        setWeekOffset(newWeekOffset);
        const newWindowStart = newWeekOffset * 7 - DAYS_BACK;
        const newDi = diRelToToday - newWindowStart;
        setTimeout(() => scrollToX(newDi), 120);
      }
    }

    // 3초 후 하이라이트 해제
    if (resHighlightTimer.current) clearTimeout(resHighlightTimer.current);
    resHighlightTimer.current = setTimeout(() => setResHighlight(null), 3000);
  }, [today, weekOffset]);

  // 신환 이름 집합 (consultations 기준, patientId 없음=신규, 취소/입원완료 제외)
  const newPatientNames = useMemo(() => {
    // "신)이름" 같은 접두사 제거 후 비교
    const normName = n => (n || "").replace(/^신\)\s*/,"").replace(/\s/g,"").toLowerCase();
    const set = new Set();
    Object.values(consultations).forEach(c => {
      if (!c?.name) return;
      if (c.patientId) return;                              // patientId 있으면 재입원 → 제외
      if (c.status === "취소" || c.status === "입원완료") return;
      set.add(normName(c.name));
    });
    return set;
  }, [consultations]);

  const saveSlots = useCallback(async ns => {
    setSlots(ns);
    await set(ref(db, "slots"), ns);
  }, []);

  // 상담일지 역방향 동기화: 타임라인에서 예약 삭제/이동 시 상담일지 업데이트
  const syncConsultationOnSlotChange = useCallback(async (fromSlotKey, personName, consultationId, newSlotKey) => {
    // 해당 병상+이름(또는 consultationId)으로 상담 찾기
    const match = Object.entries(consultations).find(([id, c]) => {
      if (c.reservedSlot !== fromSlotKey) return false;
      if (consultationId && id === consultationId) return true;
      return c.name === personName;
    });
    if (!match) return;
    const [cId, c] = match;
    if (newSlotKey) {
      // 병상 이동: reservedSlot 업데이트
      await set(ref(db, `consultations/${cId}`), { ...c, reservedSlot: newSlotKey });
    } else {
      // 예약 삭제: 병상 배정 해제 → 상담중으로 복귀
      await set(ref(db, `consultations/${cId}`), { ...c, reservedSlot: null, status: "상담중" });
    }
  }, [consultations]);

  const saveMemo = useCallback(async (roomId, text) => {
    const next = { ...roomMemos, [roomId]: text };
    setRoomMemos(next);
    await set(ref(db, "roomMemos"), next);
  }, [roomMemos]);

  const saveSingleRoomMemo = useCallback(async (text) => {
    setSingleRoomMemoText(text);
    await set(ref(db, "roomTypeMemos/1인실"), text);
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

    // 예약 이동 시 상담일지 연동
    if (bar.type === "reservation") {
      await syncConsultationOnSlotChange(fromKey, person.name, person.consultationId, targetSlotKey);
    }
    setDragging(null);
    setDragOver(null);
  }, [dragging, slots, saveSlots, syncConsultationOnSlotChange]);


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
      // 예약 삭제 시 상담일지 연동 (현재 입원 정보 삭제는 연동 제외)
      if (mode === "reservation") {
        await syncConsultationOnSlotChange(slotKey, data.name, data.consultationId, null);
      }
      setEditModal(null); setPopover(null);
    } finally { setSaving(false); }
  }, [editModal, slots, saveSlots, syncConsultationOnSlotChange]);

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
    // 예약 삭제 시 상담일지 연동
    if (bar.type === "reservation") {
      await syncConsultationOnSlotChange(slotKey, bar.person.name, bar.person.consultationId, null);
    }
    setPopover(null);
  }, [popover, slots, saveSlots, syncConsultationOnSlotChange]);

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
      <header style={{ background:"#0f2744", color:"#fff", padding:"12px 20px", display:"flex", alignItems:"center", gap:12, flexShrink:0, boxShadow:"0 2px 8px rgba(0,0,0,0.18)", flexWrap:"wrap", position:"sticky", top:0, zIndex:40 }}>
        <span style={{ fontSize:17, fontWeight:800 }}>병동 타임라인</span>
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
          { label:"자리보존", preserved:true },
        ].map(l => (
          <div key={l.label} style={{ display:"flex", alignItems:"center", gap:5 }}>
            <div style={{ width:14, height:14, borderRadius:3,
              background: l.preserved
                ? "repeating-linear-gradient(45deg, #fde68a 0px, #fde68a 4px, #fffbeb 4px, #fffbeb 8px)"
                : l.hatching ? "transparent" : l.color,
              backgroundImage: (!l.preserved && l.hatching) ? "repeating-linear-gradient(45deg, rgba(239,68,68,0.55) 0px, rgba(239,68,68,0.55) 3px, transparent 3px, transparent 10px)" : "none",
              border: l.preserved ? "1.5px dashed #f59e0b" : l.hatching ? "2px solid #ef4444" : "none" }}/>
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
        {/* 환자 검색 */}
        <div style={{ position:"relative", marginLeft:"auto", flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"center", border:"1.5px solid #e2e8f0", borderRadius:8, overflow:"visible", background:"#f8fafc" }}>
            <span style={{ padding:"0 8px", fontSize:14, color:"#94a3b8" }}>🔍</span>
            <input
              ref={tlSearchRef}
              style={{ border:"none", outline:"none", background:"transparent", padding:"6px 4px", fontSize:13, width:140, fontFamily:"inherit" }}
              placeholder="환자 이름 검색..."
              value={tlSearchQuery}
              onChange={e => doTlSearch(e.target.value)}
              onFocus={() => setTlSearchFocused(true)}
              onBlur={() => setTimeout(() => setTlSearchFocused(false), 200)}
            />
            {tlSearchQuery && (
              <button onClick={() => { setTlSearchQuery(""); setTlSearchResults([]); }}
                style={{ border:"none", background:"none", cursor:"pointer", padding:"0 8px", color:"#94a3b8", fontSize:14 }}>✕</button>
            )}
          </div>
          {/* 검색 결과 드롭다운 */}
          {tlSearchFocused && tlSearchResults.length > 0 && (
            <div style={{ position:"absolute", top:"100%", right:0, minWidth:260, background:"#fff", borderRadius:8,
              boxShadow:"0 4px 20px rgba(0,0,0,0.15)", border:"1px solid #e2e8f0", zIndex:100, maxHeight:300, overflowY:"auto", marginTop:4 }}>
              {tlSearchResults.map((r, i) => (
                <div key={i}
                  onClick={() => { scrollToRow(r.slotKey); setTlSearchFocused(false); }}
                  style={{ padding:"8px 14px", cursor:"pointer", borderBottom:"1px solid #f1f5f9", display:"flex", alignItems:"center", gap:8, background:"#fff", transition:"background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background="#f0f9ff"}
                  onMouseLeave={e => e.currentTarget.style.background="#fff"}>
                  <span style={{ fontSize:11, background:r.type==="current"?"#dbeafe":"#f5f3ff", color:r.type==="current"?"#1d4ed8":"#7c3aed",
                    borderRadius:4, padding:"1px 6px", fontWeight:700, flexShrink:0 }}>
                    {r.type==="current"?"입원중":"예약"}
                  </span>
                  <span style={{ fontWeight:700, fontSize:13 }}>{r.name}</span>
                  <span style={{ fontSize:11, color:"#94a3b8", marginLeft:"auto" }}>{r.roomId}호{r.admitDate&&` · ${r.admitDate}`}</span>
                </div>
              ))}
            </div>
          )}
          {tlSearchFocused && tlSearchQuery.trim() && tlSearchResults.length === 0 && (
            <div style={{ position:"absolute", top:"100%", right:0, width:240, background:"#fff", borderRadius:8,
              boxShadow:"0 4px 20px rgba(0,0,0,0.15)", border:"1px solid #e2e8f0", zIndex:100, padding:"12px 14px", marginTop:4,
              fontSize:13, color:"#94a3b8", textAlign:"center" }}>검색 결과 없음</div>
          )}
        </div>
      </div>

      {/* ── 타임라인 본체 + 메모 패널 ── */}
      {/* 외부 flex: 타임라인 스크롤 영역 / 메모 패널을 나란히 배치 */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", minHeight:0 }}>
      {/* 타임라인 스크롤 (가로+세로) — 메모 패널은 여기 포함 안 됨 */}
      <div ref={timelineScrollRef} style={{ flex:1, overflow:"auto" }} onScroll={onTimelineScroll}>
      <div style={{ minWidth: LEFT_W + DAY_W * DAYS_TOTAL }}>

      {/* 타임라인 */}
      <div style={{ flex:1, position:"relative" }}>
        <div>

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
                        const isDragTarget  = dragOver === slotKey && dragging?.slotKey !== slotKey;
                        const isDragSource  = dragging?.slotKey === slotKey;
                        const isRowHighlit  = highlightKey?.slotKey === slotKey;

                        return (
                          <div key={bi}
                            ref={el => { rowRefs.current[slotKey] = el; }}
                            style={{ display:"flex", height:ROW_H, borderBottom:"1px solid #f1f5f9",
                              background: isDragTarget ? "#f0fdf4" : isRowHighlit ? "#fff1f2" : "#fff",
                              outline: isDragTarget ? "2px solid #059669" : isRowHighlit ? "2px solid #ef4444" : "none",
                              outlineOffset: -2,
                              transition:"background 0.3s, outline 0.3s" }}
                            onDragOver={e => { e.preventDefault(); setDragOver(slotKey); }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); }}
                            onDrop={e => { e.preventDefault(); executeDrop(slotKey); }}>

                            {/* 병상 레이블 */}
                            <div style={{ width:LEFT_W, minWidth:LEFT_W, flexShrink:0, position:"sticky", left:0, zIndex:9,
                              background: isDragTarget?"#f0fdf4": isDragSource?"#faf5ff":"#fff",
                              borderRight:"2px solid #e2e8f0", display:"flex", alignItems:"center", padding:"0 6px 0 14px", gap:6, transition:"background 0.15s" }}
                              onMouseEnter={e=>{ if(!isDragTarget) e.currentTarget.style.background="#f8fafc"; }}
                              onMouseLeave={e=>{ if(!isDragTarget) e.currentTarget.style.background=isDragSource?"#faf5ff":"#fff"; }}>
                              {/* 병실 이동 영역 (병상번호 + 환자명) */}
                              <div style={{ display:"flex", alignItems:"center", gap:6, flex:1, minWidth:0, cursor:"pointer", overflow:"hidden" }}
                                onClick={() => router.push(`/room?roomId=${room.id}`)}>
                                <span style={{ background:"#1e3a5f", color:"#fff", borderRadius:5, padding:"2px 8px", fontSize:13, fontWeight:800, flexShrink:0 }}>{bi+1}번</span>
                                {isDragTarget && <span style={{ fontSize:11, color:"#059669", fontWeight:700 }}>← 여기에 놓기</span>}
                                {!isDragTarget && (
                                  slot?.current?.name
                                    ? <span style={{ fontSize:12, color:"#334155", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{slot.current.name}</span>
                                    : <span style={{ fontSize:11, color:"#cbd5e1" }}>빈 병상</span>
                                )}
                              </div>
                              {/* +예약 배지: 병실 이동 영역 밖에 독립 배치 */}
                              {!isDragTarget && (slot?.reservations||[]).filter(r=>r?.name).length > 0 && (
                                <span
                                  onClick={() => cycleReservationHighlight(slotKey, slot)}
                                  style={{ fontSize:10, background:"#ede9fe", color:"#7c3aed", borderRadius:4, padding:"1px 5px", fontWeight:700, flexShrink:0, cursor:"pointer", userSelect:"none" }}
                                  title="클릭 시 예약 날짜 순으로 이동">
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
                                    data:{ name:"", admitDate:toDateStr(day), discharge:"미정", note:"", scheduleAlert:false },
                                    currentPatient: slot?.current?.name ? slot.current : null })}
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
                                }}/>

                              ))}

                              {/* ── 환자 바 ── */}
                              {bars.map((bar, bi2) => {
                                // 자리보존 바 별도 렌더링
                                if (bar.type === "preserved") {
                                  const barLeft  = bar.startDay * DAY_W + (bar.overflowLeft  ? 0 : 3);
                                  const barWidth = Math.max(20, (bar.endDay - bar.startDay + 1) * DAY_W - (bar.overflowLeft?0:3) - (bar.overflowRight?0:3));
                                  const BAR_H    = ROW_H - 16;
                                  return (
                                    <div key={bi2}
                                      style={{ position:"absolute", left:barLeft, top:8, height:BAR_H, width:barWidth,
                                        background:"repeating-linear-gradient(45deg, #fde68a 0px, #fde68a 6px, #fffbeb 6px, #fffbeb 12px)",
                                        zIndex:4, borderRadius:4, border:"1.5px dashed #f59e0b",
                                        display:"flex", alignItems:"center", justifyContent:"center",
                                        overflow:"hidden", pointerEvents:"none",
                                      }}>
                                      <span style={{ fontSize:10, fontWeight:800, color:"#92400e", whiteSpace:"nowrap", padding:"0 4px" }}>
                                        {bar.overflowLeft && "‹ "}🛋 자리보존{bar.overflowRight && " ›"}
                                      </span>
                                    </div>
                                  );
                                }

                                const p = bar.person;
                                const disD   = parseDateStr(p.discharge);
                                const admitD = parseDateStr(p.admitDate);
                                const disToday   = disD   && dateOnly(disD).getTime()   === today.getTime();
                                const admitToday = admitD && dateOnly(admitD).getTime() === today.getTime();
                                const isDraggingThis = dragging?.slotKey===slotKey && dragging?.bar?.resIndex===bar.resIndex && dragging?.bar?.type===bar.type;

                                let bg = bar.type==="current" ? "#10b981" : "#8b5cf6";
                                if (bar.type==="current" && disToday)   bg = "#f59e0b";
                                if (bar.type==="current" && admitToday) bg = "#3b82f6";
                                const isResHighlit = resHighlight?.slotKey === slotKey && resHighlight?.resIndex === bar.resIndex;
                                const isBarHighlit = isRowHighlit || isResHighlit;

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
                                      boxShadow: isDraggingThis ? "none" : isResHighlit ? "0 0 0 3px #f59e0b, 0 4px 16px rgba(245,158,11,0.5)" : isRowHighlit ? "0 0 0 3px #ef4444, 0 4px 12px rgba(0,0,0,0.3)" : "0 2px 6px rgba(0,0,0,0.18)",
                                      opacity: isDraggingThis ? 0.4 : 1,
                                      outline: isResHighlit ? "2px solid #f59e0b" : isRowHighlit ? "2px solid #ef4444" : "none",
                                      transition:"opacity 0.15s, box-shadow 0.3s, outline 0.3s",
                                      userSelect:"none",
                                    }}
                                    onClick={e => { e.stopPropagation(); if (!dragging) setPopover({ slotKey, bar, x:e.clientX+8, y:e.clientY+8 }); }}
                                    onMouseEnter={e=>{ if(!isDraggingThis) e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.28)"; }}
                                    onMouseLeave={e=>{ e.currentTarget.style.boxShadow=isDraggingThis?"none":"0 2px 6px rgba(0,0,0,0.18)"; }}>

                                    {/* 1줄: 이름 + 퇴원일 */}
                                    <div style={{ display:"flex", alignItems:"center", gap:4, overflow:"hidden" }}>
                                      {bar.overflowLeft && <span style={{ color:"rgba(255,255,255,0.7)", fontSize:11, flexShrink:0 }}>‹</span>}
                                      {(() => { const ad = parseDateStr(p.admitDate); return newPatientNames.has((p.name||"").replace(/^신\)\s*/,"").replace(/\s/g,"").toLowerCase()) && (!ad || dateOnly(ad).getTime() >= today.getTime() - 7*24*60*60*1000); })() && (
                                        <span style={{ background:"#fef08a", color:"#713f12", borderRadius:3, padding:"1px 4px", fontSize:10, fontWeight:800, flexShrink:0 }}>★신</span>
                                      )}
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
                                if (bar.type === "preserved") return null; // 자리보존 바는 위에서 처리
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
                                      {(() => { const ad = parseDateStr(p.admitDate); return newPatientNames.has((p.name||"").replace(/^신\)\s*/,"").replace(/\s/g,"").toLowerCase()) && (!ad || dateOnly(ad).getTime() >= today.getTime() - 7*24*60*60*1000); })() && (
                                        <span style={{ background:"#fef08a", color:"#713f12", borderRadius:3, padding:"1px 4px", fontSize:10, fontWeight:800, flexShrink:0 }}>★신</span>
                                      )}
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
      </div>{/* 타임라인 열 끝 */}
      </div>{/* minWidth 컨테이너 끝 */}
      </div>{/* 타임라인 스크롤 컨테이너 끝 */}

      {/* ── 드래그 핸들 ── */}
      {memoOpen && (
        <div
          onMouseDown={onResizerMouseDown}
          style={{ width:5, flexShrink:0, cursor:"col-resize", background:"#e2e8f0", transition:"background 0.15s", zIndex:10, position:"relative" }}
          onMouseEnter={e => e.currentTarget.style.background="#94a3b8"}
          onMouseLeave={e => e.currentTarget.style.background="#e2e8f0"}
          title="드래그하여 너비 조절"
        >
          <div style={{ position:"absolute", top:"50%", left:"50%", transform:"translate(-50%,-50%)", display:"flex", flexDirection:"column", gap:3, pointerEvents:"none" }}>
            {[0,1,2].map(i => <div key={i} style={{ width:3, height:3, borderRadius:"50%", background:"#94a3b8" }}/>)}
          </div>
        </div>
      )}

      {/* ── 메모 패널 (가로 고정, 세로 스크롤은 타임라인과 동기화) ── */}
      <div ref={memoScrollRef} onScroll={onMemoScroll} style={{ width: memoOpen ? memoWidth : 36, flexShrink:0, borderLeft: memoOpen ? "none" : "2px solid #e2e8f0", background:"#f8fafc", overflowY:"auto", overflowX:"hidden" }}>
        {/* 패널 헤더 — sticky, 날짜 헤더(54px)와 높이 일치 */}
        <div style={{ position:"sticky", top:0, zIndex:29, height:54, display:"flex", alignItems:"center", justifyContent: memoOpen ? "space-between" : "center", padding: memoOpen ? "0 12px" : "0", borderBottom:"2px solid #cbd5e1", background:"#f8fafc", boxShadow:"0 2px 6px rgba(0,0,0,0.07)" }}>
          {memoOpen && <span style={{ fontSize:12, fontWeight:800, color:"#64748b" }}>📝 병실 메모</span>}
          <button onClick={() => setMemoOpen(o => !o)}
            style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, color:"#94a3b8", padding:2, lineHeight:1 }}
            title={memoOpen ? "메모 패널 닫기" : "메모 패널 열기"}>
            {memoOpen ? "»" : "«"}
          </button>
        </div>

        {/* 병실 메모 목록 — 병동/병실 높이에 맞춰 정렬, 별도 스크롤 없음 */}
        {memoOpen && Object.entries(WARD_STRUCTURE).map(([wardNum, ward]) => {
          const isCollapsed = collapsed[wardNum];
          const filteredRooms = ward.rooms.filter(r => !filterType || r.type === filterType);
          return (
            <div key={wardNum}>
              {/* 병동 헤더 높이 맞춤 (35px) */}
              <div style={{ height:35, background:"#1e293b" }}/>
              {!isCollapsed && filteredRooms.map(room => {
                const cardH = 27 + room.capacity * 61;
                return (
                  <div key={room.id} style={{ height:cardH, borderBottom:"1px solid #e2e8f0", boxSizing:"border-box", display:"flex", flexDirection:"column", background: localMemos[room.id] ? "#fffef0" : "#fff" }}>
                    <div style={{ height:27, flexShrink:0, display:"flex", alignItems:"center", padding:"0 8px", gap:5, background:"#f0f4f8", borderBottom:"1px solid #e8edf2" }}>
                      <span style={{ fontSize:10, fontWeight:800, color:TYPE_COLOR[room.type], background:TYPE_BG[room.type], borderRadius:4, padding:"1px 5px" }}>{room.id}호</span>
                    </div>
                    <textarea
                      value={localMemos[room.id] || ""}
                      onChange={e => setLocalMemos(m => ({ ...m, [room.id]: e.target.value }))}
                      onBlur={e => { const t = e.target.value; if (t !== (roomMemos[room.id] || "")) saveMemo(room.id, t); }}
                      placeholder="메모..."
                      style={{ flex:1, border:"none", resize:"none", fontSize:12, padding:"5px 8px", fontFamily:"inherit", color:"#334155", outline:"none", background:"transparent", boxSizing:"border-box", lineHeight:1.5 }}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
        {memoOpen && <div style={{ height:40 }}/>}
      </div>

      </div>{/* 외부 flex 컨테이너 끝 */}

      {/* ── 1인실 전용 메모 패널 (최하단) ── */}
      {filterType === "1인실" && (
        <div style={{ flexShrink:0, background:"#eef2ff", borderTop:"2px solid #c7d2fe" }}>
          <div
            onClick={() => setSingleMemoOpen(o => !o)}
            style={{ padding:"6px 16px", display:"flex", alignItems:"center", gap:8, cursor:"pointer", userSelect:"none" }}>
            <span style={{ fontSize:13, fontWeight:800, color:"#4338ca" }}>📋 1인실 예약 메모</span>
            <span style={{ fontSize:11, color:"#818cf8" }}>{singleMemoOpen ? "▼" : "▲"}</span>
            {!singleMemoOpen && localSingleMemo && (
              <span style={{ fontSize:11, color:"#6366f1", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:400 }}>
                {localSingleMemo.split("\n")[0]}
              </span>
            )}
          </div>
          {singleMemoOpen && (
            <textarea
              value={localSingleMemo}
              onChange={e => setLocalSingleMemo(e.target.value)}
              onBlur={e => { const t = e.target.value; if (t !== singleRoomMemoText) saveSingleRoomMemo(t); }}
              placeholder="1인실 예약 조정, 대기 현황, 특이사항 등 자유롭게 입력하세요..."
              style={{ display:"block", width:"100%", border:"none", resize:"none", height:130, fontSize:13, padding:"6px 16px 10px", fontFamily:"inherit", color:"#1e1b4b", outline:"none", background:"transparent", boxSizing:"border-box", lineHeight:1.7 }}
            />
          )}
        </div>
      )}

      {/* 팝오버 */}
      {popover && !dragging && (
        <Popover
          popover={popover}
          onClose={() => setPopover(null)}
          onEdit={() => {
            const { bar, slotKey } = popover;
            const currentPat = bar.type !== "current" ? (slots[slotKey]?.current?.name ? slots[slotKey].current : null) : null;
            setEditModal({ slotKey, mode:bar.type==="current"?"current":"reservation", data:{...bar.person}, resIndex:bar.resIndex, currentPatient: currentPat });
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
          currentPatient={editModal.currentPatient || null}
        />
      )}
    </div>
  );
}

const hBtn = {
  background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)",
  color:"#e2e8f0", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12, fontWeight:600,
};

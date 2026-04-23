import { useState, useRef, useCallback } from "react";
import { searchPatientsByName } from "../lib/patientSearch";
import { useWardData } from "../lib/WardDataContext";

// 색상 팔레트 — 카드 배경으로 사용 (bg: 옅은 배경, dot: 팔레트에 표시되는 점 색)
export const CARD_COLORS = [
  { key: "",        label: "없음",   bg: "transparent", dot: "#e2e8f0" },
  { key: "yellow",  label: "노랑",   bg: "#fef3c7",     dot: "#f59e0b" },
  { key: "pink",    label: "분홍",   bg: "#fce7f3",     dot: "#ec4899" },
  { key: "sky",     label: "하늘",   bg: "#e0f2fe",     dot: "#0ea5e9" },
  { key: "purple",  label: "보라",   bg: "#ede9fe",     dot: "#8b5cf6" },
  { key: "green",   label: "연두",   bg: "#dcfce7",     dot: "#22c55e" },
  { key: "orange",  label: "주황",   bg: "#ffedd5",     dot: "#f97316" },
  { key: "red",     label: "빨강",   bg: "#fee2e2",     dot: "#ef4444" },
];

export function getCardColorBg(key) {
  const c = CARD_COLORS.find(x => x.key === (key || ""));
  return c ? c.bg : "transparent";
}

const ADMIT_TIME_OPTIONS = ["아침","점심","저녁"];
const DISCHARGE_TIME_OPTIONS = ["아침 후","점심 후","저녁 후"];
const ALL_TIME_OPTIONS = [...ADMIT_TIME_OPTIONS, ...DISCHARGE_TIME_OPTIONS];

function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1])-1, parseInt(m[2]));
  const d = new Date(str); return isNaN(d) ? null : d;
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

// modal: { slotKey, mode: "current"|"reservation", resIndex, data, currentPatient? }
// onClose: () => void
// onSaved?: () => void (저장/삭제/전환 후 추가 처리가 필요한 경우)
export default function SlotEditModal({ modal, onClose, onSaved }) {
  const { slots, saveSlots, recordDischarge, syncConsultationOnSlotChange, cleanupDailyBoards } = useWardData();
  const [saving, setSaving] = useState(false);

  const initialData = modal?.data || {};
  const [form, setForm] = useState({
    name:          initialData.name          || "",
    admitDate:     initialData.admitDate     || "",
    admitTime:     initialData.admitTime     || "",
    discharge:     initialData.discharge     || "미정",
    dischargeTime: initialData.dischargeTime || "",
    note:          initialData.note          || "",
    scheduleAlert: initialData.scheduleAlert || false,
    patientId:     initialData.patientId     || "",
    preserveSeat:  initialData.preserveSeat  || false,
    color:         initialData.color         || "",
  });
  const [suggestions,     setSuggestions]     = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching,       setSearching]       = useState(false);
  const searchTimer = useRef(null);

  if (!modal) return null;

  const { slotKey, mode, resIndex, currentPatient } = modal;
  const isNew         = resIndex === -1;
  const isReservation = mode === "reservation";
  const slotLabel     = slotKey.replace(/(\d+)-(\d+)/, "$1호 $2번");

  const curDisD   = currentPatient?.discharge ? parseDateStr(currentPatient.discharge) : null;
  const frmAdmitD = form.admitDate ? parseDateStr(form.admitDate) : null;
  const diffDays  = (curDisD && frmAdmitD)
    ? Math.round((dateOnly(frmAdmitD).getTime() - dateOnly(curDisD).getTime()) / 86400000)
    : -1;
  const showPreserveSeat = isReservation && !!currentPatient?.name && currentPatient.name === form.name && diffDays >= 1 && diffDays <= 7;
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

  // ── 저장 ───────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const payload = { ...form, preserveSeat: showPreserveSeat ? form.preserveSeat : false };
      const ns = JSON.parse(JSON.stringify(slots));
      if (!ns[slotKey]) ns[slotKey] = { current: null, reservations: [] };
      const slot = ns[slotKey];
      if (mode === "current") {
        slot.current = { ...(slot.current || {}), ...payload };
      } else {
        if (!slot.reservations) slot.reservations = [];
        if (resIndex >= 0) slot.reservations[resIndex] = { ...(slot.reservations[resIndex] || {}), ...payload };
        else slot.reservations.push({ ...payload });
      }
      await saveSlots(ns, [slotKey]);

      const oldData = initialData || {};
      if (oldData.admitDate !== payload.admitDate || oldData.discharge !== payload.discharge) {
        await cleanupDailyBoards(payload.name, oldData, payload);
      }
      const cId = initialData?.consultationId || payload.consultationId;
      if (cId) {
        await syncConsultationOnSlotChange(slotKey, payload.name, cId, slotKey, {
          admitDate: payload.admitDate || undefined,
          dischargeDate: payload.discharge || undefined,
        });
      }
      if (onSaved) onSaved();
      onClose();
    } finally { setSaving(false); }
  }, [form, saving, slots, slotKey, mode, resIndex, initialData, saveSlots, syncConsultationOnSlotChange, cleanupDailyBoards, showPreserveSeat, onClose, onSaved]);

  // ── 삭제 ───────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (saving) return;
    const data = initialData;
    if (!window.confirm(`${data.name}님의 ${mode === "current" ? "입원 정보" : "예약"}를 삭제하시겠습니까?`)) return;
    setSaving(true);
    try {
      const ns = JSON.parse(JSON.stringify(slots));
      if (mode === "current") {
        const cur = slots[slotKey]?.current;
        if (cur?.name) {
          await syncConsultationOnSlotChange(slotKey, cur.name, cur.consultationId, null, undefined, 'discharge');
          const d = cur.discharge;
          const disDate = d?.match(/^(\d{4})-(\d{2})-(\d{2})/) ? d.split("T")[0]
            : d?.match(/(\d{1,2})\/(\d{1,2})/) ? `${new Date().getFullYear()}-${d.match(/(\d{1,2})\/(\d{1,2})/)[1].padStart(2,"0")}-${d.match(/(\d{1,2})\/(\d{1,2})/)[2].padStart(2,"0")}` : null;
          await recordDischarge(cur.name, slotKey, disDate);
        }
        if (ns[slotKey]) ns[slotKey].current = null;
        await saveSlots(ns, [slotKey]);
      } else {
        await syncConsultationOnSlotChange(slotKey, data.name, data.consultationId, null, undefined, 'cancel');
        if (ns[slotKey]) ns[slotKey].reservations = (ns[slotKey].reservations || []).filter((_,i) => i !== resIndex);
        await saveSlots(ns, [slotKey]);
      }
      if (data) await cleanupDailyBoards(data.name, data, {});
      if (onSaved) onSaved();
      onClose();
    } finally { setSaving(false); }
  }, [saving, slots, slotKey, mode, resIndex, initialData, saveSlots, recordDischarge, syncConsultationOnSlotChange, cleanupDailyBoards, onClose, onSaved]);

  // ── 입원 전환 ──────────────────────────────────────────────────────────
  const handleConvert = useCallback(async () => {
    if (saving || mode !== "reservation") return;
    const data = initialData;
    if (!window.confirm(`${data.name}님을 현재 입원 환자로 전환하시겠습니까?`)) return;
    setSaving(true);
    try {
      const ns = JSON.parse(JSON.stringify(slots));
      if (!ns[slotKey]) ns[slotKey] = { current: null, reservations: [] };
      ns[slotKey].current = { ...data };
      ns[slotKey].reservations = (ns[slotKey].reservations || []).filter((_,i) => i !== resIndex);
      await saveSlots(ns, [slotKey]);
      if (onSaved) onSaved();
      onClose();
    } finally { setSaving(false); }
  }, [saving, slots, slotKey, mode, resIndex, initialData, saveSlots, onClose, onSaved]);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:16, padding:"24px 28px", width:"min(92vw,400px)", maxHeight:"92vh", overflowY:"auto", boxShadow:"0 24px 64px rgba(0,0,0,0.3)" }}>
        <div style={{ fontWeight:800, fontSize:16, color:"#0f2744", marginBottom:4 }}>
          {isNew ? "📅 예약 입원 추가" : isReservation ? "📅 예약 수정" : "🏥 입원 정보 수정"}
        </div>
        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:20 }}>{slotLabel} 병상</div>

        {/* 이름 + 자동완성 */}
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

        {/* 입원/퇴원일 + 시간 */}
        {[
          ...(isReservation ? [{ label:"예약 입원일 (예: 4/15)", key:"admitDate", timeKey:"admitTime", ph:"4/15" }] : []),
          { label:"퇴원 예정일 (예: 4/25 또는 미정)", key:"discharge", timeKey:"dischargeTime", ph:"4/25 또는 미정" },
        ].map(f => (
          <div key={f.key} style={{ marginBottom:14 }}>
            <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>{f.label}</label>
            <div style={{ display:"flex", gap:6 }}>
              <input style={{...inpStyle, flex:1}} value={form[f.key]} onChange={e=>setForm(p=>({...p,[f.key]:e.target.value}))} placeholder={f.ph} />
              {(() => { const opts = f.timeKey === "admitTime" ? ADMIT_TIME_OPTIONS : DISCHARGE_TIME_OPTIONS; return (!form[f.timeKey] || ALL_TIME_OPTIONS.includes(form[f.timeKey])) ? (
                <select value={form[f.timeKey]||""} onChange={e=>{ if(e.target.value==="__custom__"){ const v=prompt("시간 입력 (예: 14시)"); setForm(p=>({...p,[f.timeKey]:v?v.trim():""})); } else setForm(p=>({...p,[f.timeKey]:e.target.value})); }}
                  style={{...inpStyle, width:110, color:form[f.timeKey]?"#166534":"#94a3b8", flexShrink:0}}>
                  <option value="">시간</option>
                  {opts.map(t=><option key={t} value={t}>{t}</option>)}
                  <option value="__custom__">직접입력</option>
                </select>
              ) : (
                <input value={form[f.timeKey]} onChange={e=>setForm(p=>({...p,[f.timeKey]:e.target.value}))}
                  style={{...inpStyle, width:110, color:"#166534", flexShrink:0}} />
              ); })()}
            </div>
          </div>
        ))}

        {/* 메모 */}
        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:5 }}>메모</label>
          <textarea style={{...inpStyle, resize:"vertical", minHeight:72, lineHeight:1.6}} value={form.note} onChange={e=>setForm(p=>({...p,note:e.target.value}))} placeholder="치료 내용, 특이사항 등" />
        </div>

        {/* 카드 색상 팔레트 */}
        <div style={{ marginBottom:14 }}>
          <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:6 }}>카드 강조 색상 (병상 시트에서 표시)</label>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {CARD_COLORS.map(c => {
              const active = (form.color || "") === c.key;
              return (
                <button key={c.key || "none"} type="button"
                  onClick={() => setForm(p => ({ ...p, color: c.key }))}
                  title={c.label}
                  style={{
                    width: 34, height: 28, borderRadius: 7,
                    background: c.key ? c.bg : "#fff",
                    border: active ? `2.5px solid ${c.key ? c.dot : "#0f2744"}` : "1.5px solid #e2e8f0",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, color: "#475569",
                  }}>
                  {c.key ? "" : "×"}
                </button>
              );
            })}
          </div>
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
          <button onClick={handleSave} disabled={saving || !form.name.trim()}
            style={{ flex:1, background:form.name.trim()?"#0f2744":"#e2e8f0", color:form.name.trim()?"#fff":"#94a3b8", border:"none", borderRadius:9, padding:"11px", fontSize:14, fontWeight:700, cursor:form.name.trim()?"pointer":"default" }}>
            {saving ? "저장 중..." : "저장"}
          </button>
          {!isNew && isReservation && (
            <button onClick={handleConvert} disabled={saving}
              style={{ flex:1, background:"#059669", color:"#fff", border:"none", borderRadius:9, padding:"11px", fontSize:14, fontWeight:700, cursor:"pointer" }}>
              🛏 입원 전환
            </button>
          )}
          {!isNew && (
            <button onClick={handleDelete} disabled={saving}
              style={{ background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, fontWeight:700, cursor:"pointer" }}>삭제</button>
          )}
          <button onClick={onClose}
            style={{ background:"#f1f5f9", color:"#64748b", border:"none", borderRadius:9, padding:"11px 14px", fontSize:14, cursor:"pointer" }}>취소</button>
        </div>
      </div>
    </div>
  );
}

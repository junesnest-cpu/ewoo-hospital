import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const DAYS  = ["월","화","수","목","금","토","일"];
const TIMES = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00"];
const LUNCH = "12:00";

const PHYS_TREATS = [
  { id:"pain",   name:"페인스크렘블러", color:"#dc2626", bg:"#fef2f2" },
  { id:"manip2", name:"도수치료2",      color:"#7c3aed", bg:"#faf5ff" },
  { id:"manip1", name:"도수치료1",      color:"#059669", bg:"#f0fdf4" },
];

function getWeekStart(d) {
  const date = new Date(d);
  const dow  = date.getDay();
  date.setDate(date.getDate() + (dow === 0 ? -6 : 1 - dow));
  date.setHours(0, 0, 0, 0);
  return date;
}
function weekKey(ws)  { return ws.toISOString().slice(0, 10); }
function addDays(d,n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtDate(d)   { return `${d.getMonth()+1}/${d.getDate()}`; }

export default function PhysicalPage() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [mobileTh, setMobileTh] = useState(0);
  const today  = new Date();

  const [weekStart,   setWeekStart]   = useState(() => getWeekStart(today));
  const [schedule,    setSchedule]    = useState({});
  const [slots,       setSlots]       = useState({});
  const [treatPlans,  setTreatPlans]  = useState({});
  const [therapists,  setTherapists]  = useState(["치료사1", "치료사2"]);

  // 모달
  const [modal,       setModal]       = useState(null);
  const [selSlot,     setSelSlot]     = useState("");
  const [selTreat,    setSelTreat]    = useState("");
  const [showExtra,   setShowExtra]   = useState(false);
  const [extraTime,   setExtraTime]   = useState("");
  // 예정 환자 직접 입력
  const [pendingName, setPendingName] = useState("");

  // 인쇄
  const [printMode,   setPrintMode]   = useState(false);
  const [printSel,    setPrintSel]    = useState({});
  const scheduleRef   = React.useRef({});
  const treatPlansRef = React.useRef({});

  const wk        = weekKey(weekStart);
  const weekStartRef = React.useRef(weekStart);
  React.useEffect(() => { weekStartRef.current = weekStart; }, [weekStart]);
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  useEffect(() => {
    const u1 = onValue(ref(db, "slots"),            s => setSlots(s.val() || {}));
    const u2 = onValue(ref(db, "treatmentPlans"), s => {
      const v = s.val() || {};
      setTreatPlans(v);
      treatPlansRef.current = v;
    });
    const u3 = onValue(ref(db, "physicalSchedule"), s => {
      const v = s.val() || {};
      setSchedule(v);
      scheduleRef.current = v;
    });
    const u4 = onValue(ref(db, "settings"), s => {
      const v = s.val() || {};
      const th1 = v.therapist1 || "치료사1";
      const th2 = v.therapist2 || "치료사2";
      setTherapists([th1, th2]);
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const getCell = useCallback((th, dayIdx, time) =>
    schedule[wk]?.[th]?.[dayIdx]?.[time] || null,
  [schedule, wk]);

  const saveCellAndSync = useCallback(async (th, dayIdx, time, data) => {
    const currentWk = weekKey(weekStartRef.current);

    // 1. 삭제 전에 기존 셀 데이터 먼저 저장 (삭제 후엔 찾을 수 없음)
    const oldCell = scheduleRef.current[currentWk]?.[th]?.[dayIdx]?.[time] || null;

    // 2. physicalSchedule 업데이트
    const nxt = JSON.parse(JSON.stringify(scheduleRef.current));
    if (!nxt[currentWk])             nxt[currentWk] = {};
    if (!nxt[currentWk][th])         nxt[currentWk][th] = {};
    if (!nxt[currentWk][th][dayIdx]) nxt[currentWk][th][dayIdx] = {};
    if (data === null) delete nxt[currentWk][th][dayIdx][time];
    else               nxt[currentWk][th][dayIdx][time] = data;
    scheduleRef.current = nxt;
    setSchedule(nxt);
    await set(ref(db, `physicalSchedule/${currentWk}`), nxt[currentWk] || {});

    // 3. treatmentPlans 역방향 연동
    if (data?.slotKey && data?.treatmentId) {
      // 등록: treatmentPlans에 추가
      // 기존 셀에 다른 환자가 있었다면 그 환자 것은 먼저 제거
      if (oldCell?.slotKey && oldCell?.treatmentId &&
          (oldCell.slotKey !== data.slotKey || oldCell.treatmentId !== data.treatmentId)) {
        await syncToTreatmentPlan(oldCell.slotKey, dayIdx, oldCell.treatmentId, "remove");
      }
      await syncToTreatmentPlan(data.slotKey, dayIdx, data.treatmentId, "add");
    } else if (data === null && oldCell?.slotKey && oldCell?.treatmentId) {
      // 삭제: treatmentPlans에서 제거
      await syncToTreatmentPlan(oldCell.slotKey, dayIdx, oldCell.treatmentId, "remove");
    }
  }, []);

  const syncToTreatmentPlan = useCallback(async (slotKey, dayIdx, treatmentId, action) => {
    const date  = addDays(weekStartRef.current, dayIdx);
    const mKey  = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey  = String(date.getDate());
    const tp    = JSON.parse(JSON.stringify(treatPlansRef.current));
    if (!tp[slotKey])         tp[slotKey] = {};
    if (!tp[slotKey][mKey])   tp[slotKey][mKey] = {};
    const existing = tp[slotKey][mKey][dKey] || [];
    if (action === "add") {
      if (!existing.some(e => e.id === treatmentId)) {
        tp[slotKey][mKey][dKey] = [...existing, { id: treatmentId, qty: "1" }];
      }
    } else {
      tp[slotKey][mKey][dKey] = existing.filter(e => e.id !== treatmentId);
    }
    treatPlansRef.current = tp;
    setTreatPlans(tp);
    await set(ref(db, `treatmentPlans/${slotKey}/${mKey}/${dKey}`), tp[slotKey][mKey][dKey]);
  }, []);

  // saveCell은 alias로 유지
  const saveCell = saveCellAndSync;

  // 대기 환자: 해당 주 치료계획에 물리치료 있고 미배정
  const pendingPatients = (() => {
    const res = [];
    weekDates.forEach((date, dayIdx) => {
      const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
      const dKey = String(date.getDate());
      Object.entries(treatPlans).forEach(([slotKey, months]) => {
        const items = months?.[mKey]?.[dKey] || [];
        items.filter(e => PHYS_TREATS.some(t => t.id === e.id)).forEach(e => {
          const name = slots[slotKey]?.current?.name;
          if (!name) return;
          const assigned = therapists.some(th =>
            Object.values(schedule[wk]?.[th]?.[dayIdx] || {}).some(c => c.slotKey === slotKey && c.treatmentId === e.id)
          );
          if (!assigned) res.push({ slotKey, name, dayIdx, treatmentId: e.id });
        });
      });
    });
    return res;
  })();

  // 모달 열기
  const openModal = (th, dayIdx, time) => {
    const ex = getCell(th, dayIdx, time);
    setModal({ th, dayIdx, time });
    setSelSlot(ex?.slotKey || "");
    setSelTreat(ex?.treatmentId || "");
    setShowExtra(false);
    setExtraTime("");
    setPendingName("");
  };

  // 해당 요일 선택 가능 환자 목록
  const modalPatients = modal ? (() => {
    const { dayIdx } = modal;
    const date = weekDates[dayIdx];
    const mKey = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
    const dKey = String(date.getDate());
    const result = [];
    // 치료계획 연동 환자 (치료항목 포함)
    Object.entries(treatPlans).forEach(([slotKey, months]) => {
      const items = months?.[mKey]?.[dKey] || [];
      const ph = items.filter(e => PHYS_TREATS.some(t => t.id === e.id));
      const name = slots[slotKey]?.current?.name;
      if (!name) return;
      result.push({ slotKey, name, treatmentIds: ph.map(e => e.id), linked: true });
    });
    // 현재 입원 중인 환자 (치료계획 없어도)
    Object.entries(slots).forEach(([slotKey, sd]) => {
      if (!sd?.current?.name) return;
      if (result.find(r => r.slotKey === slotKey)) return;
      result.push({ slotKey, name: sd.current.name, treatmentIds: [], linked: false });
    });
    return result;
  })() : [];

  const doRegister = async () => {
    if (!modal || !selTreat) return;
    const { th, dayIdx, time: base } = modal;
    const time = showExtra && extraTime ? extraTime : base;
    // 예정 환자 직접 입력 처리
    let slotKey = selSlot;
    let name    = "";
    let roomId  = "";
    let bedNum  = "";
    if (selSlot === "__pending__") {
      if (!pendingName.trim()) return;
      slotKey = `pending_${Date.now()}`;
      name    = pendingName.trim();
    } else {
      name   = slots[selSlot]?.current?.name || "";
      roomId = selSlot.split("-")[0] || "";
      bedNum = selSlot.split("-")[1] || "";
    }
    if (!slotKey) return;
    await saveCell(th, dayIdx, time, { slotKey, patientName: name, treatmentId: selTreat, isPending: selSlot === "__pending__", roomId, bedNum });
    setModal(null);
  };

  const doRemove = async (th, dayIdx, time) => {
    if (!confirm("삭제하시겠습니까?")) return;
    // 삭제 전 기존 cell 정보로 treatmentPlan에서도 제거
    const currentWk = weekKey(weekStartRef.current);
    const oldCell = scheduleRef.current[currentWk]?.[th]?.[dayIdx]?.[time];
    if (oldCell?.slotKey && oldCell?.treatmentId) {
      await syncToTreatmentPlan(oldCell.slotKey, dayIdx, oldCell.treatmentId, "remove");
    }
    await saveCell(th, dayIdx, time, null);
  };

  // 인쇄용 환자 목록
  const printPatients = (() => {
    const map = {};
    therapists.forEach(th => {
      Object.entries(schedule[wk]?.[th] || {}).forEach(([di, times]) => {
        Object.entries(times || {}).forEach(([time, data]) => {
          if (!data?.slotKey) return;
          const key = data.slotKey;
          if (!map[key]) map[key] = { name: data.patientName, slotKey: key, entries: [] };
          map[key].entries.push({ dayIdx: parseInt(di), time, treatmentId: data.treatmentId, therapist: th });
        });
      });
    });
    return Object.values(map).sort((a, b) => a.name?.localeCompare(b.name, "ko"));
  })();

  const isThisWeek = weekKey(getWeekStart(today)) === wk;

  return (
    <div style={S.page}>
      {/* 헤더 */}
      <header style={S.header}>
        <button style={S.btnBack} onClick={() => router.push("/")}>← 현황판</button>
        <div style={S.hcenter}>
          <div style={S.htitle}>🏃 물리치료실 주간 계획표</div>
          <div style={S.hsub}>
            {fmtDate(weekDates[0])} ~ {fmtDate(weekDates[6])}
            &nbsp;|&nbsp; {therapists[0]} · {therapists[1]}
          </div>
        </div>
        <div style={S.hright}>
          <button style={S.btnW} onClick={() => setWeekStart(w => addDays(w, -7))}>‹ 전주</button>
          {!isThisWeek && (
            <button style={{ ...S.btnW, background: "#065f46", color: "#6ee7b7" }}
              onClick={() => setWeekStart(getWeekStart(today))}>이번 주</button>
          )}
          <button style={S.btnW} onClick={() => setWeekStart(w => addDays(w, 7))}>다음 주 ›</button>
          <button style={S.btnW} onClick={() => router.push("/settings")}>⚙️ 설정</button>
          <button style={{ ...S.btnW, background: printMode ? "#7c3aed" : "rgba(255,255,255,0.15)" }}
            onClick={() => { setPrintMode(p => !p); setPrintSel({}); }}>
            {printMode ? "✕ 취소" : "🖨 인쇄"}
          </button>
        </div>
      </header>

      {/* 인쇄 선택 바 */}
      {printMode && (
        <div style={S.printBar}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#7c3aed" }}>인쇄할 환자 선택</span>
          <div style={{ display: "flex", gap: 8, flex: 1, flexWrap: "wrap" }}>
            {printPatients.map(p => (
              <label key={p.slotKey} style={S.pCheck}>
                <input type="checkbox" checked={!!printSel[p.slotKey]}
                  onChange={e => setPrintSel(prev => ({ ...prev, [p.slotKey]: e.target.checked }))} />
                <span style={{ marginLeft: 5 }}>{p.name}님</span>
              </label>
            ))}
          </div>
          <button style={S.btnOk} onClick={() => window.print()}>선택 인쇄</button>
        </div>
      )}

      {/* 본문 */}
      <div style={S.body}>
        {/* 사이드바: 대기 환자 */}
        <div style={S.sidebar}>
          <div style={S.sbTitle}>📋 배정 대기</div>
          {pendingPatients.length === 0
            ? <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 6 }}>없음</div>
            : pendingPatients.map((p, i) => {
                const tr = PHYS_TREATS.find(t => t.id === p.treatmentId);
                return (
                  <div key={i} style={S.pendCard}>
                    <div style={{ fontWeight: 700, fontSize: 12 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>{DAYS[p.dayIdx]}</div>
                    <span style={{ ...S.trTag, background: tr?.bg, color: tr?.color, borderColor: tr?.color }}>{tr?.name}</span>
                  </div>
                );
              })
          }
        </div>

        {/* 모바일 치료사 탭 선택 */}
        {isMobile && (
          <div style={{ display:"flex", gap:0, margin:"8px 0", borderRadius:8, overflow:"hidden", border:"1px solid #e2e8f0" }}>
            {therapists.map((th, i) => (
              <button key={i} style={{ flex:1, padding:"9px 0", fontSize:13, fontWeight:700, border:"none", cursor:"pointer",
                background: mobileTh === i ? "#0f4c35" : "#f8fafc", color: mobileTh === i ? "#fff" : "#475569" }}
                onClick={() => setMobileTh(i)}>{th}</button>
            ))}
          </div>
        )}
        {/* 시간표: 두 치료사 나란히 (데스크탑) / 한명씩 (모바일) */}
        <div style={S.tableArea}>
          <table style={{ ...S.tbl, minWidth: isMobile ? 380 : 900 }}>
            <colgroup>
              <col style={{ width: 48 }} />
              {(!isMobile || mobileTh === 0) && weekDates.map((_, i) => <col key={`a${i}`} />)}
              {!isMobile && <col style={{ width: 6 }} />}
              {(!isMobile || mobileTh === 1) && weekDates.map((_, i) => <col key={`b${i}`} />)}
            </colgroup>
            <thead>
              <tr>
                <th style={S.thTime} rowSpan={2}>시간</th>
                {(!isMobile || mobileTh === 0) && <th colSpan={7} style={{ ...S.thTh, background: "#0f4c35" }}>{therapists[0]}</th>}
                {!isMobile && <th rowSpan={2} style={S.thDiv} />}
                {(!isMobile || mobileTh === 1) && <th colSpan={7} style={{ ...S.thTh, background: "#1e3a5f" }}>{therapists[1]}</th>}
              </tr>
              <tr>
                {[0, 1].map(ti =>
                  weekDates.map((date, di) => (
                    <th key={`${ti}-${di}`} style={{ ...S.thDay, color: di >= 5 ? "#2563eb" : "#374151", background: di >= 5 ? "#eff6ff" : "#f8fafc" }}>
                      <div style={{ fontSize: 11 }}>{DAYS[di]}</div>
                      <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 400 }}>{fmtDate(date)}</div>
                    </th>
                  ))
                )}
              </tr>
            </thead>
            <tbody>
              {TIMES.map(time => {
                const isLunch = time === LUNCH;
                return (
                  <tr key={time} style={{ height: isLunch ? 26 : 50 }}>
                    <td style={{ ...S.tdTime, color: isLunch ? "#94a3b8" : "#0f2744", background: isLunch ? "#f8fafc" : "#fff" }}>
                      {time}
                      {isLunch && <span style={{ fontSize: 8, display: "block", color: "#94a3b8" }}>점심</span>}
                    </td>
                    {therapists.map((th, ti) => {
                      if (isMobile && ti !== mobileTh) return null;
                      return (
                      <React.Fragment key={ti}>
                        {ti === 1 && !isMobile && <td key="div" style={S.tdDiv} />}
                        {weekDates.map((_, dayIdx) => {
                          if (isLunch) return <td key={`${ti}-${dayIdx}`} style={S.tdLunch}>—</td>;
                          const cell = getCell(th, dayIdx, time);
                          const tr   = cell ? PHYS_TREATS.find(t => t.id === cell.treatmentId) : null;
                          return (
                            <td key={`${ti}-${dayIdx}`}
                              style={{ ...S.tdCell, background: cell ? tr?.bg : "#fff" }}
                              onClick={() => openModal(th, dayIdx, time)}>
                              {cell ? (
                                <div style={S.cellIn}>
                                  <div style={{ fontWeight: 700, fontSize: 11, color: tr?.color, lineHeight: 1.2 }}>
                                    {cell.patientName}
                                    {cell.isPending && <span style={{ fontSize: 9, color: "#f59e0b", marginLeft: 3 }}>예정</span>}
                                  </div>
                                  <div style={{ fontSize: 9, color: tr?.color }}>{tr?.name}</div>
                                  {cell.roomId && <div style={{ fontSize: 9, color: "#64748b" }}>{cell.roomId}호 {cell.bedNum}번</div>}
                                  <button style={S.xBtn} onClick={e => { e.stopPropagation(); doRemove(th, dayIdx, time); }}>✕</button>
                                </div>
                              ) : (
                                <div style={S.plusCell}>+</div>
                              )}
                            </td>
                          );
                        })}
                      </React.Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 등록 모달 */}
      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.mHead, background: "#059669" }}>
              <span style={S.mTitle}>
                {modal.th} · {DAYS[modal.dayIdx]} {fmtDate(weekDates[modal.dayIdx])} {modal.time}
              </span>
              <button style={S.mClose} onClick={() => setModal(null)}>✕</button>
            </div>
            <div style={{ padding: 16 }}>
              <label style={S.lbl}>환자 선택</label>
              <select style={S.sel} value={selSlot} onChange={e => { setSelSlot(e.target.value); setSelTreat(""); setPendingName(""); }}>
                <option value="">— 선택 —</option>
                <option value="__pending__">✏️ 예정 환자 직접 입력</option>
                <optgroup label="── 현재 입원 중 ──">
                  {modalPatients.filter(p => p.linked).map(p => (
                    <option key={p.slotKey} value={p.slotKey}>★ {p.name} ({p.slotKey})</option>
                  ))}
                </optgroup>
                <optgroup label="── 전체 입원 환자 ──">
                  {modalPatients.filter(p => !p.linked).map(p => (
                    <option key={p.slotKey} value={p.slotKey}>{p.name} ({p.slotKey})</option>
                  ))}
                </optgroup>
              </select>

              {/* 예정 환자 이름 직접 입력 */}
              {selSlot === "__pending__" && (
                <input style={{ ...S.inp, marginTop: 8 }} value={pendingName} onChange={e => setPendingName(e.target.value)}
                  placeholder="환자 이름 입력" />
              )}

              {/* 치료 종류 */}
              <label style={{ ...S.lbl, marginTop: 12 }}>치료 종류</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {PHYS_TREATS.map(t => (
                  <button key={t.id}
                    style={{ border: `1.5px solid ${t.color}`, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700,
                      background: selTreat === t.id ? t.color : t.bg, color: selTreat === t.id ? "#fff" : t.color }}
                    onClick={() => setSelTreat(t.id)}>{t.name}
                  </button>
                ))}
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={showExtra} onChange={e => setShowExtra(e.target.checked)} />
                다른 시간으로 등록
              </label>
              {showExtra && (
                <input style={{ ...S.inp, marginTop: 6 }} type="time" value={extraTime}
                  onChange={e => setExtraTime(e.target.value)} step="1800" />
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button style={{ ...S.btnOk, flex: 1 }} onClick={doRegister}
                  disabled={(!selSlot || (selSlot === "__pending__" && !pendingName.trim())) || !selTreat}>
                  등록
                </button>
                {getCell(modal.th, modal.dayIdx, modal.time) && (
                  <button style={S.btnDel}
                    onClick={() => { doRemove(modal.th, modal.dayIdx, modal.time); setModal(null); }}>삭제</button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 인쇄 전용 */}
      <PrintCards patients={printPatients} selected={printSel} weekDates={weekDates} />
    </div>
  );
}

function PrintCards({ patients, selected, weekDates }) {
  const list = patients.filter(p => selected[p.slotKey]);
  if (!list.length) return null;
  const tName = id => ({ pain: "페인스크렘블러", manip2: "도수치료2", manip1: "도수치료1" }[id] || id);
  return (
    <div className="print-only" style={{ display: "none" }}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 7mm; }
          body * { visibility: hidden !important; }
          .print-only, .print-only * { visibility: visible !important; }
          .print-only { position:fixed; top:0; left:0; width:100%; background:#fff; z-index:9999; display:block !important; }
          .pcard { break-inside:avoid; border:1.5px solid #aaa; border-radius:6px; padding:8px 10px; margin-bottom:10mm; }
        }
      `}</style>
      <div style={{ fontFamily: "'Noto Sans KR',sans-serif", columns: 2, columnGap: "6mm", fontSize: 11 }}>
        {list.map(p => {
          const sorted = [...p.entries].sort((a, b) => a.dayIdx - b.dayIdx || a.time.localeCompare(b.time));
          return (
            <div key={p.slotKey} className="pcard" style={{ marginBottom: "10mm" }}>
              <div style={{ fontWeight: 800, fontSize: 13, borderBottom: "1px solid #ccc", paddingBottom: 4, marginBottom: 5 }}>
                {p.name}님 <span style={{ fontSize: 9, color: "#888", fontWeight: 400 }}>{p.slotKey}</span>
              </div>
              <div style={{ fontSize: 9, color: "#666", marginBottom: 4 }}>
                물리치료 안내 &nbsp;{`${weekDates[0].getMonth()+1}/${weekDates[0].getDate()}`} ~ {`${weekDates[6].getMonth()+1}/${weekDates[6].getDate()}`}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f0f0f0" }}>
                    {["날짜","요일","치료","시간"].map(h => (
                      <th key={h} style={{ border: "1px solid #ddd", padding: "2px 4px", textAlign: "center" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e, i) => (
                    <tr key={i}>
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px", textAlign: "center" }}>
                        {`${weekDates[e.dayIdx].getMonth()+1}/${weekDates[e.dayIdx].getDate()}`}
                      </td>
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px", textAlign: "center" }}>{"월화수목금토일"[e.dayIdx]}</td>
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px" }}>{tName(e.treatmentId)}</td>
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px", textAlign: "center", fontWeight: 700 }}>{e.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 6, paddingTop: 5, borderTop: "1px dashed #ccc", fontSize: 9, color: "#555", textAlign: "center" }}>
                치료 시간에 맞춰 지하 1층 통합치료실로 방문해 주세요.
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const S = {
  page:    { fontFamily: "'Noto Sans KR','Pretendard',sans-serif", background: "#f0f4f8", minHeight: "100vh", display: "flex", flexDirection: "column" },
  header:  { background: "#059669", color: "#fff", display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)", flexShrink: 0, flexWrap: "wrap" },
  btnBack: { background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 },
  hcenter: { flex: 1, textAlign: "center" },
  htitle:  { fontSize: 16, fontWeight: 800 },
  hsub:    { fontSize: 10, color: "#a7f3d0", marginTop: 1 },
  hright:  { display: "flex", gap: 6, flexWrap: "wrap" },
  btnW:    { background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600 },
  printBar:{ background: "#faf5ff", borderBottom: "1px solid #e9d5ff", padding: "8px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", flexShrink: 0 },
  pCheck:  { display: "flex", alignItems: "center", fontSize: 12, cursor: "pointer", background: "#fff", border: "1px solid #e9d5ff", borderRadius: 6, padding: "2px 8px" },
  body:    { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: { width: 155, flexShrink: 0, background: "#fff", borderRight: "1px solid #e2e8f0", padding: "10px", overflowY: "auto" },
  sbTitle: { fontSize: 12, fontWeight: 800, color: "#059669", marginBottom: 8 },
  pendCard:{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 7, padding: "7px", marginBottom: 5 },
  trTag:   { fontSize: 9, fontWeight: 700, borderRadius: 3, padding: "1px 5px", border: "1px solid", display: "inline-block", marginTop: 3 },
  tableArea:{ flex: 1, overflowX: "auto", overflowY: "auto" },
  tbl:     { width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 900 },
  thTime:  { background: "#0f2744", color: "#fff", fontSize: 10, fontWeight: 700, textAlign: "center", border: "1px solid #1e3a5f", padding: "4px 2px", verticalAlign: "middle" },
  thTh:    { color: "#fff", fontSize: 12, fontWeight: 800, textAlign: "center", padding: "6px 4px", border: "1px solid rgba(255,255,255,0.2)" },
  thDiv:   { background: "#cbd5e1", border: "none", width: 6 },
  thDay:   { fontSize: 10, fontWeight: 700, textAlign: "center", border: "1px solid #e2e8f0", padding: "3px 2px" },
  tdTime:  { fontSize: 10, fontWeight: 700, textAlign: "center", border: "1px solid #e2e8f0", padding: "2px", whiteSpace: "nowrap", verticalAlign: "middle" },
  tdLunch: { background: "#f8fafc", border: "1px solid #e2e8f0", textAlign: "center", color: "#cbd5e1", fontSize: 11 },
  tdDiv:   { background: "#e2e8f0", border: "none", width: 6 },
  tdCell:  { border: "1px solid #e2e8f0", cursor: "pointer", verticalAlign: "top", transition: "background 0.12s" },
  cellIn:  { padding: "3px 5px", position: "relative", minHeight: 40 },
  plusCell:{ color: "#e2e8f0", fontSize: 18, textAlign: "center", padding: "6px 0", userSelect: "none" },
  xBtn:    { position: "absolute", top: 1, right: 1, background: "#fee2e2", border: "none", color: "#dc2626", borderRadius: 3, width: 14, height: 14, cursor: "pointer", fontSize: 8, lineHeight: "14px", textAlign: "center" },
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modal:   { background: "#fff", borderRadius: 12, width: "100%", maxWidth: 440, boxShadow: "0 8px 40px rgba(0,0,0,0.2)", overflow: "hidden" },
  mHead:   { color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px" },
  mTitle:  { fontSize: 13, fontWeight: 800 },
  mClose:  { background: "none", border: "none", color: "rgba(255,255,255,0.7)", fontSize: 18, cursor: "pointer" },
  lbl:     { display: "block", fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 4 },
  inp:     { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  sel:     { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 7, padding: "7px 10px", fontSize: 13, outline: "none", fontFamily: "inherit" },
  btnOk:   { background: "#059669", color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 13, fontWeight: 700 },
  btnDel:  { background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 700 },
};

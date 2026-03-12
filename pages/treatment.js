import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

const TREATMENT_GROUPS = [
  {
    group: "고주파 온열치료", color: "#dc2626", bg: "#fef2f2",
    items: [{ id: "hyperthermia", name: "고주파 온열치료", price: 300000 }],
  },
  {
    group: "싸이모신알파1", color: "#7c3aed", bg: "#faf5ff",
    items: [
      { id: "zadaxin",  name: "자닥신",   price: 350000 },
      { id: "imualpha", name: "이뮤알파", price: 300000 },
      { id: "scion",    name: "싸이원주", price: 250000 },
    ],
  },
  {
    group: "수액류", color: "#0ea5e9", bg: "#f0f9ff",
    items: [
      { id: "glutathione", name: "글루타치온",          price: 60000 },
      { id: "dramin",      name: "닥터라민+지씨멀티주", price: 100000 },
      { id: "thioctic",    name: "티옥트산",            price: 40000 },
      { id: "gt",          name: "G+T",                 price: 100000 },
      { id: "myers1",      name: "마이어스1",           price: 70000 },
      { id: "myers2",      name: "마이어스2",           price: 120000 },
      { id: "selenium_iv", name: "셀레늄",              price: 70000 },
      { id: "vitd",        name: "비타민D",             price: 50000 },
      { id: "vitc",        name: "고용량 비타민C",      price: null, custom: "vitc" },
    ],
  },
  {
    group: "물리치료", color: "#059669", bg: "#f0fdf4",
    items: [
      { id: "pain",   name: "페인스크렘블러", price: 200000 },
      { id: "manip2", name: "도수치료2",      price: 200000 },
      { id: "manip1", name: "도수치료1",      price: 120000 },
    ],
  },
  {
    group: "경구제", color: "#d97706", bg: "#fffbeb",
    items: [
      { id: "meshima",    name: "메시마F",      price: 18000, custom: "qty" },
      { id: "selenase_l", name: "셀레나제액상", price: 5000,  custom: "qty" },
      { id: "selenase_t", name: "셀레나제정",   price: 5000,  custom: "qty" },
      { id: "selenase_f", name: "셀레나제필름", price: 5000,  custom: "qty" },
    ],
  },
];

const ALL_ITEMS = TREATMENT_GROUPS.flatMap(g => g.items);

function calcPrice(item, qty) {
  if (!item) return 0;
  if (item.custom === "vitc") {
    const g = parseInt(qty) || 0;
    if (g <= 0) return 0;
    const units = Math.ceil(g / 10);
    return units === 1 ? 30000 : 30000 + (units - 1) * 10000;
  }
  if (item.custom === "qty") return item.price * (parseInt(qty) || 0);
  return item.price;
}

function getItemGroup(itemId) {
  return TREATMENT_GROUPS.find(g => g.items.some(i => i.id === itemId));
}

const DAY_KO = ["일","월","화","수","목","금","토"];

function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getFirstDow(y, m)    { return new Date(y, m, 1).getDay(); }

function parseDateStr(str) {
  if (!str || str === "미정") return null;
  const m = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (m) return new Date(new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]));
  const d = new Date(str);
  return isNaN(d) ? null : d;
}
function dateOnly(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }

function getWeekNumber(admitDateStr, targetDate) {
  const admit = parseDateStr(admitDateStr);
  if (!admit) return null;
  const diff = Math.floor((dateOnly(targetDate) - dateOnly(admit)) / 86400000);
  if (diff < 0) return null;
  return Math.floor(diff / 7) + 1;
}

export default function TreatmentPage() {
  const router = useRouter();
  const { slotKey, name, discharge, admitDate } = router.query;

  const roomId = slotKey ? slotKey.split("-")[0] : "";
  const bedNum = slotKey ? slotKey.split("-")[1] : "";

  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [plan,  setPlan]  = useState({});
  const [modalDay,  setModalDay]  = useState(null);
  const [selection, setSelection] = useState({});
  const [copiedDay, setCopiedDay] = useState(null);

  useEffect(() => {
    if (!slotKey) return;
    const r = ref(db, `treatmentPlans/${slotKey}`);
    const unsub = onValue(r, snap => setPlan(snap.val() || {}));
    return () => unsub();
  }, [slotKey]);

  const monthKey  = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthData = plan[monthKey] || {};
  const dischargeDate = parseDateStr(discharge);

  const saveDay = useCallback(async (day, items) => {
    const newPlan = { ...plan, [monthKey]: { ...monthData, [String(day)]: items } };
    setPlan(newPlan);
    await set(ref(db, `treatmentPlans/${slotKey}`), newPlan);
  }, [plan, monthKey, monthData, slotKey]);

  const registerAll = () => {
    if (Object.keys(selection).length === 0) return;
    const existing = monthData[String(modalDay)] || [];
    const newItems = [
      ...existing.filter(e => !selection[e.id]),
      ...Object.entries(selection).map(([id, qty]) => ({ id, qty }))
    ];
    saveDay(modalDay, newItems);
    setSelection({});
  };

  const removeItem = (day, itemId) => {
    saveDay(day, (monthData[String(day)] || []).filter(e => e.id !== itemId));
  };

  const copyDay  = (day) => setCopiedDay({ day, monthKey });
  const pasteDay = (targetDay) => {
    if (!copiedDay) return;
    const srcItems = (plan[copiedDay.monthKey] || {})[String(copiedDay.day)] || [];
    saveDay(targetDay, [...srcItems]);
  };

  const dayTotal = (day) =>
    (monthData[String(day)] || []).reduce((s, e) => s + calcPrice(ALL_ITEMS.find(i => i.id === e.id), e.qty), 0);

  const monthTotal = Object.keys(monthData).reduce((s, d) => s + dayTotal(parseInt(d)), 0);

  const weeklyStats = (() => {
    if (!admitDate) return [];
    const weeks = {};
    Object.keys(monthData).forEach(d => {
      const wk = getWeekNumber(admitDate, new Date(year, month, parseInt(d)));
      if (wk === null) return;
      if (!weeks[wk]) weeks[wk] = { total: 0, days: [] };
      weeks[wk].total += dayTotal(parseInt(d));
      weeks[wk].days.push(parseInt(d));
    });
    return Object.entries(weeks).map(([wk, v]) => ({ week: parseInt(wk), ...v })).sort((a,b) => a.week - b.week);
  })();

  const daysInMonth = getDaysInMonth(year, month);
  const firstDow    = getFirstDow(year, month);

  const calCells = [];
  for (let i = 0; i < firstDow; i++) calCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calCells.push(d);
  while (calCells.length % 7 !== 0) calCells.push(null);

  const modalItems = modalDay ? (monthData[String(modalDay)] || []) : [];

  const toggleItem = (item) => {
    setSelection(prev => {
      const next = { ...prev };
      if (next[item.id] !== undefined) delete next[item.id];
      else next[item.id] = item.custom === "vitc" ? "10" : "1";
      return next;
    });
  };

  const setQty = (itemId, qty) => setSelection(prev => ({ ...prev, [itemId]: qty }));

  if (!slotKey) return <div style={{ padding:40, color:"#64748b", fontFamily:"sans-serif" }}>로딩 중...</div>;

  return (
    <div style={TS.page}>
      <header style={TS.header}>
        <button style={TS.btnBack} onClick={() => router.back()}>← 병실로</button>
        <div style={TS.headerCenter}>
          <div style={TS.roomLabel}>{roomId}호 {bedNum}번 병상</div>
          <div style={TS.patientLabel}>{name || slotKey}님</div>
          {admitDate && <div style={TS.subLabel}>입원일: {admitDate}</div>}
          {discharge && discharge !== "미정" && <div style={{ ...TS.subLabel, color:"#fbbf24" }}>퇴원 예정: {discharge}</div>}
        </div>
        <div style={TS.monthNav}>
          <button style={TS.btnMonth} onClick={() => { if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); }}>‹</button>
          <span style={TS.monthLabel}>{year}년 {month+1}월</span>
          <button style={TS.btnMonth} onClick={() => { if(month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); }}>›</button>
        </div>
        <button style={TS.btnPrint} onClick={() => window.print()}>🖨 인쇄</button>
      </header>

      {/* 합계 바 */}
      <div style={TS.totalBar}>
        <span style={TS.totalItem}>
          {month+1}월 합계&nbsp;<strong style={{ color:"#dc2626" }}>{monthTotal.toLocaleString()}원</strong>
        </span>
        {weeklyStats.map(wk => (
          <span key={wk.week} style={{ ...TS.totalItem, borderLeft:"1px solid #e2e8f0", paddingLeft:14 }}>
            {wk.week}주차&nbsp;
            <strong style={{ color: wk.total>=1300000?"#16a34a":"#dc2626" }}>{Math.floor(wk.total/10000)}만원</strong>
            <span style={{ fontSize:11, marginLeft:3, color: wk.total>=1300000?"#16a34a":"#dc2626" }}>
              {wk.total>=1300000 ? "✓ 충족" : `(${Math.floor((1300000-wk.total)/10000)}만 부족)`}
            </span>
          </span>
        ))}
        {copiedDay && (
          <span style={{ ...TS.totalItem, color:"#7c3aed", marginLeft:"auto" }}>
            📋 {copiedDay.monthKey.slice(5)}월 {copiedDay.day}일 복사됨
            <button style={TS.btnClearCopy} onClick={() => setCopiedDay(null)}>✕</button>
          </span>
        )}
      </div>

      {/* 달력 */}
      <div style={TS.calWrap}>
        <div style={TS.calGrid}>
          {DAY_KO.map((d, i) => (
            <div key={d} style={{ ...TS.dowCell, color: i===0?"#dc2626":i===6?"#2563eb":"#64748b" }}>{d}</div>
          ))}
        </div>
        <div style={TS.calGrid}>
          {calCells.map((day, idx) => {
            if (!day) return <div key={`e${idx}`} style={TS.emptyCell} />;
            const dow       = (firstDow + day - 1) % 7;
            const items     = monthData[String(day)] || [];
            const total     = dayTotal(day);
            const isToday   = year===today.getFullYear() && month===today.getMonth() && day===today.getDate();
            const thisDate  = new Date(year, month, day);
            const isDisch   = dischargeDate && dateOnly(dischargeDate).getTime()===dateOnly(thisDate).getTime();
            const isCopied  = copiedDay && copiedDay.monthKey===monthKey && copiedDay.day===day;
            const wkNum     = admitDate ? getWeekNumber(admitDate, thisDate) : null;

            return (
              <div key={day}
                style={{ ...TS.dayCell,
                  border: isDisch ? "2px solid #f59e0b" : isToday ? "2px solid #0ea5e9" : isCopied ? "2px dashed #7c3aed" : "1px solid #e2e8f0",
                  background: isDisch ? "#fffbeb" : items.length>0 ? "#fff" : "#fafafa",
                }}
                onClick={() => { setModalDay(day); setSelection({}); }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ ...TS.dayNum, background:isToday?"#0ea5e9":undefined, color:isToday?"#fff":dow===0?"#dc2626":dow===6?"#2563eb":"#374151" }}>
                    {day}
                  </div>
                  {wkNum && <span style={{ fontSize:9, color:"#94a3b8", fontWeight:600 }}>{wkNum}주</span>}
                </div>
                {isDisch && <div style={TS.dischargeTag}>🚪 퇴원 예정</div>}
                <div style={TS.tagList}>
                  {items.map(e => {
                    const item = ALL_ITEMS.find(i => i.id === e.id);
                    const grp  = getItemGroup(e.id);
                    if (!item) return null;
                    return (
                      <span key={e.id} style={{ ...TS.tag, background:grp.bg, color:grp.color, borderColor:grp.color }}>
                        {item.custom==="vitc"?`비타민C ${e.qty}g`:item.custom==="qty"?`${item.name} ${e.qty}개`:item.name}
                      </span>
                    );
                  })}
                </div>
                {total > 0 && <div style={TS.dayTotalLabel}>{Math.floor(total/10000)}만원</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 요약 테이블 */}
      <div style={TS.summaryWrap}>
        <div style={TS.summaryTitle}>📋 {month+1}월 치료 요약</div>
        {Object.keys(monthData).length === 0
          ? <div style={{ color:"#94a3b8", fontSize:14 }}>등록된 치료가 없습니다.</div>
          : (
            <table style={TS.table}>
              <thead><tr>
                <th style={TS.th}>날짜</th>
                <th style={TS.th}>주차</th>
                <th style={TS.th}>치료 내용</th>
                <th style={{ ...TS.th, textAlign:"right" }}>금액</th>
              </tr></thead>
              <tbody>
                {Object.entries(monthData).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).map(([day, items]) =>
                  items?.length > 0 && (
                    <tr key={day} style={{ cursor:"pointer" }} onClick={() => { setModalDay(parseInt(day)); setSelection({}); }}>
                      <td style={TS.td}>{month+1}/{day} ({DAY_KO[(firstDow+parseInt(day)-1)%7]})</td>
                      <td style={TS.td}>{admitDate?`${getWeekNumber(admitDate, new Date(year,month,parseInt(day)))}주차`:"-"}</td>
                      <td style={TS.td}>
                        {(items||[]).map(e => {
                          const item = ALL_ITEMS.find(i => i.id === e.id);
                          const grp  = getItemGroup(e.id);
                          if (!item) return null;
                          return <span key={e.id} style={{ ...TS.tag, marginRight:4, background:grp.bg, color:grp.color, borderColor:grp.color }}>
                            {item.custom==="vitc"?`비타민C ${e.qty}g`:item.custom==="qty"?`${item.name} ${e.qty}개`:item.name}
                          </span>;
                        })}
                      </td>
                      <td style={{ ...TS.td, textAlign:"right", fontWeight:700 }}>{dayTotal(parseInt(day)).toLocaleString()}원</td>
                    </tr>
                  )
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...TS.td, fontWeight:800 }}>월 합계</td>
                  <td style={{ ...TS.td, textAlign:"right", fontWeight:800, color:"#dc2626", fontSize:16 }}>{monthTotal.toLocaleString()}원</td>
                </tr>
                {weeklyStats.map(wk => (
                  <tr key={wk.week} style={{ background: wk.total>=1300000?"#f0fdf4":"#fef2f2" }}>
                    <td colSpan={3} style={{ ...TS.td, fontSize:13 }}>
                      {wk.week}주차
                      <span style={{ fontSize:11, color:"#64748b", marginLeft:8 }}>({wk.days.map(d=>`${month+1}/${d}`).join(", ")})</span>
                    </td>
                    <td style={{ ...TS.td, textAlign:"right", fontWeight:700, color:wk.total>=1300000?"#16a34a":"#dc2626" }}>
                      {wk.total.toLocaleString()}원 {wk.total>=1300000?"✓ 충족":"✗ 미충족"}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
          )
        }
      </div>

      {/* 날짜 모달 */}
      {modalDay && (
        <div style={TS.overlay} onClick={() => { setModalDay(null); setSelection({}); }}>
          <div style={TS.modal} onClick={e => e.stopPropagation()}>
            <div style={TS.modalHeader}>
              <span style={TS.modalTitle}>
                {month+1}월 {modalDay}일 ({DAY_KO[(firstDow+modalDay-1)%7]})
                {admitDate && <span style={{ fontSize:12, color:"#7dd3fc", marginLeft:8 }}>{getWeekNumber(admitDate, new Date(year,month,modalDay))}주차</span>}
              </span>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <button style={TS.btnCopy} onClick={() => copyDay(modalDay)}>📋 복사</button>
                {copiedDay && copiedDay.day !== modalDay && (
                  <button style={TS.btnPaste} onClick={() => pasteDay(modalDay)}>
                    📌 {copiedDay.day}일 → {modalDay}일 붙여넣기
                  </button>
                )}
                <button style={TS.btnClose} onClick={() => { setModalDay(null); setSelection({}); }}>✕</button>
              </div>
            </div>

            {/* 등록된 항목 */}
            {modalItems.length > 0 && (
              <div style={TS.registeredList}>
                <div style={{ fontSize:12, fontWeight:700, color:"#64748b", marginBottom:6 }}>등록된 치료</div>
                {modalItems.map(e => {
                  const item = ALL_ITEMS.find(i => i.id === e.id);
                  const grp  = getItemGroup(e.id);
                  if (!item) return null;
                  return (
                    <div key={e.id} style={{ ...TS.regItem, borderLeftColor: grp.color }}>
                      <div style={{ flex:1 }}>
                        <span style={{ fontWeight:700, color:grp.color }}>
                          {item.custom==="vitc"?`비타민C ${e.qty}g`:item.custom==="qty"?`${item.name} ${e.qty}개`:item.name}
                        </span>
                        <span style={{ color:"#64748b", fontSize:12, marginLeft:8 }}>{calcPrice(item,e.qty).toLocaleString()}원</span>
                      </div>
                      <button style={TS.btnRemove} onClick={() => removeItem(modalDay, e.id)}>✕</button>
                    </div>
                  );
                })}
                <div style={TS.dayTotalRow}>당일 합계: <strong style={{ color:"#dc2626", marginLeft:6 }}>{dayTotal(modalDay).toLocaleString()}원</strong></div>
              </div>
            )}

            {/* 다중 선택 패널 */}
            <div style={TS.addSection}>
              <div style={TS.addTitle}>치료 선택 (여러 개 선택 후 일괄 등록)</div>
              {TREATMENT_GROUPS.map((group) => (
                <div key={group.group} style={TS.groupBlock}>
                  <div style={{ ...TS.groupLabel, color: group.color }}>{group.group}</div>
                  <div style={TS.itemRow}>
                    {group.items.map(item => {
                      const isSel   = selection[item.id] !== undefined;
                      const isAdded = modalItems.some(e => e.id === item.id);
                      return (
                        <button key={item.id}
                          style={{ ...TS.itemBtn, background:isSel?group.color:isAdded?group.bg:"#f8fafc", color:isSel?"#fff":group.color, borderColor:group.color }}
                          onClick={() => toggleItem(item)}>
                          {isSel?"☑ ":isAdded?"✓ ":""}{item.name}
                        </button>
                      );
                    })}
                  </div>
                  {/* 수량 입력 (선택된 항목 중 custom 있는 것만) */}
                  {group.items.filter(item => selection[item.id]!==undefined && item.custom).map(item => (
                    <div key={item.id} style={TS.qtyRow}>
                      <span style={{ fontSize:12, color:group.color, fontWeight:700, minWidth:90 }}>{item.name}</span>
                      {item.custom==="vitc" ? (
                        <select style={TS.qtySelect} value={selection[item.id]} onChange={e => setQty(item.id, e.target.value)}>
                          {[10,20,30,40,50,60,70,80,90,100].map(g => (
                            <option key={g} value={g}>{g}g — {calcPrice(item,g).toLocaleString()}원</option>
                          ))}
                        </select>
                      ) : (
                        <>
                          <input type="number" min="1" style={TS.qtyInput} value={selection[item.id]} onChange={e => setQty(item.id, e.target.value)} />
                          <span style={{ fontSize:12, color:"#64748b" }}>개 = {calcPrice(item, selection[item.id]).toLocaleString()}원</span>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {/* 일괄 등록 바 */}
            {Object.keys(selection).length > 0 && (
              <div style={TS.registerBar}>
                <span style={{ fontSize:13, color:"#0f2744" }}>
                  {Object.keys(selection).length}개 선택 —
                  <strong style={{ color:"#dc2626", marginLeft:4 }}>
                    {Object.entries(selection).reduce((s,[id,qty]) => s + calcPrice(ALL_ITEMS.find(i=>i.id===id), qty), 0).toLocaleString()}원
                  </strong>
                </span>
                <button style={TS.btnRegister} onClick={registerAll}>✓ 일괄 등록</button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* 인쇄 전용 영역 — 화면에선 숨김, 인쇄시만 표시 */}
      <PrintView
        name={name} roomId={roomId} bedNum={bedNum}
        year={year} month={month} monthData={monthData}
        firstDow={firstDow} daysInMonth={daysInMonth}
      />
    </div>
  );
}

// ── 인쇄 전용 컴포넌트 (달력 형태) ─────────────────────────────────────────
function PrintView({ name, roomId, bedNum, year, month, monthData, firstDow, daysInMonth }) {
  const allItems = TREATMENT_GROUPS.flatMap(g => g.items);

  // 달력 셀 생성
  const calCells = [];
  for (let i = 0; i < firstDow; i++) calCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calCells.push(d);
  while (calCells.length % 7 !== 0) calCells.push(null);
  const weeks = [];
  for (let i = 0; i < calCells.length; i += 7) weeks.push(calCells.slice(i, i+7));

  return (
    <div className="print-only" style={{ display:"none" }}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 8mm 10mm; }
          body * { visibility: hidden !important; }
          .print-only, .print-only * { visibility: visible !important; }
          .print-only { position: fixed; top: 0; left: 0; width: 100%; background: white; z-index: 9999; display: block !important; }
        }
      `}</style>
      <div style={{ fontFamily:"'Noto Sans KR', sans-serif", color:"#000" }}>

        {/* 헤더 */}
        <div style={{ textAlign:"center", marginBottom:8, borderBottom:"2px solid #222", paddingBottom:6 }}>
          <div style={{ fontSize:18, fontWeight:800, letterSpacing:-0.5 }}>치료 일정표</div>
          <div style={{ fontSize:12, fontWeight:600, marginTop:3, color:"#333" }}>
            {roomId}호 {bedNum}번 병상 &nbsp;·&nbsp; {name}님 &nbsp;·&nbsp; {year}년 {month+1}월
          </div>
        </div>

        {/* 달력 */}
        <table style={{ width:"100%", borderCollapse:"collapse", tableLayout:"fixed", height:"calc(100vh - 80px)" }}>
          <thead>
            <tr>
              {DAY_KO.map((d, i) => (
                <th key={d} style={{ border:"1px solid #bbb", padding:"5px 0", fontSize:11, fontWeight:700, textAlign:"center", background:"#f0f0f0", color: i===0?"#cc0000":i===6?"#0033cc":"#222", width:"14.28%" }}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi} style={{ height: `${Math.floor(100/weeks.length)}%` }}>
                {week.map((day, di) => {
                  if (!day) return <td key={di} style={{ border:"1px solid #bbb", verticalAlign:"top", background:"#fafafa" }} />;
                  const dow   = (firstDow + day - 1) % 7;
                  const items = monthData[String(day)] || [];
                  return (
                    <td key={di} style={{ border:"1px solid #bbb", verticalAlign:"top", padding:"4px 5px", background:"#fff" }}>
                      {/* 날짜 숫자 */}
                      <div style={{ fontSize:12, fontWeight:800, marginBottom:3, color: dow===0?"#cc0000":dow===6?"#0033cc":"#222" }}>
                        {day}
                      </div>
                      {/* 치료 항목 */}
                      {items.map(e => {
                        const item = allItems.find(i => i.id === e.id);
                        if (!item) return null;
                        const label = item.custom==="vitc" ? `비타민C ${e.qty}g`
                                    : item.custom==="qty"  ? `${item.name} ${e.qty}개`
                                    : item.name;
                        return (
                          <div key={e.id} style={{ fontSize:9.5, lineHeight:1.5, color:"#111", borderLeft:"2px solid #555", paddingLeft:3, marginBottom:2 }}>
                            {label}
                          </div>
                        );
                      })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* 푸터 */}
        <div style={{ marginTop:8, fontSize:9, color:"#888", textAlign:"right" }}>
          출력일: {new Date().toLocaleDateString("ko-KR")}
        </div>
      </div>
    </div>
  );
}

const PS = {
  th: { border:"1px solid #ccc", padding:"7px 10px", fontWeight:700, textAlign:"center", background:"#f0f0f0" },
  td: { border:"1px solid #ccc", padding:"7px 10px", verticalAlign:"middle" },
};

const TS = {
  page: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", gap:16, padding:"12px 20px", boxShadow:"0 2px 12px rgba(0,0,0,0.18)", flexWrap:"wrap" },
  btnBack: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600, flexShrink:0 },
  headerCenter: { flex:1, textAlign:"center" },
  roomLabel: { fontSize:13, color:"#7dd3fc", fontWeight:600, marginBottom:2 },
  patientLabel: { fontSize:20, fontWeight:800 },
  subLabel: { fontSize:12, color:"#94a3b8", marginTop:2 },
  monthNav: { display:"flex", alignItems:"center", gap:10, flexShrink:0 },
  btnMonth: { background:"rgba(255,255,255,0.1)", border:"none", color:"#fff", borderRadius:6, width:32, height:32, cursor:"pointer", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" },
  monthLabel: { fontSize:15, fontWeight:700, minWidth:90, textAlign:"center" },
  totalBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", display:"flex", alignItems:"center", flexWrap:"wrap", gap:16, padding:"10px 20px" },
  totalItem: { fontSize:13, color:"#0f2744", display:"flex", alignItems:"center", gap:4 },
  btnClearCopy: { background:"none", border:"none", color:"#7c3aed", cursor:"pointer", fontSize:13, marginLeft:4 },
  calWrap: { padding:"14px 14px 0" },
  calGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3 },
  dowCell: { textAlign:"center", fontSize:12, fontWeight:700, padding:"6px 0" },
  emptyCell: { minHeight:90 },
  dayCell: { minHeight:90, borderRadius:8, padding:"5px", cursor:"pointer", display:"flex", flexDirection:"column", transition:"box-shadow 0.15s" },
  dayNum: { width:22, height:22, borderRadius:"50%", fontSize:12, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dischargeTag: { fontSize:9, fontWeight:700, color:"#d97706", background:"#fef3c7", borderRadius:3, padding:"1px 4px", marginBottom:2 },
  tagList: { display:"flex", flexDirection:"column", gap:2, flex:1, overflow:"hidden" },
  tag: { fontSize:10, fontWeight:700, borderRadius:4, padding:"1px 5px", border:"1px solid", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  dayTotalLabel: { fontSize:10, fontWeight:800, color:"#dc2626", textAlign:"right", marginTop:"auto" },
  summaryWrap: { padding:"16px 20px 30px" },
  summaryTitle: { fontSize:15, fontWeight:800, color:"#0f2744", marginBottom:10 },
  table: { width:"100%", borderCollapse:"collapse", background:"#fff", borderRadius:10, overflow:"hidden", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" },
  th: { background:"#0f2744", color:"#fff", padding:"10px 14px", fontSize:13, fontWeight:700, textAlign:"left" },
  td: { padding:"9px 14px", fontSize:13, borderBottom:"1px solid #f1f5f9", verticalAlign:"middle" },
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"flex-start", justifyContent:"center", zIndex:1000, overflowY:"auto", padding:"20px 0" },
  modal: { background:"#fff", borderRadius:14, width:"100%", maxWidth:620, margin:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.22)", overflow:"hidden" },
  modalHeader: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 18px" },
  modalTitle: { fontSize:15, fontWeight:800 },
  btnClose: { background:"none", border:"none", color:"#94a3b8", fontSize:18, cursor:"pointer" },
  btnCopy:  { background:"rgba(255,255,255,0.12)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:12, fontWeight:600 },
  btnPaste: { background:"#7c3aed", border:"none", color:"#fff", borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:12, fontWeight:600 },
  registeredList: { padding:"12px 18px", background:"#f8fafc", borderBottom:"1px solid #e2e8f0" },
  regItem: { display:"flex", alignItems:"center", gap:8, padding:"6px 10px", marginBottom:5, background:"#fff", borderRadius:8, borderLeft:"3px solid", boxShadow:"0 1px 3px rgba(0,0,0,0.05)" },
  btnRemove: { background:"#fee2e2", border:"none", color:"#dc2626", borderRadius:5, width:22, height:22, cursor:"pointer", fontSize:11, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dayTotalRow: { textAlign:"right", fontSize:13, color:"#0f2744", paddingTop:8, borderTop:"1px dashed #e2e8f0", marginTop:6 },
  addSection: { padding:"12px 18px", maxHeight:"42vh", overflowY:"auto" },
  addTitle: { fontSize:12, fontWeight:700, color:"#64748b", marginBottom:10, background:"#f0f9ff", borderRadius:6, padding:"6px 10px" },
  groupBlock: { marginBottom:12 },
  groupLabel: { fontSize:11, fontWeight:800, letterSpacing:0.5, marginBottom:5 },
  itemRow: { display:"flex", flexWrap:"wrap", gap:5 },
  itemBtn: { border:"1.5px solid", borderRadius:7, padding:"5px 10px", cursor:"pointer", fontSize:12, fontWeight:600, transition:"all 0.15s" },
  qtyRow: { display:"flex", alignItems:"center", gap:8, marginTop:6, flexWrap:"wrap", paddingLeft:8, borderLeft:"2px solid #e2e8f0" },
  qtySelect: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"4px 8px", fontSize:12, outline:"none", fontFamily:"inherit" },
  qtyInput: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"4px 8px", fontSize:12, outline:"none", width:60, fontFamily:"inherit" },
  registerBar: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 18px", background:"#f0fdf4", borderTop:"1px solid #bbf7d0" },
  btnRegister: { background:"#16a34a", color:"#fff", border:"none", borderRadius:8, padding:"8px 20px", cursor:"pointer", fontSize:14, fontWeight:800 },
  btnPrint: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600, flexShrink:0 },
};

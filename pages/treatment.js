import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

// ── 치료 항목 정의 ────────────────────────────────────────────────────────────
const TREATMENT_GROUPS = [
  {
    group: "고주파 온열치료",
    color: "#dc2626", bg: "#fef2f2",
    items: [
      { id: "hyperthermia", name: "고주파 온열치료", price: 300000 },
    ],
  },
  {
    group: "싸이모신알파1",
    color: "#7c3aed", bg: "#faf5ff",
    items: [
      { id: "zadaxin",   name: "자닥신",   price: 350000 },
      { id: "imualpha",  name: "이뮤알파", price: 300000 },
      { id: "scion",     name: "싸이원주", price: 250000 },
    ],
  },
  {
    group: "수액류",
    color: "#0ea5e9", bg: "#f0f9ff",
    items: [
      { id: "glutathione",  name: "글루타치온",            price: 60000 },
      { id: "dramin",       name: "닥터라민+지씨멀티주",   price: 100000 },
      { id: "thioctic",     name: "티옥트산",              price: 40000 },
      { id: "gt",           name: "G+T",                   price: 100000 },
      { id: "myers1",       name: "마이어스1",             price: 70000 },
      { id: "myers2",       name: "마이어스2",             price: 120000 },
      { id: "selenium_iv",  name: "셀레늄",                price: 70000 },
      { id: "vitd",         name: "비타민D",               price: 50000 },
      { id: "vitc",         name: "고용량 비타민C",        price: null, custom: "vitc" },
      // custom: "vitc" → 10g 단위 수량 입력, 10g=30000, 20g~= +10000/10g
    ],
  },
  {
    group: "물리치료",
    color: "#059669", bg: "#f0fdf4",
    items: [
      { id: "pain",   name: "페인스크렘블러", price: 200000 },
      { id: "manip2", name: "도수치료2",      price: 200000 },
      { id: "manip1", name: "도수치료1",      price: 120000 },
    ],
  },
  {
    group: "경구제",
    color: "#d97706", bg: "#fffbeb",
    items: [
      { id: "meshima",    name: "메시마F",      price: 18000,  custom: "qty" },
      { id: "selenase_l", name: "셀레나제액상", price: 5000,   custom: "qty" },
      { id: "selenase_t", name: "셀레나제정",   price: 5000,   custom: "qty" },
      { id: "selenase_f", name: "셀레나제필름", price: 5000,   custom: "qty" },
    ],
  },
];

// 가격 계산
function calcPrice(item, qty) {
  if (item.custom === "vitc") {
    const g = parseInt(qty) || 0;
    if (g <= 0) return 0;
    const units = Math.ceil(g / 10);
    if (units === 1) return 30000;
    return 30000 + (units - 1) * 10000;
  }
  if (item.custom === "qty") {
    return item.price * (parseInt(qty) || 0);
  }
  return item.price;
}

function priceLabel(item) {
  if (item.custom === "vitc") return "10g당 3만원 (20g~+1만원)";
  if (item.custom === "qty")  return `개당 ${(item.price/10000).toFixed(1)}만원`;
  return `${(item.price/10000).toFixed(item.price % 10000 === 0 ? 0 : 1)}만원`;
}

function won(n) {
  if (n >= 10000) return `${Math.floor(n/10000)}만${n%10000 ? `${n%10000}` : ""}원`;
  return `${n}원`;
}

const DAY_KO = ["일","월","화","수","목","금","토"];

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfWeek(year, month) {
  return new Date(year, month, 1).getDay();
}

// ════════════════════════════════════════════════════════════════════════════
export default function TreatmentPage() {
  const router = useRouter();
  const { slotKey, name } = router.query;

  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed
  const [plan,  setPlan]  = useState({}); // { "2025-03": { "5": [{id, qty}, ...], ... } }
  const [modalDay,    setModalDay]    = useState(null); // 날짜 클릭 시 모달
  const [addingItem,  setAddingItem]  = useState(null); // { groupIdx, itemIdx }
  const [addingQty,   setAddingQty]   = useState("1");

  // Firebase 구독
  useEffect(() => {
    if (!slotKey) return;
    const r = ref(db, `treatmentPlans/${slotKey}`);
    const unsub = onValue(r, snap => {
      setPlan(snap.val() || {});
    });
    return () => unsub();
  }, [slotKey]);

  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;

  // 현재 달 데이터
  const monthData = plan[monthKey] || {};

  // 저장
  const saveDay = useCallback(async (day, items) => {
    const newPlan = { ...plan, [monthKey]: { ...monthData, [String(day)]: items } };
    setPlan(newPlan);
    await set(ref(db, `treatmentPlans/${slotKey}`), newPlan);
  }, [plan, monthKey, monthData, slotKey]);

  // 치료 항목 추가
  const addItem = () => {
    if (addingItem === null) return;
    const group = TREATMENT_GROUPS[addingItem.groupIdx];
    const item  = group.items[addingItem.itemIdx];
    const existing = modalDay ? (monthData[String(modalDay)] || []) : [];
    // 같은 id는 덮어쓰기
    const filtered = existing.filter(e => e.id !== item.id);
    const newItems = [...filtered, { id: item.id, qty: addingQty }];
    saveDay(modalDay, newItems);
    setAddingItem(null);
    setAddingQty("1");
  };

  const removeItem = (day, itemId) => {
    const existing = monthData[String(day)] || [];
    saveDay(day, existing.filter(e => e.id !== itemId));
  };

  // 월 합계
  const monthTotal = Object.entries(monthData).reduce((sum, [, items]) => {
    return sum + (items || []).reduce((s, e) => {
      const item = TREATMENT_GROUPS.flatMap(g => g.items).find(i => i.id === e.id);
      return s + (item ? calcPrice(item, e.qty) : 0);
    }, 0);
  }, 0);

  // 날짜별 합계
  const dayTotal = (day) => {
    return (monthData[String(day)] || []).reduce((s, e) => {
      const item = TREATMENT_GROUPS.flatMap(g => g.items).find(i => i.id === e.id);
      return s + (item ? calcPrice(item, e.qty) : 0);
    }, 0);
  };

  const daysInMonth = getDaysInMonth(year, month);
  const firstDow    = getFirstDayOfWeek(year, month);

  // 달력 셀
  const calCells = [];
  for (let i = 0; i < firstDow; i++) calCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calCells.push(d);
  while (calCells.length % 7 !== 0) calCells.push(null);

  const modalItems = modalDay ? (monthData[String(modalDay)] || []) : [];
  const allItems   = TREATMENT_GROUPS.flatMap(g => g.items);

  if (!slotKey) return <div style={{ padding:40, color:"#64748b" }}>로딩 중...</div>;

  return (
    <div style={TS.page}>
      {/* 헤더 */}
      <header style={TS.header}>
        <button style={TS.btnBack} onClick={() => router.back()}>← 병실로</button>
        <div style={TS.headerTitle}>
          <span style={TS.patientName}>{name || slotKey}</span>
          <span style={TS.headerSub}>치료 일정표</span>
        </div>
        <div style={TS.monthNav}>
          <button style={TS.btnMonth} onClick={() => { if (month === 0) { setYear(y => y-1); setMonth(11); } else setMonth(m => m-1); }}>‹</button>
          <span style={TS.monthLabel}>{year}년 {month+1}월</span>
          <button style={TS.btnMonth} onClick={() => { if (month === 11) { setYear(y => y+1); setMonth(0); } else setMonth(m => m+1); }}>›</button>
        </div>
        <div style={TS.monthTotal}>
          월 합계: <strong style={{ color:"#dc2626", marginLeft:4 }}>{monthTotal.toLocaleString()}원</strong>
        </div>
      </header>

      {/* 달력 */}
      <div style={TS.calWrap}>
        {/* 요일 헤더 */}
        <div style={TS.calGrid}>
          {DAY_KO.map((d, i) => (
            <div key={d} style={{ ...TS.dowCell, color: i===0?"#dc2626":i===6?"#2563eb":"#64748b" }}>{d}</div>
          ))}
        </div>
        {/* 날짜 셀 */}
        <div style={TS.calGrid}>
          {calCells.map((day, idx) => {
            if (!day) return <div key={`e${idx}`} style={TS.emptyCell} />;
            const dow   = (firstDow + day - 1) % 7;
            const items = monthData[String(day)] || [];
            const total = dayTotal(day);
            const isToday = year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
            return (
              <div key={day} style={{ ...TS.dayCell, border: isToday ? "2px solid #0ea5e9" : "1px solid #e2e8f0", background: items.length > 0 ? "#fff" : "#fafafa" }}
                onClick={() => setModalDay(day)}>
                <div style={{ ...TS.dayNum, color: dow===0?"#dc2626":dow===6?"#2563eb":"#374151", background: isToday?"#0ea5e9":undefined, color: isToday?"#fff":dow===0?"#dc2626":dow===6?"#2563eb":"#374151" }}>
                  {day}
                </div>
                {/* 치료 태그들 */}
                <div style={TS.tagList}>
                  {items.map(e => {
                    const item  = allItems.find(i => i.id === e.id);
                    const group = TREATMENT_GROUPS.find(g => g.items.some(i => i.id === e.id));
                    if (!item) return null;
                    return (
                      <span key={e.id} style={{ ...TS.tag, background: group.bg, color: group.color, borderColor: group.color }}>
                        {item.custom === "vitc" ? `비타민C ${e.qty}g` : item.custom === "qty" ? `${item.name} ${e.qty}개` : item.name}
                      </span>
                    );
                  })}
                </div>
                {total > 0 && <div style={TS.dayTotal}>{Math.floor(total/10000)}만원</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 날짜 모달 */}
      {modalDay && (
        <div style={TS.overlay} onClick={() => { setModalDay(null); setAddingItem(null); }}>
          <div style={TS.modal} onClick={e => e.stopPropagation()}>
            <div style={TS.modalHeader}>
              <span style={TS.modalTitle}>{month+1}월 {modalDay}일 ({DAY_KO[(firstDow + modalDay - 1) % 7]}) 치료 일정</span>
              <button style={TS.btnClose} onClick={() => { setModalDay(null); setAddingItem(null); }}>✕</button>
            </div>

            {/* 현재 등록된 항목 */}
            {modalItems.length > 0 && (
              <div style={TS.registeredList}>
                {modalItems.map(e => {
                  const item  = allItems.find(i => i.id === e.id);
                  const group = TREATMENT_GROUPS.find(g => g.items.some(i => i.id === e.id));
                  if (!item) return null;
                  const price = calcPrice(item, e.qty);
                  return (
                    <div key={e.id} style={{ ...TS.regItem, borderLeftColor: group.color }}>
                      <div style={{ flex:1 }}>
                        <span style={{ fontWeight:700, color: group.color }}>
                          {item.custom === "vitc" ? `비타민C ${e.qty}g` : item.custom === "qty" ? `${item.name} ${e.qty}개` : item.name}
                        </span>
                        <span style={{ color:"#64748b", fontSize:12, marginLeft:8 }}>{price.toLocaleString()}원</span>
                      </div>
                      <button style={TS.btnRemove} onClick={() => removeItem(modalDay, e.id)}>✕</button>
                    </div>
                  );
                })}
                <div style={TS.dayTotalRow}>
                  당일 합계: <strong style={{ color:"#dc2626", marginLeft:6 }}>{dayTotal(modalDay).toLocaleString()}원</strong>
                </div>
              </div>
            )}

            {/* 치료 추가 패널 */}
            <div style={TS.addSection}>
              <div style={TS.addTitle}>+ 치료 추가</div>
              {TREATMENT_GROUPS.map((group, gi) => (
                <div key={gi} style={TS.groupBlock}>
                  <div style={{ ...TS.groupLabel, color: group.color }}>{group.group}</div>
                  <div style={TS.itemRow}>
                    {group.items.map((item, ii) => {
                      const isSelected = addingItem?.groupIdx === gi && addingItem?.itemIdx === ii;
                      const alreadyAdded = modalItems.some(e => e.id === item.id);
                      return (
                        <button key={item.id}
                          style={{ ...TS.itemBtn,
                            background: isSelected ? group.color : alreadyAdded ? group.bg : "#f8fafc",
                            color: isSelected ? "#fff" : group.color,
                            borderColor: group.color,
                            opacity: 1,
                          }}
                          onClick={() => {
                            if (isSelected) { setAddingItem(null); return; }
                            setAddingItem({ groupIdx: gi, itemIdx: ii });
                            setAddingQty(item.custom === "vitc" ? "10" : "1");
                          }}>
                          {alreadyAdded && !isSelected && "✓ "}
                          {item.name}
                          <span style={{ fontSize:10, opacity:0.8, marginLeft:3 }}>({priceLabel(item)})</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* 수량 입력 (선택된 항목이 이 그룹에 있을 때) */}
                  {group.items.some((_, ii) => addingItem?.groupIdx === gi && addingItem?.itemIdx === ii) && (() => {
                    const item = group.items[addingItem.itemIdx];
                    return (
                      <div style={TS.qtyRow}>
                        {item.custom === "vitc" && (
                          <>
                            <label style={TS.qtyLabel}>용량 (g 단위, 10g씩)</label>
                            <select style={TS.qtySelect} value={addingQty} onChange={e => setAddingQty(e.target.value)}>
                              {[10,20,30,40,50,60,70,80,90,100].map(g => (
                                <option key={g} value={g}>{g}g — {calcPrice(item, g).toLocaleString()}원</option>
                              ))}
                            </select>
                          </>
                        )}
                        {item.custom === "qty" && (
                          <>
                            <label style={TS.qtyLabel}>처방 개수</label>
                            <input type="number" min="1" style={TS.qtyInput} value={addingQty} onChange={e => setAddingQty(e.target.value)} />
                            <span style={{ fontSize:12, color:"#64748b" }}>= {calcPrice(item, addingQty).toLocaleString()}원</span>
                          </>
                        )}
                        <button style={{ ...TS.btnAdd, background: group.color }} onClick={addItem}>등록</button>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 월별 치료 요약 테이블 */}
      <div style={TS.summaryWrap}>
        <div style={TS.summaryTitle}>📋 {month+1}월 치료 요약</div>
        {Object.keys(monthData).length === 0
          ? <div style={{ color:"#94a3b8", fontSize:14, padding:"12px 0" }}>등록된 치료가 없습니다.</div>
          : (
            <table style={TS.table}>
              <thead>
                <tr>
                  <th style={TS.th}>날짜</th>
                  <th style={TS.th}>치료 내용</th>
                  <th style={{ ...TS.th, textAlign:"right" }}>금액</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(monthData)
                  .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                  .map(([day, items]) => items?.length > 0 && (
                    <tr key={day} style={{ cursor:"pointer" }} onClick={() => setModalDay(parseInt(day))}>
                      <td style={TS.td}>
                        {month+1}/{day} ({DAY_KO[(firstDow + parseInt(day) - 1) % 7]})
                      </td>
                      <td style={TS.td}>
                        {(items || []).map(e => {
                          const item  = allItems.find(i => i.id === e.id);
                          const group = TREATMENT_GROUPS.find(g => g.items.some(i => i.id === e.id));
                          if (!item) return null;
                          return (
                            <span key={e.id} style={{ ...TS.tag, marginRight:4, background: group.bg, color: group.color, borderColor: group.color }}>
                              {item.custom === "vitc" ? `비타민C ${e.qty}g` : item.custom === "qty" ? `${item.name} ${e.qty}개` : item.name}
                            </span>
                          );
                        })}
                      </td>
                      <td style={{ ...TS.td, textAlign:"right", fontWeight:700, color:"#0f2744" }}>
                        {dayTotal(parseInt(day)).toLocaleString()}원
                      </td>
                    </tr>
                  ))
                }
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ ...TS.td, fontWeight:800, color:"#0f2744" }}>월 합계</td>
                  <td style={{ ...TS.td, textAlign:"right", fontWeight:800, color:"#dc2626", fontSize:16 }}>
                    {monthTotal.toLocaleString()}원
                  </td>
                </tr>
              </tfoot>
            </table>
          )
        }
      </div>
    </div>
  );
}

const TS = {
  page: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", gap:20, padding:"14px 24px", flexWrap:"wrap", boxShadow:"0 2px 12px rgba(0,0,0,0.18)" },
  btnBack: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600 },
  headerTitle: { display:"flex", flexDirection:"column", gap:2 },
  patientName: { fontSize:18, fontWeight:800 },
  headerSub: { fontSize:11, color:"#7dd3fc", letterSpacing:1 },
  monthNav: { display:"flex", alignItems:"center", gap:10, marginLeft:"auto" },
  btnMonth: { background:"rgba(255,255,255,0.1)", border:"none", color:"#fff", borderRadius:6, width:32, height:32, cursor:"pointer", fontSize:18, display:"flex", alignItems:"center", justifyContent:"center" },
  monthLabel: { fontSize:16, fontWeight:700, minWidth:100, textAlign:"center" },
  monthTotal: { fontSize:14, color:"#cbd5e1", background:"rgba(255,255,255,0.08)", borderRadius:8, padding:"6px 16px" },

  calWrap: { padding:"20px 20px 0" },
  calGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4 },
  dowCell: { textAlign:"center", fontSize:12, fontWeight:700, padding:"8px 0" },
  emptyCell: { minHeight:100 },
  dayCell: { minHeight:100, borderRadius:8, padding:"6px", cursor:"pointer", transition:"box-shadow 0.15s", display:"flex", flexDirection:"column", gap:3 },
  dayNum: { width:24, height:24, borderRadius:"50%", fontSize:13, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:2, flexShrink:0 },
  tagList: { display:"flex", flexDirection:"column", gap:2, flex:1 },
  tag: { fontSize:10, fontWeight:700, borderRadius:4, padding:"1px 5px", border:"1px solid", display:"inline-block", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  dayTotal: { fontSize:10, fontWeight:800, color:"#dc2626", textAlign:"right", marginTop:"auto" },

  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"flex-start", justifyContent:"center", zIndex:1000, overflowY:"auto", padding:"20px 0" },
  modal: { background:"#fff", borderRadius:14, width:"100%", maxWidth:600, margin:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.22)", overflow:"hidden" },
  modalHeader: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px" },
  modalTitle: { fontSize:15, fontWeight:800 },
  btnClose: { background:"none", border:"none", color:"#94a3b8", fontSize:18, cursor:"pointer", lineHeight:1 },

  registeredList: { padding:"14px 20px", background:"#f8fafc", borderBottom:"1px solid #e2e8f0" },
  regItem: { display:"flex", alignItems:"center", gap:8, padding:"7px 10px", marginBottom:6, background:"#fff", borderRadius:8, borderLeft:"3px solid", boxShadow:"0 1px 3px rgba(0,0,0,0.05)" },
  btnRemove: { background:"#fee2e2", border:"none", color:"#dc2626", borderRadius:5, width:22, height:22, cursor:"pointer", fontSize:11, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dayTotalRow: { textAlign:"right", fontSize:13, color:"#0f2744", paddingTop:8, borderTop:"1px dashed #e2e8f0", marginTop:6 },

  addSection: { padding:"14px 20px", maxHeight:"50vh", overflowY:"auto" },
  addTitle: { fontSize:13, fontWeight:800, color:"#0f2744", marginBottom:12 },
  groupBlock: { marginBottom:14 },
  groupLabel: { fontSize:11, fontWeight:800, letterSpacing:0.5, marginBottom:6, textTransform:"uppercase" },
  itemRow: { display:"flex", flexWrap:"wrap", gap:6 },
  itemBtn: { border:"1.5px solid", borderRadius:7, padding:"5px 10px", cursor:"pointer", fontSize:12, fontWeight:600, transition:"all 0.15s" },
  qtyRow: { display:"flex", alignItems:"center", gap:8, marginTop:8, flexWrap:"wrap" },
  qtyLabel: { fontSize:12, color:"#64748b", fontWeight:600 },
  qtySelect: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"5px 8px", fontSize:13, outline:"none", fontFamily:"inherit" },
  qtyInput: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"5px 8px", fontSize:13, outline:"none", width:70, fontFamily:"inherit" },
  btnAdd: { color:"#fff", border:"none", borderRadius:7, padding:"6px 16px", cursor:"pointer", fontSize:13, fontWeight:700 },

  summaryWrap: { padding:"20px" },
  summaryTitle: { fontSize:15, fontWeight:800, color:"#0f2744", marginBottom:12 },
  table: { width:"100%", borderCollapse:"collapse", background:"#fff", borderRadius:10, overflow:"hidden", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" },
  th: { background:"#0f2744", color:"#fff", padding:"10px 14px", fontSize:13, fontWeight:700, textAlign:"left" },
  td: { padding:"10px 14px", fontSize:13, borderBottom:"1px solid #f1f5f9", verticalAlign:"middle" },
};

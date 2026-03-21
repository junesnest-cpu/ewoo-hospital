import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

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
    group: "미슬토", color: "#166534", bg: "#f0fdf4",
    items: [
      { id: "iscador_m", name: "이스카도M", price: 75000 },
      { id: "iscador_q", name: "이스카도Q", price: 80000 },
    ],
  },
  {
    group: "수액류", color: "#0ea5e9", bg: "#f0f9ff",
    items: [
      { id: "glutathione",     name: "글루타치온",          price: 60000 },
      { id: "glutathione_qty", name: "글루타치온(개수)",    price: 60000, custom: "qty" },
      { id: "dramin",          name: "닥터라민+지씨멀티주", price: 100000 },
      { id: "thioctic",        name: "티옥트산",            price: 40000 },
      { id: "thioctic_qty",    name: "티옥트산(개수)",      price: 40000, custom: "qty" },
      { id: "gt",          name: "G+T",                 price: 100000 },
      { id: "myers1",      name: "마이어스1",           price: 70000 },
      { id: "myers2",      name: "마이어스2",           price: 120000 },
      { id: "selenium_iv",   name: "셀레늄",              price: 70000 },
      { id: "vitd",          name: "비타민D",             price: 50000 },
      { id: "vitc",          name: "고용량 비타민C",      price: null, custom: "vitc" },
      { id: "periview_360",  name: "페리주 360ml",        price: 100000 },
      { id: "periview_560",  name: "페리주 560ml",        price: 150000 },
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
    group: "고압산소치료", color: "#0ea5e9", bg: "#f0f9ff",
    items: [
      { id: "hyperbaric", name: "고압산소치료", price: 0 },
    ],
  },
  {
    group: "외용제", color: "#be185d", bg: "#fdf2f8",
    items: [
      { id: "rejuderm", name: "리쥬더마", price: 45000, custom: "qty" },
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

function calcPrice(item, qty, dateObj) {
  if (!item) return 0;
  if (item.custom === "vitc") {
    const g = parseInt(qty) || 0;
    if (g <= 0) return 0;
    const units = Math.ceil(g / 10);
    return units === 1 ? 30000 : 30000 + (units - 1) * 10000;
  }
  if (item.custom === "qty") {
    let unitPrice = item.price;
    // 날짜별 가격 변동 (2025/3/16 기준)
    if (dateObj) {
      const cutoff = new Date(2025, 2, 16); // 3/16
      const before = dateOnly(dateObj) < dateOnly(cutoff);
      if (item.id === "meshima"    && before) unitPrice = 15000;
      if (item.id === "iscador_m"  && before) unitPrice = 65000;
      if (item.id === "iscador_q"  && before) unitPrice = 70000;
    }
    return unitPrice * (parseInt(qty) || 0);
  }
  return item.price;
}

function getItemGroup(itemId) {
  return TREATMENT_GROUPS.find(g => g.items.some(i => i.id === itemId));
}

// 병실 → 타입 매핑
const ROOM_TYPE_MAP = {
  "202":"1인실","302":"1인실","502":"1인실","602":"1인실",
  "204":"2인실","304":"2인실","305":"2인실","504":"2인실",
  "201":"4인실","203":"4인실","301":"4인실","303":"4인실","501":"4인실","503":"4인실",
  "205":"6인실","206":"6인실","306":"6인실","505":"6인실","506":"6인실","601":"6인실","603":"6인실",
};
// 병실료 (1박당)
const ROOM_CHARGE = { "1인실": 180000, "2인실": 120000, "4인실": 60000, "6인실": 0 };
// 주간 기준금액 (병실료 프리 시 변경)
const WEEK_BASE_NORMAL = 1300000;
const WEEK_BASE_FREE   = { "1인실": 2600000, "2인실": 2200000, "4인실": 1800000, "6인실": 1300000 };

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
  const isMobile = useIsMobile();
  const { slotKey, name, discharge, admitDate, patientId } = router.query;

  const roomId = slotKey ? slotKey.split("-")[0] : "";
  const bedNum = slotKey ? slotKey.split("-")[1] : "";

  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [plan,  setPlan]  = useState({});
  const [modalDay,  setModalDay]  = useState(null);
  const [selection, setSelection] = useState({});
  const [copiedDay, setCopiedDay] = useState(null);
  const [roomFree,  setRoomFree]  = useState(false); // 병실료 프리 옵션
  const [weeklyPlan,setWeeklyPlan]= useState({}); // {itemId: {count:N, price:P}} 주N회 계획
  const [showWkPlan,setShowWkPlan]= useState(false); // 주간 계획 패널 토글
  const [resolvedPatientId, setResolvedPatientId] = useState(""); // URL에 없으면 슬롯에서 조회

  useEffect(() => {
    if (!slotKey) return;
    const unsub1 = onValue(ref(db, `treatmentPlans/${slotKey}`), snap => setPlan(snap.val() || {}));
    const unsub2 = onValue(ref(db, `weeklyPlans/${slotKey}`), snap => setWeeklyPlan(snap.val() || {}));
    const unsub3 = onValue(ref(db, `treatmentSettings/${slotKey}`), snap => {
      const s = snap.val();
      if (s?.roomFree !== undefined) setRoomFree(s.roomFree);
    });
    // patientId가 URL에 없으면 슬롯 데이터에서 조회
    if (patientId) {
      setResolvedPatientId(patientId);
    } else {
      get(ref(db, `slots/${slotKey}`)).then(snap => {
        const pid = snap.val()?.current?.patientId;
        if (pid) setResolvedPatientId(pid);
      });
    }
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [slotKey, patientId]);

  const saveWeeklyPlan = useCallback(async (newPlan) => {
    setWeeklyPlan(newPlan);
    await set(ref(db, `weeklyPlans/${slotKey}`), newPlan);
  }, [slotKey]);

  const handleRoomFreeChange = useCallback(async (checked) => {
    setRoomFree(checked);
    await set(ref(db, `treatmentSettings/${slotKey}/roomFree`), checked);
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

  const roomType    = ROOM_TYPE_MAP[roomId] || "6인실";
  const chargePerNight = roomFree ? 0 : (ROOM_CHARGE[roomType] || 0);
  const weekBase    = roomFree ? (WEEK_BASE_FREE[roomType] || WEEK_BASE_NORMAL) : WEEK_BASE_NORMAL;

  // 해당 날짜에 병실료가 부과되는지 (입원일 이상, 퇴원일 미만)
  const hasRoomCharge = (day) => {
    if (chargePerNight === 0) return false;
    const d = new Date(year, month, day);
    const admit = parseDateStr(admitDate);
    if (!admit || d < dateOnly(admit)) return false;
    if (dischargeDate && d >= dateOnly(dischargeDate)) return false;
    return true;
  };

  const dayTotal = (day) => {
    const treatTotal = (monthData[String(day)] || []).reduce((s, e) => s + calcPrice(ALL_ITEMS.find(i => i.id === e.id), e.qty), 0);
    return treatTotal + (hasRoomCharge(day) ? chargePerNight : 0);
  };

  const dayTreatTotal = (day) => {
    const dateObj = new Date(year, month, day);
    return (monthData[String(day)] || []).reduce((s, e) => s + calcPrice(ALL_ITEMS.find(i => i.id === e.id), e.qty, dateObj), 0);
  };

  // 달력에 표시된 날짜 기준 치료 합계 + 병실료
  const allDaysInMonth = Array.from({length: getDaysInMonth(year, month)}, (_,i) => i+1);
  const monthRoomTotal = chargePerNight > 0
    ? allDaysInMonth.filter(d => hasRoomCharge(d)).length * chargePerNight
    : 0;
  const monthTreatTotal = Object.keys(monthData).reduce((s, d) => s + dayTreatTotal(parseInt(d)), 0);
  const monthTotal = monthTreatTotal + monthRoomTotal;

  // 주N회 계획의 주간 예상 금액 (실제 치료 입력 전)
  const weeklyPlanTotal = Object.entries(weeklyPlan).reduce((sum, [itemId, plan]) => {
    const item = ALL_ITEMS.find(i => i.id === itemId);
    if (!item) return sum;
    const unitPrice = item.price || 0;
    return sum + unitPrice * (plan.count || 0);
  }, 0);

  // 주차별 하한선 계산
  // - 7일 이하 단기입원(1주차 단독): 하루당 200,000원
  // - 완전한 1주(7일): weekBase (130만원, roomFree 시 별도)
  // - 7일 초과 잔여일(2주차 이상 불완전): 하루당 185,000원
  const calcWeekMin = (weekNum, hospDays) => {
    if (hospDays >= 7) return weekBase;
    if (weekNum === 1) return hospDays * 200000;
    return hospDays * 185000;
  };

  const weeklyStats = (() => {
    if (!admitDate) return [];
    const admit = parseDateStr(admitDate);
    if (!admit) return [];

    const weeks = {};
    const daysInM = getDaysInMonth(year, month);

    for (let d = 1; d <= daysInM; d++) {
      const thisDate = new Date(year, month, d);
      const diff = Math.floor((dateOnly(thisDate) - dateOnly(admit)) / 86400000);
      if (diff < 0) continue; // 입원일 이전
      // 퇴원일 다음날부터 제외 (퇴원 당일 치료는 포함)
      if (dischargeDate && dateOnly(thisDate) > dateOnly(dischargeDate)) continue;
      const wk = Math.floor(diff / 7) + 1;
      if (!weeks[wk]) weeks[wk] = { total: 0, days: [], startDay: d, planTotal: 0, hospDays: 0 };
      weeks[wk].hospDays++;
      // 치료 있는 날만 합산
      const dayTreat = dayTreatTotal(d);
      if (dayTreat > 0) {
        weeks[wk].total += dayTreat;
        weeks[wk].days.push(d);
      }
    }

    // 주N회 계획: 오늘이 속한 구간에 표시
    if (weeklyPlanTotal > 0) {
      const todayWk = getWeekNumber(admitDate, new Date());
      if (todayWk !== null) {
        if (!weeks[todayWk]) weeks[todayWk] = { total: 0, days: [], planTotal: 0, hospDays: 0 };
        weeks[todayWk].planTotal = weeklyPlanTotal;
      }
    }

    return Object.entries(weeks)
      .filter(([, v]) => v.total > 0 || v.planTotal > 0)
      .map(([wk, v]) => ({ week: parseInt(wk), ...v, weekMin: calcWeekMin(parseInt(wk), v.hospDays) }))
      .sort((a, b) => a.week - b.week);
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
      <header style={{ ...TS.header, flexDirection: isMobile ? "column" : "row", alignItems: isMobile ? "flex-start" : "center", padding: isMobile ? "10px 14px" : "12px 20px", gap: isMobile ? 6 : 16 }}>
        {/* 모바일: 상단 한 줄 — 뒤로 + 환자명 + 인쇄 */}
        <div style={{ display:"flex", alignItems:"center", width:"100%", gap:8 }}>
          <button style={TS.btnBack} onClick={() => router.back()}>← 병실로</button>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize: isMobile ? 16 : 20, fontWeight:800, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
              <span
                onClick={resolvedPatientId ? () => router.push(`/patients?id=${encodeURIComponent(resolvedPatientId)}`) : undefined}
                style={resolvedPatientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}}>
                {name || slotKey}
              </span>님
            </div>
            <div style={{ fontSize:11, color:"#7dd3fc", fontWeight:600 }}>{roomId}호 {bedNum}번 병상{admitDate ? ` · 입원 ${admitDate}` : ""}{discharge && discharge !== "미정" ? ` · 퇴원 ${discharge}` : ""}</div>
          </div>
          <button style={TS.btnPrint} onClick={() => window.print()}>🖨 인쇄</button>
        </div>
        {/* 월 네비 */}
        <div style={{ ...TS.monthNav, width: isMobile ? "100%" : "auto", justifyContent: isMobile ? "center" : "flex-start" }}>
          <button style={TS.btnMonth} onClick={() => { if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); }}>‹</button>
          <span style={TS.monthLabel}>{year}년 {month+1}월</span>
          <button style={TS.btnMonth} onClick={() => { if(month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); }}>›</button>
        </div>
      </header>

      {/* 합계 바 */}
      <div style={TS.totalBar}>
        <span style={TS.totalItem}>
          💊 치료비&nbsp;<strong style={{ color:"#dc2626" }}>{monthTreatTotal.toLocaleString()}원</strong>
        </span>
        {ROOM_CHARGE[roomType] > 0 && (
          <span style={{ ...TS.totalItem, borderLeft:"1px solid #e2e8f0", paddingLeft:14, fontSize:12,
            color: roomFree ? "#94a3b8" : "#0369a1" }}>
            🏠 병실료&nbsp;
            {roomFree
              ? <strong style={{ color:"#94a3b8", textDecoration:"line-through" }}>{monthRoomTotal.toLocaleString()}원</strong>
              : <strong style={{ color:"#0369a1" }}>{monthRoomTotal.toLocaleString()}원</strong>
            }
            {!roomFree && <span style={{ fontSize:11, color:"#64748b", marginLeft:4 }}>
              ({chargePerNight.toLocaleString()}원 × {allDaysInMonth.filter(d=>hasRoomCharge(d)).length}박)
            </span>}
          </span>
        )}
        {ROOM_CHARGE[roomType] > 0 && !roomFree && (
          <span style={{ ...TS.totalItem, borderLeft:"1px solid #e2e8f0", paddingLeft:14, fontWeight:800 }}>
            합계&nbsp;<strong style={{ color:"#dc2626" }}>{monthTotal.toLocaleString()}원</strong>
          </span>
        )}
        <label style={{ display:"flex", alignItems:"center", gap:5, fontSize:12, cursor:"pointer",
          background: roomFree?"#fef9c3":"#f1f5f9", borderRadius:7,
          padding:"3px 10px", border:`1px solid ${roomFree?"#fbbf24":"#e2e8f0"}`, fontWeight:700,
          color: roomFree?"#92400e":"#64748b", flexShrink:0 }}>
          <input type="checkbox" checked={roomFree} onChange={e=>handleRoomFreeChange(e.target.checked)}/>
          🎁 병실료 Free
          {roomFree && <span style={{ fontSize:11, color:"#059669", marginLeft:4 }}>
            (치료 기준 {(weekBase/10000).toFixed(0)}만원/주)
          </span>}
        </label>
        <button onClick={()=>setShowWkPlan(p=>!p)}
          style={{ background:showWkPlan?"#0f2744":"#f1f5f9", color:showWkPlan?"#fff":"#475569",
            border:"1px solid #e2e8f0", borderRadius:7, padding:"3px 12px", cursor:"pointer",
            fontSize:12, fontWeight:700, flexShrink:0 }}>
          📋 주N회 계획 {Object.keys(weeklyPlan).length>0?`(${Object.keys(weeklyPlan).length}종)`:""} {showWkPlan?"▲":"▼"}
        </button>
        {weeklyStats.map(wk => (
          <span key={wk.week} style={{ ...TS.totalItem, borderLeft:"1px solid #e2e8f0", paddingLeft:14 }}>
            {wk.week}주차&nbsp;
            <strong style={{ color: wk.total>=wk.weekMin?"#16a34a":"#dc2626" }}>{Math.floor(wk.total/10000)}만원</strong>
            <span style={{ fontSize:11, marginLeft:3, color: wk.total>=wk.weekMin?"#16a34a":"#dc2626" }}>
              {wk.total>=wk.weekMin ? "✓ 충족" : `(${Math.floor((wk.weekMin-wk.total)/10000)}만 부족)`}
            </span>
            {wk.hospDays < 7 && <span style={{ fontSize:10, marginLeft:3, color:"#94a3b8" }}>({wk.hospDays}일×{wk.week===1?"20":"18.5"}만)</span>}
            {wk.planTotal>0 && <span style={{ fontSize:11, marginLeft:4, color:"#0369a1" }}>+계획{Math.floor(wk.planTotal/10000)}만</span>}
          </span>
        ))}
        {copiedDay && (
          <span style={{ ...TS.totalItem, color:"#7c3aed", marginLeft:"auto" }}>
            📋 {copiedDay.monthKey.slice(5)}월 {copiedDay.day}일 복사됨
            <button style={TS.btnClearCopy} onClick={() => setCopiedDay(null)}>✕</button>
          </span>
        )}
      </div>

      {/* 주N회 계획 패널 */}
      {showWkPlan && (
        <div style={{ background:"#f0f9ff", borderBottom:"1px solid #bae6fd", padding:"12px 20px" }}>
          <div style={{ display:"flex", alignItems:"center", flexWrap:"wrap", gap:10, marginBottom:10 }}>
            <span style={{ fontSize:14, fontWeight:800, color:"#0369a1" }}>📋 주간 치료 계획 (주N회)</span>
            <span style={{ fontSize:12, color:"#64748b" }}>— 실제 입력 시 날짜에 반영되고 계획에서 제거됩니다</span>
            {resolvedPatientId && (
              <button onClick={() => router.push(`/patients?id=${encodeURIComponent(resolvedPatientId)}`)}
                style={{ marginLeft:"auto", background:"#0f2744", color:"#fff", border:"none", borderRadius:7,
                  padding:"4px 14px", cursor:"pointer", fontSize:13, fontWeight:700, flexShrink:0 }}>
                👤 환자 정보
              </button>
            )}
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:10 }}>
            {TREATMENT_GROUPS.flatMap(g=>g.items).filter(item=>
              ["hyperthermia","pain","manip2","manip1","hyperbaric"].includes(item.id)
            ).map(item=>{
              const plan = weeklyPlan[item.id];
              const grp = getItemGroup(item.id);
              return (
                <div key={item.id} style={{ display:"flex", alignItems:"center", gap:6,
                  background:"#fff", border:`1.5px solid ${grp?.color||"#e2e8f0"}`,
                  borderRadius:8, padding:"6px 12px" }}>
                  <span style={{ fontSize:13, fontWeight:700, color:grp?.color }}>{item.name}</span>
                  <span style={{ fontSize:12, color:"#64748b" }}>주</span>
                  <select value={plan?.count||0}
                    onChange={e=>{
                      const v=parseInt(e.target.value);
                      const newP={...weeklyPlan};
                      if(v===0) delete newP[item.id];
                      else newP[item.id]={count:v, price:item.price};
                      saveWeeklyPlan(newP);
                    }}
                    style={{ border:"1px solid #e2e8f0", borderRadius:5, padding:"2px 6px", fontSize:13, outline:"none" }}>
                    {[0,1,2,3,4,5,6,7].map(n=><option key={n} value={n}>{n===0?"미설정":`${n}회`}</option>)}
                  </select>
                  {plan?.count>0 && (
                    <span style={{ fontSize:11, color:"#0369a1" }}>
                      = {(item.price*(plan.count||0)).toLocaleString()}원/주
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {weeklyPlanTotal>0 && (
            <div style={{ fontSize:13, fontWeight:700, color:"#0369a1" }}>
              주간 계획 합계: <strong>{weeklyPlanTotal.toLocaleString()}원/주</strong>
              &nbsp;(7주: {(weeklyPlanTotal*7).toLocaleString()}원)
            </div>
          )}
        </div>
      )}

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
                {hasRoomCharge(day) && !roomFree && (
                  <div style={{ fontSize:9, color:"#0369a1", fontWeight:600 }}>🏠{(chargePerNight/10000)}만</div>
                )}
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
                  <td colSpan={3} style={{ ...TS.td, fontWeight:800 }}>💊 치료비 합계</td>
                  <td style={{ ...TS.td, textAlign:"right", fontWeight:800, color:"#dc2626", fontSize:15 }}>{monthTreatTotal.toLocaleString()}원</td>
                </tr>
                {ROOM_CHARGE[roomType] > 0 && (
                  <tr style={{ background:"#f0f9ff" }}>
                    <td colSpan={3} style={{ ...TS.td, fontWeight:700, color:"#0369a1" }}>
                      🏠 병실료 ({roomType} {chargePerNight.toLocaleString()}원 × {allDaysInMonth.filter(d=>hasRoomCharge(d)).length}박)
                      {roomFree && <span style={{ marginLeft:6, color:"#94a3b8", fontWeight:400 }}>→ Free 적용</span>}
                    </td>
                    <td style={{ ...TS.td, textAlign:"right", fontWeight:700,
                      color: roomFree?"#94a3b8":"#0369a1",
                      textDecoration: roomFree?"line-through":"none" }}>
                      {monthRoomTotal.toLocaleString()}원
                    </td>
                  </tr>
                )}
                {ROOM_CHARGE[roomType] > 0 && !roomFree && (
                  <tr style={{ background:"#fff0f0" }}>
                    <td colSpan={3} style={{ ...TS.td, fontWeight:800 }}>총 합계</td>
                    <td style={{ ...TS.td, textAlign:"right", fontWeight:800, color:"#dc2626", fontSize:16 }}>{monthTotal.toLocaleString()}원</td>
                  </tr>
                )}
                {weeklyStats.map(wk => (
                  <tr key={wk.week} style={{ background: wk.total>=wk.weekMin?"#f0fdf4":"#fef2f2" }}>
                    <td colSpan={3} style={{ ...TS.td, fontSize:13 }}>
                      {wk.week}주차
                      <span style={{ fontSize:11, color:"#64748b", marginLeft:8 }}>({wk.days.map(d=>`${month+1}/${d}`).join(", ")})</span>
                      {wk.hospDays < 7 && <span style={{ fontSize:10, color:"#94a3b8", marginLeft:6 }}>하한 {(wk.weekMin/10000).toFixed(1)}만원 ({wk.hospDays}일)</span>}
                    </td>
                    <td style={{ ...TS.td, textAlign:"right", fontWeight:700, color:wk.total>=wk.weekMin?"#16a34a":"#dc2626" }}>
                      {wk.total.toLocaleString()}원 {wk.total>=wk.weekMin?"✓ 충족":"✗ 미충족"}
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
                        <span style={{ color:"#64748b", fontSize:12, marginLeft:8 }}>{calcPrice(item,e.qty,new Date(year,month,modalDay)).toLocaleString()}원</span>
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
        admitDate={admitDate} discharge={discharge}
      />
    </div>
  );
}

// ── 인쇄 전용 컴포넌트 ──────────────────────────────────────────────────────
function PrintView({ name, roomId, bedNum, year, month, monthData, firstDow, daysInMonth,
  admitDate, discharge }) {
  const allItems = TREATMENT_GROUPS.flatMap(g => g.items);

  const calCells = [];
  for (let i = 0; i < firstDow; i++) calCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calCells.push(d);
  while (calCells.length % 7 !== 0) calCells.push(null);
  const weeks = [];
  for (let i = 0; i < calCells.length; i += 7) weeks.push(calCells.slice(i, i+7));

  // 주 수에 따라 셀 높이 및 폰트 동적 계산 (A4 세로 297mm - 여백 - 헤더 - 푸터)
  const numWeeks = weeks.length;
  // A4(297mm) - 상하여백16mm - 헤더18mm - 요일행9mm - 푸터12mm = 약242mm
  const rowHeightMm = Math.floor(242 / numWeeks);
  // 날짜 숫자 / 치료 항목 폰트 — 주 수에 따라 최대한 크게
  const dayNumFontPx = numWeeks <= 4 ? 28 : numWeeks === 5 ? 22 : 18;
  const treatFontPx  = numWeeks <= 4 ? 22 : numWeeks === 5 ? 17 : 14;

  return (
    <div className="ewoo-print-area" style={{ display:"none" }}>
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 0; }
          html, body {
            width: 210mm; height: 297mm;
            margin: 0 !important; padding: 0 !important;
            overflow: hidden !important;
          }
          body * { visibility: hidden !important; }
          .ewoo-print-area, .ewoo-print-area * { visibility: visible !important; }
          .ewoo-print-area {
            position: absolute; top: 0; left: 0;
            width: 210mm; height: 297mm;
            background: white; z-index: 9999; display: flex !important;
            flex-direction: column; box-sizing: border-box;
            padding: 8mm 10mm;
            overflow: hidden;
          }
          .print-cal-table { flex: 1; border-collapse: collapse; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
        @media screen { .ewoo-print-area { display: none !important; } }
      `}</style>
      <div style={{ fontFamily:"'Noto Sans KR', sans-serif", color:"#000",
        display:"flex", flexDirection:"column", height:"100%", gap:0 }}>

        {/* 헤더 */}
        <div style={{ borderBottom:"2px solid #0f4c35", paddingBottom:6, marginBottom:8, flexShrink:0 }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:12, flexWrap:"wrap" }}>
            <span style={{ fontSize:30, fontWeight:900, color:"#0f2744", lineHeight:1.1 }}>치료 일정표</span>
            <span style={{ fontSize:21, fontWeight:700, color:"#334155" }}>
              {year}년 {month+1}월 &nbsp;·&nbsp; {roomId}호 {bedNum}번 &nbsp;·&nbsp;
              <span style={{ fontSize:26, fontWeight:900 }}>{name}</span>님
            </span>
            {admitDate && <span style={{ fontSize:18, color:"#64748b", marginLeft:4 }}>
              입원 {admitDate}{discharge && discharge!=="미정" ? ` · 퇴원예정 ${discharge}` : ""}
            </span>}
          </div>
        </div>

        {/* 달력 — flex:1로 남은 공간 꽉 채움 */}
        <table className="print-cal-table" style={{ width:"100%", borderCollapse:"collapse",
          tableLayout:"fixed", flex:1 }}>
          <thead>
            <tr>
              {DAY_KO.map((d, i) => (
                <th key={d} style={{ border:"1px solid #bbb", padding:"4px 0",
                  fontSize:14, fontWeight:800, textAlign:"center", background:"#f0f0f0",
                  color: i===0?"#cc0000":i===6?"#0033cc":"#222", width:"14.28%" }}>
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, wi) => (
              <tr key={wi} style={{ height:`${rowHeightMm}mm` }}>
                {week.map((day, di) => {
                  if (!day) return (
                    <td key={di} style={{ border:"1px solid #ddd", background:"#f9f9f9" }} />
                  );
                  const dow   = (firstDow + day - 1) % 7;
                  const items = monthData[String(day)] || [];
                  return (
                    <td key={di} style={{ border:"1px solid #ddd", verticalAlign:"top",
                      padding:"3px 5px", background:"#fff" }}>
                      {/* 날짜 */}
                      <div style={{ fontSize:dayNumFontPx, fontWeight:900, marginBottom:2,
                        color: dow===0?"#cc0000":dow===6?"#0033cc":"#222" }}>
                        {day}
                      </div>
                      {/* 치료 항목만 — 금액 없음 */}
                      {items.map(e => {
                        const item = allItems.find(i => i.id === e.id);
                        if (!item) return null;
                        const grp = TREATMENT_GROUPS.find(g => g.items.some(i => i.id === e.id));
                        const label = item.custom==="vitc" ? `비타민C ${e.qty}g`
                                    : item.custom==="qty"  ? `${item.name} ${e.qty}개`
                                    : item.name;
                        return (
                          <div key={e.id} style={{ fontSize:treatFontPx, lineHeight:1.3, color:"#111",
                            borderLeft:`3px solid ${grp?.color||"#555"}`,
                            paddingLeft:4, marginBottom:2 }}>
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

        {/* 하단 로고 */}
        <div style={{ flexShrink:0, marginTop:4, paddingTop:4, borderTop:"1px solid #ddd",
          display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <img src="/ewoo-logo.png" alt="이우요양병원"
            style={{ height:28, objectFit:"contain" }}/>
          <div style={{ fontSize:10, color:"#aaa" }}>
            출력일: {new Date().toLocaleDateString("ko-KR")}
          </div>
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
  btnBack: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontSize:14, fontWeight:600, flexShrink:0 },
  headerCenter: { flex:1, textAlign:"center" },
  roomLabel: { fontSize:14, color:"#7dd3fc", fontWeight:600, marginBottom:2 },
  patientLabel: { fontSize:22, fontWeight:800 },
  subLabel: { fontSize:13, color:"#94a3b8", marginTop:2 },
  monthNav: { display:"flex", alignItems:"center", gap:10, flexShrink:0 },
  btnMonth: { background:"rgba(255,255,255,0.1)", border:"none", color:"#fff", borderRadius:6, width:36, height:36, cursor:"pointer", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center" },
  monthLabel: { fontSize:17, fontWeight:700, minWidth:100, textAlign:"center" },
  totalBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", display:"flex", alignItems:"center", flexWrap:"wrap", gap:16, padding:"11px 20px" },
  totalItem: { fontSize:14, color:"#0f2744", display:"flex", alignItems:"center", gap:4 },
  btnClearCopy: { background:"none", border:"none", color:"#7c3aed", cursor:"pointer", fontSize:14, marginLeft:4 },
  calWrap: { padding:"14px 12px 0", overflowX:"auto" },
  calGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4 },
  dowCell: { textAlign:"center", fontSize:14, fontWeight:700, padding:"7px 0" },
  emptyCell: { minHeight:100 },
  dayCell: { minHeight:100, borderRadius:8, padding:"6px", cursor:"pointer", display:"flex", flexDirection:"column", transition:"box-shadow 0.15s" },
  dayNum: { width:26, height:26, borderRadius:"50%", fontSize:14, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dischargeTag: { fontSize:10, fontWeight:700, color:"#d97706", background:"#fef3c7", borderRadius:3, padding:"1px 5px", marginBottom:2 },
  tagList: { display:"flex", flexDirection:"column", gap:2, flex:1, overflow:"hidden" },
  tag: { fontSize:12, fontWeight:700, borderRadius:4, padding:"2px 6px", border:"1px solid", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  dayTotalLabel: { fontSize:11, fontWeight:800, color:"#dc2626", textAlign:"right", marginTop:"auto" },
  summaryWrap: { padding:"18px 20px 32px" },
  summaryTitle: { fontSize:17, fontWeight:800, color:"#0f2744", marginBottom:12 },
  table: { width:"100%", borderCollapse:"collapse", background:"#fff", borderRadius:10, overflow:"hidden", boxShadow:"0 1px 6px rgba(0,0,0,0.06)" },
  th: { background:"#0f2744", color:"#fff", padding:"11px 16px", fontSize:14, fontWeight:700, textAlign:"left" },
  td: { padding:"10px 16px", fontSize:14, borderBottom:"1px solid #f1f5f9", verticalAlign:"middle" },
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", display:"flex", alignItems:"flex-start", justifyContent:"center", zIndex:1000, overflowY:"auto", padding:"20px 0" },
  modal: { background:"#fff", borderRadius:14, width:"100%", maxWidth:660, margin:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.22)", overflow:"hidden" },
  modalHeader: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px" },
  modalTitle: { fontSize:17, fontWeight:800 },
  btnClose: { background:"none", border:"none", color:"#94a3b8", fontSize:20, cursor:"pointer" },
  btnCopy:  { background:"rgba(255,255,255,0.12)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 },
  btnPaste: { background:"#7c3aed", border:"none", color:"#fff", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 },
  registeredList: { padding:"14px 20px", background:"#f8fafc", borderBottom:"1px solid #e2e8f0" },
  regItem: { display:"flex", alignItems:"center", gap:8, padding:"8px 12px", marginBottom:6, background:"#fff", borderRadius:8, borderLeft:"3px solid", boxShadow:"0 1px 3px rgba(0,0,0,0.05)" },
  btnRemove: { background:"#fee2e2", border:"none", color:"#dc2626", borderRadius:5, width:26, height:26, cursor:"pointer", fontSize:13, fontWeight:800, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 },
  dayTotalRow: { textAlign:"right", fontSize:14, color:"#0f2744", paddingTop:8, borderTop:"1px dashed #e2e8f0", marginTop:6 },
  addSection: { padding:"14px 20px", maxHeight:"44vh", overflowY:"auto" },
  addTitle: { fontSize:14, fontWeight:700, color:"#64748b", marginBottom:10, background:"#f0f9ff", borderRadius:6, padding:"7px 12px" },
  groupBlock: { marginBottom:14 },
  groupLabel: { fontSize:13, fontWeight:800, letterSpacing:0.3, marginBottom:6 },
  itemRow: { display:"flex", flexWrap:"wrap", gap:6 },
  itemBtn: { border:"1.5px solid", borderRadius:7, padding:"6px 13px", cursor:"pointer", fontSize:13, fontWeight:600, transition:"all 0.15s" },
  qtyRow: { display:"flex", alignItems:"center", gap:8, marginTop:7, flexWrap:"wrap", paddingLeft:10, borderLeft:"2px solid #e2e8f0" },
  qtySelect: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"5px 10px", fontSize:13, outline:"none", fontFamily:"inherit" },
  qtyInput: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"5px 10px", fontSize:13, outline:"none", width:70, fontFamily:"inherit" },
  registerBar: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 20px", background:"#f0fdf4", borderTop:"1px solid #bbf7d0" },
  btnRegister: { background:"#16a34a", color:"#fff", border:"none", borderRadius:8, padding:"10px 24px", cursor:"pointer", fontSize:15, fontWeight:800 },
  btnPrint: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontSize:14, fontWeight:600, flexShrink:0 },
};

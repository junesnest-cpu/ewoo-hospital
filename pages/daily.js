import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { ref, onValue } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const WARD_STRUCTURE = {
  2: { name: "2병동", rooms: [
    { id:"201",capacity:4 },{ id:"202",capacity:1 },{ id:"203",capacity:4 },
    { id:"204",capacity:2 },{ id:"205",capacity:6 },{ id:"206",capacity:6 },
  ]},
  3: { name: "3병동", rooms: [
    { id:"301",capacity:4 },{ id:"302",capacity:1 },{ id:"303",capacity:4 },
    { id:"304",capacity:2 },{ id:"305",capacity:2 },{ id:"306",capacity:6 },
  ]},
  5: { name: "5병동", rooms: [
    { id:"501",capacity:4 },{ id:"502",capacity:1 },{ id:"503",capacity:4 },
    { id:"504",capacity:2 },{ id:"505",capacity:6 },{ id:"506",capacity:6 },
  ]},
  6: { name: "6병동", rooms: [
    { id:"601",capacity:6 },{ id:"602",capacity:1 },{ id:"603",capacity:6 },
  ]},
};

const TREATMENT_GROUPS = [
  { group:"고주파 온열치료", color:"#dc2626", bg:"#fef2f2",
    items:[{ id:"hyperthermia", name:"고주파 온열치료" }, { id:"hyperbaric", name:"고압산소치료" }] },
  { group:"싸이모신알파1", color:"#7c3aed", bg:"#faf5ff",
    items:[{ id:"zadaxin",name:"자닥신" },{ id:"imualpha",name:"이뮤알파" },{ id:"scion",name:"싸이원주" }] },
  { group:"수액류", color:"#0ea5e9", bg:"#f0f9ff",
    items:[
      { id:"glutathione",name:"글루타치온" },{ id:"dramin",name:"닥터라민+지씨멀티주" },
      { id:"thioctic",name:"티옥트산" },{ id:"gt",name:"G+T" },
      { id:"myers1",name:"마이어스1" },{ id:"myers2",name:"마이어스2" },
      { id:"selenium_iv",name:"셀레늄" },{ id:"vitd",name:"비타민D" },
      { id:"vitc",name:"고용량 비타민C",custom:"vitc" },
    ] },
  { group:"물리치료", color:"#059669", bg:"#f0fdf4",
    items:[{ id:"pain",name:"페인스크렘블러" },{ id:"manip2",name:"도수치료2" },{ id:"manip1",name:"도수치료1" }] },
  { group:"경구제", color:"#d97706", bg:"#fffbeb",
    items:[
      { id:"meshima",name:"메시마F",custom:"qty" },{ id:"selenase_l",name:"셀레나제액상",custom:"qty" },
      { id:"selenase_t",name:"셀레나제정",custom:"qty" },{ id:"selenase_f",name:"셀레나제필름",custom:"qty" },
    ] },
];

const ALL_ITEMS = TREATMENT_GROUPS.flatMap(g => g.items);
const DAY_KO = ["일","월","화","수","목","금","토"];

function toInputValue(d) { return d.toISOString().slice(0,10); }
function toKoreanDate(d) {
  return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${DAY_KO[d.getDay()]})`;
}
function getMonthKey(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function getDayKey(d)   { return String(d.getDate()); }

function itemLabel(e) {
  const item = ALL_ITEMS.find(i => i.id === e.id);
  if (!item) return e.id;
  if (item.custom === "vitc") return `비타민C ${e.qty}g`;
  if (item.custom === "qty")  return `${item.name} ${e.qty}개`;
  return item.name;
}

export default function DailyPage() {
  const router = useRouter();
  const today  = new Date();
  today.setHours(0,0,0,0);

  const [selectedDate, setSelectedDate] = useState(today);
  const [dateInput,    setDateInput]    = useState(toInputValue(today));
  const [slots,        setSlots]        = useState({});
  const [treatPlans,   setTreatPlans]   = useState({});
  const [loading,      setLoading]      = useState(true);
  // 치료 종류별 필터
  const [filterGroup,  setFilterGroup]  = useState(null);
  const [physSched,    setPhysSched]    = useState({});
  const [hyperSched,   setHyperSched]   = useState({});
  const [therapists,   setTherapists]   = useState(["치료사1","치료사2"]);

  useEffect(() => {
    const unsubS  = onValue(ref(db, "slots"),                snap => setSlots(snap.val() || {}));
    const unsubT  = onValue(ref(db, "treatmentPlans"),        snap => { setTreatPlans(snap.val() || {}); setLoading(false); });
    const unsubP  = onValue(ref(db, "physicalSchedule"),      snap => setPhysSched(snap.val() || {}));
    const unsubH  = onValue(ref(db, "hyperthermiaSchedule"),  snap => setHyperSched(snap.val() || {}));
    const unsubSt = onValue(ref(db, "settings"),              snap => { const v=snap.val()||{}; setTherapists([v.therapist1||"치료사1",v.therapist2||"치료사2"]); });
    return () => { unsubS(); unsubT(); unsubP(); unsubH(); unsubSt(); };
  }, []);

  const applyDate = () => {
    const d = new Date(dateInput + "T00:00:00");
    setSelectedDate(d);
  };

  // 선택 날짜 기준으로 치료 있는 환자 취합
  const monthKey = getMonthKey(selectedDate);
  const dayKey   = getDayKey(selectedDate);

  // ── 치료 시간 매핑 ───────────────────────────────────────────────────────
  // 선택 날짜의 요일 인덱스 (월=0)
  const dow = selectedDate.getDay(); // 0=일,1=월..6=토
  const dayIdx = String(dow === 0 ? 6 : dow - 1);
  // physicalSchedule 주 키 계산
  function getWeekStart(d) { const x=new Date(d); const dw=x.getDay(); x.setDate(x.getDate()+(dw===0?-6:1-dw)); x.setHours(0,0,0,0); return x; }
  const wk = getWeekStart(selectedDate).toISOString().slice(0,10);

  // slotKey → {physical: "HH:MM", hyperthermia: "HH:MM", hyperbaric: "HH:MM"} 시간 맵
  const timeMap = {};
  // 물리치료 (치료사1·2)
  therapists.forEach(th => {
    const phDay = physSched[wk]?.[th];
    const phDayData = phDay?.[dayIdx] || phDay?.[parseInt(dayIdx)] || {};
    Object.entries(phDayData).forEach(([time, data]) => {
      if (!data?.slotKey) return;
      if (!timeMap[data.slotKey]) timeMap[data.slotKey] = {};
      if (!timeMap[data.slotKey].physical) timeMap[data.slotKey].physical = time.slice(0,5);
    });
  });
  // 고주파 — dayIdx 숫자/문자열 모두 커버
  const htDay = hyperSched[wk]?.["hyperthermia"];
  const htDayData = htDay?.[dayIdx] || htDay?.[parseInt(dayIdx)] || {};
  Object.entries(htDayData).forEach(([time, data]) => {
    if (!data?.slotKey) return;
    if (!timeMap[data.slotKey]) timeMap[data.slotKey] = {};
    timeMap[data.slotKey].hyperthermia = time.slice(0,5);
  });
  // 고압산소 (a/b 슬롯) — dayIdx 숫자/문자열 모두 커버
  const hbDay = hyperSched[wk]?.["hyperbaric"];
  const hbDayData = hbDay?.[dayIdx] || hbDay?.[parseInt(dayIdx)] || {};
  Object.entries(hbDayData).forEach(([time, slots_]) => {
    // slots_가 {a:{...}, b:{...}} 형태인지 확인
    // 구형 저장 방식(직접 객체)도 처리
    const entries = (slots_ && (slots_.a || slots_.b))
      ? [["a", slots_.a], ["b", slots_.b]]
      : [["_", slots_]];
    entries.forEach(([, data]) => {
      if (!data?.slotKey) return;
      if (!timeMap[data.slotKey]) timeMap[data.slotKey] = {};
      const t = (data.subTime || time).slice(0,5);
      if (!timeMap[data.slotKey].hyperbaric) timeMap[data.slotKey].hyperbaric = t;
      else if (!timeMap[data.slotKey].hyperbaric.includes(t)) timeMap[data.slotKey].hyperbaric += `·${t}`;
    });
  });

  const dailyList = []; // { wardName, roomId, bedNum, slotKey, patientName, items, timeMap }

  Object.entries(WARD_STRUCTURE).forEach(([, ward]) => {
    ward.rooms.forEach(room => {
      for (let b = 1; b <= room.capacity; b++) {
        const slotKey = `${room.id}-${b}`;
        // 현재 입원 환자 이름
        const patientName = slots[slotKey]?.current?.name;
        if (!patientName) continue;
        // 치료 계획 확인
        const items = treatPlans[slotKey]?.[monthKey]?.[dayKey];
        if (!items || items.length === 0) continue;
        dailyList.push({
          wardName: ward.name,
          roomId:   room.id,
          bedNum:   b,
          slotKey,
          patientName,
          items,
          times: timeMap[slotKey] || {},
        });
      }
    });
  });

  // 필터 적용
  const filtered = filterGroup
    ? dailyList.filter(p => p.items.some(e => TREATMENT_GROUPS.find(g => g.group === filterGroup)?.items.some(i => i.id === e.id)))
    : dailyList;

  // 치료 종류별 집계 (당일 몇 명)
  const groupCounts = TREATMENT_GROUPS.map(g => ({
    group: g.group, color: g.color, bg: g.bg,
    count: dailyList.filter(p => p.items.some(e => g.items.some(i => i.id === e.id))).length,
  })).filter(g => g.count > 0);

  const isToday = selectedDate.getTime() === today.getTime();

  return (
    <div style={DS.page}>
      {/* 헤더 */}
      <header style={DS.header}>
        <div style={DS.headerCenter}>
          <div style={DS.headerTitle}>일일 치료 일정</div>
          <div style={DS.headerSub}>{toKoreanDate(selectedDate)}</div>
        </div>
        <div style={DS.dateNav}>
          <button style={DS.btnDay} onClick={() => {
            const d = new Date(selectedDate); d.setDate(d.getDate()-1);
            setSelectedDate(d); setDateInput(toInputValue(d));
          }}>‹ 전날</button>
          <input type="date" style={DS.dateInput} value={dateInput}
            onChange={e => setDateInput(e.target.value)}
            onBlur={applyDate} onKeyDown={e => e.key==="Enter" && applyDate()} />
          <button style={DS.btnDay} onClick={() => {
            const d = new Date(selectedDate); d.setDate(d.getDate()+1);
            setSelectedDate(d); setDateInput(toInputValue(d));
          }}>다음 ›</button>
          {!isToday && (
            <button style={{ ...DS.btnDay, background:"#065f46", color:"#6ee7b7" }}
              onClick={() => { setSelectedDate(new Date(today)); setDateInput(toInputValue(today)); }}>
              오늘
            </button>
          )}
          <button style={DS.btnPrint} onClick={() => window.print()}>🖨 인쇄</button>
        </div>
      </header>

      {/* 요약 바 */}
      <div style={DS.summaryBar}>
        <span style={DS.summaryTotal}>
          총 <strong style={{ color:"#0ea5e9", fontSize:18 }}>{filtered.length}</strong>명
          {filterGroup && <span style={{ color:"#94a3b8", fontSize:12, marginLeft:6 }}>({filterGroup} 필터 중)</span>}
        </span>
        <div style={DS.groupFilters}>
          <button style={{ ...DS.filterBtn, background: filterGroup===null?"#0f2744":"#f1f5f9", color: filterGroup===null?"#fff":"#64748b" }}
            onClick={() => setFilterGroup(null)}>전체</button>
          {groupCounts.map(g => (
            <button key={g.group}
              style={{ ...DS.filterBtn, background: filterGroup===g.group ? g.color : g.bg, color: filterGroup===g.group ? "#fff" : g.color, borderColor: g.color }}
              onClick={() => setFilterGroup(filterGroup===g.group ? null : g.group)}>
              {g.group} ({g.count})
            </button>
          ))}
        </div>
      </div>

      {/* 본문 */}
      <main style={DS.main}>
        {loading ? (
          <div style={DS.empty}>불러오는 중...</div>
        ) : filtered.length === 0 ? (
          <div style={DS.empty}>
            {dailyList.length === 0
              ? "이 날 치료 일정이 없습니다."
              : "선택한 치료 종류의 환자가 없습니다."}
          </div>
        ) : (
          // 병동별로 묶어서 표시
          Object.entries(WARD_STRUCTURE).map(([wardNo, ward]) => {
            const wardPatients = filtered.filter(p => p.wardName === ward.name);
            if (wardPatients.length === 0) return null;
            return (
              <div key={wardNo} style={DS.wardBlock}>
                <div style={DS.wardTitle}>{ward.name} — {wardPatients.length}명</div>
                <div style={DS.cardGrid}>
                  {wardPatients.map(p => (
                    <div key={p.slotKey} style={DS.card}>
                      {/* 환자 정보 */}
                      <div style={DS.cardHeader}>
                        <div style={DS.roomBadge}>{p.roomId}호 {p.bedNum}번</div>
                        <div style={DS.patientName}>{p.patientName}님</div>
                        <button style={DS.btnDetail}
                          onClick={() => router.push(`/treatment?slotKey=${encodeURIComponent(p.slotKey)}&name=${encodeURIComponent(p.patientName)}`)}>
                          일정표 →
                        </button>
                      </div>
                      {/* 치료 항목 */}
                      <div style={DS.itemList}>
                        {p.items.map(e => {
                          const grp = TREATMENT_GROUPS.find(g => g.items.some(i => i.id === e.id));
                          return (
                            <span key={e.id} style={{ ...DS.itemTag, background: grp?.bg, color: grp?.color, borderColor: grp?.color }}>
                              {itemLabel(e)}
                              {e.id==="pain"||e.id==="manip1"||e.id==="manip2" ? (p.times.physical ? <span style={{fontSize:9,opacity:0.75,marginLeft:3}}>({p.times.physical})</span> : null) : null}
                              {e.id==="hyperthermia" && p.times.hyperthermia ? <span style={{fontSize:9,opacity:0.75,marginLeft:3}}>({p.times.hyperthermia})</span> : null}
                              {e.id==="hyperbaric"   && p.times.hyperbaric   ? <span style={{fontSize:9,opacity:0.75,marginLeft:3}}>({p.times.hyperbaric})</span>   : null}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </main>

      {/* 인쇄 전용 영역 */}
      <div className="print-only" style={{ display:"none" }}>
        <style>{`
          @media print {
            @page { size: A4 portrait; margin: 15mm 12mm; }
            body * { visibility: hidden !important; }
            .print-only, .print-only * { visibility: visible !important; }
            .print-only { position: fixed; top:0; left:0; width:100%; background:white; z-index:9999; display:block !important; }
          }
        `}</style>
        <div style={{ fontFamily:"'Noto Sans KR',sans-serif", color:"#000" }}>
          <div style={{ textAlign:"center", borderBottom:"2px solid #000", paddingBottom:8, marginBottom:14 }}>
            <div style={{ fontSize:18, fontWeight:800 }}>일일 치료 일정표</div>
            <div style={{ fontSize:13, marginTop:3 }}>{toKoreanDate(selectedDate)} · 총 {dailyList.length}명</div>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <thead>
              <tr style={{ background:"#f0f0f0" }}>
                <th style={PS.th}>병동</th>
                <th style={PS.th}>병실·병상</th>
                <th style={PS.th}>환자명</th>
                <th style={{ ...PS.th, textAlign:"left" }}>치료 내용</th>
              </tr>
            </thead>
            <tbody>
              {dailyList.map(p => (
                <tr key={p.slotKey}>
                  <td style={{ ...PS.td, textAlign:"center" }}>{p.wardName}</td>
                  <td style={{ ...PS.td, textAlign:"center" }}>{p.roomId}호 {p.bedNum}번</td>
                  <td style={{ ...PS.td, textAlign:"center", fontWeight:700 }}>{p.patientName}님</td>
                  <td style={PS.td}>{p.items.map(e => itemLabel(e)).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop:10, fontSize:9, color:"#888", textAlign:"right" }}>
            출력일: {new Date().toLocaleDateString("ko-KR")}
          </div>
        </div>
      </div>
    </div>
  );
}

const DS = {
  page: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", gap:16, padding:"12px 20px", boxShadow:"0 2px 12px rgba(0,0,0,0.18)", flexWrap:"wrap" },
  btnBack: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600, flexShrink:0 },
  headerCenter: { flex:1, textAlign:"center" },
  headerTitle: { fontSize:18, fontWeight:800 },
  headerSub: { fontSize:12, color:"#7dd3fc", marginTop:2 },
  dateNav: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  btnDay: { background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#fff", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 },
  dateInput: { border:"1px solid rgba(255,255,255,0.3)", background:"rgba(255,255,255,0.1)", color:"#fff", borderRadius:6, padding:"5px 8px", fontSize:13, outline:"none", fontFamily:"inherit" },
  btnPrint: { background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 },
  summaryBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"10px 20px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" },
  summaryTotal: { fontSize:15, fontWeight:700, color:"#0f2744", flexShrink:0 },
  groupFilters: { display:"flex", gap:6, flexWrap:"wrap" },
  filterBtn: { border:"1.5px solid #e2e8f0", borderRadius:7, padding:"4px 12px", cursor:"pointer", fontSize:12, fontWeight:700 },
  main: { padding:"20px" },
  empty: { textAlign:"center", color:"#94a3b8", fontSize:15, marginTop:60 },
  wardBlock: { marginBottom:24 },
  wardTitle: { fontSize:15, fontWeight:800, color:"#0f2744", borderLeft:"4px solid #0ea5e9", paddingLeft:10, marginBottom:12 },
  cardGrid: { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:10 },
  card: { background:"#fff", borderRadius:12, padding:"14px", boxShadow:"0 1px 6px rgba(0,0,0,0.07)", border:"1px solid #e2e8f0" },
  cardHeader: { display:"flex", alignItems:"center", gap:8, marginBottom:10 },
  roomBadge: { background:"#0f2744", color:"#fff", borderRadius:6, padding:"2px 8px", fontSize:11, fontWeight:700, flexShrink:0 },
  patientName: { fontSize:15, fontWeight:800, flex:1 },
  btnDetail: { background:"#f0f9ff", color:"#0ea5e9", border:"1px solid #bae6fd", borderRadius:6, padding:"3px 10px", cursor:"pointer", fontSize:11, fontWeight:700, flexShrink:0 },
  itemList: { display:"flex", flexWrap:"wrap", gap:5 },
  itemTag: { fontSize:11, fontWeight:700, borderRadius:5, padding:"2px 8px", border:"1px solid" },
};

const PS = {
  th: { border:"1px solid #ccc", padding:"7px 10px", fontWeight:700, textAlign:"center", background:"#f0f0f0" },
  td: { border:"1px solid #ccc", padding:"7px 10px", verticalAlign:"middle" },
};

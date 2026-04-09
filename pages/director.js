import { useState, useEffect } from "react";
import { ref, onValue } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "../lib/firebaseConfig";

// ── 치료 항목 정의 (treatment.js와 동일) ──
const ITEMS = [
  { id:"hyperthermia", name:"고주파 온열치료", price:300000, custom:"qty", unit:"회", group:"고주파", color:"#dc2626" },
  { id:"zadaxin", name:"자닥신", price:350000, group:"싸이모신", color:"#7c3aed" },
  { id:"imualpha", name:"이뮤알파", price:300000, group:"싸이모신", color:"#7c3aed" },
  { id:"scion", name:"싸이원주", price:250000, group:"싸이모신", color:"#7c3aed" },
  { id:"iscador_m", name:"이스카도M", price:75000, group:"미슬토", color:"#166534" },
  { id:"iscador_q", name:"이스카도Q", price:80000, group:"미슬토", color:"#166534" },
  { id:"glutathione", name:"글루타치온", price:60000, group:"수액류", color:"#0ea5e9" },
  { id:"glutathione_qty", name:"글루타치온(개수)", price:60000, custom:"qty", group:"수액류", color:"#0ea5e9" },
  { id:"dramin", name:"닥터라민+멀티주", price:100000, group:"수액류", color:"#0ea5e9" },
  { id:"thioctic", name:"티옥트산", price:40000, group:"수액류", color:"#0ea5e9" },
  { id:"thioctic_qty", name:"티옥트산(개수)", price:40000, custom:"qty", group:"수액류", color:"#0ea5e9" },
  { id:"gt", name:"G+T", price:100000, group:"수액류", color:"#0ea5e9" },
  { id:"myers1", name:"마이어스1", price:70000, group:"수액류", color:"#0ea5e9" },
  { id:"myers2", name:"마이어스2", price:120000, group:"수액류", color:"#0ea5e9" },
  { id:"selenium_iv", name:"셀레늄", price:70000, group:"수액류", color:"#0ea5e9" },
  { id:"vitd", name:"비타민D", price:50000, group:"수액류", color:"#0ea5e9" },
  { id:"vitc", name:"고용량 비타민C", price:null, custom:"vitc", group:"수액류", color:"#0ea5e9" },
  { id:"periview_360", name:"페리주 360ml", price:100000, group:"수액류", color:"#0ea5e9" },
  { id:"periview_560", name:"페리주 560ml", price:150000, group:"수액류", color:"#0ea5e9" },
  { id:"pain", name:"페인스크렘블러", price:200000, custom:"qty", unit:"회", group:"물리치료", color:"#059669" },
  { id:"manip2", name:"도수치료2", price:200000, custom:"qty", unit:"회", group:"물리치료", color:"#059669" },
  { id:"manip1", name:"도수치료1", price:120000, custom:"qty", unit:"회", group:"물리치료", color:"#059669" },
  { id:"hyperbaric", name:"고압산소치료", price:0, group:"고압산소", color:"#0ea5e9" },
  { id:"rejuderm", name:"리쥬더마", price:45000, custom:"qty", group:"외용제", color:"#be185d" },
  { id:"meshima", name:"메시마F", price:18000, custom:"qty", group:"경구제", color:"#d97706" },
  { id:"selenase_l", name:"셀레나제액상", price:5000, custom:"qty", group:"경구제", color:"#d97706" },
  { id:"selenase_t", name:"셀레나제정", price:5000, custom:"qty", group:"경구제", color:"#d97706" },
  { id:"selenase_f", name:"셀레나제필름", price:5000, custom:"qty", group:"경구제", color:"#d97706" },
];

function vitcPrice(g) {
  if (g <= 0) return 0;
  const u = Math.ceil(g / 10);
  return u === 1 ? 30000 : 30000 + (u - 1) * 10000;
}

function encodeEmail(e) { return (e||"").replace(/\./g,",").replace(/@/g,"_at_"); }

const TOTAL_BEDS = 78;

function monthAdd(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

export default function DirectorPage() {
  const [authed, setAuthed] = useState(null); // null=loading, false=denied, true=ok
  const [profile, setProfile] = useState(null);

  // Auth
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, user => {
      if (!user) { setAuthed(false); return; }
      const ek = encodeEmail(user.email);
      onValue(ref(db, `users/${ek}`), snap => {
        const p = snap.val();
        if (p?.role === "director") { setProfile(p); setAuthed(true); }
        else setAuthed(false);
      }, { onlyOnce: true });
    });
    return unsub;
  }, []);

  if (authed === null) return <div style={{ padding:60, textAlign:"center", fontFamily:"sans-serif", color:"#64748b" }}>로딩 중...</div>;
  if (authed === false) return <div style={{ padding:60, textAlign:"center", fontFamily:"sans-serif" }}>
    <div style={{ fontSize:20, fontWeight:800, color:"#dc2626", marginBottom:12 }}>접근 권한 없음</div>
    <div style={{ color:"#64748b" }}>병원장 전용 페이지입니다.</div>
    <a href="/approval" style={{ color:"#0ea5e9", marginTop:16, display:"inline-block" }}>← 결재 시스템으로</a>
  </div>;

  return <DirectorDashboard profile={profile} />;
}

function DirectorDashboard({ profile }) {
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth() + 1;
  const todayStr = `${thisYear}${String(thisMonth).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}`;
  const currentYM = `${thisYear}-${String(thisMonth).padStart(2,"0")}`;

  const [year, setYear] = useState(thisYear);
  const [occMonth, setOccMonth] = useState(thisMonth);
  const [revenue, setRevenue] = useState(null);
  const [occupancy, setOccupancy] = useState(null);
  const [loading, setLoading] = useState({ rev:false, occ:false });
  const [error, setError] = useState({});
  const [treatMonth, setTreatMonth] = useState(currentYM);

  // 상담·입원 통계 (Firebase consultations)
  const [consultations, setConsultations] = useState({});
  useEffect(() => {
    const u = onValue(ref(db, "consultations"), s => setConsultations(s.val() || {}));
    return () => u();
  }, []);

  // 월별 상담건수/입원예약건수/신규입원수 계산
  const consultStats = (() => {
    const stats = {};
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}-${String(m).padStart(2,"0")}`;
      stats[m] = { consult: 0, reserved: 0, newAdmit: 0 };
    }
    Object.values(consultations).forEach(c => {
      if (!c?.name) return;
      // 상담건수: createdAt 기준
      if (c.createdAt?.startsWith(`${year}-`)) {
        const m = parseInt(c.createdAt.slice(5, 7));
        if (stats[m]) stats[m].consult++;
      }
      // 입원예약건수: admitDate 기준, 예약완료 상태
      if (c.status === "예약완료" && c.admitDate?.startsWith(`${year}-`)) {
        const m = parseInt(c.admitDate.slice(5, 7));
        if (stats[m]) stats[m].reserved++;
      }
      // 신규입원수: admitDate 기준, 입원완료 상태, patientId 없음 (신환)
      if (c.status === "입원완료" && c.admitDate?.startsWith(`${year}-`)) {
        const isNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
        if (isNew) {
          const m = parseInt(c.admitDate.slice(5, 7));
          if (stats[m]) stats[m].newAdmit++;
        }
      }
    });
    return stats;
  })();

  // 전년도 상담 통계 (전년 동월 대비용)
  const prevYearConsultStats = (() => {
    const stats = {};
    for (let m = 1; m <= 12; m++) stats[m] = { consult: 0, reserved: 0, newAdmit: 0 };
    const py = year - 1;
    Object.values(consultations).forEach(c => {
      if (!c?.name) return;
      if (c.createdAt?.startsWith(`${py}-`)) {
        const m = parseInt(c.createdAt.slice(5, 7));
        if (stats[m]) stats[m].consult++;
      }
      if (c.status === "예약완료" && c.admitDate?.startsWith(`${py}-`)) {
        const m = parseInt(c.admitDate.slice(5, 7));
        if (stats[m]) stats[m].reserved++;
      }
      if (c.status === "입원완료" && c.admitDate?.startsWith(`${py}-`)) {
        const isNew = c.isNewPatient !== undefined ? !!c.isNewPatient : !c.patientId;
        if (isNew) {
          const m = parseInt(c.admitDate.slice(5, 7));
          if (stats[m]) stats[m].newAdmit++;
        }
      }
    });
    return stats;
  })();

  // 전년도 매출 데이터
  const [prevYearRevenue, setPrevYearRevenue] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/director-stats",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"revenue",year:year-1})});
        if (r.ok) setPrevYearRevenue(await r.json());
      } catch(e) {}
    })();
  }, [year]);

  // EMR 매출/가동률
  const fetchRevenue = async () => {
    setLoading(p=>({...p,rev:true})); setError(p=>({...p,rev:null}));
    try {
      const r = await fetch("/api/director-stats",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"revenue",year})});
      if(!r.ok) throw new Error(await r.text());
      setRevenue(await r.json());
    } catch(e){ setError(p=>({...p,rev:e.message})); }
    setLoading(p=>({...p,rev:false}));
  };
  const fetchOccupancy = async () => {
    setLoading(p=>({...p,occ:true})); setError(p=>({...p,occ:null}));
    try {
      const r = await fetch("/api/director-stats",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"occupancy",year,month:occMonth})});
      if(!r.ok) throw new Error(await r.text());
      setOccupancy(await r.json());
    } catch(e){ setError(p=>({...p,occ:e.message})); }
    setLoading(p=>({...p,occ:false}));
  };
  useEffect(()=>{ fetchRevenue(); },[year]);
  useEffect(()=>{ fetchOccupancy(); },[year,occMonth]);

  // 치료항목 — treatMonth 기준 연도 + 전달/전년 연도에서 독립적으로 fetch
  const treatYear = parseInt(treatMonth.split("-")[0]);
  const [treatData, setTreatData] = useState({}); // { year: { items } }
  useEffect(() => {
    // 필요한 연도 목록: treatMonth 연도 + 전년도 (전년동월 비교용)
    const years = [...new Set([treatYear, treatYear - 1])];
    (async () => {
      const result = {};
      for (const y of years) {
        if (treatData[y]) { result[y] = treatData[y]; continue; }
        try {
          const r = await fetch("/api/director-stats",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"revenue",year:y})});
          if (r.ok) { const d = await r.json(); result[y] = d.treatmentItems || {}; }
          else result[y] = {};
        } catch(e) { result[y] = {}; }
      }
      setTreatData(prev => ({...prev, ...result}));
    })();
  }, [treatYear]);
  const treatAggAll = { ...(treatData[treatYear]||{}), ...(treatData[treatYear-1]||{}) };

  const fmtAmt = n => n != null ? Math.round(n).toLocaleString() : "-";
  const fmtMan = n => n != null && n !== 0 ? `${Math.round(n/10000).toLocaleString()}만` : "-";
  const yoyPct = (cur, prev) => {
    if (!prev || prev === 0) return cur > 0 ? "+∞" : null;
    const pct = Math.round(((cur - prev) / prev) * 100);
    return pct > 0 ? `+${pct}%` : `${pct}%`;
  };
  const yoyStyle = (cur, prev) => {
    if (!prev || prev === 0) return { color: "#94a3b8" };
    const pct = ((cur - prev) / prev) * 100;
    return { color: pct > 0 ? "#dc2626" : pct < 0 ? "#2563eb" : "#64748b", fontSize: 11, fontWeight: 600, marginLeft: 3 };
  };

  const hasOutpatient = revenue?.outpatient && Object.keys(revenue.outpatient).length > 0;
  const hasBedDays = revenue?.bedDays && Object.keys(revenue.bedDays).length > 0;

  const monthlyData = (() => {
    if (!revenue) return [];
    const map = {};
    for (let m=1;m<=12;m++) {
      const ym = `${year}${String(m).padStart(2,"0")}`;
      map[ym] = { month:m, inTotal:0, outTotal:0, bedDays:0, grandTotal:0, gongdan:0, bonbu:0 };
    }
    Object.entries(revenue.inpatient||{}).forEach(([ym,r])=>{ if(map[ym]){map[ym].inTotal=r.total||0;map[ym].gongdan=r.gongdan||0;map[ym].bonbu=r.bonbu||0;} });
    Object.entries(revenue.outpatient||{}).forEach(([ym,r])=>{ if(map[ym]) map[ym].outTotal=r.total||0; });
    Object.entries(revenue.bedDays||{}).forEach(([ym,v])=>{ if(map[ym]) map[ym].bedDays=v||0; });
    Object.values(map).forEach(r=>{ r.grandTotal=r.inTotal+r.outTotal; });
    // 전년 동월 데이터 병합
    const py = year - 1;
    const rows = Object.values(map).sort((a,b)=>a.month-b.month);
    rows.forEach(r => {
      const pym = `${py}${String(r.month).padStart(2,"0")}`;
      const pIn = prevYearRevenue?.inpatient?.[pym]?.total || 0;
      const pOut = prevYearRevenue?.outpatient?.[pym]?.total || 0;
      const pBd = prevYearRevenue?.bedDays?.[pym] || 0;
      const pGongdan = prevYearRevenue?.inpatient?.[pym]?.gongdan || 0;
      r.prevGrand = pIn + pOut;
      r.prevIn = pIn;
      r.prevOut = pOut;
      r.prevBedDays = pBd;
      r.prevGongdan = pGongdan;
    });
    return rows;
  })();
  const yearTotals = monthlyData.reduce((t,r)=>({inTotal:t.inTotal+r.inTotal,outTotal:t.outTotal+r.outTotal,bedDays:t.bedDays+r.bedDays,grandTotal:t.grandTotal+r.grandTotal,gongdan:t.gongdan+(r.gongdan||0)}),{inTotal:0,outTotal:0,bedDays:0,grandTotal:0,gongdan:0});

  // 일자별 매출/가동률 데이터
  const occData = (() => {
    if (!occupancy?.daily) return { rows:[], avgOcc:0, avgRate:0, sumIn:0, sumOut:0, sumGongdan:0, sumConsult:0, sumReserved:0 };
    const actual = occupancy.daily;
    const isCurrentMonth = year===thisYear && occMonth===thisMonth;
    const daysInMonth = new Date(year,occMonth,0).getDate();
    const lastActual = actual.length>0 ? actual[actual.length-1] : null;
    // 일별 상담/예약 건수 계산
    const dailyConsult = {}, dailyReserved = {};
    Object.values(consultations).forEach(c => {
      if (!c?.name) return;
      if (c.createdAt) {
        const cd = c.createdAt.replace(/-/g,"");
        if (cd.startsWith(`${year}${String(occMonth).padStart(2,"0")}`)) {
          dailyConsult[cd] = (dailyConsult[cd]||0) + 1;
        }
      }
      if (c.status === "예약완료" && c.admitDate) {
        const ad = c.admitDate.replace(/-/g,"");
        if (ad.startsWith(`${year}${String(occMonth).padStart(2,"0")}`)) {
          dailyReserved[ad] = (dailyReserved[ad]||0) + 1;
        }
      }
    });
    const rows = [...actual.map(d=>({...d, projected:false, consult:dailyConsult[d.date]||0, reserved:dailyReserved[d.date]||0}))];
    if (isCurrentMonth && lastActual) {
      for (let d=now.getDate()+1;d<=daysInMonth;d++) {
        const dt = `${year}${String(occMonth).padStart(2,"0")}${String(d).padStart(2,"0")}`;
        rows.push({date:dt, occupied:lastActual.occupied, total:TOTAL_BEDS, rate:lastActual.rate, projected:true, inTotal:0, outTotal:0, gongdan:0, consult:dailyConsult[dt]||0, reserved:dailyReserved[dt]||0});
      }
    }
    const ao = rows.filter(r=>!r.projected);
    return {
      rows,
      avgOcc: ao.length ? Math.round(ao.reduce((s,d)=>s+d.occupied,0)/ao.length) : 0,
      avgRate: ao.length ? Math.round(ao.reduce((s,d)=>s+d.rate,0)/ao.length*10)/10 : 0,
      sumIn: ao.reduce((s,d)=>s+(d.inTotal||0),0),
      sumOut: ao.reduce((s,d)=>s+(d.outTotal||0),0),
      sumGongdan: ao.reduce((s,d)=>s+(d.gongdan||0),0),
      sumConsult: rows.reduce((s,d)=>s+d.consult,0),
      sumReserved: rows.reduce((s,d)=>s+d.reserved,0),
    };
  })();

  // 치료항목 비교 데이터 (EMR 동기화 기준)
  const prevMonth = monthAdd(treatMonth, -1);
  const lastYearMonth = monthAdd(treatMonth, -12);
  const curData = treatAggAll[treatMonth] || {};
  const prevData = treatAggAll[prevMonth] || {};
  const lyData = treatAggAll[lastYearMonth] || {};

  const treatRows = ITEMS.filter(i => i.price !== 0 && i.price !== null && !i.id.endsWith("_dm")).map(item => {
    const cur = curData[item.id] || { count:0, revenue:0 };
    const prev = prevData[item.id] || { count:0, revenue:0 };
    const ly = lyData[item.id] || { count:0, revenue:0 };
    return { ...item, cur, prev, ly };
  }).filter(r => r.cur.count > 0 || r.prev.count > 0 || r.ly.count > 0);

  // vitc는 price가 null이므로 별도 처리
  const vitcItem = ITEMS.find(i=>i.id==="vitc");
  const vitcCur = curData["vitc"] || {count:0,revenue:0};
  const vitcPrev = prevData["vitc"] || {count:0,revenue:0};
  const vitcLy = lyData["vitc"] || {count:0,revenue:0};
  if (vitcCur.count>0||vitcPrev.count>0||vitcLy.count>0) {
    treatRows.push({ ...vitcItem, price:0, cur:vitcCur, prev:vitcPrev, ly:vitcLy });
  }

  const treatTotals = treatRows.reduce((t,r)=>({curRev:t.curRev+r.cur.revenue,prevRev:t.prevRev+r.prev.revenue,lyRev:t.lyRev+r.ly.revenue}),{curRev:0,prevRev:0,lyRev:0});

  const pctChange = (cur,prev) => {
    if (!prev || prev===0) return cur>0 ? {txt:"NEW",color:"#0ea5e9"} : {txt:"-",color:"#94a3b8"};
    const p = Math.round((cur-prev)/prev*100);
    if (p>0) return {txt:`+${p}%`,color:"#16a34a"};
    if (p<0) return {txt:`${p}%`,color:"#dc2626"};
    return {txt:"0%",color:"#64748b"};
  };

  const S = {
    page: { fontFamily:"'Noto Sans KR',sans-serif", background:"#f0f4f8", minHeight:"100vh" },
    header: { background:"#0f2744", color:"#fff", padding:"12px 24px", display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:100 },
    main: { maxWidth:1100, margin:"0 auto", padding:"24px 16px" },
    card: { background:"#fff", borderRadius:14, padding:"20px 24px", boxShadow:"0 1px 6px rgba(0,0,0,0.06)", marginBottom:20 },
    title: { fontSize:17, fontWeight:800, color:"#0f2744", marginBottom:14, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" },
    table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
    th: { background:"#0f2744", color:"#fff", padding:"9px 10px", fontWeight:700, textAlign:"center", whiteSpace:"nowrap" },
    td: { padding:"8px 10px", borderBottom:"1px solid #f1f5f9", textAlign:"right", fontVariantNumeric:"tabular-nums" },
    tdL: { padding:"8px 10px", borderBottom:"1px solid #f1f5f9", textAlign:"center", fontWeight:700, color:"#374151" },
    totRow: { background:"#f0f4f8", fontWeight:800 },
    nav: { display:"flex", alignItems:"center", gap:8, marginLeft:"auto" },
    btn: { background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:7, padding:"5px 14px", cursor:"pointer", fontSize:14, fontWeight:700 },
    sel: { border:"1px solid #e2e8f0", borderRadius:7, padding:"5px 10px", fontSize:14, fontWeight:700, outline:"none" },
    barBg: { height:20, background:"#f1f5f9", borderRadius:4, overflow:"hidden", flex:1 },
    barFill: (pct,proj) => ({ height:"100%", background:proj?"#cbd5e1":pct>=90?"#16a34a":pct>=70?"#0ea5e9":pct>=50?"#f59e0b":"#ef4444", width:`${Math.min(pct,100)}%`, borderRadius:4 }),
  };

  const ymLabel = ym => { const [y,m]=ym.split("-"); return `${y}.${m}`; };

  return (
    <div style={S.page}>
      <header style={S.header}>
        <a href="/approval" style={{ color:"#7dd3fc", fontSize:14, textDecoration:"none" }}>← 결재</a>
        <span style={{ fontWeight:800, fontSize:17 }}>경영현황</span>
        <span style={{ fontSize:13, opacity:0.7, marginLeft:"auto" }}>{profile?.name} · 병원장</span>
      </header>
      <main style={S.main}>

        {/* ── 1. 매출 현황 ── */}
        <div style={S.card}>
          <div style={S.title}>
            <span>📊 월별 매출 현황</span>
            <div style={S.nav}>
              <button style={S.btn} onClick={()=>setYear(y=>y-1)}>‹</button>
              <span style={{fontSize:16,fontWeight:800,minWidth:60,textAlign:"center"}}>{year}년</span>
              <button style={S.btn} onClick={()=>setYear(y=>y+1)}>›</button>
            </div>
          </div>
          {revenue?.lastSync && <div style={{fontSize:11,color:"#94a3b8",marginBottom:10}}>동기화: {new Date(revenue.lastSync).toLocaleString("ko-KR")}</div>}
          {loading.rev && <div style={{color:"#64748b",padding:20,textAlign:"center"}}>조회 중...</div>}
          {error.rev && <div style={{color:"#dc2626",padding:12,background:"#fee2e2",borderRadius:8,fontSize:13,marginBottom:12}}>⚠️ {error.rev}</div>}
          {revenue && !loading.rev && monthlyData.every(r=>r.grandTotal===0) && (
            <div style={{color:"#94a3b8",fontSize:14,padding:20,textAlign:"center"}}>
              데이터 없음 — <code style={{fontSize:12}}>node scripts/syncDirectorStats.js {year}</code>
            </div>
          )}
          {revenue && !loading.rev && !monthlyData.every(r=>r.grandTotal===0) && (
            <div style={{overflowX:"auto"}}>
              <table style={{...S.table,fontSize:12}}>
                <thead><tr>
                  <th style={S.th} rowSpan={2}>월</th>
                  <th style={S.th} colSpan={2}>총 진료비</th>
                  <th style={S.th} colSpan={2}>입원</th>
                  <th style={S.th} colSpan={2}>외래</th>
                  <th style={S.th} colSpan={2}>공단수입</th>
                  <th style={S.th} colSpan={2}>입원일수</th>
                  <th style={S.th} colSpan={2}>상담</th>
                  <th style={S.th} colSpan={2}>예약</th>
                  <th style={S.th} colSpan={2}>신규입원</th>
                </tr><tr>
                  {Array(8).fill(0).map((_,i)=><>
                    <th key={`a${i}`} style={{...S.th,fontSize:10,padding:"3px 6px",background:"#1e3a5f"}}>금액</th>
                    <th key={`b${i}`} style={{...S.th,fontSize:10,padding:"3px 6px",background:"#1e3a5f"}}>증감</th>
                  </>)}
                </tr></thead>
                <tbody>
                  <tr style={{...S.totRow,borderBottom:"2px solid #0f2744"}}>
                    <td style={{...S.tdL,fontSize:13}}>합계</td>
                    <td style={{...S.td,fontWeight:800,color:"#dc2626"}}>{fmtAmt(yearTotals.grandTotal)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#0369a1"}}>{fmtAmt(yearTotals.inTotal)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#7c3aed"}}>{fmtAmt(yearTotals.outTotal)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#059669"}}>{fmtAmt(yearTotals.gongdan)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800}}>{yearTotals.bedDays.toLocaleString()}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800}}>{Object.values(consultStats).reduce((s,v)=>s+v.consult,0)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800}}>{Object.values(consultStats).reduce((s,v)=>s+v.reserved,0)}</td><td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800}}>{Object.values(consultStats).reduce((s,v)=>s+v.newAdmit,0)}</td><td style={S.td}></td>
                  </tr>
                  {monthlyData.map(r=>{
                    const empty=r.inTotal===0&&r.outTotal===0;
                    const cs=consultStats[r.month]||{consult:0,reserved:0,newAdmit:0};
                    const pcs=prevYearConsultStats[r.month]||{consult:0,reserved:0,newAdmit:0};
                    const isFuture=year===thisYear&&r.month>thisMonth;
                    const yoyTd = (cur,prev) => {
                      const p = yoyPct(cur,prev);
                      const s = yoyStyle(cur,prev);
                      return <td style={{...S.td,...s,fontSize:11}}>{p||""}</td>;
                    };
                    return(<tr key={r.month} style={{opacity:isFuture?0.3:1}}>
                      <td style={S.tdL}>{r.month}월</td>
                      <td style={{...S.td,fontWeight:800,color:"#dc2626"}}>{empty?"-":fmtAmt(r.grandTotal)}</td>
                      {yoyTd(r.grandTotal,r.prevGrand)}
                      <td style={{...S.td,color:"#0369a1",fontWeight:600}}>{empty?"-":fmtAmt(r.inTotal)}</td>
                      {yoyTd(r.inTotal,r.prevIn)}
                      <td style={{...S.td,color:"#7c3aed",fontWeight:600}}>{empty?"-":fmtAmt(r.outTotal)}</td>
                      {yoyTd(r.outTotal,r.prevOut)}
                      <td style={{...S.td,color:"#059669",fontWeight:600}}>{empty||!r.gongdan?"-":fmtAmt(r.gongdan)}</td>
                      {yoyTd(r.gongdan,r.prevGongdan)}
                      <td style={{...S.td,color:"#64748b"}}>{r.bedDays||"-"}</td>
                      {yoyTd(r.bedDays,r.prevBedDays)}
                      <td style={{...S.td,color:"#059669",fontWeight:600}}>{cs.consult||"-"}</td>
                      {yoyTd(cs.consult,pcs.consult)}
                      <td style={{...S.td,color:"#0ea5e9",fontWeight:600}}>{cs.reserved||"-"}</td>
                      {yoyTd(cs.reserved,pcs.reserved)}
                      <td style={{...S.td,color:"#d97706",fontWeight:600}}>{cs.newAdmit||"-"}</td>
                      {yoyTd(cs.newAdmit,pcs.newAdmit)}
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── 2. 일자별 매출현황 ── */}
        <div style={S.card}>
          <div style={S.title}>
            <span>📅 일자별 매출현황</span>
            <div style={S.nav}>
              <select style={S.sel} value={occMonth} onChange={e=>setOccMonth(parseInt(e.target.value))}>
                {Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>{i+1}월</option>)}
              </select>
              <span style={{fontSize:12,color:"#64748b"}}>총 {TOTAL_BEDS}병상</span>
            </div>
          </div>
          {occupancy?.lastSync&&<div style={{fontSize:11,color:"#94a3b8",marginBottom:10}}>동기화: {new Date(occupancy.lastSync).toLocaleString("ko-KR")}</div>}
          {loading.occ&&<div style={{color:"#64748b",padding:20,textAlign:"center"}}>조회 중...</div>}
          {error.occ&&<div style={{color:"#dc2626",padding:12,background:"#fee2e2",borderRadius:8,fontSize:13,marginBottom:12}}>⚠️ {error.occ}</div>}
          {!loading.occ&&occData.rows.length>0&&(
            <div style={{overflowX:"auto"}}>
              <table style={S.table}>
                <thead><tr>
                  <th style={{...S.th,width:70}}>날짜</th>
                  <th style={{...S.th,width:65}}>재원</th>
                  <th style={{...S.th,width:60}}>가동률</th>
                  <th style={S.th}>입원</th>
                  <th style={S.th}>외래</th>
                  <th style={S.th}>공단수입</th>
                  <th style={{...S.th,width:45}}>상담</th>
                  <th style={{...S.th,width:45}}>예약</th>
                </tr></thead>
                <tbody>
                  <tr style={{...S.totRow,borderBottom:"2px solid #0f2744"}}>
                    <td style={{...S.tdL,fontSize:14,color:"#0f2744"}}>합계/평균</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800}}>{occData.avgOcc}/{TOTAL_BEDS}</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800,fontSize:15,color:occData.avgRate>=70?"#16a34a":"#d97706"}}>{occData.avgRate}%</td>
                    <td style={{...S.td,fontWeight:800,color:"#0369a1"}}>{occData.sumIn?fmtAmt(occData.sumIn):"-"}</td>
                    <td style={{...S.td,fontWeight:800,color:"#7c3aed"}}>{occData.sumOut?fmtAmt(occData.sumOut):"-"}</td>
                    <td style={{...S.td,fontWeight:800,color:"#059669"}}>{occData.sumGongdan?fmtAmt(occData.sumGongdan):"-"}</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800}}>{occData.sumConsult||"-"}</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800}}>{occData.sumReserved||"-"}</td>
                  </tr>
                  {occData.rows.map(d=>{
                    const day=parseInt(d.date.slice(6));const dow=new Date(year,occMonth-1,day).getDay();
                    const isToday=d.date===todayStr;
                    return(<tr key={d.date} style={{background:isToday?"#fffbeb":dow===0?"#fff5f5":dow===6?"#f0f0ff":undefined,opacity:d.projected?0.45:1}}>
                      <td style={{...S.tdL,color:isToday?"#d97706":dow===0?"#dc2626":dow===6?"#2563eb":"#374151",fontWeight:isToday?800:700}}>
                        {occMonth}/{day}{isToday&&<span style={{fontSize:9,marginLeft:3,color:"#d97706"}}>오늘</span>}{d.projected&&<span style={{fontSize:9,marginLeft:3,color:"#94a3b8"}}>예상</span>}
                      </td>
                      <td style={{...S.td,textAlign:"center"}}>{d.occupied}/{d.total}</td>
                      <td style={{...S.td,textAlign:"center",fontWeight:700,color:d.projected?"#94a3b8":d.rate>=90?"#16a34a":d.rate>=70?"#0ea5e9":d.rate>=50?"#d97706":"#dc2626"}}>{d.rate}%</td>
                      <td style={{...S.td,color:"#0369a1",fontWeight:600}}>{d.inTotal?fmtAmt(d.inTotal):"-"}</td>
                      <td style={{...S.td,color:"#7c3aed",fontWeight:600}}>{d.outTotal?fmtAmt(d.outTotal):"-"}</td>
                      <td style={{...S.td,color:"#059669",fontWeight:600}}>{d.gongdan?fmtAmt(d.gongdan):"-"}</td>
                      <td style={{...S.td,textAlign:"center",color:"#059669"}}>{d.consult||"-"}</td>
                      <td style={{...S.td,textAlign:"center",color:"#0ea5e9"}}>{d.reserved||"-"}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading.occ&&occData.rows.length===0&&occupancy&&<div style={{color:"#94a3b8",fontSize:14,padding:20,textAlign:"center"}}>데이터 없음 — 동기화 스크립트를 재실행하세요</div>}
        </div>

        {/* ── 3. 치료항목 월별 현황 ── */}
        <div style={S.card}>
          <div style={S.title}>
            <span>💊 치료항목 월별 현황</span>
            <div style={S.nav}>
              <button style={S.btn} onClick={()=>setTreatMonth(m=>monthAdd(m,-1))}>‹</button>
              <select style={S.sel} value={treatMonth.split("-")[0]}
                onChange={e=>setTreatMonth(`${e.target.value}-${treatMonth.split("-")[1]}`)}>
                {Array.from({length:thisYear-2019},(_,i)=><option key={2020+i} value={2020+i}>{2020+i}년</option>)}
              </select>
              <select style={S.sel} value={parseInt(treatMonth.split("-")[1])}
                onChange={e=>setTreatMonth(`${treatMonth.split("-")[0]}-${String(e.target.value).padStart(2,"0")}`)}>
                {Array.from({length:12},(_,i)=><option key={i+1} value={i+1}>{i+1}월</option>)}
              </select>
              <button style={S.btn} onClick={()=>setTreatMonth(m=>monthAdd(m,1))}>›</button>
            </div>
          </div>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12}}>
            비교: 전달 ({ymLabel(prevMonth)}) · 전년동월 ({ymLabel(lastYearMonth)})
          </div>
          {treatRows.length===0 ? (
            <div style={{color:"#94a3b8",fontSize:14,padding:20,textAlign:"center"}}>해당 월 치료 데이터가 없습니다.</div>
          ) : (
            <div style={{overflowX:"auto"}}>
              <table style={S.table}>
                <thead><tr>
                  <th style={S.th}>치료항목</th>
                  <th style={S.th}>수량</th>
                  <th style={S.th}>매출</th>
                  <th style={{...S.th,fontSize:11}}>전달 수량</th>
                  <th style={{...S.th,fontSize:11}}>전달 매출</th>
                  <th style={{...S.th,fontSize:11}}>전달 대비</th>
                  <th style={{...S.th,fontSize:11}}>전년 수량</th>
                  <th style={{...S.th,fontSize:11}}>전년 매출</th>
                  <th style={{...S.th,fontSize:11}}>전년 대비</th>
                </tr></thead>
                <tbody>
                  <tr style={{...S.totRow,borderBottom:"2px solid #0f2744"}}>
                    <td style={{...S.tdL,textAlign:"left",paddingLeft:12,fontSize:14}}>합계</td>
                    <td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#0369a1",fontSize:14}}>{fmtAmt(treatTotals.curRev)}</td>
                    <td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#64748b"}}>{fmtAmt(treatTotals.prevRev)}</td>
                    <td style={{...S.td,fontWeight:800,color:pctChange(treatTotals.curRev,treatTotals.prevRev).color}}>{pctChange(treatTotals.curRev,treatTotals.prevRev).txt}</td>
                    <td style={S.td}></td>
                    <td style={{...S.td,fontWeight:800,color:"#64748b"}}>{fmtAmt(treatTotals.lyRev)}</td>
                    <td style={{...S.td,fontWeight:800,color:pctChange(treatTotals.curRev,treatTotals.lyRev).color}}>{pctChange(treatTotals.curRev,treatTotals.lyRev).txt}</td>
                  </tr>
                  {treatRows.map(r=>{
                    const pc1=pctChange(r.cur.revenue,r.prev.revenue);
                    const pc2=pctChange(r.cur.revenue,r.ly.revenue);
                    return(<tr key={r.id}>
                      <td style={{...S.tdL,textAlign:"left",paddingLeft:12}}>
                        <span style={{color:r.color,fontWeight:700}}>{r.name}</span>
                      </td>
                      <td style={{...S.td,fontWeight:700}}>{r.cur.count||"-"}</td>
                      <td style={{...S.td,fontWeight:700,color:"#0369a1"}}>{r.cur.revenue?fmtAmt(r.cur.revenue):"-"}</td>
                      <td style={{...S.td,color:"#64748b"}}>{r.prev.count||"-"}</td>
                      <td style={{...S.td,color:"#64748b"}}>{r.prev.revenue?fmtAmt(r.prev.revenue):"-"}</td>
                      <td style={{...S.td,fontWeight:700,color:pc1.color}}>{pc1.txt}</td>
                      <td style={{...S.td,color:"#64748b"}}>{r.ly.count||"-"}</td>
                      <td style={{...S.td,color:"#64748b"}}>{r.ly.revenue?fmtAmt(r.ly.revenue):"-"}</td>
                      <td style={{...S.td,fontWeight:700,color:pc2.color}}>{pc2.txt}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

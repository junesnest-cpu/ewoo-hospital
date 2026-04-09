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
  const [treatAgg, setTreatAgg] = useState({});
  const [treatMonth, setTreatMonth] = useState(currentYM);

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

  // 치료항목 집계 (Firebase treatmentPlans)
  useEffect(() => {
    const unsub = onValue(ref(db, "treatmentPlans"), snap => {
      const all = snap.val() || {};
      const agg = {};
      for (const months of Object.values(all)) {
        if (!months || typeof months !== "object") continue;
        for (const [mk, days] of Object.entries(months)) {
          if (!agg[mk]) agg[mk] = {};
          if (!days || typeof days !== "object") continue;
          for (const items of Object.values(days)) {
            if (!Array.isArray(items)) continue;
            for (const e of items) {
              if (!e?.id || e.emr === "removed") continue;
              const def = ITEMS.find(i => i.id === e.id);
              if (!def || def.price === 0) continue;
              if (e.id.endsWith("_dm")) continue; // 퇴원약 제외
              if (!agg[mk][e.id]) agg[mk][e.id] = { count: 0, revenue: 0 };
              if (def.custom === "vitc") {
                agg[mk][e.id].count += 1;
                agg[mk][e.id].revenue += vitcPrice(parseInt(e.qty) || 0);
              } else if (def.custom === "qty") {
                const q = parseInt(e.qty) || 1;
                agg[mk][e.id].count += q;
                agg[mk][e.id].revenue += (def.price || 0) * q;
              } else {
                agg[mk][e.id].count += 1;
                agg[mk][e.id].revenue += def.price || 0;
              }
            }
          }
        }
      }
      setTreatAgg(agg);
    });
    return unsub;
  }, []);

  const fmtAmt = n => n != null ? Math.round(n).toLocaleString() : "-";
  const fmtMan = n => n != null && n !== 0 ? `${Math.round(n/10000).toLocaleString()}만` : "-";

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
    return Object.values(map).sort((a,b)=>a.month-b.month);
  })();
  const hasDetail = monthlyData.some(r=>r.gongdan>0||r.bonbu>0);
  const yearTotals = monthlyData.reduce((t,r)=>({inTotal:t.inTotal+r.inTotal,outTotal:t.outTotal+r.outTotal,bedDays:t.bedDays+r.bedDays,grandTotal:t.grandTotal+r.grandTotal,gongdan:t.gongdan+r.gongdan,bonbu:t.bonbu+r.bonbu}),{inTotal:0,outTotal:0,bedDays:0,grandTotal:0,gongdan:0,bonbu:0});

  // 가동률 데이터
  const occData = (() => {
    if (!occupancy?.daily) return { rows:[], avgOcc:0, avgRate:0 };
    const actual = occupancy.daily;
    const isCurrentMonth = year===thisYear && occMonth===thisMonth;
    const daysInMonth = new Date(year,occMonth,0).getDate();
    const lastActual = actual.length>0 ? actual[actual.length-1] : null;
    const rows = [...actual.map(d=>({...d,projected:false}))];
    if (isCurrentMonth && lastActual) {
      for (let d=now.getDate()+1;d<=daysInMonth;d++) {
        rows.push({date:`${year}${String(occMonth).padStart(2,"0")}${String(d).padStart(2,"0")}`,occupied:lastActual.occupied,total:TOTAL_BEDS,rate:lastActual.rate,projected:true});
      }
    }
    const ao = rows.filter(r=>!r.projected);
    return { rows, avgOcc:ao.length?Math.round(ao.reduce((s,d)=>s+d.occupied,0)/ao.length):0, avgRate:ao.length?Math.round(ao.reduce((s,d)=>s+d.rate,0)/ao.length*10)/10:0 };
  })();

  // 치료항목 비교 데이터
  const prevMonth = monthAdd(treatMonth, -1);
  const lastYearMonth = monthAdd(treatMonth, -12);
  const curData = treatAgg[treatMonth] || {};
  const prevData = treatAgg[prevMonth] || {};
  const lyData = treatAgg[lastYearMonth] || {};

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
              <table style={S.table}>
                <thead><tr>
                  <th style={S.th}>월</th><th style={S.th}>입원</th>
                  {hasOutpatient&&<th style={S.th}>외래</th>}
                  {hasBedDays&&<th style={S.th}>입원일수</th>}
                  {hasDetail&&<th style={S.th}>공단수입</th>}
                  {hasDetail&&<th style={S.th}>본부금</th>}
                  <th style={S.th}>총 진료비</th>
                </tr></thead>
                <tbody>
                  {monthlyData.map(r=>{
                    const empty=r.inTotal===0&&r.outTotal===0;
                    return(<tr key={r.month} style={{opacity:year===thisYear&&r.month>thisMonth?0.3:1}}>
                      <td style={S.tdL}>{r.month}월</td>
                      <td style={{...S.td,color:"#0369a1",fontWeight:600}}>{empty?"-":fmtAmt(r.inTotal)}</td>
                      {hasOutpatient&&<td style={{...S.td,color:"#7c3aed",fontWeight:600}}>{empty?"-":fmtAmt(r.outTotal)}</td>}
                      {hasBedDays&&<td style={{...S.td,textAlign:"center",color:"#64748b"}}>{r.bedDays||"-"}</td>}
                      {hasDetail&&<td style={{...S.td,color:"#059669"}}>{empty?"-":fmtAmt(r.gongdan)}</td>}
                      {hasDetail&&<td style={{...S.td,color:"#d97706"}}>{empty?"-":fmtAmt(r.bonbu)}</td>}
                      <td style={{...S.td,fontWeight:800,color:"#dc2626"}}>{empty?"-":fmtAmt(r.grandTotal)}</td>
                    </tr>);
                  })}
                  <tr style={S.totRow}>
                    <td style={{...S.tdL,fontSize:14}}>합계</td>
                    <td style={{...S.td,fontWeight:800,color:"#0369a1"}}>{fmtAmt(yearTotals.inTotal)}</td>
                    {hasOutpatient&&<td style={{...S.td,fontWeight:800,color:"#7c3aed"}}>{fmtAmt(yearTotals.outTotal)}</td>}
                    {hasBedDays&&<td style={{...S.td,textAlign:"center",fontWeight:800}}>{yearTotals.bedDays.toLocaleString()}</td>}
                    {hasDetail&&<td style={{...S.td,fontWeight:800,color:"#059669"}}>{fmtAmt(yearTotals.gongdan)}</td>}
                    {hasDetail&&<td style={{...S.td,fontWeight:800,color:"#d97706"}}>{fmtAmt(yearTotals.bonbu)}</td>}
                    <td style={{...S.td,fontWeight:800,color:"#dc2626",fontSize:14}}>{fmtAmt(yearTotals.grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── 2. 병상 가동률 ── */}
        <div style={S.card}>
          <div style={S.title}>
            <span>🛏️ 병상 가동률</span>
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
                <thead><tr><th style={{...S.th,width:70}}>날짜</th><th style={{...S.th,width:70}}>재원</th><th style={{...S.th,width:70}}>가동률</th><th style={S.th}>시각화</th></tr></thead>
                <tbody>
                  <tr style={{...S.totRow,borderBottom:"2px solid #0f2744"}}>
                    <td style={{...S.tdL,fontSize:14,color:"#0f2744"}}>평균</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800}}>{occData.avgOcc}/{TOTAL_BEDS}</td>
                    <td style={{...S.td,textAlign:"center",fontWeight:800,fontSize:15,color:occData.avgRate>=70?"#16a34a":"#d97706"}}>{occData.avgRate}%</td>
                    <td style={{...S.td,padding:"8px 12px"}}><div style={S.barBg}><div style={S.barFill(occData.avgRate,false)}/></div></td>
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
                      <td style={{...S.td,padding:"8px 12px"}}><div style={S.barBg}><div style={S.barFill(d.rate,d.projected)}/></div></td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading.occ&&occData.rows.length===0&&occupancy&&<div style={{color:"#94a3b8",fontSize:14,padding:20,textAlign:"center"}}>데이터 없음</div>}
        </div>

        {/* ── 3. 치료항목 월별 현황 ── */}
        <div style={S.card}>
          <div style={S.title}>
            <span>💊 치료항목 월별 현황</span>
            <div style={S.nav}>
              <button style={S.btn} onClick={()=>setTreatMonth(m=>monthAdd(m,-1))}>‹</button>
              <span style={{fontSize:16,fontWeight:800,minWidth:80,textAlign:"center"}}>{ymLabel(treatMonth)}</span>
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
                  <tr style={S.totRow}>
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
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

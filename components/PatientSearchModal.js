/**
 * 환자 검색 / 신규 등록 모달
 * 사용법:
 *   <PatientSearchModal
 *     onSelect={(patient) => { ... }}  // 환자 선택 시 콜백
 *     onClose={() => setOpen(false)}
 *   />
 */

import { useState } from "react";
import {
  findPatientByPhone,
  searchPatientsByName,
  registerNewPatient,
  normalizePhone,
} from "../lib/patientSearch";

const S = {
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.6)", zIndex:2000,
    display:"flex", alignItems:"center", justifyContent:"center", padding:16 },
  box: { background:"#fff", borderRadius:16, width:"100%", maxWidth:500,
    maxHeight:"90vh", overflowY:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.2)" },
  header: { padding:"16px 20px 0", display:"flex", alignItems:"center",
    justifyContent:"space-between" },
  title: { fontSize:17, fontWeight:800, color:"#0f2744" },
  closeBtn: { background:"none", border:"none", fontSize:20, cursor:"pointer",
    color:"#94a3b8", lineHeight:1 },
  body: { padding:"12px 20px 20px" },
  tabBar: { display:"flex", gap:4, marginBottom:14,
    borderBottom:"2px solid #e2e8f0", paddingBottom:0 },
  tab: (active) => ({
    padding:"7px 16px", border:"none", borderRadius:"6px 6px 0 0",
    cursor:"pointer", fontSize:13, fontWeight:700,
    background: active ? "#0f2744" : "none",
    color:      active ? "#fff"    : "#94a3b8",
    marginBottom:-2, borderBottom: active ? "2px solid #0f2744" : "none",
  }),
  label: { display:"block", fontSize:12, fontWeight:700, color:"#64748b",
    marginBottom:3, marginTop:10 },
  input: { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:7,
    padding:"8px 10px", fontSize:14, outline:"none", boxSizing:"border-box",
    fontFamily:"inherit" },
  btn: (color="#0f2744") => ({
    background:color, color:"#fff", border:"none", borderRadius:7,
    padding:"8px 18px", cursor:"pointer", fontSize:14, fontWeight:700,
  }),
  resultItem: { display:"flex", alignItems:"center", gap:10, padding:"10px 12px",
    border:"1.5px solid #e2e8f0", borderRadius:9, marginBottom:6,
    cursor:"pointer", background:"#fff", transition:"background 0.1s" },
  badge: (color) => ({
    background:color, color:"#fff", borderRadius:5,
    padding:"1px 7px", fontSize:11, fontWeight:700, flexShrink:0,
  }),
  info: { fontSize:12, color:"#94a3b8", marginTop:1 },
};

export default function PatientSearchModal({ onSelect, onClose }) {
  const [tab,       setTab]       = useState("search"); // "search" | "new"
  const [query,     setQuery]     = useState("");
  const [queryType, setQueryType] = useState("phone"); // "phone" | "name"
  const [results,   setResults]   = useState(null); // null=미검색
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  // 신규 등록 폼
  const [form, setForm] = useState({
    name:"", birthDate:"", gender:"", phone:"", chartNo:"",
    address:"", doctor:"", diagnosis:"",
  });
  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [saving, setSaving] = useState(false);

  // ── 검색 ──────────────────────────────────────────────────────────────────
  const doSearch = async () => {
    if (!query.trim()) return;
    setLoading(true); setError(""); setResults(null);
    try {
      if (queryType === "phone") {
        const p = await findPatientByPhone(query.trim());
        setResults(p ? [p] : []);
      } else {
        const list = await searchPatientsByName(query.trim());
        setResults(list);
      }
    } catch(e) {
      setError("검색 오류: " + e.message);
    }
    setLoading(false);
  };

  // ── 신규 등록 ─────────────────────────────────────────────────────────────
  const doRegister = async () => {
    if (!form.name.trim())      { setError("환자명을 입력해 주세요."); return; }
    if (!form.birthDate.trim()) { setError("생년월일을 입력해 주세요."); return; }
    setSaving(true); setError("");
    try {
      const patient = await registerNewPatient(form);
      if (patient._duplicate) {
        setError(`이미 등록된 환자입니다. (${patient.internalId} · ${patient.name})`);
        setSaving(false); return;
      }
      onSelect(patient);
    } catch(e) {
      setError("등록 오류: " + e.message);
    }
    setSaving(false);
  };

  return (
    <div style={S.overlay} onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div style={S.box}>
        {/* 헤더 */}
        <div style={S.header}>
          <span style={S.title}>👤 환자 조회 / 등록</span>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={S.body}>
          {/* 탭 */}
          <div style={S.tabBar}>
            <button style={S.tab(tab==="search")} onClick={()=>{setTab("search");setError("");}}>🔍 기존 환자 검색</button>
            <button style={S.tab(tab==="new")}    onClick={()=>{setTab("new");setError("");}}>➕ 신규 환자 등록</button>
          </div>

          {error && (
            <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:7,
              padding:"8px 12px", color:"#dc2626", fontSize:13, marginBottom:10 }}>
              ⚠ {error}
            </div>
          )}

          {/* ── 검색 탭 ────────────────────────────────────────────────── */}
          {tab === "search" && (
            <>
              {/* 검색 유형 선택 */}
              <div style={{ display:"flex", gap:6, marginBottom:8 }}>
                {[["phone","📱 전화번호"],["name","👤 이름"]].map(([t,l])=>(
                  <button key={t} onClick={()=>{setQueryType(t);setQuery("");setResults(null);}}
                    style={{ padding:"5px 14px", borderRadius:6, border:"1.5px solid",
                      cursor:"pointer", fontSize:13, fontWeight:700,
                      borderColor: queryType===t ? "#0f2744":"#e2e8f0",
                      background:  queryType===t ? "#0f2744":"#f8fafc",
                      color:       queryType===t ? "#fff":"#64748b" }}>
                    {l}
                  </button>
                ))}
              </div>

              <div style={{ display:"flex", gap:6 }}>
                <input
                  style={{ ...S.input, flex:1 }}
                  placeholder={queryType==="phone" ? "010-0000-0000" : "환자 이름"}
                  value={query}
                  onChange={e=>setQuery(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&doSearch()}
                  autoFocus
                />
                <button style={S.btn()} onClick={doSearch} disabled={loading}>
                  {loading ? "..." : "검색"}
                </button>
              </div>

              {/* 결과 */}
              {results !== null && (
                <div style={{ marginTop:12 }}>
                  {results.length === 0 ? (
                    <div style={{ textAlign:"center", padding:"16px 0", color:"#94a3b8", fontSize:14 }}>
                      검색 결과 없음
                      <div style={{ marginTop:8 }}>
                        <button style={{ ...S.btn("#7c3aed"), fontSize:12 }}
                          onClick={()=>{
                            setTab("new");
                            setError("");
                            // 전화번호 검색이었으면 폼에 자동 입력
                            if(queryType==="phone") setF("phone", query);
                            else setF("name", query);
                          }}>
                          ➕ 신규 환자로 등록
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize:12, color:"#64748b", marginBottom:8, fontWeight:600 }}>
                        {results.length}명 검색됨
                      </div>
                      {results.map((p, i) => (
                        <div key={i} style={S.resultItem}
                          onMouseEnter={e=>e.currentTarget.style.background="#f0f9ff"}
                          onMouseLeave={e=>e.currentTarget.style.background="#fff"}
                          onClick={()=>onSelect(p)}>
                          <span style={S.badge("#0f2744")}>{p.internalId}</span>
                          {p.chartNo && <span style={S.badge("#64748b")}>차트 {p.chartNo}</span>}
                          <div style={{ flex:1 }}>
                            <div style={{ fontWeight:700, fontSize:15 }}>{p.name}</div>
                            <div style={S.info}>
                              {p.birthDate && `${p.birthDate} · `}
                              {p.gender==="M"?"남":"여"} ·{" "}
                              {p.phone ? p.phone.replace(/(\d{3})(\d{4})(\d{4})/,"$1-$2-$3") : "연락처 없음"}
                            </div>
                            {p.diagnosis && (
                              <div style={{ ...S.info, color:"#7c3aed", marginTop:1 }}>{p.diagnosis.slice(0,40)}</div>
                            )}
                          </div>
                          <span style={{ fontSize:20, color:"#0ea5e9" }}>›</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── 신규 등록 탭 ────────────────────────────────────────────── */}
          {tab === "new" && (
            <>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 12px" }}>
                <div>
                  <label style={S.label}>환자명 ★</label>
                  <input style={S.input} value={form.name} onChange={e=>setF("name",e.target.value)} placeholder="홍길동"/>
                </div>
                <div>
                  <label style={S.label}>성별</label>
                  <div style={{ display:"flex", gap:6, marginTop:2 }}>
                    {[["M","남"],["F","여"]].map(([v,l])=>(
                      <button key={v} onClick={()=>setF("gender",v)}
                        style={{ flex:1, padding:"7px", borderRadius:6, border:"1.5px solid",
                          cursor:"pointer", fontSize:13, fontWeight:700,
                          borderColor: form.gender===v ? "#0f2744":"#e2e8f0",
                          background:  form.gender===v ? "#0f2744":"#f8fafc",
                          color:       form.gender===v ? "#fff":"#64748b" }}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={S.label}>생년월일 ★</label>
                  <input style={S.input} type="date" value={form.birthDate} onChange={e=>setF("birthDate",e.target.value)}/>
                </div>
                <div>
                  <label style={S.label}>전화번호</label>
                  <input style={S.input} value={form.phone} onChange={e=>setF("phone",e.target.value)} placeholder="010-0000-0000"/>
                </div>
              </div>
              <label style={S.label}>주상병</label>
              <input style={S.input} value={form.diagnosis} onChange={e=>setF("diagnosis",e.target.value)} placeholder="예: [C34] 기관지 및 폐의 악성 신생물"/>
              <label style={S.label}>주소</label>
              <input style={S.input} value={form.address} onChange={e=>setF("address",e.target.value)} placeholder="(선택)"/>
              <label style={S.label}>차트번호 (EMR)</label>
              <input style={S.input} value={form.chartNo} onChange={e=>setF("chartNo",e.target.value)} placeholder="나중에 입력 가능"/>

              <button style={{ ...S.btn("#0f2744"), width:"100%", marginTop:16, padding:10, fontSize:15 }}
                onClick={doRegister} disabled={saving}>
                {saving ? "등록 중..." : "✅ 신규 환자 등록"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

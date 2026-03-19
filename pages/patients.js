import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, get } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import { findPatientByPhone, findPatientByChartNo, searchPatientsByName, normalizePhone } from "../lib/patientSearch";
import useIsMobile from "../lib/useismobile";

const S = {
  app:    { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", padding:"10px 16px", display:"flex", alignItems:"center", gap:10, position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 8px rgba(0,0,0,0.15)" },
  body:   { maxWidth:860, margin:"0 auto", padding:"16px 12px" },
  card:   { background:"#fff", borderRadius:12, padding:"16px 18px", boxShadow:"0 1px 6px rgba(0,0,0,0.07)", marginBottom:12 },
  label:  { fontSize:11, fontWeight:700, color:"#94a3b8", marginBottom:2 },
  value:  { fontSize:14, fontWeight:600, color:"#0f172a" },
  badge:  (bg, color) => ({ background:bg, color, borderRadius:5, padding:"2px 8px", fontSize:11, fontWeight:700, display:"inline-block" }),
  tab:    (active) => ({ padding:"7px 18px", border:"none", borderRadius:"6px 6px 0 0", cursor:"pointer", fontSize:13, fontWeight:700, background:active?"#0f2744":"#f1f5f9", color:active?"#fff":"#64748b", marginBottom:-2, borderBottom:active?"2px solid #0f2744":"none" }),
  input:  { border:"1.5px solid #e2e8f0", borderRadius:8, padding:"9px 12px", fontSize:14, outline:"none", fontFamily:"inherit", width:"100%", boxSizing:"border-box" },
};

function InfoGrid({ items }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))", gap:"10px 16px" }}>
      {items.map(({ label, value }) => value ? (
        <div key={label}>
          <div style={S.label}>{label}</div>
          <div style={S.value}>{value}</div>
        </div>
      ) : null)}
    </div>
  );
}

export default function PatientsPage() {
  const router   = useRouter();
  const isMobile = useIsMobile();

  const [query,     setQuery]     = useState("");
  const [searching, setSearching] = useState(false);
  const [results,   setResults]   = useState(null);
  const [selected,  setSelected]  = useState(null); // 선택된 환자

  // 관련 데이터
  const [consultations, setConsultations] = useState([]);
  const [currentSlot,   setCurrentSlot]   = useState(null); // { slotKey, data }
  const [reservations,  setReservations]  = useState([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab,     setActiveTab]     = useState("info");

  // URL에서 patientId 로드
  useEffect(() => {
    const { id } = router.query;
    if (id) loadPatientById(id);
  }, [router.query]);

  // 입력 유형 자동 감지 후 검색
  // - 순수 숫자 9자리 미만 → 차트번호
  // - 숫자 포함(9자리 이상 또는 하이픈 포함) → 전화번호
  // - 그 외 → 이름
  const doSearch = useCallback(async (q) => {
    const trimmed = (q || query).trim();
    if (!trimmed || trimmed.length < 2) return;
    setSearching(true); setResults(null); setSelected(null);
    try {
      let found;
      const digitsOnly = trimmed.replace(/\D/g, "");
      if (/^\d+$/.test(trimmed) && trimmed.length < 9) {
        // 순수 숫자 단자리 → 차트번호 검색
        const p = await findPatientByChartNo(trimmed);
        found = p ? [p] : [];
      } else if (/\d/.test(trimmed)) {
        // 숫자 포함 → 전화번호 검색
        const p = await findPatientByPhone(trimmed);
        found = p ? [p] : [];
      } else {
        found = await searchPatientsByName(trimmed);
      }
      if (found.length === 1) await selectPatient(found[0]);
      else setResults(found);
    } catch(e) {
      console.error("[환자검색] 오류:", e);
      setResults([]);
    }
    setSearching(false);
  }, [query]);

  // 입력 즉시 자동 검색 (500ms debounce)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) { setResults(null); return; }
    const timer = setTimeout(() => doSearch(trimmed), 500);
    return () => clearTimeout(timer);
  }, [query]);

  const loadPatientById = async (internalId) => {
    try {
      const snap = await get(ref(db, "patients"));
      const all  = snap.val() || {};
      const p    = Object.values(all).find(x => x.internalId === internalId);
      if (p) await selectPatient(p);
    } catch(e) {
      console.error("[환자조회] loadPatientById 오류:", e);
    }
  };

  const selectPatient = async (p) => {
    setSelected(p); setResults(null); setLoadingDetail(true); setActiveTab("info");
    try {
      // 상담이력
      const cSnap = await get(ref(db, "consultations"));
      const allC  = Object.values(cSnap.val() || {});
      const linked = allC
        .filter(c => c.patientId === p.internalId || (c.name === p.name && !c.patientId))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setConsultations(linked);
      // 입원/예약 현황
      const sSnap = await get(ref(db, "slots"));
      const allS  = sSnap.val() || {};
      let curSlot = null, resList = [];
      Object.entries(allS).forEach(([slotKey, slot]) => {
        if (slot?.current?.patientId === p.internalId || slot?.current?.name === p.name)
          curSlot = { slotKey, data: slot.current };
        (slot?.reservations || []).forEach(r => {
          if (r.patientId === p.internalId || r.name === p.name)
            resList.push({ slotKey, data: r });
        });
      });
      setCurrentSlot(curSlot);
      setReservations(resList);
    } catch(e) {
      console.error("[환자조회] selectPatient 오류:", e);
    }
    setLoadingDetail(false);
  };

  const phoneDisplay = (p) => {
    if (!p) return "";
    const n = normalizePhone(p);
    if (n.length === 11) return `${n.slice(0,3)}-${n.slice(3,7)}-${n.slice(7)}`;
    if (n.length === 10) return `${n.slice(0,3)}-${n.slice(3,6)}-${n.slice(6)}`;
    return p;
  };

  const statusColor = { "상담중":"#0ea5e9", "입원예정":"#7c3aed", "입원":"#059669", "종결":"#94a3b8", "부재중":"#f59e0b" };

  return (
    <div style={S.app}>
      {/* 헤더 */}
      <header style={S.header}>
        <button onClick={() => router.push("/")}
          style={{ background:"rgba(255,255,255,0.15)", border:"1px solid rgba(255,255,255,0.3)", color:"#fff", borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600 }}>
          ← 병실 현황
        </button>
        <span style={{ fontSize:18, fontWeight:900 }}>👤 환자 조회</span>
      </header>

      <div style={S.body}>
        {/* 검색 */}
        <div style={{ ...S.card, marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:6 }}>이름 또는 전화번호를 입력하면 자동으로 검색됩니다</div>
          <div style={{ display:"flex", gap:8 }}>
            <input style={{ ...S.input, flex:1 }}
              placeholder="이름 또는 전화번호"
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key==="Enter" && doSearch()} autoFocus />
            {searching && <span style={{ display:"flex", alignItems:"center", color:"#94a3b8", fontSize:13, flexShrink:0 }}>검색 중...</span>}
          </div>
        </div>

        {/* 검색 결과 목록 */}
        {results !== null && (
          <div style={S.card}>
            {results.length === 0 ? (
              <div style={{ textAlign:"center", padding:"20px 0", color:"#94a3b8" }}>검색 결과 없음</div>
            ) : (
              <>
                <div style={{ fontSize:13, fontWeight:700, color:"#64748b", marginBottom:10 }}>{results.length}명 검색됨</div>
                {results.map((p, i) => (
                  <div key={i} onClick={() => selectPatient(p)}
                    style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", border:"1.5px solid #e2e8f0", borderRadius:9, marginBottom:6, cursor:"pointer", transition:"background 0.1s" }}
                    onMouseEnter={e => e.currentTarget.style.background="#f0f9ff"}
                    onMouseLeave={e => e.currentTarget.style.background="#fff"}>
                    <span style={S.badge("#0f2744","#fff")}>{p.internalId}</span>
                    {p.chartNo && <span style={S.badge("#e2e8f0","#475569")}>차트 {p.chartNo}</span>}
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:700, fontSize:15 }}>{p.name}</div>
                      <div style={{ fontSize:12, color:"#94a3b8" }}>
                        {p.birthDate || p.birthYear || ""} {p.gender==="M"?"남":"여"} · {phoneDisplay(p.phone)}
                      </div>
                    </div>
                    <span style={{ color:"#0ea5e9", fontSize:20 }}>›</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* 환자 프로필 */}
        {selected && (
          <>
            {/* 기본 정보 카드 */}
            <div style={{ ...S.card, borderTop:"3px solid #0f2744" }}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:14, flexWrap:"wrap", gap:8 }}>
                <div>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ fontSize:22, fontWeight:900 }}>{selected.name}</span>
                    <span style={S.badge("#0f2744","#fff")}>{selected.internalId}</span>
                    {selected.chartNo && <span style={S.badge("#e2e8f0","#475569")}>차트 {selected.chartNo}</span>}
                    {currentSlot && <span style={S.badge("#dcfce7","#166534")}>🏥 현재 입원중 {currentSlot.slotKey.split("-")[0]}호</span>}
                  </div>
                </div>
                <button onClick={() => setSelected(null)}
                  style={{ background:"#f1f5f9", border:"none", borderRadius:6, padding:"5px 12px", cursor:"pointer", fontSize:13, color:"#64748b" }}>
                  ✕ 닫기
                </button>
              </div>
              <InfoGrid items={[
                { label:"생년월일", value:selected.birthDate || selected.birthYear },
                { label:"성별",     value:selected.gender==="M"?"남성":selected.gender==="F"?"여성":"" },
                { label:"전화번호", value:phoneDisplay(selected.phone) },
                { label:"주상병",   value:selected.diagnosis },
                { label:"주소",     value:selected.address },
                { label:"진료의사", value:selected.doctor },
                { label:"최근 입원일", value:selected.lastAdmitDate },
                { label:"등록 경로", value:selected.source==="consultation"?"상담":"EMR 임포트" },
              ]} />
            </div>

            {/* 탭 */}
            <div style={{ display:"flex", gap:4, borderBottom:"2px solid #e2e8f0", marginBottom:0 }}>
              {[["info","🏥 입원현황"],["consult",`📋 상담이력 (${consultations.length})`]].map(([t,l]) => (
                <button key={t} style={S.tab(activeTab===t)} onClick={() => setActiveTab(t)}>{l}</button>
              ))}
            </div>

            {loadingDetail ? (
              <div style={{ ...S.card, textAlign:"center", color:"#94a3b8", padding:"24px" }}>불러오는 중...</div>
            ) : (
              <>
                {/* 입원 현황 탭 */}
                {activeTab === "info" && (
                  <div style={S.card}>
                    {currentSlot ? (
                      <div style={{ marginBottom:16 }}>
                        <div style={{ fontSize:14, fontWeight:800, color:"#059669", marginBottom:8 }}>✅ 현재 입원 중</div>
                        <InfoGrid items={[
                          { label:"병실·병상",  value:currentSlot.slotKey.replace("-"," 호 ")+"번" },
                          { label:"퇴원 예정",  value:currentSlot.data.discharge },
                          { label:"메모",       value:currentSlot.data.note },
                        ]} />
                        <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
                          <button onClick={() => router.push(`/room?roomId=${currentSlot.slotKey.split("-")[0]}`)}
                            style={{ background:"#0f2744", color:"#fff", border:"none", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                            병실 상세 보기 →
                          </button>
                          <button onClick={() => router.push(
                            `/treatment?slotKey=${encodeURIComponent(currentSlot.slotKey)}&name=${encodeURIComponent(selected.name)}&discharge=${encodeURIComponent(currentSlot.data.discharge||"")}&admitDate=${encodeURIComponent(currentSlot.data.admitDate||"")}&patientId=${encodeURIComponent(selected.internalId)}`
                          )} style={{ background:"#dc2626", color:"#fff", border:"none", borderRadius:7, padding:"7px 16px", cursor:"pointer", fontSize:13, fontWeight:700 }}>
                            📋 치료 일정표 →
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color:"#94a3b8", fontSize:14, marginBottom:reservations.length?16:0 }}>현재 입원 중인 병실 없음</div>
                    )}
                    {reservations.length > 0 && (
                      <>
                        <div style={{ fontSize:14, fontWeight:800, color:"#7c3aed", marginBottom:8 }}>📅 입원 예약 ({reservations.length}건)</div>
                        {reservations.map((r, i) => (
                          <div key={i} style={{ background:"#faf5ff", border:"1px solid #e9d5ff", borderRadius:8, padding:"10px 12px", marginBottom:6 }}>
                            <InfoGrid items={[
                              { label:"병실·병상",  value:r.slotKey.replace("-"," 호 ")+"번" },
                              { label:"입원 예정",  value:r.data.admitDate },
                              { label:"퇴원 예정",  value:r.data.discharge },
                            ]} />
                          </div>
                        ))}
                      </>
                    )}
                    {!currentSlot && reservations.length === 0 && (
                      <div style={{ color:"#94a3b8", fontSize:13, marginTop:8 }}>입원 이력 없음</div>
                    )}
                  </div>
                )}

                {/* 상담 이력 탭 */}
                {activeTab === "consult" && (
                  <div style={S.card}>
                    {consultations.length === 0 ? (
                      <div style={{ color:"#94a3b8", fontSize:14 }}>상담 이력 없음</div>
                    ) : consultations.map((c, i) => (
                      <div key={i} style={{ borderBottom:"1px solid #f1f5f9", paddingBottom:12, marginBottom:12 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6, flexWrap:"wrap" }}>
                          <span style={{ fontSize:13, fontWeight:700, color:"#64748b" }}>{c.createdAt}</span>
                          {c.status && <span style={{ ...S.badge(statusColor[c.status]||"#e2e8f0", "#fff"), }}>{c.status}</span>}
                          {c.admitDate && <span style={S.badge("#f5f3ff","#7c3aed")}>입원예정 {c.admitDate}</span>}
                        </div>
                        <InfoGrid items={[
                          { label:"진단",   value:c.diagnosis },
                          { label:"병원",   value:c.hospital },
                          { label:"수술",   value:c.surgery ? `✓ ${c.surgeryDate||""}` : "" },
                          { label:"항암",   value:c.chemo   ? `✓ ${c.chemoDate||""}`   : "" },
                          { label:"방사선", value:c.radiation ? `✓ ${c.radiationDate||""}` : "" },
                          { label:"희망 병실", value:c.roomTypes?.join("·") },
                        ]} />
                        {c.memo && <div style={{ marginTop:6, fontSize:13, color:"#475569", background:"#f8fafc", borderRadius:6, padding:"6px 8px" }}>{c.memo}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

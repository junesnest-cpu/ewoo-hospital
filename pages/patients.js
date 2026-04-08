import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { ref, onValue, get, set, update, remove } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import { findPatientByPhone, findPatientByChartNo, searchPatientsByName, normalizePhone } from "../lib/patientSearch";
import useIsMobile from "../lib/useismobile";

const ROOM_TYPE = {
  "201":"4인실","202":"1인실","203":"4인실","204":"2인실","205":"6인실","206":"6인실",
  "301":"4인실","302":"1인실","303":"4인실","304":"2인실","305":"2인실","306":"6인실",
  "501":"4인실","502":"1인실","503":"4인실","504":"2인실","505":"6인실","506":"6인실",
  "601":"6인실","602":"1인실","603":"6인실",
};
function roomLabel(slotKey) {
  const [roomId, bed] = slotKey.split("-");
  const type = ROOM_TYPE[roomId] || "";
  return { roomId, bed, type, label: `${roomId}호 ${bed}번${type ? ` (${type})` : ""}` };
}

const S = {
  app:    { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", padding:"12px 20px", display:"flex", alignItems:"center", gap:12, position:"sticky", top:0, zIndex:40, boxShadow:"0 2px 8px rgba(0,0,0,0.15)" },
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
  const [deletingRes,   setDeletingRes]   = useState(false);

  // 진단 관련 상태
  const [diagRunning,  setDiagRunning]  = useState(false);
  const [diagResults,  setDiagResults]  = useState(null); // null = 미실행
  const [diagFixing,   setDiagFixing]   = useState(false);
  const [diagFixMsg,   setDiagFixMsg]   = useState("");

  // URL에서 patientId 또는 이름 로드
  useEffect(() => {
    const { id, name } = router.query;
    if (id) loadPatientById(id);
    else if (name) { setQuery(name); doSearch(name); }
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

  // 사이드바 검색 이벤트
  useEffect(() => {
    const handler = (e) => { const q = e.detail?.q; if (q) setQuery(q); };
    window.addEventListener("sidebar-search", handler);
    return () => window.removeEventListener("sidebar-search", handler);
  }, []);

  const loadPatientById = async (internalId) => {
    try {
      const snap = await get(ref(db, "patients"));
      const all  = snap.val() || {};
      const p    = Object.values(all).filter(Boolean).find(x => x.internalId === internalId);
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
      const allC  = Object.values(cSnap.val() || {}).filter(Boolean);
      const linked = allC
        .filter(c => {
          if (c.patientId && p.internalId) return c.patientId === p.internalId;
          if (!c.patientId) return c.name === p.name; // patientId 없는 구형 상담 기록은 이름 매칭
          return false;
        })
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setConsultations(linked);
      // 입원/예약 현황
      const sSnap = await get(ref(db, "slots"));
      const allS  = sSnap.val() || {};
      let curSlot = null, resList = [];
      Object.entries(allS).forEach(([slotKey, slot]) => {
        if (!slot) return;
        const cur = slot.current;
        const matchCurrent = cur && (
          (cur.patientId && p.internalId) ? cur.patientId === p.internalId : (!cur.patientId && cur.name === p.name)
        );
        if (matchCurrent) curSlot = { slotKey, data: cur };
        (Array.isArray(slot.reservations) ? slot.reservations : Object.values(slot.reservations || {})).filter(Boolean).forEach((r, ri) => {
          const matchRes = (r.patientId && p.internalId) ? r.patientId === p.internalId : (!r.patientId && r.name === p.name);
          if (matchRes) resList.push({ slotKey, data: r, resIndex: ri });
        });
      });
      setCurrentSlot(curSlot);
      setReservations(resList);
    } catch(e) {
      console.error("[환자조회] selectPatient 오류:", e);
    }
    setLoadingDetail(false);
  };

  // ── 데이터 진단 ───────────────────────────────────────────────────────────
  const runDiagnosis = useCallback(async () => {
    setDiagRunning(true); setDiagResults(null); setDiagFixMsg("");
    try {
      const [pSnap, phoneSnap, chartSnap, sSnap, cSnap] = await Promise.all([
        get(ref(db, "patients")),
        get(ref(db, "patientByPhone")),
        get(ref(db, "patientByChartNo")),
        get(ref(db, "slots")),
        get(ref(db, "consultations")),
      ]);
      const pRaw   = pSnap.val()    || {};
      const phones = phoneSnap.val() || {};
      const charts = chartSnap.val() || {};
      const slots  = sSnap.val()    || {};
      const conRaw = cSnap.val()    || {};

      const allPatients = Object.entries(pRaw).map(([dbKey, v]) => ({ dbKey, ...v })).filter(x => x.name);
      const allCons     = Object.entries(conRaw).map(([k, v]) => ({ _key: k, ...v })).filter(Boolean);

      // ① 환자 레코드 문제
      const nullEntries       = Object.entries(pRaw).filter(([, v]) => !v).map(([k]) => k);
      const missingInternalId = allPatients.filter(p => !p.internalId);
      const missingChartNo    = allPatients.filter(p => !p.chartNo);

      // ② 인덱스 불일치
      const phoneMismatch = allPatients.filter(p => {
        if (!p.phone) return false;
        const n = p.phone.replace(/\D/g, "");
        return n.length >= 10 && phones[n] !== p.internalId;
      });
      const chartMismatch = allPatients.filter(p => {
        if (!p.chartNo) return false;
        return charts[String(p.chartNo)] !== p.internalId;
      });

      // ③ 중복 환자 (동일 이름 + 생년월일)
      const byNameBirth = {};
      allPatients.forEach(p => {
        const key = `${p.name}__${p.birthDate || p.birthYear || ""}`;
        if (!byNameBirth[key]) byNameBirth[key] = [];
        byNameBirth[key].push(p);
      });
      const duplicates = Object.values(byNameBirth).filter(g => g.length > 1);

      // 동일 전화번호 중복
      const byPhone = {};
      allPatients.filter(p => p.phone).forEach(p => {
        const n = p.phone.replace(/\D/g, "");
        if (!byPhone[n]) byPhone[n] = [];
        byPhone[n].push(p);
      });
      const dupPhones = Object.values(byPhone).filter(g => g.length > 1);

      // ④ 슬롯 연결 문제
      const pById  = {}; allPatients.forEach(p => { if (p.internalId) pById[p.internalId] = p; });
      const pByName= {}; allPatients.forEach(p => { if (p.name) pByName[p.name] = p; });

      const slotNoPatient   = []; // patientId 있는데 환자 없음
      const slotNameOnly    = []; // patientId 없는데 이름으로 환자 존재
      const slotLinked      = []; // 제대로 연결된 슬롯

      Object.entries(slots).forEach(([sk, slot]) => {
        if (!slot?.current?.name) return;
        const cur = slot.current;
        if (cur.patientId) {
          if (pById[cur.patientId]) slotLinked.push({ slotKey: sk, name: cur.name, patientId: cur.patientId });
          else slotNoPatient.push({ slotKey: sk, name: cur.name, patientId: cur.patientId });
        } else {
          const found = pByName[cur.name];
          if (found) slotNameOnly.push({ slotKey: sk, name: cur.name, suggestId: found.internalId, chartNo: found.chartNo });
        }
      });

      // ⑤ 상담 연결 문제
      const conNameOnly  = [];
      const conNoPatient = [];
      allCons.forEach(c => {
        if (!c.name) return;
        if (c.patientId) {
          if (!pById[c.patientId]) conNoPatient.push({ key: c._key, name: c.name, patientId: c.patientId });
        } else {
          const found = pByName[c.name];
          if (found) conNameOnly.push({ key: c._key, name: c.name, suggestId: found.internalId });
        }
      });

      setDiagResults({
        totalPatients: allPatients.length,
        nullEntries, missingInternalId, missingChartNo,
        phoneMismatch, chartMismatch,
        duplicates, dupPhones,
        slotNoPatient, slotNameOnly, slotLinked,
        conNameOnly, conNoPatient,
        allPatients, pById, pByName,
      });
    } catch(e) {
      console.error("[진단]", e);
      setDiagResults({ error: e.message });
    }
    setDiagRunning(false);
  }, []);

  const fixIssues = useCallback(async (type, diagResults) => {
    if (!diagResults) return;
    setDiagFixing(true); setDiagFixMsg("");
    try {
      const updates = {};

      if (type === "rebuild_index") {
        // 전화번호·차트번호 인덱스 재구축
        diagResults.allPatients.forEach(p => {
          if (!p.internalId) return;
          if (p.phone) {
            const n = p.phone.replace(/\D/g, "");
            if (n.length >= 10) updates[`patientByPhone/${n}`] = p.internalId;
          }
          if (p.chartNo) updates[`patientByChartNo/${p.chartNo}`] = p.internalId;
        });
        await update(ref(db), updates);
        setDiagFixMsg(`✅ 인덱스 재구축 완료 (${Object.keys(updates).length}건)`);
      }

      if (type === "link_slots") {
        // 슬롯 patientId 연결 (이름 일치)
        const sSnap = await get(ref(db, "slots"));
        const sAll  = sSnap.val() || {};
        let count = 0;
        for (const [sk, slot] of Object.entries(sAll)) {
          if (!slot) continue;
          if (slot.current?.name && !slot.current?.patientId) {
            const found = diagResults.pByName[slot.current.name];
            if (found?.internalId) {
              updates[`slots/${sk}/current/patientId`] = found.internalId;
              count++;
            }
          }
          (Array.isArray(slot.reservations) ? slot.reservations : Object.values(slot.reservations || {})).forEach((r, i) => {
            if (r?.name && !r?.patientId) {
              const found = diagResults.pByName[r.name];
              if (found?.internalId) {
                updates[`slots/${sk}/reservations/${i}/patientId`] = found.internalId;
                count++;
              }
            }
          });
        }
        if (count > 0) { await update(ref(db), updates); }
        setDiagFixMsg(`✅ 슬롯 patientId 연결 완료 (${count}건)`);
      }

      if (type === "link_consults") {
        // 상담 patientId 연결 (이름 일치)
        const cSnap = await get(ref(db, "consultations"));
        const cAll  = cSnap.val() || {};
        let count = 0;
        for (const [k, c] of Object.entries(cAll)) {
          if (!c || c.patientId || !c.name) continue;
          const found = diagResults.pByName[c.name];
          if (found?.internalId) {
            updates[`consultations/${k}/patientId`] = found.internalId;
            count++;
          }
        }
        if (count > 0) { await update(ref(db), updates); }
        setDiagFixMsg(`✅ 상담 patientId 연결 완료 (${count}건)`);
      }

      await runDiagnosis();
    } catch(e) {
      setDiagFixMsg(`❌ 오류: ${e.message}`);
    }
    setDiagFixing(false);
  }, [runDiagnosis]);

  const deleteReservation = async (slotKey, resIndex) => {
    if (!window.confirm("이 예약을 삭제하시겠습니까?")) return;
    setDeletingRes(true);
    try {
      const snap = await get(ref(db, `slots/${slotKey}`));
      const slot = snap.val();
      if (!slot) return;
      const arr = Array.isArray(slot.reservations) ? slot.reservations : Object.values(slot.reservations || {});
      const newRes = arr.filter((r, i) => i !== resIndex && r);
      await set(ref(db, `slots/${slotKey}/reservations`), newRes.length > 0 ? newRes : null);
      if (selected) await selectPatient(selected);
    } catch(e) {
      alert("삭제 중 오류가 발생했습니다.");
    }
    setDeletingRes(false);
  };

  // 날짜 파싱 + 일수 계산
  const parseAnyDate = (s) => {
    if (!s || s === "미정") return null;
    let d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    const md = String(s).match(/^(\d{1,2})[\/\.](\d{1,2})$/);
    if (md) { d = new Date(new Date().getFullYear(), parseInt(md[1])-1, parseInt(md[2])); return isNaN(d.getTime()) ? null : d; }
    return null;
  };
  const daysBetween = (start, end) => {
    const s = parseAnyDate(start);
    if (!s) return null;
    const e = parseAnyDate(end) || new Date();
    const diff = Math.round((e - s) / 86400000);
    return diff >= 0 ? diff + 1 : null;
  };

  const calcAge = (birthDate, birthYear) => {
    const str = String(birthDate || birthYear || "");
    const year = parseInt(str.slice(0, 4));
    if (!year || isNaN(year) || year < 1900) return null;
    const now = new Date();
    let age = now.getFullYear() - year;
    if (birthDate && str.length >= 10) {
      const m = parseInt(str.slice(5, 7)), d = parseInt(str.slice(8, 10));
      if (!isNaN(m) && !isNaN(d) && (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d))) age--;
    }
    return age;
  };

  const mergePhoneDupGroup = async (grp) => {
    const sorted = [...grp].sort((a, b) => {
      if (a.chartNo && !b.chartNo) return -1;
      if (!a.chartNo && b.chartNo) return 1;
      return parseInt((a.internalId||"P99999").replace(/\D/g,"")) - parseInt((b.internalId||"P99999").replace(/\D/g,""));
    });
    const primary = sorted[0], secondary = sorted[1];
    if (!window.confirm(`[중복 통합 확인]\n\n유지: ${primary.internalId} ${primary.name} (차트:${primary.chartNo||"없음"})\n삭제: ${secondary.internalId} ${secondary.name} (차트:${secondary.chartNo||"없음"})\n\n삭제된 ID의 상담·병실 기록은 유지 ID로 이전됩니다.`)) return;
    setDiagFixing(true); setDiagFixMsg("");
    try {
      const updates = {};
      // 1. primary 레코드에 secondary 필드 보완 (primary 우선, 누락 필드만 보완)
      const merged = { ...secondary };
      Object.entries(primary).forEach(([k,v]) => { if (v !== undefined && v !== null && v !== "" && k !== "dbKey") merged[k] = v; });
      if (!primary.chartNo && secondary.chartNo) merged.chartNo = secondary.chartNo;
      merged.internalId = primary.internalId;
      delete merged.dbKey;
      updates[`patients/${primary.dbKey}`] = merged;
      // 2. 상담 patientId 이전
      const cSnap = await get(ref(db, "consultations"));
      Object.entries(cSnap.val() || {}).forEach(([k,c]) => {
        if (c?.patientId === secondary.internalId) updates[`consultations/${k}/patientId`] = primary.internalId;
      });
      // 3. 슬롯 patientId 이전
      const sSnap = await get(ref(db, "slots"));
      Object.entries(sSnap.val() || {}).forEach(([sk, slot]) => {
        if (!slot) return;
        if (slot.current?.patientId === secondary.internalId) updates[`slots/${sk}/current/patientId`] = primary.internalId;
        (Array.isArray(slot.reservations)?slot.reservations:Object.values(slot.reservations||{})).forEach((r,i) => {
          if (r?.patientId === secondary.internalId) updates[`slots/${sk}/reservations/${i}/patientId`] = primary.internalId;
        });
      });
      // 4. 인덱스 갱신
      const allPhones = [primary.phone, secondary.phone].filter(Boolean);
      allPhones.forEach(p => { const n=p.replace(/\D/g,""); if(n.length>=10) updates[`patientByPhone/${n}`]=primary.internalId; });
      if (secondary.chartNo) updates[`patientByChartNo/${secondary.chartNo}`] = primary.internalId;
      if (primary.chartNo)   updates[`patientByChartNo/${primary.chartNo}`]   = primary.internalId;
      await update(ref(db), updates);
      // 5. secondary 레코드 삭제
      await remove(ref(db, `patients/${secondary.dbKey}`));
      setDiagFixMsg(`✅ 통합 완료 — ${secondary.internalId}(${secondary.name}) → ${primary.internalId}`);
      await runDiagnosis();
    } catch(e) { setDiagFixMsg(`❌ 통합 오류: ${e.message}`); }
    setDiagFixing(false);
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
        <span style={{ fontSize:16, fontWeight:800 }}>환자 조회</span>
      </header>

      <div style={S.body}>
        {/* 상단 탭 — 검색 / 데이터 진단 */}
        <div style={{ display:"flex", gap:4, marginBottom:12 }}>
          {[["search","🔍 환자 검색"],["diag","🔧 데이터 진단"]].map(([t,l]) => (
            <button key={t}
              onClick={() => {
                if (t === "diag") { setActiveTab("diag_root"); setSelected(null); setResults(null); }
                else { setActiveTab("info"); }
              }}
              style={{ padding:"8px 18px", border:"none", borderRadius:8, cursor:"pointer", fontSize:13, fontWeight:700,
                background: (t === "diag" ? activeTab === "diag_root" : activeTab !== "diag_root") ? "#0f2744" : "#f1f5f9",
                color:      (t === "diag" ? activeTab === "diag_root" : activeTab !== "diag_root") ? "#fff"    : "#64748b" }}>
              {l}
            </button>
          ))}
        </div>

        {/* 검색 */}
        {activeTab !== "diag_root" && <div style={{ ...S.card, marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#94a3b8", marginBottom:6 }}>이름 또는 전화번호를 입력하면 자동으로 검색됩니다</div>
          <div style={{ display:"flex", gap:8 }}>
            <input style={{ ...S.input, flex:1 }}
              placeholder="이름 또는 전화번호"
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key==="Enter" && doSearch()} autoFocus />
            {searching && <span style={{ display:"flex", alignItems:"center", color:"#94a3b8", fontSize:13, flexShrink:0 }}>검색 중...</span>}
          </div>
        </div>}

        {/* 검색 결과 목록 */}
        {activeTab !== "diag_root" && results !== null && (
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
        {activeTab !== "diag_root" && selected && (
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
                { label:"생년월일",     value: (() => { const bd = selected.birthDate || selected.birthYear; if (!bd) return null; const age = calcAge(selected.birthDate, selected.birthYear); return age ? `${bd} (${age}세)` : bd; })() },
                { label:"성별",         value:selected.gender==="M"?"남성":selected.gender==="F"?"여성":"" },
                { label:"전화번호",     value:phoneDisplay(selected.phone) },
                { label:"주소증",       value:selected.chiefComplaint },
                { label:"주상병",       value:selected.diagName || selected.diagnosis },
                { label:"주소",         value:selected.address },
                { label:"진료의사",     value:selected.lastDoctor || selected.doctor },
                { label:"주치의 과목",  value:selected.lastDept },
                { label:"최근 입원일",  value:selected.lastAdmitDate },
                { label:"등록 경로",    value:selected.source==="consultation"?"상담":"EMR 임포트" },
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
                        <div style={{ fontSize:14, fontWeight:800, color:"#7c3aed", marginBottom:6 }}>📅 입원 예약 ({reservations.length}건)</div>
                        {[...reservations].sort((a, b) => (a.data.admitDate||"").localeCompare(b.data.admitDate||"")).map((r, i) => {
                          const rm = roomLabel(r.slotKey);
                          return (
                            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", border:"1px solid #e9d5ff", borderRadius:7, padding:"7px 12px", marginBottom:5, background:"#faf5ff" }}>
                              <div style={{ fontSize:13, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                                <span style={{ fontWeight:800, color:"#7c3aed" }}>{rm.roomId}호 {rm.bed}번</span>
                                {rm.type && <span style={{ fontSize:11, background:"#ede9fe", color:"#6d28d9", borderRadius:4, padding:"1px 6px", fontWeight:700 }}>{rm.type}</span>}
                                <span style={{ color:"#94a3b8", fontSize:12 }}>|</span>
                                <span style={{ fontWeight:600 }}>{r.data.admitDate}</span>
                                {r.data.discharge && <><span style={{ color:"#94a3b8" }}>→</span><span style={{ color:"#475569" }}>{r.data.discharge}</span></>}
                              </div>
                              <button onClick={() => deleteReservation(r.slotKey, r.resIndex)} disabled={deletingRes}
                                style={{ flexShrink:0, background:"#fee2e2", color:"#dc2626", border:"1px solid #fca5a5", borderRadius:6, padding:"3px 8px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                                삭제
                              </button>
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* 입원 이력 */}
                    {(() => {
                      const history = [];
                      // 현재 입원
                      if (currentSlot?.data?.admitDate) {
                        history.push({ admitDate: currentSlot.data.admitDate, discharge: currentSlot.data.discharge, isCurrent: true, source: "slot" });
                      }
                      // 상담 기록 기반 (입원완료)
                      consultations.filter(c => c.status === "입원완료" && c.admitDate).forEach(c => {
                        history.push({ admitDate: c.admitDate, discharge: c.dischargeDate || null, isCurrent: false, source: "consultation" });
                      });
                      // EMR 입원이력 (SILVER_PATIENT_INFO)
                      (selected?.emrAdmissions || []).forEach(e => {
                        const dup = history.some(h => h.admitDate && e.admitDate && h.admitDate.slice(0,10) === e.admitDate.slice(0,10));
                        if (!dup) history.push({ admitDate: e.admitDate, discharge: e.dischargeDate || null, isCurrent: false, source: "emr" });
                      });
                      history.sort((a, b) => (b.admitDate || "").localeCompare(a.admitDate || ""));
                      if (history.length === 0) return null;

                      // 연도별 합산
                      const byYear = {};
                      let totalDays = 0;
                      history.forEach(h => {
                        const d = daysBetween(h.admitDate, h.discharge);
                        if (!d) return;
                        totalDays += d;
                        const yr = (h.admitDate || "").slice(0, 4);
                        if (yr) byYear[yr] = (byYear[yr] || 0) + d;
                      });
                      const yearEntries = Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0]));

                      return (
                        <div style={{ marginTop:16, paddingTop:16, borderTop:"1px solid #f1f5f9" }}>
                          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, flexWrap:"wrap" }}>
                            <span style={{ fontSize:14, fontWeight:800, color:"#0f2744" }}>📊 입원 이력</span>
                            <span style={{ fontSize:11, color:"#94a3b8" }}>{history.length}건</span>
                            {totalDays > 0 && (
                              <span style={{ fontSize:12, background:"#dbeafe", color:"#1e40af", borderRadius:5, padding:"2px 8px", fontWeight:700 }}>전체 {totalDays}일</span>
                            )}
                            {yearEntries.map(([yr, days]) => (
                              <span key={yr} style={{ fontSize:12, background:"#f0fdf4", color:"#166534", borderRadius:5, padding:"2px 8px", fontWeight:600 }}>{yr}년 {days}일</span>
                            ))}
                          </div>
                          {history.map((h, i) => {
                            const days = daysBetween(h.admitDate, h.discharge);
                            return (
                              <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", border:"1px solid #e2e8f0", borderRadius:7, padding:"7px 12px", marginBottom:5, background: h.isCurrent ? "#f0fdf4" : "#f8fafc" }}>
                                <div style={{ fontSize:13 }}>
                                  <span style={{ fontWeight:700 }}>{h.admitDate}</span>
                                  <span style={{ color:"#94a3b8", margin:"0 6px" }}>→</span>
                                  <span style={{ color: h.isCurrent ? "#059669" : "#475569" }}>
                                    {h.isCurrent ? (h.discharge && h.discharge !== "미정" ? h.discharge : "재원 중") : (h.discharge || "미상")}
                                  </span>
                                  {h.isCurrent && <span style={{ marginLeft:6, fontSize:11, background:"#dcfce7", color:"#166534", borderRadius:3, padding:"1px 5px", fontWeight:700 }}>현재</span>}
                                  {h.source === "emr" && <span style={{ marginLeft:6, fontSize:10, background:"#f1f5f9", color:"#64748b", borderRadius:3, padding:"1px 5px" }}>EMR</span>}
                                </div>
                                {days && <span style={{ fontSize:12, color:"#64748b", background:"#e2e8f0", borderRadius:4, padding:"1px 8px", fontWeight:600, flexShrink:0 }}>{days}일</span>}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

                    {!currentSlot && reservations.length === 0 && consultations.filter(c => c.status === "입원완료").length === 0 && !(selected?.emrAdmissions?.length > 0) && (
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
                          { label:"희망 병실", value:Array.isArray(c.roomTypes) ? c.roomTypes.join("·") : (c.roomTypes || "") },
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
        {/* ── 데이터 진단 탭 ───────────────────────────────── */}
        {activeTab === "diag_root" && (
          <div style={S.card}>
            <div style={{ fontSize:15, fontWeight:800, color:"#0f2744", marginBottom:12 }}>🔧 환자 데이터 진단</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
              <button onClick={runDiagnosis} disabled={diagRunning}
                style={{ background:"#0f2744", color:"#fff", border:"none", borderRadius:8, padding:"8px 20px", fontSize:13, fontWeight:700, cursor:"pointer", opacity: diagRunning ? 0.6 : 1 }}>
                {diagRunning ? "진단 중..." : "🔍 진단 실행"}
              </button>
              {diagResults && !diagResults.error && (
                <>
                  <button onClick={() => fixIssues("rebuild_index", diagResults)} disabled={diagFixing}
                    style={{ background:"#0369a1", color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
                    📇 전화·차트 인덱스 재구축
                  </button>
                  {(diagResults.slotNameOnly.length > 0) && (
                    <button onClick={() => fixIssues("link_slots", diagResults)} disabled={diagFixing}
                      style={{ background:"#059669", color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
                      🏥 슬롯 patientId 연결 ({diagResults.slotNameOnly.length}건)
                    </button>
                  )}
                  {(diagResults.conNameOnly.length > 0) && (
                    <button onClick={() => fixIssues("link_consults", diagResults)} disabled={diagFixing}
                      style={{ background:"#7c3aed", color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
                      📋 상담 patientId 연결 ({diagResults.conNameOnly.length}건)
                    </button>
                  )}
                </>
              )}
            </div>

            {diagFixMsg && (
              <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"8px 14px", marginBottom:12, fontSize:13, fontWeight:700, color:"#166534" }}>
                {diagFixMsg}
              </div>
            )}

            {diagResults?.error && (
              <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 14px", color:"#dc2626", fontSize:13 }}>
                ❌ 진단 오류: {diagResults.error}
              </div>
            )}

            {diagResults && !diagResults.error && (() => {
              const d = diagResults;
              const DiagSection = ({ title, count, color, bg, children }) => (
                <div style={{ marginBottom:14 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={{ fontSize:13, fontWeight:800, color }}>{title}</span>
                    <span style={{ background: count === 0 ? "#dcfce7" : bg, color: count === 0 ? "#166534" : color,
                      borderRadius:6, padding:"1px 10px", fontSize:12, fontWeight:700 }}>
                      {count === 0 ? "✓ 이상 없음" : `${count}건`}
                    </span>
                  </div>
                  {count > 0 && children}
                </div>
              );
              const Row = ({ items }) => (
                <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginLeft:8 }}>
                  {items.slice(0,20).map((item, i) => (
                    <span key={i} style={{ background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:6, padding:"2px 8px", fontSize:12 }}>
                      {typeof item === "string" ? item : JSON.stringify(item)}
                    </span>
                  ))}
                  {items.length > 20 && <span style={{ fontSize:12, color:"#94a3b8" }}>... 외 {items.length-20}건</span>}
                </div>
              );

              return (
                <div>
                  <div style={{ background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:8, padding:"10px 14px", marginBottom:14, fontSize:13 }}>
                    총 환자 수: <strong>{d.totalPatients}명</strong>
                  </div>

                  <DiagSection title="① null/빈 환자 레코드" count={d.nullEntries.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.nullEntries} />
                  </DiagSection>

                  <DiagSection title="② internalId 없는 환자" count={d.missingInternalId.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.missingInternalId.map(p => `${p.name} (키: ${p.dbKey})`)} />
                  </DiagSection>

                  <DiagSection title="③ 차트번호 없는 환자" count={d.missingChartNo.length} color="#d97706" bg="#fef3c7">
                    <Row items={d.missingChartNo.map(p => `${p.name} (${p.internalId})`)} />
                  </DiagSection>

                  <DiagSection title="④ 전화번호 인덱스 불일치" count={d.phoneMismatch.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.phoneMismatch.map(p => `${p.name} 전화:${p.phone} → ${p.internalId}`)} />
                  </DiagSection>

                  <DiagSection title="⑤ 차트번호 인덱스 불일치" count={d.chartMismatch.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.chartMismatch.map(p => `${p.name} 차트:${p.chartNo} → ${p.internalId}`)} />
                  </DiagSection>

                  <DiagSection title="⑥ 중복 환자 (이름+생년월일)" count={d.duplicates.length} color="#7c3aed" bg="#ede9fe">
                    {d.duplicates.map((grp, i) => (
                      <div key={i} style={{ marginLeft:8, marginBottom:4, fontSize:12 }}>
                        <strong>{grp[0].name}</strong> ({grp[0].birthDate || grp[0].birthYear || "생년불명"}):&nbsp;
                        {grp.map(p => `${p.internalId}(차트:${p.chartNo||"-"})`).join(" / ")}
                      </div>
                    ))}
                  </DiagSection>

                  <DiagSection title="⑦ 중복 전화번호" count={d.dupPhones.length} color="#7c3aed" bg="#ede9fe">
                    {d.dupPhones.map((grp, i) => (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginLeft:8, marginBottom:6, fontSize:12, flexWrap:"wrap" }}>
                        <span><strong>{grp[0].phone}</strong>: {grp.map(p => `${p.name}(${p.internalId}${p.chartNo?` 차트:${p.chartNo}`:""})`).join(" / ")}</span>
                        <button onClick={() => mergePhoneDupGroup(grp)} disabled={diagFixing}
                          style={{ background:"#7c3aed", color:"#fff", border:"none", borderRadius:5, padding:"2px 10px", fontSize:11, fontWeight:700, cursor:"pointer", flexShrink:0 }}>
                          통합
                        </button>
                      </div>
                    ))}
                  </DiagSection>

                  <DiagSection title="⑧ 슬롯에 patientId 없음 (이름으로 환자 존재)" count={d.slotNameOnly.length} color="#d97706" bg="#fef3c7">
                    <Row items={d.slotNameOnly.map(s => `${s.slotKey} ${s.name} → ${s.suggestId}(차트:${s.chartNo||"-"})`)} />
                  </DiagSection>

                  <DiagSection title="⑨ 슬롯 patientId가 환자에 없음" count={d.slotNoPatient.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.slotNoPatient.map(s => `${s.slotKey} ${s.name} patientId:${s.patientId}`)} />
                  </DiagSection>

                  <DiagSection title="⑩ 상담에 patientId 없음 (이름으로 환자 존재)" count={d.conNameOnly.length} color="#d97706" bg="#fef3c7">
                    <Row items={d.conNameOnly.map(c => `${c.name} → ${c.suggestId}`)} />
                  </DiagSection>

                  <DiagSection title="⑪ 상담 patientId가 환자에 없음" count={d.conNoPatient.length} color="#dc2626" bg="#fee2e2">
                    <Row items={d.conNoPatient.map(c => `${c.name} patientId:${c.patientId}`)} />
                  </DiagSection>

                  {/* 차트번호별 환자 목록 */}
                  <div style={{ marginTop:20, borderTop:"1px solid #e2e8f0", paddingTop:14 }}>
                    <div style={{ fontSize:13, fontWeight:800, color:"#0f2744", marginBottom:8 }}>📑 차트번호 연동 현황 (상위 50명)</div>
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                        <thead>
                          <tr style={{ background:"#f8fafc" }}>
                            {["차트번호","이름","internalId","전화번호","생년월일","차트인덱스","전화인덱스"].map(h => (
                              <th key={h} style={{ padding:"6px 8px", textAlign:"left", borderBottom:"1px solid #e2e8f0", fontWeight:700, color:"#475569", whiteSpace:"nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {d.allPatients.filter(p => p.chartNo).sort((a,b) => String(a.chartNo).localeCompare(String(b.chartNo), undefined, {numeric:true})).slice(0,50).map((p,i) => {
                            const phone = (p.phone||"").replace(/\D/g,"");
                            const chartOk = d.chartMismatch.every(m => m.internalId !== p.internalId);
                            const phoneOk = !p.phone || phone.length < 10 || d.phoneMismatch.every(m => m.internalId !== p.internalId);
                            return (
                              <tr key={i}
                                style={{ background: i%2===0?"#fff":"#f8fafc", cursor:"pointer" }}
                                onClick={() => { selectPatient(p); setActiveTab("info"); }}
                                onMouseEnter={e=>e.currentTarget.style.background="#f0f9ff"}
                                onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"#fff":"#f8fafc"}>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9", fontWeight:700 }}>{p.chartNo}</td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9", fontWeight:600 }}>{p.name}</td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9", color:"#64748b" }}>{p.internalId}</td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9" }}>{phoneDisplay(p.phone)}</td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9" }}>{p.birthDate||p.birthYear||""}</td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"center" }}>
                                  <span style={{ color: chartOk?"#059669":"#dc2626", fontWeight:700 }}>{chartOk?"✓":"✗"}</span>
                                </td>
                                <td style={{ padding:"5px 8px", borderBottom:"1px solid #f1f5f9", textAlign:"center" }}>
                                  <span style={{ color: phoneOk?"#059669":"#dc2626", fontWeight:700 }}>{phoneOk?"✓":"✗"}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

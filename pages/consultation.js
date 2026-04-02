import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set, push, remove, query, orderByChild, startAt, endAt } from "firebase/database";
import { db } from "../lib/firebaseConfig";
import useIsMobile from "../lib/useismobile";

const ROOM_TYPES = ["1인실","2인실","4인실","6인실"];
const WARD_STRUCTURE = {
  2: { rooms: [
    {id:"201",type:"4인실",cap:4},{id:"202",type:"1인실",cap:1},{id:"203",type:"4인실",cap:4},
    {id:"204",type:"2인실",cap:2},{id:"205",type:"6인실",cap:6},{id:"206",type:"6인실",cap:6},
  ]},
  3: { rooms: [
    {id:"301",type:"4인실",cap:4},{id:"302",type:"1인실",cap:1},{id:"303",type:"4인실",cap:4},
    {id:"304",type:"2인실",cap:2},{id:"305",type:"2인실",cap:2},{id:"306",type:"6인실",cap:6},
  ]},
  5: { rooms: [
    {id:"501",type:"4인실",cap:4},{id:"502",type:"1인실",cap:1},{id:"503",type:"4인실",cap:4},
    {id:"504",type:"2인실",cap:2},{id:"505",type:"6인실",cap:6},{id:"506",type:"6인실",cap:6},
  ]},
  6: { rooms: [
    {id:"601",type:"6인실",cap:6},{id:"602",type:"1인실",cap:1},{id:"603",type:"6인실",cap:6},
  ]},
};

const TYPE_COLOR = {"1인실":"#6366f1","2인실":"#0ea5e9","4인실":"#10b981","6인실":"#f59e0b"};
const TYPE_BG    = {"1인실":"#eef2ff","2인실":"#e0f2fe","4인실":"#d1fae5","6인실":"#fef3c7"};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function fmtDate(str) {
  if (!str) return "";
  const d = new Date(str);
  if (isNaN(d)) return str;
  return `${d.getMonth()+1}/${d.getDate()}`;
}
function monthKey(str) {
  if (!str) return "";
  return str.slice(0,7); // "YYYY-MM"
}
// admitDate를 YYYY-MM-DD로 정규화 (M/D 형식은 createdAt 연도 기준)
function normAdmitDate(c) {
  const s = c.admitDate;
  if (!s) return null;
  if (s.includes("-")) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const year = c.createdAt ? new Date(c.createdAt).getFullYear() : new Date().getFullYear();
  return `${year}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
}
function korMonth(ym) {
  if (!ym) return "";
  const [y,m] = ym.split("-");
  return `${y}년 ${parseInt(m)}월`;
}

const EMPTY_FORM = {
  name:"", birthYear:"", age:"",
  phone:"", phoneNote:"",
  phone2:"", phone2Note:"",
  diagnosis:"", hospital:"",
  admitDate:"", roomTypes:[],
  surgery:false, surgeryDate:"",
  chemo:false, chemoDate:"",
  radiation:false, radiationDate:"",
  memo:"",
  createdAt:"", status:"상담중",
  recontact:false, recontactDate:"", recontactMemo:"",
};

const CUR_YEAR = new Date().getFullYear();
function calcAge(birthYear) {
  const n = parseInt(birthYear);
  if (isNaN(n) || n < 1900 || n > CUR_YEAR) return "";
  return String(CUR_YEAR - n);
}
function calcBirthYear(age) {
  const n = parseInt(age);
  if (isNaN(n) || n < 0 || n > 130) return "";
  return String(CUR_YEAR - n);
}
function normPhone(p) {
  return (p||"").replace(/[^0-9]/g, "");
}

export default function ConsultationPage() {
  const router = useRouter();
  const isMobile = useIsMobile();

  const [consultations, setConsultations] = useState({});
  const [slots, setSlots] = useState({});
  const [patients, setPatients] = useState({});
  const [view, setView] = useState("list"); // list | form
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({...EMPTY_FORM});
  const [search, setSearch] = useState("");
  const [filterMonth, setFilterMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
  });
  const [filterStatus, setFilterStatus] = useState("전체");
  const [filterAdmitDate, setFilterAdmitDate] = useState(""); // 예약날짜 검색

  // 폼 내 기존 환자 검색
  const [ptSearchQ, setPtSearchQ] = useState("");
  const [ptSearchOpen, setPtSearchOpen] = useState(false);

  // 연락처 자동 매칭
  const [phoneMatch, setPhoneMatch]   = useState(null); // { name, info, data }
  const [phone2Match, setPhone2Match] = useState(null);

  // 전체 상담 (연락처 검색용 — 별도 구독)
  const [allConsultations, setAllConsultations] = useState({});

  // 병실 모달 (예약 등록)
  const [reserveModal, setReserveModal] = useState(null); // { consultation }
  const [reserveSlot, setReserveSlot] = useState("");

  // 월별 상담일지 로드 (월 변경 시 해당 월만 로드)
  useEffect(() => {
    setConsultations({});
    let q;
    if (filterMonth) {
      const monthStart = `${filterMonth}-01`;
      const monthEnd   = `${filterMonth}-31`;
      q = query(ref(db,"consultations"), orderByChild("createdAt"), startAt(monthStart), endAt(monthEnd));
    } else {
      q = ref(db,"consultations");
    }
    const unsub = onValue(q, snap => {
      setConsultations(snap.val() || {});
    });
    return unsub;
  }, [filterMonth]);

  useEffect(() => {
    const unsub2 = onValue(ref(db,"slots"), snap => {
      setSlots(snap.val() || {});
    });
    return unsub2;
  }, []);

  useEffect(() => {
    const unsub3 = onValue(ref(db,"patients"), snap => {
      setPatients(snap.val() || {});
    });
    return unsub3;
  }, []);

  // 연락처 매칭용 전체 상담 로드 (한 번만)
  useEffect(() => {
    const unsub4 = onValue(ref(db,"consultations"), snap => {
      setAllConsultations(snap.val() || {});
    });
    return unsub4;
  }, []);

  const setF = (k,v) => setForm(f=>({...f,[k]:v}));

  // 기존 환자 검색 결과
  const ptResults = useMemo(() => {
    const q = ptSearchQ.trim().toLowerCase();
    if (!q) return [];
    return Object.entries(patients)
      .map(([id, p]) => ({id, ...p}))
      .filter(p => (p.name||"").toLowerCase().includes(q) || (p.phone||"").includes(q))
      .slice(0, 8);
  }, [ptSearchQ, patients]);

  // 연락처로 기존 환자/상담 검색
  function lookupByPhone(phone) {
    const norm = normPhone(phone);
    if (norm.length < 10) return null;
    // patients 우선
    for (const [id, p] of Object.entries(patients)) {
      if (p.name && normPhone(p.phone) === norm) {
        const by = p.birthDate ? p.birthDate.slice(0,4) : (p.birthYear||"");
        return { name: p.name, info: [by ? `${by}년생` : "", p.diagnosis].filter(Boolean).join(" · "),
          fill: { name:p.name, phone:phone, birthYear:by, age:by?calcAge(by):"", diagnosis:p.diagnosis||"",
                  patientId:p.internalId||id } };
      }
    }
    // 전체 상담 검색
    for (const [id, c] of Object.entries(allConsultations)) {
      if (editId && id === editId) continue; // 자기 자신 제외
      if (c.name && (normPhone(c.phone) === norm || normPhone(c.phone2) === norm)) {
        return { name: c.name, info: [c.birthYear ? `${c.birthYear}년생` : "", c.diagnosis].filter(Boolean).join(" · "),
          fill: { name:c.name, phone:normPhone(c.phone)===norm?phone:c.phone,
                  phone2:normPhone(c.phone2)===norm?phone:c.phone2,
                  phone2Note:c.phone2Note||"", phoneNote:c.phoneNote||"",
                  birthYear:c.birthYear||"", age:c.age||"", diagnosis:c.diagnosis||"",
                  hospital:c.hospital||"", patientId:c.patientId||"" } };
      }
    }
    return null;
  }

  function applyPhoneMatch(match) {
    setForm(f => ({ ...f, ...match.fill,
      phone: f.phone, phone2: f.phone2, // 현재 입력한 번호 유지
    }));
  }

  function fillFromPatient(p) {
    const by = p.birthDate ? p.birthDate.slice(0,4) : (p.birthYear||"");
    setForm(f => ({
      ...f,
      name:       p.name       || f.name,
      phone:      p.phone ? p.phone.replace(/(\d{3})(\d{4})(\d{4})/,"$1-$2-$3") : f.phone,
      birthYear:  by || f.birthYear,
      age:        by ? calcAge(by) : f.age,
      diagnosis:  p.diagnosis  || f.diagnosis,
      patientId:  p.internalId || p.id || f.patientId,
    }));
    setPtSearchOpen(false);
    setPtSearchQ("");
  }

  const toggleRoomType = (rt) => {
    setForm(f=>({...f, roomTypes: f.roomTypes.includes(rt) ? f.roomTypes.filter(x=>x!==rt) : [...f.roomTypes, rt]}));
  };

  const saveConsultation = async () => {
    if (!form.name.trim()) { alert("이름을 입력해 주세요."); return; }
    const data = { ...form, updatedAt: today() };
    if (editId) {
      await set(ref(db,`consultations/${editId}`), {...consultations[editId], ...data});
    } else {
      data.createdAt = today();
      data.status = data.status || "상담중";
      await push(ref(db,"consultations"), data);
    }
    setView("list"); setEditId(null); setForm({...EMPTY_FORM});
  };

  const deleteConsultation = async (id) => {
    if (!confirm("이 상담 기록을 삭제하시겠습니까?")) return;
    await remove(ref(db,`consultations/${id}`));
    setView("list"); setEditId(null);
  };

  // 예약 등록: consultation → slots reservation
  const doRegisterReservation = async () => {
    if (!reserveSlot) { alert("병상을 선택해 주세요."); return; }
    const c = reserveModal.consultation;
    const existing = slots[reserveSlot] || { current: null, reservations: [] };
    const reservations = [...(existing.reservations||[]), {
      name: c.name,
      admitDate: c.admitDate ? fmtDate(c.admitDate) : "",
      discharge: "미정",
      note: [c.diagnosis, c.hospital, c.memo].filter(Boolean).join(" / "),
      scheduleAlert: false,
      bedPosition: parseInt(reserveSlot.split("-")[1]),
    }];
    reservations.sort((a,b) => {
      const pa = a.admitDate?.match(/(\d+)\/(\d+)/);
      const pb = b.admitDate?.match(/(\d+)\/(\d+)/);
      if (!pa) return 1; if (!pb) return -1;
      return (parseInt(pa[1])*31+parseInt(pa[2])) - (parseInt(pb[1])*31+parseInt(pb[2]));
    });
    await set(ref(db,`slots/${reserveSlot}`), {...existing, reservations});
    // 상담 상태 -> 예약완료 + slots에 예약 자동 등록
    const consult = reserveModal.consultation;
    await set(ref(db,`consultations/${reserveModal.id}`), {...consult, status:"예약완료", reservedSlot: reserveSlot});
    // slots에도 예약 추가
    const slotSnap = await new Promise(res=>{ const u=onValue(ref(db,`slots/${reserveSlot}`),s=>{u();res(s.val());},{onlyOnce:true}); });
    const slotData = slotSnap || { current:null, reservations:[] };
    const newReservations = [...(slotData.reservations||[])];
    // 중복 방지: 같은 이름+날짜 예약이 없을 때만 추가
    const dup = newReservations.find(r=>r.name===consult.name && r.admitDate===consult.admitDate);
    if (!dup) {
      newReservations.push({
        name: consult.name,
        admitDate: consult.admitDate ? fmtDate(consult.admitDate) : "",
        discharge: consult.discharge || "미정",
        note: consult.diagnosis || "",
        consultationId: reserveModal.id,
      });
      await set(ref(db,`slots/${reserveSlot}`), {...slotData, reservations: newReservations});
    }
    setReserveModal(null); setReserveSlot("");
    alert(`${c.name}님 ${reserveSlot} 예약 등록 완료`);
  };

  // 필터링된 목록
  // 순번 계산용: 오래된 순(오름차순) - 이달 1번이 가장 먼저 전화온 사람
  const allListAsc = Object.entries(consultations).map(([id,c])=>({id,...c}))
    .sort((a,b) => {
      const dc = (a.createdAt||"").localeCompare(b.createdAt||"");
      if (dc !== 0) return dc;
      return (a.id||"").localeCompare(b.id||""); // 같은 날이면 id(입력순) 기준
    });

  // 월별 순번 계산 (오름차순 기준 → 1번 = 이달 첫 상담)
  const monthSeqMap = {};
  allListAsc.forEach(c => {
    const mk = monthKey(c.createdAt);
    if (!mk) return;
    if (!monthSeqMap[mk]) monthSeqMap[mk] = 0;
    monthSeqMap[mk]++;
    c._monthSeq = monthSeqMap[mk];
  });

  // 화면 표시용: 최신순(내림차순) — 최근 상담이 위에, 같은 날은 나중 입력이 위
  const allList = [...allListAsc].sort((a,b) => {
    const dc = (b.createdAt||"").localeCompare(a.createdAt||"");
    if (dc !== 0) return dc;
    return (b.id||"").localeCompare(a.id||""); // 같은 날이면 나중 입력이 위
  });

  // 월 목록: 현재 월 기준 최근 24개월 고정 생성 (월별 로드이므로 loaded data에서 추출 불가)
  const months = (() => {
    const result = [];
    const d = new Date();
    for (let i = 0; i < 24; i++) {
      result.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`);
      d.setMonth(d.getMonth() - 1);
    }
    return result;
  })();

  const filtered = allList.filter(c => {
    if (filterStatus !== "전체") {
      // admitDate가 있고 입원완료/취소가 아니면 예약완료로 간주
      const effectiveStatus = (c.admitDate && c.status !== "입원완료" && c.status !== "취소")
        ? "예약완료" : c.status;
      if (effectiveStatus !== filterStatus) return false;
    }
    // 예약날짜 필터: admitDate가 선택한 날짜와 일치
    if (filterAdmitDate) {
      if (!c.admitDate) return false;
      // admitDate는 "YYYY-MM-DD" 또는 "M/D" 형식 모두 처리
      const admitNorm = c.admitDate.includes("-")
        ? c.admitDate.slice(0,10)
        : (() => { const m=c.admitDate.match(/(\d{1,2})\/(\d{1,2})/); return m?`${new Date().getFullYear()}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`:null; })();
      if (admitNorm !== filterAdmitDate) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const all = [c.name,c.phone,c.phoneNote,c.phone2,c.phone2Note,c.diagnosis,c.hospital,c.birthYear,
                   c.age,c.memo,c.recontactMemo,c.route,c.reservedSlot,
                   c.surgeryDate,c.chemoDate,c.admitDate]
        .filter(Boolean).join(" ").toLowerCase();
      if (!all.includes(q)) return false;
    }
    return true;
  });

  // 표시용: 월 구분선 삽입 위해 이전 카드와 월 비교
  const filteredWithDivider = filtered.reduce((acc, c, i) => {
    const mk = monthKey(c.createdAt);
    const prevMk = i > 0 ? monthKey(filtered[i-1].createdAt) : null;
    if (mk !== prevMk) acc.push({ _divider: true, monthKey: mk });
    acc.push(c);
    return acc;
  }, []);

  // 입원예정일이 있으나 병상 미배정인 상담 목록
  // - 월 필터 무관하게 전체 데이터 기준
  // - 오늘 이전 항목 제외 (M/D 형식은 createdAt 연도로 YYYY-MM-DD 변환 후 비교)
  const pendingAdmits = Object.entries(allConsultations)
    .map(([id, c]) => ({ id, ...c, _normAdmit: normAdmitDate({...c}) }))
    .filter(c => {
      if (!c.admitDate) return false;
      if (c.status === "취소" || c.status === "입원완료") return false;
      if (c.reservedSlot) return false;
      if (!c._normAdmit) return false;
      if (c._normAdmit < today()) return false; // 오늘 이전 제외
      return true;
    })
    .sort((a, b) => a._normAdmit.localeCompare(b._normAdmit));

  // M/D 형식 → Date 변환 (슬롯 날짜 비교용)
  const parseMD = (str) => {
    if (!str || str === "미정") return null;
    const m = str.match(/(\d{1,2})\/(\d{1,2})/);
    if (!m) return null;
    const d = new Date(); d.setHours(0,0,0,0);
    d.setMonth(parseInt(m[1])-1); d.setDate(parseInt(m[2]));
    return d;
  };

  // 특정 슬롯이 주어진 입원예정일에 가용한지 확인
  const isAvailableOn = (slotKey, isoDate) => {
    if (!isoDate) return true;
    const target = new Date(isoDate); target.setHours(0,0,0,0);
    const slot = slots[slotKey];
    if (!slot) return true;
    if (slot.current?.name) {
      const dis = parseMD(slot.current.discharge);
      if (!dis || dis >= target) return false;
    }
    for (const r of (slot.reservations || [])) {
      if (!r?.name) continue;
      const rAdmit = parseMD(r.admitDate);
      const rDis   = parseMD(r.discharge);
      if (rAdmit && rDis) {
        if (rAdmit <= target && target <= rDis) return false;
      } else if (rAdmit) {
        if (rAdmit.getTime() === target.getTime()) return false;
      }
    }
    return true;
  };

  // 재연락 필요 목록 (완료/취소 제외, 날짜 오름차순)
  const recontactList = allList
    .filter(c => c.recontact && c.status !== "입원완료" && c.status !== "취소")
    .sort((a,b) => (a.recontactDate||"9999").localeCompare(b.recontactDate||"9999"));
  const recontactOverdue = recontactList.filter(c => c.recontactDate && c.recontactDate < today());
  const recontactToday  = recontactList.filter(c => c.recontactDate === today());

  // 병실 목록 (예약 등록 모달용)
  const allRooms = Object.values(WARD_STRUCTURE).flatMap(w=>w.rooms);
  const getRoomSlots = (roomId, cap) =>
    Array.from({length:cap},(_,i)=>({slotKey:`${roomId}-${i+1}`, bed:i+1}));

  const statusColor = {
    "상담중":"#f59e0b","예약완료":"#10b981","취소":"#94a3b8","입원완료":"#0ea5e9"
  };

  // ── 폼 뷰 ──────────────────────────────────────────────────────────────────
  if (view === "form") {
    return (
      <div style={S.page}>
        <header style={S.header}>
          <button style={S.btnBack} onClick={()=>{setView("list");setEditId(null);setForm({...EMPTY_FORM});setPtSearchOpen(false);setPtSearchQ("");setPhoneMatch(null);setPhone2Match(null);}}>← 목록</button>
          <span style={S.htitle}>{editId ? "상담 기록 수정" : "신규 상담 등록"}</span>
          {editId && <button style={{...S.btnBack, background:"#fef2f2", color:"#dc2626", marginLeft:"auto"}}
            onClick={()=>deleteConsultation(editId)}>삭제</button>}
        </header>
        <div style={S.formBody}>

          {/* 기존 환자 불러오기 (신규 등록 시에만) */}
          {!editId && (
            <div style={{...S.section, marginBottom:10}}>
              <button onClick={()=>setPtSearchOpen(v=>!v)}
                style={{ background:"none", border:"none", cursor:"pointer", padding:0,
                  fontWeight:800, fontSize:14, color:"#0f2744", display:"flex", alignItems:"center", gap:6, width:"100%" }}>
                🔍 기존 환자 불러오기 <span style={{fontSize:12, color:"#94a3b8"}}>{ptSearchOpen?"▲":"▼"}</span>
              </button>
              {ptSearchOpen && (
                <div style={{marginTop:10}}>
                  <input value={ptSearchQ} onChange={e=>setPtSearchQ(e.target.value)}
                    placeholder="이름 또는 연락처로 검색" autoFocus style={{...S.inp, marginBottom:8}}/>
                  {ptSearchQ && ptResults.length === 0 && (
                    <div style={{fontSize:13, color:"#94a3b8", padding:"6px 0"}}>검색 결과 없음 — 아래에 직접 입력하세요.</div>
                  )}
                  {ptResults.map(p => (
                    <div key={p.id} onClick={()=>fillFromPatient(p)}
                      style={{padding:"9px 12px", borderRadius:8, cursor:"pointer", marginBottom:4,
                        background:"#f8fafc", border:"1.5px solid #e2e8f0",
                        display:"flex", alignItems:"center", gap:10}}>
                      <span style={{fontWeight:700, fontSize:15}}>{p.name}</span>
                      {(p.birthDate||p.birthYear) && <span style={{fontSize:12, color:"#64748b"}}>{(p.birthDate?p.birthDate.slice(0,4):p.birthYear)}년생</span>}
                      {p.phone && <span style={{fontSize:12, color:"#475569"}}>📞 {p.phone}</span>}
                      {p.diagnosis && <span style={{fontSize:12, color:"#64748b"}}>{p.diagnosis}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 기본 정보 + 진단 (합친 섹션) */}
          <div style={S.section}>
            <div style={{display:"flex", alignItems:"center", gap:10, marginBottom:10}}>
              <span style={{fontSize:14, fontWeight:800, color:"#0f2744"}}>👤 기본 정보</span>
              {editId && form.createdAt && (
                <span style={{fontSize:12, color:"#94a3b8", fontWeight:500}}>등록일: {form.createdAt}</span>
              )}
            </div>

            {/* 이름 + 상태 */}
            <div style={S.row2}>
              <div style={S.field}>
                <label style={S.lbl}>이름 *</label>
                <input style={S.inp} value={form.name} onChange={e=>setF("name",e.target.value)} placeholder="홍길동"/>
              </div>
              <div style={S.field}>
                <label style={S.lbl}>상태</label>
                <select style={S.inp} value={form.status} onChange={e=>setF("status",e.target.value)}>
                  {["상담중","예약완료","입원완료","취소"].map(s=><option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* 출생연도 + 나이 + 진단명 + 병원 (4열) */}
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8, marginBottom:8}}>
              <div style={S.field}>
                <label style={S.lbl}>출생연도</label>
                <div style={{display:"flex", alignItems:"center", gap:4}}>
                  <input style={{...S.inp, flex:1, minWidth:0}} value={form.birthYear}
                    onChange={e=>{ const v=e.target.value; setF("birthYear",v); const a=calcAge(v); if(a) setF("age",a); }} placeholder="1955"/>
                </div>
                {form.birthYear && calcAge(form.birthYear) && (
                  <span style={{fontSize:11, color:"#059669", fontWeight:700}}>→ {calcAge(form.birthYear)}세</span>
                )}
              </div>
              <div style={S.field}>
                <label style={S.lbl}>나이 (만)</label>
                <input style={S.inp} value={form.age}
                  onChange={e=>{ const v=e.target.value; setF("age",v); const by=calcBirthYear(v); if(by) setF("birthYear",by); }} placeholder="70"/>
                {form.age && calcBirthYear(form.age) && (
                  <span style={{fontSize:11, color:"#0369a1", fontWeight:700}}>→ {calcBirthYear(form.age)}년생</span>
                )}
              </div>
              <div style={S.field}>
                <label style={S.lbl}>진단명</label>
                <input style={S.inp} value={form.diagnosis} onChange={e=>setF("diagnosis",e.target.value)} placeholder="유방암 2기"/>
              </div>
              <div style={S.field}>
                <label style={S.lbl}>상급병원</label>
                <input style={S.inp} value={form.hospital} onChange={e=>setF("hospital",e.target.value)} placeholder="세브란스병원"/>
              </div>
            </div>

            {/* 연락처 2행 */}
            <div style={{display:"grid", gridTemplateColumns:"2fr 1fr 2fr 1fr", gap:8, marginBottom: phoneMatch||phone2Match ? 4 : 8}}>
              <div style={S.field}>
                <label style={S.lbl}>연락처 (본인)</label>
                <input style={S.inp} value={form.phone}
                  onChange={e=>{
                    const v=e.target.value; setF("phone",v);
                    const m=lookupByPhone(v);
                    setPhoneMatch(m && m.name !== form.name ? m : null);
                  }} placeholder="010-0000-0000"/>
              </div>
              <div style={S.field}>
                <label style={S.lbl}>관계</label>
                <input style={S.inp} value={form.phoneNote} onChange={e=>setF("phoneNote",e.target.value)} placeholder="본인"/>
              </div>
              <div style={S.field}>
                <label style={S.lbl}>연락처 (보호자)</label>
                <input style={S.inp} value={form.phone2}
                  onChange={e=>{
                    const v=e.target.value; setF("phone2",v);
                    const m=lookupByPhone(v);
                    setPhone2Match(m && m.name !== form.name ? m : null);
                  }} placeholder="010-0000-0000"/>
              </div>
              <div style={S.field}>
                <label style={S.lbl}>관계</label>
                <input style={S.inp} value={form.phone2Note} onChange={e=>setF("phone2Note",e.target.value)} placeholder="딸"/>
              </div>
            </div>

            {/* 연락처 매칭 배너 */}
            {(phoneMatch || phone2Match) && (() => {
              const m = phoneMatch || phone2Match;
              return (
                <div style={{display:"flex", alignItems:"center", gap:10, flexWrap:"wrap",
                  background:"#eff6ff", border:"1.5px solid #93c5fd", borderRadius:8,
                  padding:"8px 12px", marginBottom:8, fontSize:13}}>
                  <span style={{fontSize:15}}>🔍</span>
                  <span>
                    <strong>{m.name}</strong>
                    {m.info && <span style={{color:"#475569", marginLeft:6}}>{m.info}</span>}
                    <span style={{color:"#64748b"}}> 님의 기록과 일치합니다. 정보를 불러올까요?</span>
                  </span>
                  <div style={{display:"flex", gap:6, marginLeft:"auto"}}>
                    <button onClick={()=>{ applyPhoneMatch(m); setPhoneMatch(null); setPhone2Match(null); }}
                      style={{background:"#2563eb", color:"#fff", border:"none", borderRadius:6,
                        padding:"5px 14px", cursor:"pointer", fontSize:13, fontWeight:700}}>불러오기</button>
                    <button onClick={()=>{ setPhoneMatch(null); setPhone2Match(null); }}
                      style={{background:"#f1f5f9", color:"#374151", border:"none", borderRadius:6,
                        padding:"5px 12px", cursor:"pointer", fontSize:13, fontWeight:600}}>무시</button>
                  </div>
                </div>
              );
            })()}

            {/* 치료 이력: 수술 | 항암 | 방사선 한 줄 */}
            <div style={{display:"flex", gap:10, flexWrap:"wrap", alignItems:"flex-start"}}>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <label style={{...S.checkLabel, minWidth:"auto"}}>
                  <input type="checkbox" checked={form.surgery} onChange={e=>setF("surgery",e.target.checked)}/>
                  <span>수술</span>
                </label>
                {form.surgery && <input style={{...S.inp, width:140}} type="date" value={form.surgeryDate} onChange={e=>setF("surgeryDate",e.target.value)}/>}
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <label style={{...S.checkLabel, minWidth:"auto"}}>
                  <input type="checkbox" checked={form.chemo} onChange={e=>setF("chemo",e.target.checked)}/>
                  <span>항암</span>
                </label>
                {form.chemo && <input style={{...S.inp, width:140}} type="date" value={form.chemoDate} onChange={e=>setF("chemoDate",e.target.value)}/>}
              </div>
              <div style={{display:"flex", alignItems:"center", gap:6}}>
                <label style={{...S.checkLabel, minWidth:"auto"}}>
                  <input type="checkbox" checked={form.radiation} onChange={e=>setF("radiation",e.target.checked)}/>
                  <span>방사선</span>
                </label>
                {form.radiation && <input style={{...S.inp, width:140}} type="date" value={form.radiationDate} onChange={e=>setF("radiationDate",e.target.value)}/>}
              </div>
            </div>
          </div>

          {/* 입원 희망 + 기타 요청사항 */}
          <div style={S.section}>
            <div style={S.sectionTitle}>📅 입원 희망</div>

            {/* 입원예약일 + 희망병실 한 줄 */}
            <div style={{display:"flex", gap:16, alignItems:"flex-start", marginBottom:12, flexWrap:"wrap"}}>
              <div style={{minWidth:160}}>
                <label style={S.lbl}>입원 예약일</label>
                <input style={{...S.inp, width:160}} type="date" value={form.admitDate} onChange={e=>setF("admitDate",e.target.value)}/>
              </div>
              <div style={{flex:1}}>
                <label style={S.lbl}>희망 병실 (복수 선택)</label>
                <div style={{display:"flex", gap:8, flexWrap:"wrap", marginTop:4}}>
                  {ROOM_TYPES.map(rt=>(
                    <button key={rt} style={{border:`1.5px solid ${TYPE_COLOR[rt]}`, borderRadius:8, padding:"6px 14px",
                      background: form.roomTypes.includes(rt) ? TYPE_COLOR[rt] : TYPE_BG[rt],
                      color: form.roomTypes.includes(rt) ? "#fff" : TYPE_COLOR[rt],
                      fontWeight:700, fontSize:13, cursor:"pointer"}}
                      onClick={()=>toggleRoomType(rt)}>{rt}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* 기타 요청사항 — 크게 */}
            <div style={S.field}>
              <label style={S.lbl}>기타 요청사항</label>
              <textarea style={{...S.inp, minHeight:260, resize:"vertical"}} value={form.memo}
                onChange={e=>setF("memo",e.target.value)} placeholder="요청사항, 특이사항, 상담 내용 등 자유롭게 입력"/>
            </div>
          </div>

          {/* 재연락 */}
          <div style={S.section}>
            <div style={S.sectionTitle}>📞 재연락</div>
            <div style={S.treatRow}>
              <label style={S.checkLabel}>
                <input type="checkbox" checked={form.recontact} onChange={e=>setF("recontact",e.target.checked)}/>
                <span style={{color: form.recontact ? "#dc2626":"#374151"}}>재연락 필요</span>
              </label>
              {form.recontact && (
                <div style={{flex:1}}>
                  <label style={S.lbl}>재연락 예정일</label>
                  <input style={S.inp} type="date" value={form.recontactDate} onChange={e=>setF("recontactDate",e.target.value)}/>
                </div>
              )}
            </div>
            {form.recontact && (
              <div style={S.field}>
                <label style={S.lbl}>재연락 메모</label>
                <input style={S.inp} value={form.recontactMemo} onChange={e=>setF("recontactMemo",e.target.value)}
                  placeholder="재연락 시 확인할 내용"/>
              </div>
            )}
          </div>

          <button style={S.btnSave} onClick={saveConsultation}>
            {editId ? "수정 저장" : "상담 등록"}
          </button>
        </div>
      </div>
    );
  }

  // ── 목록 뷰 ────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <header style={S.header}>
        <button style={S.btnBack} onClick={()=>router.push("/")}>← 병동</button>
        <span style={S.htitle}>📋 입원 상담 일지</span>
        <button style={{...S.btnBack, background:"#0f4c35", color:"#fff", marginLeft:"auto"}}
          onClick={()=>{ setForm({...EMPTY_FORM, createdAt:today()}); setEditId(null); setPtSearchOpen(true); setView("form"); }}>
          + 신규 등록
        </button>
      </header>

      {/* 입원 대기 배너 */}
      {pendingAdmits.length > 0 && (
        <div style={S.pendingBanner}>
          <span style={{fontWeight:700, fontSize:13}}>🏥 입원 예약 대기</span>
          <span style={{fontSize:12, color:"#92400e", marginLeft:8}}>{pendingAdmits.length}명 — 병실 배정 필요</span>
          <div style={{display:"flex", gap:6, flexWrap:"wrap", marginTop:8}}>
            {pendingAdmits.map(c=>(
              <button key={c.id} style={S.pendCard}
                onClick={()=>setReserveModal({id:c.id, consultation:c})}>
                <span style={{fontWeight:700}}>{c.name}</span>
                <span style={{fontSize:11, color:"#92400e", marginLeft:4}}>{fmtDate(c.admitDate)} 입원예정</span>
                {c.roomTypes?.length>0 && <span style={{fontSize:10, color:"#78350f", marginLeft:4}}>({c.roomTypes.join("·")})</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 재연락 필요 섹션 */}
      {recontactList.length > 0 && (
        <div style={{background: recontactOverdue.length>0 ? "#fef2f2":"#fff7ed", borderBottom:`2px solid ${recontactOverdue.length>0?"#fca5a5":"#fed7aa"}`, padding:"12px 16px"}}>
          <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:8}}>
            <span style={{fontWeight:800, fontSize:13, color: recontactOverdue.length>0?"#dc2626":"#ea580c"}}>
              📞 재연락 필요 {recontactList.length}명
            </span>
            {recontactOverdue.length>0 && (
              <span style={{fontSize:11, fontWeight:700, background:"#dc2626", color:"#fff", borderRadius:5, padding:"1px 7px"}}>
                {recontactOverdue.length}건 기한 초과
              </span>
            )}
            {recontactToday.length>0 && (
              <span style={{fontSize:11, fontWeight:700, background:"#f59e0b", color:"#fff", borderRadius:5, padding:"1px 7px"}}>
                오늘 {recontactToday.length}건
              </span>
            )}
          </div>
          <div style={{display:"flex", flexDirection:"column", gap:6}}>
            {recontactList.map(c => {
              const isOverdue = c.recontactDate && c.recontactDate < today();
              const isToday   = c.recontactDate === today();
              return (
                <div key={c.id} style={{background:"#fff", border:`1.5px solid ${isOverdue?"#fca5a5":isToday?"#fcd34d":"#e2e8f0"}`,
                  borderRadius:8, padding:"8px 12px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap"}}
                  onClick={()=>{ setForm({...EMPTY_FORM,...c}); setEditId(c.id); setPtSearchOpen(false); setPtSearchQ(""); setView("form"); }}>
                  <span
                    style={{fontWeight:800, fontSize:14,
                      ...(c.patientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}) }}
                    onClick={c.patientId ? (e) => { e.stopPropagation(); router.push(`/patients?id=${encodeURIComponent(c.patientId)}`); } : undefined}>
                    {c.name}
                  </span>
                  {c.phone && <span style={{fontSize:12, color:"#475569"}}>📞 {c.phone}</span>}
                  {c.recontactDate && (
                    <span style={{fontSize:11, fontWeight:700, borderRadius:5, padding:"2px 8px",
                      background: isOverdue?"#fef2f2":isToday?"#fef3c7":"#f0fdf4",
                      color: isOverdue?"#dc2626":isToday?"#92400e":"#166534"}}>
                      {isOverdue?"⚠️ 기한초과":isToday?"📅 오늘":"📅"} {c.recontactDate}
                    </span>
                  )}
                  {c.diagnosis && <span style={{fontSize:11, color:"#64748b"}}>{c.diagnosis}</span>}
                  {c.recontactMemo && <span style={{fontSize:11, color:"#78716c", background:"#f5f5f4", borderRadius:4, padding:"1px 6px"}}>{c.recontactMemo}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 검색 + 필터 */}
      <div style={S.filterBar}>
        <input style={{...S.inp, flex:1, minWidth:100}} value={search}
          onChange={e=>setSearch(e.target.value)} placeholder="이름·연락처·진단명 검색"/>
        <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
          <span style={{fontSize:11,fontWeight:700,color:"#0369a1",whiteSpace:"nowrap"}}>📅 입원예정일</span>
          <input type="date" style={{...S.inp,width:130,padding:"4px 8px",fontSize:12}}
            value={filterAdmitDate} onChange={e=>setFilterAdmitDate(e.target.value)}/>
          {filterAdmitDate && (
            <button onClick={()=>setFilterAdmitDate("")}
              style={{background:"#fee2e2",color:"#dc2626",border:"none",borderRadius:6,padding:"3px 8px",cursor:"pointer",fontSize:11,fontWeight:700,flexShrink:0}}>✕</button>
          )}
        </div>
        <select style={{...S.inp, width:110}} value={filterMonth} onChange={e=>setFilterMonth(e.target.value)}>
          <option value="">전체 (느림)</option>
          {months.map(m=><option key={m} value={m}>{korMonth(m)}</option>)}
        </select>
        <select style={{...S.inp, width:90}} value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          {["전체","상담중","예약완료","입원완료","취소"].map(s=><option key={s}>{s}</option>)}
        </select>
      </div>

      {/* 상담 카드 목록 */}
      <div style={S.listWrap}>
        {filtered.length === 0 && (
          <div style={{textAlign:"center", color:"#94a3b8", padding:40, fontSize:14}}>상담 기록이 없습니다.</div>
        )}
        {filteredWithDivider.map((item, idx) => {
          // 월 구분선
          if (item._divider) {
            const totalInMonth = filtered.filter(c => monthKey(c.createdAt) === item.monthKey).length;
            return (
              <div key={`div-${item.monthKey}`} style={S.monthDivider}>
                <span style={S.monthDividerLabel}>{korMonth(item.monthKey)}</span>
                <span style={S.monthDividerCount}>{totalInMonth}건</span>
                <div style={S.monthDividerLine}/>
              </div>
            );
          }
          const c = item;
          const hasAdmit = !!(c.admitDate);
          const isReserved = c.status === "예약완료" || c.reservedSlot || (c.admitDate && c.status !== "입원완료" && c.status !== "취소");
          const isAdmitted = c.status === "입원완료";

          let cardStyle = { ...S.card };
          if (isAdmitted) {
            cardStyle = { ...cardStyle, background:"#f0fdf4", border:"1.5px solid #86efac", boxShadow:"0 2px 10px rgba(16,185,129,0.12)" };
          } else if (hasAdmit) {
            cardStyle = { ...cardStyle, background:"#fefce8", border:"1.5px solid #fde68a", boxShadow:"0 2px 8px rgba(245,158,11,0.1)" };
          }

          return (
            <div key={c.id} style={cardStyle} onClick={()=>{ setForm({...EMPTY_FORM,...c}); setEditId(c.id); setPtSearchOpen(false); setPtSearchQ(""); setView("form"); }}>
              {/* 이름 + 순번 + 상태 */}
              <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:5}}>
                {c._monthSeq && (
                  <span style={{ fontSize:10, fontWeight:800, borderRadius:5, padding:"2px 7px", minWidth:28, textAlign:"center",
                    background: isAdmitted?"#10b981":"#94a3b8", color:"#fff" }}>
                    {c._monthSeq}
                  </span>
                )}
                <span
                  style={{fontSize:16, fontWeight:800, color: isAdmitted?"#065f46":"#0f2744",
                    ...(c.patientId ? { cursor:"pointer", textDecoration:"underline", textDecorationStyle:"dotted" } : {}) }}
                  onClick={c.patientId ? (e) => { e.stopPropagation(); router.push(`/patients?id=${encodeURIComponent(c.patientId)}`); } : undefined}>
                  {c.name}
                </span>
                {(c.birthYear || c.age) && (
                  <span style={{fontSize:12, color:"#64748b"}}>
                    {c.birthYear ? `${c.birthYear}년생` : ""}
                    {c.birthYear && (c.age || calcAge(c.birthYear)) ? " / " : ""}
                    {c.age ? `${c.age}세` : (c.birthYear && calcAge(c.birthYear) ? `${calcAge(c.birthYear)}세` : "")}
                  </span>
                )}
                {c.recontact && c.status !== "입원완료" && c.status !== "취소" && (
                  <span style={{fontSize:10, fontWeight:700, borderRadius:5, padding:"2px 7px",
                    background: c.recontactDate && c.recontactDate < today() ? "#fef2f2" : "#fff7ed",
                    color: c.recontactDate && c.recontactDate < today() ? "#dc2626" : "#ea580c"}}>
                    📞{c.recontactDate ? " "+c.recontactDate : " 재연락"}
                  </span>
                )}
                <span style={{marginLeft:"auto", fontSize:11, fontWeight:700, borderRadius:6, padding:"2px 8px",
                  background: statusColor[c.status]+"33", color: statusColor[c.status]}}>
                  {c.status||"상담중"}
                </span>
              </div>
              {/* 연락처 + 진단 + 병원 */}
              <div style={{display:"flex", flexWrap:"wrap", gap:6, marginBottom:5}}>
                {c.phone && <span style={S.tag}>📞 {c.phone}{c.phoneNote ? ` (${c.phoneNote})`:""}</span>}
                {c.phone2 && <span style={S.tag}>📞 {c.phone2}{c.phone2Note ? ` (${c.phone2Note})`:""}</span>}
                {c.diagnosis && <span style={{...S.tag, fontWeight:600}}>{c.diagnosis}</span>}
                {c.hospital && <span style={S.tag}>🏨 {c.hospital}</span>}
              </div>
              {/* 입원 + 병실 + 치료 */}
              <div style={{display:"flex", flexWrap:"wrap", gap:6, alignItems:"center"}}>
                {hasAdmit && (
                  <span style={{...S.tag,
                    background: isAdmitted?"#bbf7d0":"#fef08a",
                    color: isAdmitted?"#065f46":"#92400e",
                    fontWeight:700}}>
                    📅 {fmtDate(c.admitDate)} 입원{isAdmitted?"완료":"예정"}
                  </span>
                )}
                {c.roomTypes?.map(rt=>(
                  <span key={rt} style={{...S.tag, background:TYPE_BG[rt], color:TYPE_COLOR[rt]}}>{rt}</span>
                ))}
                {c.surgery && <span style={{...S.tag, background:"#fef2f2", color:"#dc2626"}}>수술{c.surgeryDate?" "+fmtDate(c.surgeryDate):""}</span>}
                {c.chemo && <span style={{...S.tag, background:"#fff7ed", color:"#ea580c"}}>항암{c.chemoDate?" "+fmtDate(c.chemoDate):""}</span>}
                {c.radiation && <span style={{...S.tag, background:"#faf5ff", color:"#9333ea"}}>방사선</span>}
                <span style={{marginLeft:"auto", fontSize:10, color:"#94a3b8"}}>{c.createdAt}</span>
              </div>
              {c.memo && <div style={{marginTop:6, fontSize:12, color:"#475569", background:"rgba(0,0,0,0.03)", borderRadius:6, padding:"5px 8px", lineHeight:1.5}}>{c.memo}</div>}
              {c.reservedSlot
                ? <div style={{marginTop:4, fontSize:11, color:"#059669", fontWeight:700}}>✅ {c.reservedSlot} 병상 배정완료</div>
                : c.admitDate && c.status !== "취소" && c.status !== "입원완료" && (
                  <div style={{marginTop:6}} onClick={e=>e.stopPropagation()}>
                    <button
                      style={{fontSize:11, fontWeight:700, background:"#fef3c7", color:"#92400e",
                        border:"1.5px solid #fcd34d", borderRadius:6, padding:"3px 10px", cursor:"pointer"}}
                      onClick={()=>{ setReserveModal({id:c.id, consultation:c}); setReserveSlot(""); }}>
                      🏥 병실 배정 필요 — 클릭하여 배정
                    </button>
                  </div>
                )
              }
            </div>
          );
        })}
      </div>

      {/* 예약 등록 모달 */}
      {reserveModal && (
        <div style={S.overlay} onClick={()=>{setReserveModal(null);setReserveSlot("");}}>
          <div style={S.modal} onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:800, fontSize:16, marginBottom:4, color:"#0f2744"}}>
              🏥 병실 배정 — {reserveModal.consultation.name}님
            </div>
            <div style={{fontSize:12, color:"#64748b", marginBottom:12}}>
              입원예정: {fmtDate(reserveModal.consultation.admitDate)}
              {reserveModal.consultation.roomTypes?.length>0 && ` · 희망: ${reserveModal.consultation.roomTypes.join(", ")}`}
            </div>

            <label style={{fontSize:12, fontWeight:700, color:"#475569", display:"block", marginBottom:6}}>병상 선택</label>
            <div style={{maxHeight:280, overflowY:"auto"}}>
              {allRooms.map(room=>{
                const isPreferred = reserveModal.consultation.roomTypes?.includes(room.type);
                return (
                  <div key={room.id} style={{marginBottom:8}}>
                    <div style={{fontSize:11, fontWeight:700, color: isPreferred ? TYPE_COLOR[room.type] : "#94a3b8",
                      background: isPreferred ? TYPE_BG[room.type] : "#f8fafc",
                      borderRadius:4, padding:"2px 8px", marginBottom:4, display:"inline-block"}}>
                      {room.id}호 {room.type}{isPreferred ? " ★ 희망" : ""}
                    </div>
                    <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>
                      {getRoomSlots(room.id, room.cap).map(({slotKey, bed})=>{
                        const admitIso = reserveModal.consultation.admitDate;
                        const available = isAvailableOn(slotKey, admitIso);
                        const occupied  = slots[slotKey]?.current?.name;
                        const hasReserve = (slots[slotKey]?.reservations||[]).length > 0;
                        const selected = reserveSlot === slotKey;
                        const btnBorder = selected ? "#0f2744" : !available ? "#e2e8f0" : (available && hasReserve) ? "#f59e0b" : "#10b981";
                        const btnBg     = selected ? "#0f2744" : !available ? "#f1f5f9" : (available && hasReserve) ? "#fffbeb" : "#f0fdf4";
                        const btnColor  = selected ? "#fff"    : !available ? "#94a3b8" : (available && hasReserve) ? "#92400e" : "#065f46";
                        return (
                          <button key={slotKey}
                            style={{padding:"4px 10px", borderRadius:6, fontSize:12, fontWeight:700,
                              cursor: available ? "pointer" : "not-allowed",
                              border:`1.5px solid ${btnBorder}`,
                              background: btnBg,
                              color: btnColor,
                              opacity: available ? 1 : 0.55}}
                            disabled={!available}
                            onClick={()=>setReserveSlot(slotKey)}>
                            {bed}번{!available ? (occupied?"(사용중)":"(겹침)") : hasReserve ? "(예약있음)" : "(가용)"}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{display:"flex", gap:8, marginTop:16, flexWrap:"wrap", alignItems:"stretch"}}>
              <button style={{flex:1, ...S.btnSave, fontSize:14, padding:"10px 14px", marginTop:0}} onClick={doRegisterReservation}
                disabled={!reserveSlot}>예약 등록</button>
              <button
                style={{padding:"10px 14px", border:"1px solid #312e81", borderRadius:8,
                  background:"#eef2ff", color:"#312e81", cursor:"pointer", fontSize:13, fontWeight:700, whiteSpace:"nowrap"}}
                onClick={()=>{ setReserveModal(null); setReserveSlot(""); router.push("/ward-timeline"); }}>
                📊 타임라인 열기
              </button>
              <button style={{padding:"10px 14px", border:"1px solid #e2e8f0", borderRadius:8,
                background:"#f8fafc", cursor:"pointer", fontSize:14, fontWeight:600}}
                onClick={()=>{setReserveModal(null);setReserveSlot("");}}>취소</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

const S = {
  page: { fontFamily:"'Noto Sans KR','Pretendard',sans-serif", background:"#f0f4f8", minHeight:"100vh", color:"#0f172a" },
  header: { background:"#0f2744", color:"#fff", display:"flex", alignItems:"center", gap:12, padding:"10px 16px", boxShadow:"0 2px 8px rgba(0,0,0,0.15)" },
  btnBack: { background:"rgba(255,255,255,0.12)", border:"none", color:"#fff", borderRadius:7, padding:"6px 14px", cursor:"pointer", fontSize:13, fontWeight:600, whiteSpace:"nowrap" },
  htitle: { fontSize:16, fontWeight:800 },

  pendingBanner: { background:"#fef3c7", borderBottom:"2px solid #fcd34d", padding:"12px 16px" },
  pendCard: { background:"#fff", border:"1.5px solid #fcd34d", borderRadius:8, padding:"6px 12px", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:0, fontSize:13, fontWeight:600 },

  filterBar: { background:"#fff", borderBottom:"1px solid #e2e8f0", padding:"10px 14px", display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" },
  inp: { border:"1.5px solid #e2e8f0", borderRadius:8, padding:"8px 11px", fontSize:14, outline:"none", fontFamily:"inherit", boxSizing:"border-box", width:"100%", background:"#fff" },
  lbl: { display:"block", fontSize:12, fontWeight:700, color:"#64748b", marginBottom:3 },

  listWrap: { padding:"14px 12px", display:"flex", flexDirection:"column", gap:10 },
  card: { background:"#fff", borderRadius:12, padding:"14px", boxShadow:"0 1px 6px rgba(0,0,0,0.06)", cursor:"pointer", border:"1.5px solid transparent", transition:"border-color 0.15s" },
  tag: { fontSize:11, background:"#f1f5f9", color:"#475569", borderRadius:5, padding:"2px 7px", fontWeight:500 },

  // form
  formBody: { padding:"14px 14px 40px", maxWidth:640, margin:"0 auto" },
  section: { background:"#fff", borderRadius:12, padding:"14px", marginBottom:14, boxShadow:"0 1px 4px rgba(0,0,0,0.05)" },
  sectionTitle: { fontSize:14, fontWeight:800, color:"#0f2744", marginBottom:12 },
  row2: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 },
  field: { marginBottom:10 },
  treatRow: { display:"flex", alignItems:"center", gap:12, marginBottom:10 },
  checkLabel: { display:"flex", alignItems:"center", gap:6, fontSize:14, fontWeight:700, cursor:"pointer", minWidth:70 },
  btnSave: { width:"100%", background:"#0f2744", color:"#fff", border:"none", borderRadius:10, padding:"13px", fontSize:15, fontWeight:800, cursor:"pointer", marginTop:8 },

  // modal
  overlay: { position:"fixed", inset:0, background:"rgba(15,23,42,0.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 },
  modal: { background:"#fff", borderRadius:14, padding:"20px", width:"100%", maxWidth:440, maxHeight:"88vh", overflowY:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.2)" },

  // 월 구분선
  monthDivider: { display:"flex", alignItems:"center", gap:10, margin:"6px 0 2px", padding:"0 2px" },
  monthDividerLabel: { fontSize:14, fontWeight:900, color:"#0f2744", whiteSpace:"nowrap", letterSpacing:-0.5 },
  monthDividerCount: { fontSize:11, fontWeight:700, color:"#fff", background:"#94a3b8", borderRadius:10, padding:"1px 8px", whiteSpace:"nowrap" },
  monthDividerLine: { flex:1, height:1, background:"#e2e8f0" },
};

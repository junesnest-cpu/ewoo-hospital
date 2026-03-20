import { useState, useEffect, useRef } from "react";
import { ref, onValue, set, get, push, runTransaction, update } from "firebase/database";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { db, auth, storage } from "../lib/firebaseConfig";

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const DOC_TYPES = {
  vacation: { label: "휴가신청서",          code: "VAC", color: "#0ea5e9", bg: "#e0f2fe" },
  supply:   { label: "물품청구서",          code: "SUP", color: "#10b981", bg: "#d1fae5" },
  refund:   { label: "위탁진료 환불금 보고", code: "REF", color: "#f59e0b", bg: "#fef3c7" },
  weekly:   { label: "주간보고서(영양팀)",   code: "WKL", color: "#8b5cf6", bg: "#ede9fe" },
};
const STATUS = {
  draft:        { label: "임시저장",        color: "#64748b", bg: "#f1f5f9" },
  pending_dept: { label: "부서장 결재대기",  color: "#d97706", bg: "#fef3c7" },
  pending_dir:  { label: "병원장 결재대기",  color: "#2563eb", bg: "#dbeafe" },
  approved:     { label: "승인완료",         color: "#059669", bg: "#d1fae5" },
  final:        { label: "전결완료",         color: "#7c3aed", bg: "#ede9fe" },
  rejected:     { label: "반려",            color: "#dc2626", bg: "#fee2e2" },
};
const DEPTS    = ["원무과", "간호과", "영양팀", "기타"];
const BANKS    = ["국민은행","신한은행","우리은행","하나은행","농협은행","IBK기업은행","카카오뱅크","토스뱅크","기타"];
const LEAVE_TYPES = ["연차휴가","반차휴가","생리휴가","병가","기타"];

// ─── 유틸 ─────────────────────────────────────────────────────────────────────
function uid7()  { return Math.random().toString(36).slice(2, 9); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,"0")}.${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function fmtNum(n) { return n != null && n !== "" ? Number(n).toLocaleString() : ""; }
function daysBetween(from, to) {
  if (!from || !to) return 0;
  return Math.max(0, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);
}
async function getNextDocNumber(type) {
  const year = String(new Date().getFullYear());
  const counterRef = ref(db, `approvalCounters/${type}/${year}`);
  let num = 1;
  await runTransaction(counterRef, cur => { num = (cur || 0) + 1; return num; });
  return `${year}-${DOC_TYPES[type].code}-${String(num).padStart(3, "0")}`;
}

// ─── 스타일 ──────────────────────────────────────────────────────────────────
const S = {
  page:       { minHeight:"100vh", background:"#f0f4f8", fontFamily:"'Noto Sans KR',sans-serif" },
  header:     { background:"#0f2744", color:"#fff", padding:"12px 24px", display:"flex", alignItems:"center", gap:12, boxShadow:"0 2px 8px rgba(0,0,0,0.2)" },
  main:       { maxWidth:920, margin:"0 auto", padding:"24px 16px" },
  card:       { background:"#fff", borderRadius:12, boxShadow:"0 1px 6px rgba(0,0,0,0.08)", padding:"20px", marginBottom:16 },
  tabs:       { display:"flex", gap:4, marginBottom:20, background:"#fff", borderRadius:10, padding:4, boxShadow:"0 1px 4px rgba(0,0,0,0.06)" },
  tab:   a => ({ flex:1, padding:"9px 0", border:"none", borderRadius:8, cursor:"pointer", fontWeight:700, fontSize:13, background:a?"#0f2744":"transparent", color:a?"#fff":"#64748b", transition:"all 0.15s" }),
  docRow:     { display:"flex", alignItems:"center", gap:10, padding:"11px 6px", borderBottom:"1px solid #f1f5f9", cursor:"pointer" },
  badge: (c,b) => ({ fontSize:11, fontWeight:700, color:c, background:b, borderRadius:6, padding:"2px 8px", flexShrink:0, whiteSpace:"nowrap" }),
  btnPri:     { background:"#0f2744", color:"#fff", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnSec:     { background:"#f1f5f9", color:"#475569", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnGreen:   { background:"#d1fae5", color:"#059669", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnPurple:  { background:"#ede9fe", color:"#7c3aed", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  btnRed:     { background:"#fee2e2", color:"#dc2626", border:"none", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" },
  label:      { display:"block", fontSize:12, fontWeight:700, color:"#475569", marginBottom:4 },
  input:      { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"8px 10px", fontSize:13, outline:"none", fontFamily:"inherit", boxSizing:"border-box" },
  select:     { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"8px 10px", fontSize:13, outline:"none", fontFamily:"inherit", background:"#fff", boxSizing:"border-box" },
  sectionTit: { fontSize:14, fontWeight:800, color:"#1e3a5f", marginBottom:10, paddingBottom:6, borderBottom:"2px solid #e0f2fe" },
  th:         { background:"#f8fafc", padding:"7px 10px", textAlign:"left", fontWeight:700, color:"#475569", border:"1px solid #e2e8f0", fontSize:12 },
  td:         { padding:"6px 8px", border:"1px solid #e2e8f0", verticalAlign:"middle", fontSize:13 },
  modal:      { position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:16 },
  modalBox:   { background:"#fff", borderRadius:16, padding:24, maxWidth:600, width:"100%", maxHeight:"90vh", overflowY:"auto" },
  fab:        { position:"fixed", bottom:24, right:24, background:"#0f2744", color:"#fff", border:"none", borderRadius:14, padding:"13px 22px", fontWeight:800, fontSize:14, cursor:"pointer", boxShadow:"0 4px 16px rgba(0,0,0,0.25)", zIndex:100 },
};
function Field({ label, children, style }) {
  return <div style={{ marginBottom:12, ...style }}><label style={S.label}>{label}</label>{children}</div>;
}
function Grid({ cols=2, children }) {
  return <div style={{ display:"grid", gridTemplateColumns:`repeat(${cols},1fr)`, gap:12, marginBottom:12 }}>{children}</div>;
}
function ReadVal({ label, value, style }) {
  return <div style={{ marginBottom:8, ...style }}><div style={{ ...S.label, marginBottom:2 }}>{label}</div><div style={{ fontSize:13, color:"#1e293b" }}>{value || "-"}</div></div>;
}
function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.draft;
  return <span style={S.badge(s.color, s.bg)}>{s.label}</span>;
}

// ─── 결재 흐름 계산 ───────────────────────────────────────────────────────────
function StepIndicator({ doc, users }) {
  const steps = buildSteps(doc, users);
  return (
    <div style={{ display:"flex", alignItems:"center", gap:0, margin:"16px 0" }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center" }}>
          <div style={{ textAlign:"center", minWidth:70 }}>
            <div style={{ width:36, height:36, borderRadius:"50%", margin:"0 auto 4px",
              background: s.done ? "#059669" : s.active ? "#0ea5e9" : "#e2e8f0",
              display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>
              {s.done ? "✓" : s.active ? "●" : "○"}
            </div>
            <div style={{ fontSize:11, fontWeight:700, color: s.done?"#059669":s.active?"#0ea5e9":"#94a3b8" }}>{s.label}</div>
            {s.name && <div style={{ fontSize:10, color:"#64748b" }}>{s.name}</div>}
            {s.at && <div style={{ fontSize:10, color:"#94a3b8" }}>{fmtTs(s.at).slice(0,10)}</div>}
          </div>
          {i < steps.length - 1 && <div style={{ width:32, height:2, background:"#e2e8f0", flexShrink:0 }} />}
        </div>
      ))}
    </div>
  );
}
function buildSteps(doc, users) {
  const hist = doc.history || [];
  const getStep = (action) => hist.find(h => h.action === action || h.action === action+"_final");
  const submitted = hist[0];
  const deptStep  = hist.find(h => ["approved","final","rejected"].includes(h.action) && h.byRole === "dept_head");
  const dirStep   = hist.find(h => ["approved","rejected"].includes(h.action) && h.byRole === "director");
  const steps = [{ label:"작성", name: doc.authorName, done:true, at: submitted?.at }];
  if (doc.type !== "weekly") {
    const deptHeadName = Object.values(users||{}).find(u=>u.role==="dept_head"&&u.department===doc.authorDept)?.name || "부서장";
    steps.push({
      label:"부서장",
      name: deptHeadName,
      done: !!deptStep,
      active: doc.status === "pending_dept",
      at: deptStep?.at,
    });
  }
  const dirName = Object.values(users||{}).find(u=>u.role==="director")?.name || "병원장";
  steps.push({
    label:"병원장",
    name: dirName,
    done: !!dirStep || doc.status === "final",
    active: doc.status === "pending_dir",
    at: dirStep?.at,
  });
  return steps;
}

// ─── 파일 업로드 ──────────────────────────────────────────────────────────────
function FileUpload({ files, onChange, docId }) {
  const fileRef = useRef();
  const [uploading, setUploading] = useState(false);
  const upload = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    setUploading(true);
    try {
      const path = `approvals/${docId || uid7()}/${Date.now()}_${f.name}`;
      const uploadRef = sRef(storage, path);
      await new Promise((res, rej) => {
        const task = uploadBytesResumable(uploadRef, f);
        task.on("state_changed", null, rej, () => res());
      });
      const url = await getDownloadURL(uploadRef);
      onChange([...(files||[]), { name:f.name, url, path, size:f.size }]);
    } catch { alert("파일 업로드 실패. Firebase Storage가 활성화되어 있는지 확인하세요."); }
    setUploading(false);
    fileRef.current.value = "";
  };
  const remove = async (idx) => {
    try { await deleteObject(sRef(storage, files[idx].path)); } catch {}
    onChange(files.filter((_,i)=>i!==idx));
  };
  return (
    <div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:8 }}>
        {(files||[]).map((f,i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:6, background:"#f8fafc", border:"1px solid #e2e8f0", borderRadius:7, padding:"4px 10px", fontSize:12 }}>
            <a href={f.url} target="_blank" rel="noreferrer" style={{ color:"#0ea5e9", textDecoration:"none", fontWeight:600 }}>📎 {f.name}</a>
            <button onClick={()=>remove(i)} style={{ border:"none", background:"none", cursor:"pointer", color:"#94a3b8", fontSize:14, padding:0 }}>✕</button>
          </div>
        ))}
      </div>
      <input ref={fileRef} type="file" style={{ display:"none" }} onChange={upload} />
      <button style={{ ...S.btnSec, fontSize:12, padding:"6px 14px" }} onClick={()=>fileRef.current.click()} disabled={uploading}>
        {uploading ? "⏳ 업로드 중..." : "📎 파일 첨부"}
      </button>
    </div>
  );
}
function FileList({ files }) {
  if (!files?.length) return <span style={{ fontSize:13, color:"#94a3b8" }}>첨부파일 없음</span>;
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
      {files.map((f,i) => (
        <a key={i} href={f.url} target="_blank" rel="noreferrer"
          style={{ display:"inline-flex", alignItems:"center", gap:5, background:"#f0f9ff", border:"1px solid #bae6fd", borderRadius:7, padding:"4px 12px", fontSize:12, color:"#0284c7", textDecoration:"none", fontWeight:600 }}>
          📎 {f.name}
        </a>
      ))}
    </div>
  );
}

// ─── 휴가신청서 ───────────────────────────────────────────────────────────────
function VacationForm({ data, onChange, readonly }) {
  const f = data || {};
  const upd = (k,v) => onChange({...f,[k]:v});
  const days = daysBetween(f.fromDate, f.toDate);
  if (readonly) return (
    <div>
      <Grid><ReadVal label="성명" value={f.name} /><ReadVal label="부서" value={f.department} /></Grid>
      <ReadVal label="주민번호" value={f.idNum} />
      <ReadVal label="기간" value={f.fromDate && f.toDate ? `${f.fromDate} ~ ${f.toDate} (${days}일간)` : "-"} />
      <ReadVal label="휴가종류" value={f.leaveType + (f.leaveType==="반차휴가" && f.halfFrom ? ` (${f.halfFrom}~${f.halfTo})` : "")} />
      {(f.leaveType==="기타"||f.leaveType==="병가") && <ReadVal label="구체적 사유" value={f.reason} />}
    </div>
  );
  return (
    <div>
      <Grid><Field label="성명"><input style={S.input} value={f.name||""} onChange={e=>upd("name",e.target.value)} /></Field>
        <Field label="부서"><input style={S.input} value={f.department||""} onChange={e=>upd("department",e.target.value)} /></Field>
      </Grid>
      <Field label="주민번호"><input style={S.input} value={f.idNum||""} onChange={e=>upd("idNum",e.target.value)} placeholder="000000-0000000" /></Field>
      <Grid cols={3}>
        <Field label="휴가 시작일"><input type="date" style={S.input} value={f.fromDate||""} onChange={e=>upd("fromDate",e.target.value)} /></Field>
        <Field label="휴가 종료일"><input type="date" style={S.input} value={f.toDate||""} onChange={e=>upd("toDate",e.target.value)} /></Field>
        <Field label="일수"><div style={{ padding:"8px 10px", background:"#f8fafc", borderRadius:8, fontSize:13, border:"1.5px solid #e2e8f0" }}>{days>0?`${days}일간`:"-"}</div></Field>
      </Grid>
      <Field label="휴가종류">
        <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
          {LEAVE_TYPES.map(t=>(
            <label key={t} style={{ display:"flex", alignItems:"center", gap:4, cursor:"pointer", fontSize:13 }}>
              <input type="radio" name="leaveType" value={t} checked={f.leaveType===t} onChange={()=>upd("leaveType",t)} />{t}
            </label>
          ))}
        </div>
      </Field>
      {f.leaveType==="반차휴가" && (
        <Grid>
          <Field label="반차 시작시간"><input type="time" style={S.input} value={f.halfFrom||""} onChange={e=>upd("halfFrom",e.target.value)} /></Field>
          <Field label="반차 종료시간"><input type="time" style={S.input} value={f.halfTo||""} onChange={e=>upd("halfTo",e.target.value)} /></Field>
        </Grid>
      )}
      {(f.leaveType==="기타"||f.leaveType==="병가") && (
        <Field label="구체적 사유"><textarea style={{...S.input,height:80,resize:"vertical"}} value={f.reason||""} onChange={e=>upd("reason",e.target.value)} placeholder="사유를 구체적으로 입력하세요" /></Field>
      )}
    </div>
  );
}

// ─── 물품청구서 ───────────────────────────────────────────────────────────────
const emptyItem = () => ({ id:uid7(), name:"", unit:"개", qty:"", price:"", note:"" });
function SupplyForm({ data, onChange, readonly }) {
  const f = data || { department:"", requestDate:todayStr(), items:[emptyItem()] };
  const upd = (k,v) => onChange({...f,[k]:v});
  const updItem = (i,k,v) => { const items=[...f.items]; items[i]={...items[i],[k]:v}; upd("items",items); };
  const addItem = () => upd("items",[...f.items, emptyItem()]);
  const delItem = i => upd("items", f.items.filter((_,idx)=>idx!==i));
  const total = (f.items||[]).reduce((s,it)=>s+((Number(it.qty)||0)*(Number(it.price)||0)),0);
  if (readonly) return (
    <div>
      <Grid><ReadVal label="신청부서" value={f.department} /><ReadVal label="신청일" value={f.requestDate} /></Grid>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, marginBottom:12 }}>
        <thead><tr>{["번호","품명 및 규격","단위","수량","금액(원)","비고"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {(f.items||[]).map((it,i)=>(
            <tr key={it.id}>
              <td style={{...S.td,textAlign:"center",width:36}}>{i+1}</td>
              <td style={S.td}>{it.name}</td><td style={{...S.td,textAlign:"center",width:60}}>{it.unit}</td>
              <td style={{...S.td,textAlign:"center",width:60}}>{it.qty}</td>
              <td style={{...S.td,textAlign:"right",width:100}}>{fmtNum((Number(it.qty)||0)*(Number(it.price)||0))}</td>
              <td style={S.td}>{it.note}</td>
            </tr>
          ))}
          <tr><td colSpan={4} style={{...S.th,textAlign:"right"}}>합 계</td><td style={{...S.th,textAlign:"right"}}>{fmtNum(total)}</td><td style={S.th}></td></tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <div>
      <Grid><Field label="신청부서"><input style={S.input} value={f.department||""} onChange={e=>upd("department",e.target.value)} /></Field>
        <Field label="신청일"><input type="date" style={S.input} value={f.requestDate||""} onChange={e=>upd("requestDate",e.target.value)} /></Field>
      </Grid>
      <div style={S.sectionTit}>품목 내역</div>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, marginBottom:8 }}>
        <thead><tr>{["번호","품명 및 규격","단위","수량","단가(원)","합계","비고",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
        <tbody>
          {(f.items||[]).map((it,i)=>(
            <tr key={it.id}>
              <td style={{...S.td,textAlign:"center",width:32}}>{i+1}</td>
              <td style={S.td}><input style={{...S.input,padding:"4px 6px"}} value={it.name} onChange={e=>updItem(i,"name",e.target.value)} /></td>
              <td style={{...S.td,width:70}}><select style={{...S.select,padding:"4px 6px"}} value={it.unit} onChange={e=>updItem(i,"unit",e.target.value)}>{["개","박스","병","세트","EA","L","kg","g","m","기타"].map(u=><option key={u}>{u}</option>)}</select></td>
              <td style={{...S.td,width:70}}><input style={{...S.input,padding:"4px 6px",textAlign:"right"}} type="number" value={it.qty} onChange={e=>updItem(i,"qty",e.target.value)} /></td>
              <td style={{...S.td,width:90}}><input style={{...S.input,padding:"4px 6px",textAlign:"right"}} type="number" value={it.price} onChange={e=>updItem(i,"price",e.target.value)} /></td>
              <td style={{...S.td,width:90,textAlign:"right"}}>{fmtNum((Number(it.qty)||0)*(Number(it.price)||0))}</td>
              <td style={S.td}><input style={{...S.input,padding:"4px 6px"}} value={it.note} onChange={e=>updItem(i,"note",e.target.value)} /></td>
              <td style={{...S.td,width:28}}>{f.items.length>1&&<button onClick={()=>delItem(i)} style={{border:"none",background:"none",cursor:"pointer",color:"#dc2626",fontSize:16}}>✕</button>}</td>
            </tr>
          ))}
          <tr><td colSpan={5} style={{...S.th,textAlign:"right"}}>합 계</td><td style={{...S.th,textAlign:"right"}}>{fmtNum(total)}</td><td colSpan={2} style={S.th}></td></tr>
        </tbody>
      </table>
      <button style={{...S.btnSec,fontSize:12,padding:"6px 14px"}} onClick={addItem}>+ 품목 추가</button>
    </div>
  );
}

// ─── 위탁진료 환불금 보고 ─────────────────────────────────────────────────────
const emptyTreatment = () => ({ id:uid7(), date:"", institution:"", totalCost:"", refundAmount:"", note:"" });
const emptyPatient   = () => ({ id:uid7(), chartNo:"", name:"", phone:"", bankHolder:"", bank:"국민은행", accountNo:"", patientDbId:"", treatments:[emptyTreatment()] });

function RefundForm({ data, onChange, readonly }) {
  const f = data || { reportMonth: todayStr().slice(0,7), patients:[] };
  const upd = (k,v) => onChange({...f,[k]:v});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  const searchPatients = async (q) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    const snap = await get(ref(db, "patients"));
    const all = Object.entries(snap.val()||{}).map(([k,v])=>({...v,_key:k}));
    setSearchResults(all.filter(p=>p.name?.includes(q)||p.internalId?.includes(q)).slice(0,5));
  };
  const addPatient = (prefill) => {
    const p = { ...emptyPatient(), ...(prefill||{}) };
    upd("patients", [...(f.patients||[]), p]);
    setSearchQuery(""); setSearchResults([]);
  };
  const updPatient = (i,k,v) => { const ps=[...(f.patients||[])]; ps[i]={...ps[i],[k]:v}; upd("patients",ps); };
  const delPatient = (i) => upd("patients",(f.patients||[]).filter((_,idx)=>idx!==i));
  const updTreat  = (pi,ti,k,v) => { const ps=[...(f.patients||[])]; const ts=[...ps[pi].treatments]; ts[ti]={...ts[ti],[k]:v}; ps[pi]={...ps[pi],treatments:ts}; upd("patients",ps); };
  const addTreat  = (pi) => { const ps=[...(f.patients||[])]; ps[pi]={...ps[pi],treatments:[...ps[pi].treatments,emptyTreatment()]}; upd("patients",ps); };
  const delTreat  = (pi,ti) => { const ps=[...(f.patients||[])]; ps[pi]={...ps[pi],treatments:ps[pi].treatments.filter((_,i)=>i!==ti)}; upd("patients",ps); };
  const patientTotal = (p) => (p.treatments||[]).reduce((s,t)=>s+(Number(t.refundAmount)||0),0);
  const grandTotal = (f.patients||[]).reduce((s,p)=>s+patientTotal(p),0);

  if (readonly) return (
    <div>
      <ReadVal label="보고 월" value={f.reportMonth} />
      {(f.patients||[]).map((p,pi)=>(
        <div key={p.id} style={{ border:"1px solid #e2e8f0", borderRadius:10, padding:14, marginBottom:12 }}>
          <div style={{ fontWeight:800, fontSize:14, color:"#1e3a5f", marginBottom:10 }}>
            환자 {pi+1}: {p.name} (차트번호: {p.chartNo||"-"})
          </div>
          <Grid cols={3}>
            <ReadVal label="연락처" value={p.phone} />
            <ReadVal label="예금주" value={p.bankHolder} />
            <ReadVal label="은행" value={p.bank} />
          </Grid>
          <ReadVal label="계좌번호" value={p.accountNo} />
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, margin:"8px 0" }}>
            <thead><tr>{["진료날짜","진료기관","진료비 총액","환불금액","비고"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {(p.treatments||[]).map((t,ti)=>(
                <tr key={t.id}>
                  <td style={S.td}>{t.date}</td><td style={S.td}>{t.institution}</td>
                  <td style={{...S.td,textAlign:"right"}}>{fmtNum(t.totalCost)}</td>
                  <td style={{...S.td,textAlign:"right"}}>{fmtNum(t.refundAmount)}</td>
                  <td style={S.td}>{t.note}</td>
                </tr>
              ))}
              <tr><td colSpan={3} style={{...S.th,textAlign:"right"}}>환자 환불 합계</td>
                <td style={{...S.th,textAlign:"right",color:"#dc2626"}}>{fmtNum(patientTotal(p))}</td>
                <td style={S.th}></td></tr>
            </tbody>
          </table>
        </div>
      ))}
      <div style={{ textAlign:"right", fontWeight:800, fontSize:15, color:"#dc2626", marginTop:8, padding:"10px 0", borderTop:"2px solid #e2e8f0" }}>
        총 환불 합계: {fmtNum(grandTotal)} 원
      </div>
    </div>
  );

  return (
    <div>
      <Field label="보고 월"><input type="month" style={{...S.input,maxWidth:180}} value={f.reportMonth||""} onChange={e=>upd("reportMonth",e.target.value)} /></Field>
      {/* 환자 검색 */}
      <div style={{ marginBottom:16, position:"relative" }}>
        <label style={S.label}>환자 검색 후 추가</label>
        <div style={{ display:"flex", gap:8 }}>
          <input style={S.input} value={searchQuery} onChange={e=>searchPatients(e.target.value)} placeholder="이름 또는 차트번호로 검색..." />
          <button style={{...S.btnSec,flexShrink:0}} onClick={()=>addPatient()}>+ 직접 추가</button>
        </div>
        {searchResults.length>0 && (
          <div style={{ position:"absolute", top:"100%", left:0, right:0, background:"#fff", border:"1px solid #e2e8f0", borderRadius:8, boxShadow:"0 4px 16px rgba(0,0,0,0.1)", zIndex:50, marginTop:4 }}>
            {searchResults.map(p=>(
              <div key={p._key} onClick={()=>addPatient({ chartNo:p.internalId||"", name:p.name||"", phone:p.phone||"", bankHolder:p.bankHolder||"", bank:p.bank||"국민은행", accountNo:p.accountNo||"", patientDbId:p._key })}
                style={{ padding:"10px 14px", cursor:"pointer", borderBottom:"1px solid #f1f5f9", display:"flex", gap:10, alignItems:"center" }}
                onMouseEnter={e=>e.currentTarget.style.background="#f0f9ff"}
                onMouseLeave={e=>e.currentTarget.style.background="#fff"}>
                <span style={{ fontWeight:700, fontSize:13 }}>{p.name}</span>
                {p.internalId && <span style={{ fontSize:12, color:"#64748b" }}>차트번호: {p.internalId}</span>}
                {p.phone && <span style={{ fontSize:12, color:"#94a3b8" }}>{p.phone}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* 환자 목록 */}
      {(f.patients||[]).map((p,pi)=>(
        <div key={p.id} style={{ border:"1.5px solid #e2e8f0", borderRadius:10, padding:16, marginBottom:16, background:"#fafafa" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
            <div style={{ fontWeight:800, color:"#1e3a5f" }}>환자 {pi+1}</div>
            <button onClick={()=>delPatient(pi)} style={{ border:"none", background:"#fee2e2", color:"#dc2626", borderRadius:6, padding:"3px 10px", cursor:"pointer", fontWeight:700, fontSize:12 }}>삭제</button>
          </div>
          <Grid cols={3}>
            <Field label="차트번호"><input style={S.input} value={p.chartNo||""} onChange={e=>updPatient(pi,"chartNo",e.target.value)} /></Field>
            <Field label="성함"><input style={S.input} value={p.name||""} onChange={e=>updPatient(pi,"name",e.target.value)} /></Field>
            <Field label="연락처"><input style={S.input} value={p.phone||""} onChange={e=>updPatient(pi,"phone",e.target.value)} /></Field>
          </Grid>
          <div style={{ fontWeight:700, fontSize:13, color:"#475569", marginBottom:8 }}>계좌 정보</div>
          <Grid cols={3}>
            <Field label="예금주명"><input style={S.input} value={p.bankHolder||""} onChange={e=>updPatient(pi,"bankHolder",e.target.value)} /></Field>
            <Field label="은행"><select style={S.select} value={p.bank||"국민은행"} onChange={e=>updPatient(pi,"bank",e.target.value)}>{BANKS.map(b=><option key={b}>{b}</option>)}</select></Field>
            <Field label="계좌번호"><input style={S.input} value={p.accountNo||""} onChange={e=>updPatient(pi,"accountNo",e.target.value)} /></Field>
          </Grid>
          <div style={{ fontWeight:700, fontSize:13, color:"#475569", margin:"12px 0 8px" }}>진료 내역</div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, marginBottom:8 }}>
            <thead><tr>{["진료날짜","진료기관","진료비 총액","최종 환불금액","비고",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
            <tbody>
              {(p.treatments||[]).map((t,ti)=>(
                <tr key={t.id}>
                  <td style={{...S.td,width:120}}><input type="date" style={{...S.input,padding:"3px 6px",fontSize:12}} value={t.date} onChange={e=>updTreat(pi,ti,"date",e.target.value)} /></td>
                  <td style={S.td}><input style={{...S.input,padding:"3px 6px",fontSize:12}} value={t.institution} onChange={e=>updTreat(pi,ti,"institution",e.target.value)} /></td>
                  <td style={{...S.td,width:110}}><input type="number" style={{...S.input,padding:"3px 6px",fontSize:12,textAlign:"right"}} value={t.totalCost} onChange={e=>updTreat(pi,ti,"totalCost",e.target.value)} /></td>
                  <td style={{...S.td,width:110}}><input type="number" style={{...S.input,padding:"3px 6px",fontSize:12,textAlign:"right"}} value={t.refundAmount} onChange={e=>updTreat(pi,ti,"refundAmount",e.target.value)} /></td>
                  <td style={S.td}><input style={{...S.input,padding:"3px 6px",fontSize:12}} value={t.note} onChange={e=>updTreat(pi,ti,"note",e.target.value)} /></td>
                  <td style={{...S.td,width:28}}>{p.treatments.length>1&&<button onClick={()=>delTreat(pi,ti)} style={{border:"none",background:"none",cursor:"pointer",color:"#dc2626"}}>✕</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <button style={{...S.btnSec,fontSize:12,padding:"5px 12px"}} onClick={()=>addTreat(pi)}>+ 진료건 추가</button>
            <div style={{ fontWeight:800, color:"#dc2626", fontSize:14 }}>환자 환불 합계: {fmtNum(patientTotal(p))} 원</div>
          </div>
        </div>
      ))}
      <div style={{ textAlign:"right", fontWeight:800, fontSize:16, color:"#dc2626", padding:"12px 0", borderTop:"2px solid #e2e8f0", marginTop:4 }}>
        총 환불 합계: {fmtNum(grandTotal)} 원
      </div>
    </div>
  );
}

// ─── 주간보고서 ───────────────────────────────────────────────────────────────
function WeeklyForm({ data, onChange, readonly }) {
  const f = data || { weekFrom:"", weekTo:"", totalFood:"", staffCount:"", patientCount:"", perCapita:"", mainContent:"", notes:"" };
  const upd = (k,v) => onChange({...f,[k]:v});
  const total = Number(f.staffCount||0)+Number(f.patientCount||0);
  if (readonly) return (
    <div>
      <ReadVal label="보고기간" value={f.weekFrom && f.weekTo ? `${f.weekFrom} ~ ${f.weekTo}` : "-"} />
      <Grid cols={3}>
        <ReadVal label="직원 식수" value={f.staffCount ? `${fmtNum(f.staffCount)}명` : "-"} />
        <ReadVal label="환우 식수" value={f.patientCount ? `${fmtNum(f.patientCount)}명` : "-"} />
        <ReadVal label="총 식수" value={total ? `${fmtNum(total)}명` : "-"} />
      </Grid>
      <Grid cols={2}>
        <ReadVal label="해당 주 식비 합계" value={f.totalFood ? `${fmtNum(f.totalFood)} 원` : "-"} />
        <ReadVal label="1인 식단가" value={f.perCapita ? `${fmtNum(f.perCapita)} 원` : "-"} />
      </Grid>
      <ReadVal label="주요 내용" value={f.mainContent} />
      <ReadVal label="특이사항" value={f.notes} />
    </div>
  );
  return (
    <div>
      <Grid>
        <Field label="보고기간 시작일"><input type="date" style={S.input} value={f.weekFrom||""} onChange={e=>upd("weekFrom",e.target.value)} /></Field>
        <Field label="보고기간 종료일"><input type="date" style={S.input} value={f.weekTo||""} onChange={e=>upd("weekTo",e.target.value)} /></Field>
      </Grid>
      <Grid cols={3}>
        <Field label="직원 식수 (명)"><input type="number" style={S.input} value={f.staffCount||""} onChange={e=>upd("staffCount",e.target.value)} /></Field>
        <Field label="환우 식수 (명)"><input type="number" style={S.input} value={f.patientCount||""} onChange={e=>upd("patientCount",e.target.value)} /></Field>
        <Field label="총 식수"><div style={{ padding:"8px 10px", background:"#f8fafc", borderRadius:8, fontSize:13, border:"1.5px solid #e2e8f0" }}>{total ? `${fmtNum(total)}명` : "-"}</div></Field>
      </Grid>
      <Grid>
        <Field label="해당 주 식비 합계 (원)"><input type="number" style={S.input} value={f.totalFood||""} onChange={e=>upd("totalFood",e.target.value)} /></Field>
        <Field label="1인 식단가 (원)"><input type="number" style={S.input} value={f.perCapita||""} onChange={e=>upd("perCapita",e.target.value)} /></Field>
      </Grid>
      <Field label="주요 내용"><textarea style={{...S.input,height:100,resize:"vertical"}} value={f.mainContent||""} onChange={e=>upd("mainContent",e.target.value)} placeholder="해당 주 주요 내용을 작성하세요" /></Field>
      <Field label="특이사항"><textarea style={{...S.input,height:80,resize:"vertical"}} value={f.notes||""} onChange={e=>upd("notes",e.target.value)} placeholder="특이사항 또는 건의사항" /></Field>
    </div>
  );
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
export default function ApprovalPage() {
  const [user,       setUser]       = useState(null);
  const [profile,    setProfile]    = useState(null);
  const [allUsers,   setAllUsers]   = useState({});
  const [docs,       setDocs]       = useState({});
  const [loading,    setLoading]    = useState(true);

  // 뷰 상태
  const [view,       setView]       = useState("list"); // list | detail | new
  const [activeTab,  setActiveTab]  = useState("mine"); // mine | pending | all(director)
  const [selectedId, setSelectedId] = useState(null);
  const [newType,    setNewType]    = useState(null);

  // 결재 액션
  const [rejectModal, setRejectModal] = useState(null); // { docId }
  const [rejectMemo,  setRejectMemo]  = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // 새 문서 작성
  const [formData,   setFormData]   = useState({});
  const [files,      setFiles]      = useState([]);
  const [tempDocId]                 = useState(uid7());
  const [saving,     setSaving]     = useState(false);

  // Auth 감지
  useEffect(() => {
    const unsub = auth.onAuthStateChanged ? auth.onAuthStateChanged(u=>setUser(u)) : null;
    // Next.js에서 onAuthStateChanged를 직접 import 했으므로:
    return unsub || (() => {});
  }, []);

  // 프로필 로드
  useEffect(() => {
    if (!user) return;
    const pRef = ref(db, `users/${user.uid}`);
    return onValue(pRef, snap => {
      setProfile(snap.val());
      setLoading(false);
    });
  }, [user]);

  // 전체 사용자 로드
  useEffect(() => {
    return onValue(ref(db, "users"), snap => setAllUsers(snap.val() || {}));
  }, []);

  // 문서 로드
  useEffect(() => {
    return onValue(ref(db, "approvals"), snap => setDocs(snap.val() || {}));
  }, []);

  // 내가 결재해야 할 문서 (currentApproverUid === user.uid)
  const pendingDocs = Object.entries(docs).filter(([,d]) => d.currentApproverUid === user?.uid && !["approved","final","rejected"].includes(d.status));
  // 내가 작성한 문서
  const myDocs = Object.entries(docs).filter(([,d]) => d.authorUid === user?.uid);
  // 병원장용: 전체 결재 대기
  const allPendingDocs = Object.entries(docs).filter(([,d]) => !["approved","final","rejected","draft"].includes(d.status));

  const selectedDoc = selectedId ? docs[selectedId] : null;

  // 결재 라우팅: 제출 시 다음 결재자 uid 찾기
  const findNextApprover = (type, authorRole, authorDept) => {
    if (type === "weekly") {
      // 직접 보고 → 병원장
      const dir = Object.entries(allUsers).find(([,u])=>u.role==="director");
      return dir ? { uid: dir[0], status: "pending_dir" } : null;
    }
    if (authorRole === "staff") {
      // 같은 부서 부서장 찾기
      const dh = Object.entries(allUsers).find(([,u])=>u.role==="dept_head"&&u.department===authorDept);
      if (dh) return { uid: dh[0], status: "pending_dept" };
    }
    // 부서장/병원장이 제출하면 바로 병원장 결재
    const dir = Object.entries(allUsers).find(([,u])=>u.role==="director");
    return dir ? { uid: dir[0], status: "pending_dir" } : null;
  };

  const handleSubmit = async (asDraft = false) => {
    if (!profile) return;
    setSaving(true);
    try {
      const docNumber = asDraft ? "" : await getNextDocNumber(newType);
      const type = DOC_TYPES[newType];
      let status = "draft", currentApproverUid = null;
      if (!asDraft) {
        const next = findNextApprover(newType, profile.role, profile.department);
        if (next) { status = next.status; currentApproverUid = next.uid; }
        else { status = "approved"; }
      }
      const docRef = push(ref(db, "approvals"));
      await set(docRef, {
        docNumber, type: newType,
        title: type.label,
        authorUid: user.uid, authorName: profile.name, authorDept: profile.department,
        createdAt: Date.now(), updatedAt: Date.now(),
        status, currentApproverUid,
        formData, fileUrls: files,
        history: asDraft ? [] : [{ action:"submitted", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:"" }],
      });
      // 위탁진료: 환자 계좌정보 DB 저장
      if (newType === "refund" && !asDraft) {
        for (const p of (formData.patients||[])) {
          if (p.patientDbId && (p.bankHolder||p.bank||p.accountNo)) {
            await update(ref(db, `patients/${p.patientDbId}`), { bankHolder:p.bankHolder||"", bank:p.bank||"", accountNo:p.accountNo||"" });
          }
        }
      }
      setView("list"); setNewType(null); setFormData({}); setFiles([]);
      alert(asDraft ? "임시저장 완료" : "제출 완료");
    } catch(e) { alert("오류: "+e.message); }
    setSaving(false);
  };

  const handleApprove = async (docId, isFinal = false) => {
    setActionLoading(true);
    const doc = docs[docId];
    let newStatus, nextApproverUid = null;
    if (isFinal || doc.status === "pending_dir") {
      newStatus = isFinal ? "final" : "approved";
    } else if (doc.status === "pending_dept") {
      const dir = Object.entries(allUsers).find(([,u])=>u.role==="director");
      newStatus = "pending_dir";
      nextApproverUid = dir ? dir[0] : null;
    }
    await update(ref(db, `approvals/${docId}`), {
      status: newStatus, currentApproverUid: nextApproverUid, updatedAt: Date.now(),
      history: [...(doc.history||[]), { action: isFinal?"final":"approved", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:"" }],
    });
    setActionLoading(false);
    alert(isFinal ? "전결 처리 완료" : "승인 완료");
  };

  const handleReject = async () => {
    setActionLoading(true);
    const doc = docs[rejectModal.docId];
    await update(ref(db, `approvals/${rejectModal.docId}`), {
      status: "rejected", currentApproverUid: doc.authorUid, updatedAt: Date.now(),
      history: [...(doc.history||[]), { action:"rejected", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:rejectMemo }],
    });
    setActionLoading(false);
    setRejectModal(null); setRejectMemo("");
    alert("반려 완료");
  };

  // 반려된 문서 재제출
  const handleResubmit = async (docId) => {
    await update(ref(db, `approvals/${docId}`), { status:"draft", currentApproverUid:null, updatedAt:Date.now() });
    setView("list");
  };

  // 임시저장 문서 제출
  const handleDraftSubmit = async (docId) => {
    const doc = docs[docId];
    const docNumber = await getNextDocNumber(doc.type);
    const next = findNextApprover(doc.type, profile.role, profile.department);
    await update(ref(db, `approvals/${docId}`), {
      docNumber, status: next?.status||"approved", currentApproverUid: next?.uid||null, updatedAt:Date.now(),
      history: [{ action:"submitted", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:"" }],
    });
    alert("제출 완료");
  };

  // 로딩/미로그인
  if (loading) return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontSize:16 }}>로딩 중...</div>;
  if (!user)   return <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontSize:16 }}>로그인이 필요합니다.</div>;
  if (!profile) return <ProfileSetup user={user} onSave={p => set(ref(db,`users/${user.uid}`),p)} />;

  const renderDocForm = (type, data, onChange, docId, fileList, onFileChange, readonly) => {
    const props = { data, onChange, readonly };
    return (
      <div>
        {type==="vacation" && <VacationForm {...props} />}
        {type==="supply"   && <SupplyForm   {...props} />}
        {type==="refund"   && <RefundForm   {...props} />}
        {type==="weekly"   && <WeeklyForm   {...props} />}
        {!readonly && <div style={{ marginTop:20 }}>
          <div style={S.sectionTit}>첨부파일</div>
          <FileUpload files={fileList} onChange={onFileChange} docId={docId} />
        </div>}
        {readonly && fileList?.length > 0 && (
          <div style={{ marginTop:16 }}>
            <div style={S.sectionTit}>첨부파일</div>
            <FileList files={fileList} />
          </div>
        )}
      </div>
    );
  };

  // ── 문서 상세 뷰 ─────────────────────────────────────────────────────────────
  if (view === "detail" && selectedDoc) {
    const doc = selectedDoc;
    const isMine = doc.authorUid === user.uid;
    const isPendingMe = doc.currentApproverUid === user.uid;
    const canFinal = isPendingMe && doc.status === "pending_dept" && profile.role === "dept_head";
    const hist = doc.history || [];
    const actionColors = { submitted:"#0ea5e9", approved:"#059669", final:"#7c3aed", rejected:"#dc2626" };
    return (
      <div style={S.page}>
        <header style={S.header}>
          <button onClick={()=>setView("list")} style={{ border:"none", background:"rgba(255,255,255,0.15)", color:"#fff", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:13 }}>← 목록</button>
          <div style={{ flex:1, fontWeight:800, fontSize:16 }}>이우요양병원 결재 시스템</div>
          <div style={{ fontSize:13, color:"#94a3b8" }}>{profile.name} · {profile.department}</div>
        </header>
        <div style={S.main}>
          <div style={S.card}>
            <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:8, flexWrap:"wrap" }}>
              <span style={{ fontFamily:"monospace", fontSize:13, color:"#64748b" }}>{doc.docNumber||"임시저장"}</span>
              <span style={{...S.badge(DOC_TYPES[doc.type]?.color, DOC_TYPES[doc.type]?.bg)}}>{DOC_TYPES[doc.type]?.label}</span>
              <StatusBadge status={doc.status} />
              <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>작성: {fmtTs(doc.createdAt)}</span>
            </div>
            <StepIndicator doc={doc} users={allUsers} />
            <hr style={{ border:"none", borderTop:"1px solid #f1f5f9", margin:"16px 0" }} />
            <div style={S.sectionTit}>문서 내용</div>
            {renderDocForm(doc.type, doc.formData, null, null, doc.fileUrls, null, true)}
          </div>

          {/* 결재 이력 */}
          <div style={S.card}>
            <div style={S.sectionTit}>결재 이력</div>
            {hist.length === 0 && <div style={{ fontSize:13, color:"#94a3b8" }}>임시저장 상태입니다.</div>}
            {hist.map((h,i) => (
              <div key={i} style={{ display:"flex", gap:12, padding:"10px 0", borderBottom:"1px solid #f1f5f9" }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:actionColors[h.action]||"#94a3b8", flexShrink:0, marginTop:5 }} />
                <div>
                  <div style={{ fontSize:13, fontWeight:700 }}>
                    {h.byName} <span style={{ color:"#94a3b8", fontWeight:400 }}>({h.byRole==="director"?"병원장":h.byRole==="dept_head"?"부서장":"작성자"})</span>
                    <span style={{ marginLeft:8, fontSize:12, color:actionColors[h.action]||"#64748b" }}>
                      {h.action==="submitted"?"제출":h.action==="approved"?"승인":h.action==="final"?"전결":h.action==="rejected"?"반려":""}
                    </span>
                  </div>
                  {h.memo && <div style={{ fontSize:12, color:"#dc2626", marginTop:2 }}>반려 사유: {h.memo}</div>}
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>{fmtTs(h.at)}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 결재 액션 버튼 */}
          {isPendingMe && (
            <div style={{ ...S.card, display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
              <button style={S.btnGreen} onClick={()=>handleApprove(selectedId)} disabled={actionLoading}>✓ 승인</button>
              {canFinal && <button style={S.btnPurple} onClick={()=>handleApprove(selectedId,true)} disabled={actionLoading}>★ 전결</button>}
              <button style={S.btnRed} onClick={()=>{setRejectModal({docId:selectedId});setRejectMemo("");}} disabled={actionLoading}>✕ 반려</button>
            </div>
          )}
          {/* 반려된 내 문서: 재제출 */}
          {isMine && doc.status==="rejected" && (
            <div style={{ ...S.card, display:"flex", gap:12, justifyContent:"center" }}>
              <button style={S.btnPri} onClick={()=>handleResubmit(selectedId)}>↩ 수정 후 재제출</button>
            </div>
          )}
          {/* 임시저장 내 문서: 제출 */}
          {isMine && doc.status==="draft" && (
            <div style={{ ...S.card, display:"flex", gap:12, justifyContent:"center" }}>
              <button style={S.btnPri} onClick={()=>handleDraftSubmit(selectedId)}>→ 제출하기</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── 새 문서 작성 뷰 ──────────────────────────────────────────────────────────
  if (view === "new") {
    if (!newType) return (
      <div style={S.page}>
        <header style={S.header}>
          <button onClick={()=>setView("list")} style={{ border:"none", background:"rgba(255,255,255,0.15)", color:"#fff", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700 }}>← 취소</button>
          <div style={{ flex:1, fontWeight:800, fontSize:16 }}>새 문서 작성</div>
        </header>
        <div style={S.main}>
          <div style={S.card}>
            <div style={{ fontSize:15, fontWeight:800, color:"#1e3a5f", marginBottom:20 }}>문서 종류를 선택하세요</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
              {Object.entries(DOC_TYPES).map(([key,t]) => (
                <button key={key} onClick={()=>{setNewType(key);setFormData({});setFiles([]);}}
                  style={{ padding:"20px", border:`2px solid ${t.color}`, borderRadius:12, background:t.bg, cursor:"pointer", textAlign:"left" }}>
                  <div style={{ fontSize:15, fontWeight:800, color:t.color, marginBottom:4 }}>{t.label}</div>
                  <div style={{ fontSize:12, color:"#64748b" }}>{key==="vacation"?"연차·병가·생리휴가 등":key==="supply"?"각 부서 물품 요청":key==="refund"?"위탁진료 환자 환불 처리":"영양팀 주간 식비 보고"}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
    const typeInfo = DOC_TYPES[newType];
    return (
      <div style={S.page}>
        <header style={S.header}>
          <button onClick={()=>setNewType(null)} style={{ border:"none", background:"rgba(255,255,255,0.15)", color:"#fff", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700 }}>← 뒤로</button>
          <div style={{ flex:1, fontWeight:800, fontSize:16 }}>{typeInfo.label} 작성</div>
          <div style={{ fontSize:13, color:"#94a3b8" }}>{profile.name} · {profile.department}</div>
        </header>
        <div style={S.main}>
          <div style={S.card}>
            <div style={{ ...S.sectionTit, color: typeInfo.color }}>{typeInfo.label}</div>
            {renderDocForm(newType, formData, setFormData, tempDocId, files, setFiles, false)}
          </div>
          <div style={{ display:"flex", gap:12, justifyContent:"flex-end" }}>
            <button style={S.btnSec} onClick={()=>handleSubmit(true)} disabled={saving}>임시저장</button>
            <button style={S.btnPri} onClick={()=>handleSubmit(false)} disabled={saving}>{saving?"처리 중...":"→ 제출하기"}</button>
          </div>
        </div>
      </div>
    );
  }

  // ── 목록 뷰 ──────────────────────────────────────────────────────────────────
  const sortedDocs = (list) => [...list].sort(([,a],[,b])=>(b.createdAt||0)-(a.createdAt||0));
  const displayDocs = activeTab === "mine" ? sortedDocs(myDocs)
    : activeTab === "pending" ? sortedDocs(pendingDocs)
    : sortedDocs(allPendingDocs);

  const tabConfig = [
    { key:"mine",    label:`내 문서함 (${myDocs.length})` },
    { key:"pending", label:`결재 대기 (${pendingDocs.length})` },
    ...(profile.role === "director" ? [{ key:"all", label:`전체 진행중 (${allPendingDocs.length})` }] : []),
  ];

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={{ fontWeight:800, fontSize:17, flex:1 }}>🏥 이우요양병원 결재 시스템</div>
        <div style={{ fontSize:13, background:"rgba(255,255,255,0.1)", borderRadius:8, padding:"4px 12px" }}>
          {profile.name} · {profile.department} · {profile.role==="director"?"병원장":profile.role==="dept_head"?"부서장":"직원"}
        </div>
      </header>
      <div style={S.main}>
        {pendingDocs.length > 0 && (
          <div style={{ background:"#fef3c7", border:"1.5px solid #f59e0b", borderRadius:10, padding:"10px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:16 }}>🔔</span>
            <span style={{ fontWeight:700, color:"#92400e", fontSize:13 }}>결재 대기 문서 {pendingDocs.length}건이 있습니다.</span>
            <button onClick={()=>setActiveTab("pending")} style={{ marginLeft:"auto", border:"none", background:"#f59e0b", color:"#fff", borderRadius:7, padding:"4px 12px", cursor:"pointer", fontWeight:700, fontSize:12 }}>확인하기</button>
          </div>
        )}
        <div style={S.tabs}>
          {tabConfig.map(t=>(
            <button key={t.key} style={S.tab(activeTab===t.key)} onClick={()=>setActiveTab(t.key)}>{t.label}</button>
          ))}
        </div>
        <div style={S.card}>
          {displayDocs.length === 0 && (
            <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8", fontSize:14 }}>
              {activeTab==="mine" ? "작성한 문서가 없습니다." : activeTab==="pending" ? "결재 대기 문서가 없습니다." : "진행 중인 문서가 없습니다."}
            </div>
          )}
          {displayDocs.map(([id, doc]) => {
            const t = DOC_TYPES[doc.type] || DOC_TYPES.vacation;
            return (
              <div key={id} style={S.docRow}
                onClick={()=>{setSelectedId(id);setView("detail");}}
                onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                <span style={{ fontFamily:"monospace", fontSize:12, color:"#64748b", flexShrink:0, minWidth:110 }}>{doc.docNumber||"임시저장"}</span>
                <span style={S.badge(t.color, t.bg)}>{t.label}</span>
                <span style={{ fontWeight:600, fontSize:14, flex:1 }}>{doc.authorName}</span>
                <span style={{ fontSize:12, color:"#94a3b8", flexShrink:0 }}>{fmtTs(doc.createdAt).slice(0,10)}</span>
                <StatusBadge status={doc.status} />
              </div>
            );
          })}
        </div>
      </div>
      <button style={S.fab} onClick={()=>{setView("new");setNewType(null);}}>+ 새 문서</button>

      {/* 반려 모달 */}
      {rejectModal && (
        <div style={S.modal} onClick={()=>setRejectModal(null)}>
          <div style={S.modalBox} onClick={e=>e.stopPropagation()}>
            <div style={{ fontSize:17, fontWeight:800, color:"#dc2626", marginBottom:16 }}>반려 사유 입력</div>
            <Field label="반려 사유 (작성자에게 전달됩니다)">
              <textarea style={{...S.input,height:120,resize:"vertical"}} value={rejectMemo} onChange={e=>setRejectMemo(e.target.value)} placeholder="반려 사유를 구체적으로 입력하세요" autoFocus />
            </Field>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:12 }}>
              <button style={S.btnSec} onClick={()=>setRejectModal(null)}>취소</button>
              <button style={S.btnRed} onClick={handleReject} disabled={actionLoading||!rejectMemo.trim()}>{actionLoading?"처리중...":"반려 확인"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 프로필 설정 ──────────────────────────────────────────────────────────────
function ProfileSetup({ user, onSave }) {
  const [name, setName]   = useState(user?.email?.replace("@ewoo.com","") || "");
  const [dept, setDept]   = useState("원무과");
  const [role, setRole]   = useState("staff");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim()) { alert("이름을 입력하세요."); return; }
    setSaving(true);
    await onSave({ name:name.trim(), department:dept, role });
    setSaving(false);
  };
  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#f0f4f8" }}>
      <div style={{ background:"#fff", borderRadius:16, padding:32, maxWidth:400, width:"100%", boxShadow:"0 4px 24px rgba(0,0,0,0.1)" }}>
        <div style={{ fontSize:20, fontWeight:800, color:"#0f2744", marginBottom:6 }}>🏥 결재 시스템</div>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:24 }}>처음 사용 시 프로필을 설정해주세요.</div>
        <Field label="이름"><input style={S.input} value={name} onChange={e=>setName(e.target.value)} /></Field>
        <Field label="부서">
          <select style={S.select} value={dept} onChange={e=>setDept(e.target.value)}>{DEPTS.map(d=><option key={d}>{d}</option>)}</select>
        </Field>
        <Field label="직책">
          <select style={S.select} value={role} onChange={e=>setRole(e.target.value)}>
            <option value="staff">일반직원</option>
            <option value="dept_head">부서장</option>
            <option value="director">병원장</option>
          </select>
        </Field>
        <button style={{...S.btnPri, width:"100%", padding:"11px", fontSize:14}} onClick={save} disabled={saving}>{saving?"저장 중...":"저장하기"}</button>
      </div>
    </div>
  );
}

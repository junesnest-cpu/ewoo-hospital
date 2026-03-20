import { useState, useEffect, useRef } from "react";
import { ref, onValue, set, get, push, runTransaction, update } from "firebase/database";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { db, auth, storage } from "../lib/firebaseConfig";

// ─── 상수 ─────────────────────────────────────────────────────────────────────
const DOC_TYPES = {
  vacation: { label: "휴가신청서",          code: "VAC", color: "#0ea5e9", bg: "#e0f2fe" },
  supply:   { label: "물품청구서",          code: "SUP", color: "#10b981", bg: "#d1fae5" },
  refund:   { label: "위탁진료 환불금 보고", code: "REF", color: "#f59e0b", bg: "#fef3c7" },
  weekly:   { label: "월간보고서(영양팀)",   code: "WKL", color: "#8b5cf6", bg: "#ede9fe" },
  tax:      { label: "세금계산서 보고",      code: "TAX", color: "#dc2626", bg: "#fff1f2" },
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
// 이메일을 Firebase key로 변환 (. → , / @ → _at_)
function encodeEmail(email) {
  return (email || "").replace(/\./g, ",").replace(/@/g, "_at_");
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

// ─── 결재 도장 ─────────────────────────────────────────────────────────────
function ApprovalStamp({ label, name, date, color, action }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
      <div style={{ width:80, height:80, borderRadius:"50%", border:`3px solid ${color}`,
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        transform:"rotate(-7deg)", opacity:0.88, padding:4, userSelect:"none",
        boxShadow:`inset 0 0 0 1px ${color}44` }}>
        <div style={{ fontSize:9, color, fontWeight:800, letterSpacing:1 }}>{action}</div>
        <div style={{ fontSize:12, color, fontWeight:900, marginTop:1 }}>{name}</div>
        <div style={{ fontSize:9, color, fontWeight:600 }}>{label}</div>
        <div style={{ fontSize:8, color:`${color}bb` }}>{date}</div>
      </div>
    </div>
  );
}
function ApprovalStampArea({ doc }) {
  const hist = doc.history || [];
  const deptStep = hist.find(h => ["approved","final"].includes(h.action) && h.byRole === "dept_head");
  const dirStep  = hist.find(h => h.action === "approved" && h.byRole === "director");
  const finalStep = hist.find(h => h.action === "final");
  if (!deptStep && !dirStep && !finalStep) return null;
  return (
    <div style={{ display:"flex", gap:20, justifyContent:"flex-end", alignItems:"flex-end",
      padding:"16px 8px 4px", borderTop:"1px dashed #e2e8f0", marginTop:8 }}>
      {deptStep && doc.type !== "weekly" && (
        <ApprovalStamp label="부서장" name={deptStep.byName}
          date={fmtTs(deptStep.at).slice(0,10)} color="#7c3aed"
          action={deptStep.action==="final"?"전결":"결재"} />
      )}
      {(dirStep || finalStep) && (
        <ApprovalStamp label="병원장" name={(dirStep||finalStep).byName}
          date={fmtTs((dirStep||finalStep).at).slice(0,10)} color="#dc2626"
          action="결재" />
      )}
    </div>
  );
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
  const f = { department:"", requestDate:todayStr(), items:[emptyItem()], ...(data||{}) };
  if (!f.items || f.items.length === 0) f.items = [emptyItem()];
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

// ─── 월간보고서(영양팀) ────────────────────────────────────────────────────────
const DAYS_KO = ["월","화","수","목","금","토","일"];
const emptyDay = (date="") => ({ date, ecoFood:"", dojunFood:"", ecoSnack:"", dojunSnack:"", otherCost:"", staffCount:"", patientCount:"", note:"" });

function makeDaysForMonth(ym) {
  if (!ym) return [];
  const [y, m] = ym.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  return Array.from({ length: count }, (_, i) => {
    const d = i + 1;
    return emptyDay(`${y}.${String(m).padStart(2,"0")}.${String(d).padStart(2,"0")}`);
  });
}

function WeeklyForm({ data, onChange, readonly }) {
  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;

  // 구 형식(weekFrom) 호환 처리
  const reportMonth = data?.reportMonth || (data?.weekFrom ? data.weekFrom.slice(0,7) : defaultMonth);
  const baseDays = (data?.days && data.days.length > 0) ? data.days : makeDaysForMonth(reportMonth);
  const f = { reportMonth, days: baseDays, generalNote: data?.generalNote||"" };

  const setMonth = (ym) => {
    if (!ym) return;
    const newDays = makeDaysForMonth(ym);
    // 기존 입력값 보존: 날짜 일치하면 유지
    const merged = newDays.map(nd => {
      const existing = f.days.find(d => d.date === nd.date);
      return existing || nd;
    });
    onChange({ reportMonth: ym, days: merged, generalNote: f.generalNote });
  };

  const updDay = (i,k,v) => {
    const days = [...f.days]; days[i]={...days[i],[k]:v}; onChange({...f,days});
  };

  const dayTotal = d => (Number(d.ecoFood)||0)+(Number(d.dojunFood)||0)+(Number(d.ecoSnack)||0)+(Number(d.dojunSnack)||0)+(Number(d.otherCost)||0);
  const totals = f.days.reduce((acc,d) => ({
    food:    acc.food    + (Number(d.ecoFood)||0)  + (Number(d.dojunFood)||0),
    snack:   acc.snack   + (Number(d.ecoSnack)||0) + (Number(d.dojunSnack)||0),
    other:   acc.other   + (Number(d.otherCost)||0),
    staff:   acc.staff   + (Number(d.staffCount)||0),
    patient: acc.patient + (Number(d.patientCount)||0),
  }), {food:0,snack:0,other:0,staff:0,patient:0});
  totals.total  = totals.food + totals.snack + totals.other;
  totals.count  = totals.staff + totals.patient;
  totals.perCap = totals.count > 0 ? Math.round(totals.total / totals.count) : 0;

  // 주별 구분선: 월요일 행 위에 선 표시
  const isMonday = (dateStr) => {
    if (!dateStr) return false;
    const dt = new Date(dateStr.replace(/\./g,"-"));
    return !isNaN(dt) && dt.getDay() === 1;
  };

  // 공통 테이블 렌더
  const DayTable = ({ editable }) => (
    <div style={{overflowX:"auto"}}>
    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:780}}>
      <thead>
        <tr style={{background:"#ede9fe"}}>
          <th style={{...S.th,width:90,background:"#ede9fe"}}>날짜</th>
          <th style={{...S.th,width:28,background:"#ede9fe"}}>요일</th>
          <th style={{...S.th,minWidth:85,background:"#ede9fe"}}>에코 식재료비</th>
          <th style={{...S.th,minWidth:85,background:"#ede9fe"}}>도준 식재료비</th>
          <th style={{...S.th,minWidth:75,background:"#ede9fe"}}>에코 간식비</th>
          <th style={{...S.th,minWidth:75,background:"#ede9fe"}}>도준 간식비</th>
          <th style={{...S.th,minWidth:85,background:"#ede9fe"}}>기타(현지구매)</th>
          <th style={{...S.th,width:90,background:"#ede9fe"}}>식비합계</th>
          <th style={{...S.th,width:50,background:"#ede9fe"}}>직원</th>
          <th style={{...S.th,width:50,background:"#ede9fe"}}>환우</th>
          <th style={{...S.th,width:60,background:"#ede9fe"}}>총식수</th>
          <th style={{...S.th,width:80,background:"#ede9fe"}}>1인식단가</th>
          {editable && <th style={{...S.th,minWidth:70,background:"#ede9fe"}}>비고</th>}
        </tr>
      </thead>
      <tbody>
        {f.days.map((d,i)=>{
          const dt = d.date ? new Date(d.date.replace(/\./g,"-")) : null;
          const dow = dt&&!isNaN(dt) ? DAYS_KO[(dt.getDay()+6)%7] : "";
          const isWE = dow==="토"||dow==="일";
          const isMon = dow==="월";
          const food  = (Number(d.ecoFood)||0)+(Number(d.dojunFood)||0);
          const snack = (Number(d.ecoSnack)||0)+(Number(d.dojunSnack)||0);
          const other = Number(d.otherCost)||0;
          const total = food+snack+other;
          const cnt   = (Number(d.staffCount)||0)+(Number(d.patientCount)||0);
          const pc    = cnt>0?Math.round(total/cnt):0;
          const bg    = isWE?"#fef9ec":i%2===0?"#fff":"#f8fafc";
          const borderTop = isMon && i>0 ? "2px solid #c4b5fd" : undefined;
          return (
            <tr key={i} style={{background:bg, borderTop}}>
              <td style={{...S.td,fontFamily:"monospace",fontSize:11}}>{d.date||"-"}</td>
              <td style={{...S.td,textAlign:"center",fontWeight:700,color:dow==="토"?"#2563eb":dow==="일"?"#dc2626":"#475569"}}>{dow}</td>
              {editable ? <>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"right"}} value={d.ecoFood||""} onChange={e=>updDay(i,"ecoFood",e.target.value)} /></td>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"right"}} value={d.dojunFood||""} onChange={e=>updDay(i,"dojunFood",e.target.value)} /></td>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"right"}} value={d.ecoSnack||""} onChange={e=>updDay(i,"ecoSnack",e.target.value)} /></td>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"right"}} value={d.dojunSnack||""} onChange={e=>updDay(i,"dojunSnack",e.target.value)} /></td>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"right"}} value={d.otherCost||""} onChange={e=>updDay(i,"otherCost",e.target.value)} /></td>
              </> : <>
                <td style={{...S.td,textAlign:"right"}}>{food?fmtNum(food):""}</td>
                <td style={{...S.td,textAlign:"right"}}>{(Number(d.dojunFood)||0)?fmtNum(Number(d.dojunFood)):""}</td>
                <td style={{...S.td,textAlign:"right"}}>{(Number(d.ecoSnack)||0)?fmtNum(Number(d.ecoSnack)):""}</td>
                <td style={{...S.td,textAlign:"right"}}>{(Number(d.dojunSnack)||0)?fmtNum(Number(d.dojunSnack)):""}</td>
                <td style={{...S.td,textAlign:"right"}}>{other?fmtNum(other):""}</td>
              </>}
              <td style={{...S.td,textAlign:"right",fontWeight:700,background:"#f3f0ff"}}>{total?fmtNum(total):"-"}</td>
              {editable ? <>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"center"}} value={d.staffCount||""} onChange={e=>updDay(i,"staffCount",e.target.value)} /></td>
                <td style={S.td}><input type="number" style={{...S.input,padding:"3px 4px",fontSize:11,textAlign:"center"}} value={d.patientCount||""} onChange={e=>updDay(i,"patientCount",e.target.value)} /></td>
              </> : <>
                <td style={{...S.td,textAlign:"center"}}>{d.staffCount||""}</td>
                <td style={{...S.td,textAlign:"center"}}>{d.patientCount||""}</td>
              </>}
              <td style={{...S.td,textAlign:"center",fontWeight:700,background:"#f3f0ff"}}>{cnt||"-"}</td>
              <td style={{...S.td,textAlign:"right",background:"#f3f0ff"}}>{pc?fmtNum(pc):"-"}</td>
              {editable && <td style={S.td}><input style={{...S.input,padding:"3px 4px",fontSize:11}} value={d.note||""} onChange={e=>updDay(i,"note",e.target.value)} /></td>}
            </tr>
          );
        })}
        <tr style={{background:"#ddd6fe"}}>
          <td colSpan={2} style={{...S.th,textAlign:"center",background:"#ddd6fe"}}>월간 합계</td>
          <td colSpan={3} style={{...S.th,textAlign:"right",background:"#ddd6fe"}}>식재료비 {fmtNum(totals.food)}</td>
          <td colSpan={2} style={{...S.th,textAlign:"right",background:"#ddd6fe"}}>간식+기타 {fmtNum(totals.snack+totals.other)}</td>
          <td style={{...S.th,textAlign:"right",background:"#ddd6fe",color:"#4c1d95",fontSize:13}}>{fmtNum(totals.total)}</td>
          <td style={{...S.th,textAlign:"center",background:"#ddd6fe"}}>{totals.staff}</td>
          <td style={{...S.th,textAlign:"center",background:"#ddd6fe"}}>{totals.patient}</td>
          <td style={{...S.th,textAlign:"center",background:"#ddd6fe",fontWeight:900}}>{totals.count}</td>
          <td style={{...S.th,textAlign:"right",background:"#ddd6fe"}}>{fmtNum(totals.perCap)}</td>
          {editable && <td style={{...S.th,background:"#ddd6fe"}}></td>}
        </tr>
      </tbody>
    </table>
    </div>
  );

  if (readonly) return (
    <div>
      <ReadVal label="보고 월" value={f.reportMonth} />
      <div style={{...S.sectionTit,color:"#7c3aed"}}>일별 식비 현황</div>
      <DayTable editable={false} />
      {f.generalNote && <ReadVal label="특이사항" value={f.generalNote} style={{marginTop:12}} />}
    </div>
  );

  return (
    <div>
      <Field label="보고 월">
        <input type="month" style={{...S.input,maxWidth:200}} value={f.reportMonth||""} onChange={e=>setMonth(e.target.value)} />
      </Field>
      <div style={{...S.sectionTit,color:"#7c3aed"}}>일별 입력 <span style={{fontSize:11,fontWeight:400,color:"#94a3b8"}}>(주 경계: 보라색 구분선)</span></div>
      <DayTable editable={true} />
      <Field label="특이사항" style={{marginTop:12}}>
        <textarea style={{...S.input,height:80,resize:"vertical"}} value={f.generalNote||""} onChange={e=>onChange({...f,generalNote:e.target.value})} placeholder="이달의 특이사항이나 건의사항을 입력하세요" />
      </Field>
    </div>
  );
}

// ─── 세금계산서 보고 ──────────────────────────────────────────────────────────
const PAYMENT_METHODS = ["청구","계좌","카드","영수","기타"];
const PRESET_GROUPS = [
  { name:"주요공과금", items:[
    { category:"보험료",   vendor:"국민건강보험공단",             content:"월 건강보험료" },
    { category:"보험료",   vendor:"국민건강보험공단",             content:"월 연금보험료" },
    { category:"보험료",   vendor:"국민건강보험공단",             content:"월 고용보험료" },
    { category:"보험료",   vendor:"국민건강보험공단",             content:"월 산재보험료" },
    { category:"임대료",   vendor:"즐거운(박명희)",              content:"임대료" },
    { category:"전기세",   vendor:"한국전력공사",                content:"전기세" },
    { category:"관리비",   vendor:"즐거운건물관리",              content:"관리비" },
    { category:"가스비",   vendor:"서울도시가스",                content:"가스비" },
    { category:"수도세",   vendor:"서울특별시 서부수도사업소",    content:"수도비" },
    { category:"퇴직세",   vendor:"",                           content:"퇴직연금" },
  ]},
  { name:"주요거래처", items:[
    { category:"약제/주사제",  vendor:"제인스메디칼",             content:"의약품 월 결제분" },
    { category:"약제/주사제",  vendor:"바른메디팜",               content:"약제 및 주사제 월 결제분" },
    { category:"수탁료",       vendor:"의료법인 삼광의료재단",     content:"월분 검사료 결제" },
    { category:"의료소모품",   vendor:"메디풀",                   content:"EXAM GLOVE외 월 결제분" },
    { category:"식자재",       vendor:"신길축산육류직매장",        content:"정육 월분 결제" },
    { category:"식자재",       vendor:"㈜에코푸드코리아",          content:"식자재 월 결제분" },
    { category:"식자재",       vendor:"㈜도준푸드",               content:"식자재 월 결제분" },
  ]},
  { name:"시설관리", items:[
    { category:"주유비",   vendor:"불광주유소",               content:"주유비 - 1호차 (140호 2373)" },
    { category:"주유비",   vendor:"불광주유소",               content:"주유비 - 2호차 (234누 5978)" },
    { category:"주유비",   vendor:"불광주유소",               content:"주유비 - 스포티지 (229호 6876)" },
    { category:"방제",     vendor:"렌토킬이니셜코리아㈜",      content:"방제 월 결제분" },
    { category:"관리비",   vendor:"성도엘리베이터",            content:"월분 승강기 보수료" },
    { category:"수수료",   vendor:"㈜세광티이씨",              content:"전기안전관리대행수수료 월분" },
  ]},
  { name:"미화", items:[
    { category:"정기소모품", vendor:"늘푸름보호작업장", content:"핸드타올 및 점보롤화장지" },
  ]},
  { name:"원무과", items:[
    { category:"임대료", vendor:"㈜퍼스트전산", content:"복사기임대료" },
  ]},
  { name:"기타", items:[] },
];

function makeTaxItem(p={}) {
  return { id:uid7(), category:p.category||"", vendor:p.vendor||"", content:p.content||"", amount:"", method:"청구", issueDate:"", count:"1", note:"" };
}
function makeTaxGroups() {
  return PRESET_GROUPS.map(g => ({ name:g.name, items:g.items.map(makeTaxItem) }));
}

function TaxForm({ data, onChange, readonly }) {
  const f = (data && data.groups) ? data : { reportMonth:todayStr().slice(0,7), groups:makeTaxGroups() };
  const upd = (k,v) => onChange({...f,[k]:v});
  const updGroup = (gi,k,v) => { const gs=[...f.groups]; gs[gi]={...gs[gi],[k]:v}; upd("groups",gs); };
  const updItem  = (gi,ii,k,v) => { const gs=[...f.groups]; const its=[...gs[gi].items]; its[ii]={...its[ii],[k]:v}; gs[gi]={...gs[gi],items:its}; upd("groups",gs); };
  const addItem  = (gi) => { const gs=[...f.groups]; gs[gi]={...gs[gi],items:[...gs[gi].items,makeTaxItem()]}; upd("groups",gs); };
  const delItem  = (gi,ii) => { const gs=[...f.groups]; gs[gi]={...gs[gi],items:gs[gi].items.filter((_,i)=>i!==ii)}; upd("groups",gs); };
  const addGroup = () => { const name=window.prompt("구분명을 입력하세요:"); if(!name) return; upd("groups",[...f.groups,{name,items:[makeTaxItem()]}]); };
  const delGroup = (gi) => { if(!window.confirm("이 구분을 삭제하시겠습니까?")) return; upd("groups",f.groups.filter((_,i)=>i!==gi)); };
  const groupTotal = (g) => (g.items||[]).reduce((s,it)=>s+(Number(it.amount)||0),0);
  const grandTotal = (f.groups||[]).reduce((s,g)=>s+groupTotal(g),0);

  const TH = S.th;
  const TD = S.td;

  if (readonly) return (
    <div>
      <ReadVal label="보고 월" value={f.reportMonth} />
      {(f.groups||[]).map((g,gi) => {
        const hasData = g.items.some(it=>it.amount||it.vendor||it.content);
        if (!hasData) return null;
        return (
          <div key={gi} style={{marginBottom:16}}>
            <div style={{...S.sectionTit,color:"#dc2626"}}>{g.name}</div>
            <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead><tr>{["분류","업체","내용","금액(원)","처리","발행일","건수","비고"].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
              <tbody>
                {g.items.filter(it=>it.amount||it.vendor||it.content).map((it,ii)=>(
                  <tr key={ii}>
                    <td style={TD}>{it.category}</td><td style={TD}>{it.vendor}</td><td style={TD}>{it.content}</td>
                    <td style={{...TD,textAlign:"right"}}>{it.amount?fmtNum(it.amount):"-"}</td>
                    <td style={{...TD,textAlign:"center"}}>{it.method}</td>
                    <td style={{...TD,textAlign:"center"}}>{it.issueDate}</td>
                    <td style={{...TD,textAlign:"center"}}>{it.count?`${it.count}건`:""}</td>
                    <td style={TD}>{it.note}</td>
                  </tr>
                ))}
                <tr><td colSpan={3} style={{...TH,textAlign:"right"}}>소계</td>
                  <td style={{...TH,textAlign:"right",color:"#dc2626"}}>{fmtNum(groupTotal(g))}</td>
                  <td colSpan={4} style={TH}></td>
                </tr>
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
      <div style={{textAlign:"right",fontWeight:800,fontSize:15,color:"#dc2626",padding:"10px 0",borderTop:"2px solid #e2e8f0"}}>
        총 합계: {fmtNum(grandTotal)} 원
      </div>
    </div>
  );

  return (
    <div>
      <Field label="보고 월"><input type="month" style={{...S.input,maxWidth:180}} value={f.reportMonth||""} onChange={e=>upd("reportMonth",e.target.value)} /></Field>
      {(f.groups||[]).map((g,gi) => (
        <div key={gi} style={{marginBottom:20,border:"1.5px solid #e2e8f0",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#fff1f2",padding:"8px 14px",display:"flex",alignItems:"center",gap:10}}>
            <input style={{...S.input,fontWeight:800,fontSize:14,color:"#dc2626",border:"none",background:"transparent",padding:0,width:"auto"}}
              value={g.name} onChange={e=>updGroup(gi,"name",e.target.value)} />
            <span style={{marginLeft:"auto",fontWeight:700,fontSize:13,color:"#dc2626"}}>소계: {fmtNum(groupTotal(g))} 원</span>
            <button onClick={()=>delGroup(gi)} style={{border:"none",background:"none",cursor:"pointer",color:"#94a3b8",fontSize:18,padding:0}}>×</button>
          </div>
          <div style={{overflowX:"auto",padding:"0 0 8px"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:780}}>
            <thead><tr>{["분류","업체","내용","금액(원)","처리","발행일","건수","비고",""].map(h=><th key={h} style={TH}>{h}</th>)}</tr></thead>
            <tbody>
              {(g.items||[]).map((it,ii)=>(
                <tr key={it.id}>
                  <td style={{...TD,width:90}}><input style={{...S.input,padding:"3px 6px",fontSize:11}} value={it.category} onChange={e=>updItem(gi,ii,"category",e.target.value)} /></td>
                  <td style={{...TD,minWidth:120}}><input style={{...S.input,padding:"3px 6px",fontSize:11}} value={it.vendor} onChange={e=>updItem(gi,ii,"vendor",e.target.value)} /></td>
                  <td style={{...TD,minWidth:140}}><input style={{...S.input,padding:"3px 6px",fontSize:11}} value={it.content} onChange={e=>updItem(gi,ii,"content",e.target.value)} /></td>
                  <td style={{...TD,width:100}}><input type="number" style={{...S.input,padding:"3px 6px",fontSize:11,textAlign:"right"}} value={it.amount} onChange={e=>updItem(gi,ii,"amount",e.target.value)} /></td>
                  <td style={{...TD,width:70}}><select style={{...S.select,padding:"3px 5px",fontSize:11}} value={it.method} onChange={e=>updItem(gi,ii,"method",e.target.value)}>{PAYMENT_METHODS.map(m=><option key={m}>{m}</option>)}</select></td>
                  <td style={{...TD,width:100}}><input style={{...S.input,padding:"3px 6px",fontSize:11}} value={it.issueDate} onChange={e=>updItem(gi,ii,"issueDate",e.target.value)} placeholder="예: 1/15" /></td>
                  <td style={{...TD,width:55}}><input style={{...S.input,padding:"3px 6px",fontSize:11,textAlign:"center"}} value={it.count} onChange={e=>updItem(gi,ii,"count",e.target.value)} /></td>
                  <td style={{...TD,minWidth:80}}><input style={{...S.input,padding:"3px 6px",fontSize:11}} value={it.note} onChange={e=>updItem(gi,ii,"note",e.target.value)} /></td>
                  <td style={{...TD,width:26}}><button onClick={()=>delItem(gi,ii)} style={{border:"none",background:"none",cursor:"pointer",color:"#dc2626",fontSize:15}}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div style={{padding:"0 12px 8px"}}>
            <button style={{...S.btnSec,fontSize:11,padding:"4px 12px"}} onClick={()=>addItem(gi)}>+ 항목 추가</button>
          </div>
        </div>
      ))}
      <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:16}}>
        <button style={{...S.btnSec,fontSize:12}} onClick={addGroup}>+ 구분 추가</button>
        <span style={{marginLeft:"auto",fontWeight:800,fontSize:15,color:"#dc2626"}}>총 합계: {fmtNum(grandTotal)} 원</span>
      </div>
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

  // 프로필 로드 (이메일 기반 키)
  useEffect(() => {
    if (!user) return;
    const emailKey = encodeEmail(user.email);
    const pRef = ref(db, `users/${emailKey}`);
    return onValue(pRef, async snap => {
      const val = snap.val();
      if (val) {
        // uid 필드가 없으면 자동 설정 (관리자가 미리 생성한 경우)
        if (!val.uid) {
          await update(ref(db, `users/${emailKey}`), { uid: user.uid });
        }
        setProfile({ ...val, uid: user.uid });
      } else {
        setProfile(null);
      }
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
      const dir = Object.values(allUsers).find(u=>u.role==="director");
      return dir ? { uid: dir.uid, status: "pending_dir" } : null;
    }
    if (authorRole === "staff") {
      // 같은 부서 부서장 찾기
      const dh = Object.values(allUsers).find(u=>u.role==="dept_head"&&u.department===authorDept);
      if (dh) return { uid: dh.uid, status: "pending_dept" };
    }
    // 부서장/병원장이 제출하면 바로 병원장 결재
    const dir = Object.values(allUsers).find(u=>u.role==="director");
    return dir ? { uid: dir.uid, status: "pending_dir" } : null;
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
      const dir = Object.values(allUsers).find(u=>u.role==="director");
      newStatus = "pending_dir";
      nextApproverUid = dir ? dir.uid : null;
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
  if (!profile) return <ProfileSetup user={user} onSave={p => set(ref(db,`users/${encodeEmail(user.email)}`), { ...p, uid: user.uid })} />;

  const renderDocForm = (type, data, onChange, docId, fileList, onFileChange, readonly) => {
    const props = { data, onChange, readonly };
    return (
      <div>
        {type==="vacation" && <VacationForm {...props} />}
        {type==="supply"   && <SupplyForm   {...props} />}
        {type==="refund"   && <RefundForm   {...props} />}
        {type==="weekly"   && <WeeklyForm   {...props} />}
        {type==="tax"      && <TaxForm      {...props} />}
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
          <img src="/favicon.png" style={{ width:30, height:30, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
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
            <ApprovalStampArea doc={doc} />
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
          <img src="/favicon.png" style={{ width:30, height:30, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
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
                  <div style={{ fontSize:12, color:"#64748b" }}>{key==="vacation"?"연차·병가·생리휴가 등":key==="supply"?"각 부서 물품 요청":key==="refund"?"위탁진료 환자 환불 처리":key==="weekly"?"영양팀 월간 식비 보고":"월별 지출 세금계산서 내역"}</div>
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
          <img src="/favicon.png" style={{ width:30, height:30, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
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
  const weeklyDocs = Object.entries(docs).filter(([,d])=>d.type==="weekly");
  const taxDocs    = Object.entries(docs).filter(([,d])=>d.type==="tax");
  const displayDocs = activeTab === "mine"    ? sortedDocs(myDocs)
    : activeTab === "pending"  ? sortedDocs(pendingDocs)
    : activeTab === "weekly"   ? sortedDocs(weeklyDocs)
    : activeTab === "tax"      ? sortedDocs(taxDocs)
    : sortedDocs(allPendingDocs);

  const tabConfig = [
    { key:"mine",    label:`내 문서함 (${myDocs.length})` },
    { key:"pending", label:`결재 대기 (${pendingDocs.length})` },
    { key:"weekly",  label:`월간보고 (${weeklyDocs.length})` },
    { key:"tax",     label:`세금계산서 (${taxDocs.length})` },
    ...(profile.role === "director" ? [{ key:"all", label:`전체 진행중 (${allPendingDocs.length})` }] : []),
  ];

  return (
    <div style={S.page}>
      <header style={S.header}>
        <img src="/favicon.png" style={{ width:36, height:36, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
        <div style={{ fontWeight:800, fontSize:17, flex:1 }}>이우요양병원 결재 시스템</div>
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
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
          <button style={{ ...S.btnPri, padding:"10px 22px", fontSize:14, borderRadius:10 }}
            onClick={()=>{setView("new");setNewType(null);}}>
            + 새 문서
          </button>
        </div>
        <div style={S.tabs}>
          {tabConfig.map(t=>(
            <button key={t.key} style={S.tab(activeTab===t.key)} onClick={()=>setActiveTab(t.key)}>{t.label}</button>
          ))}
        </div>
        <div style={S.card}>
          {displayDocs.length === 0 && (
            <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8", fontSize:14 }}>
              {activeTab==="mine"?"작성한 문서가 없습니다.":activeTab==="pending"?"결재 대기 문서가 없습니다.":activeTab==="weekly"?"월간보고 문서가 없습니다.":activeTab==="tax"?"세금계산서 문서가 없습니다.":"진행 중인 문서가 없습니다."}
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

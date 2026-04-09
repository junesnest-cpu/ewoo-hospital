import { useState, useEffect, useRef } from "react";
import { ref, onValue, set, get, push, runTransaction, update, remove } from "firebase/database";
import { ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "firebase/storage";
import { db, auth, storage } from "../lib/firebaseConfig";
import { parseRefundExcel, parseWeeklyExcel, parseTaxExcel } from "../lib/excelParsers";
import useIsMobile from "../lib/useismobile";

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
  superseded:   { label: "대체됨",           color: "#94a3b8", bg: "#f1f5f9" },
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
  page:       { display:"flex", flexDirection:"column", minHeight:"100vh", background:"#f0f4f8", fontFamily:"'Noto Sans KR',sans-serif" },
  header:     { background:"#0f2744", color:"#fff", padding:"12px 24px", display:"flex", alignItems:"center", gap:12, boxShadow:"0 2px 8px rgba(0,0,0,0.2)", position:"sticky", top:0, zIndex:200, flexShrink:0 },
  main:       { maxWidth:920, margin:"0 auto", padding:"24px 16px" },
  sidebar:    { width:175, flexShrink:0, background:"#fff", borderRight:"1px solid #e2e8f0", display:"flex", flexDirection:"column", position:"sticky", top:60, height:"calc(100vh - 60px)", overflowY:"auto" },
  content:    { flex:1, padding:"24px 20px", minWidth:0, overflowX:"auto" },
  navGroup:   { fontSize:10, fontWeight:800, color:"#94a3b8", letterSpacing:"0.08em", padding:"14px 14px 7px", textTransform:"uppercase" },
  navItem: a => ({ display:"flex", alignItems:"center", gap:9, padding:"8px 14px 8px 22px", cursor:"pointer", fontWeight:a?700:500, fontSize:13, color:a?"#0f2744":"#475569", background:a?"#eff6ff":"transparent", borderLeft:a?"3px solid #0f2744":"3px solid transparent", transition:"all 0.12s", border:"none", width:"100%", textAlign:"left", boxSizing:"border-box" }),
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

// ─── 엑셀 자동입력 버튼 ─────────────────────────────────────────────────────
function ExcelImportButton({ onParsed, parserFn, accept=".xlsx,.xls", color="#0f2744", bg="#e0f2fe", label="엑셀 자동입력" }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [pending, setPending] = useState(null); // { results } — 시트 선택 대기
  const inputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true); setError("");
    try {
      const results = await parserFn(file);
      if (!results || results.length === 0) { setError("파싱된 데이터가 없습니다. 파일 형식을 확인하세요."); return; }
      if (results.length === 1) {
        onParsed(results);
      } else {
        setPending({ results }); // 시트가 여러 개면 선택 UI 표시
      }
    } catch (err) {
      setError("파싱 오류: " + err.message);
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  };

  return (
    <div style={{ marginBottom:14 }}>
      <input ref={inputRef} type="file" accept={accept} style={{ display:"none" }} onChange={handleFile} />
      <button type="button"
        style={{ border:`1.5px solid ${color}33`, background:bg, color, borderRadius:8, padding:"7px 16px", fontWeight:700, fontSize:13, cursor:loading?"not-allowed":"pointer", display:"flex", alignItems:"center", gap:8, opacity:loading?0.7:1 }}
        onClick={()=>!loading && inputRef.current?.click()}>
        <span style={{ fontSize:16 }}>📂</span>
        {loading ? "분석 중..." : label}
      </button>
      {error && <div style={{ fontSize:12, color:"#dc2626", marginTop:4 }}>{error}</div>}

      {/* 시트 선택 모달 */}
      {pending && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
          onClick={e=>{ if(e.target===e.currentTarget) setPending(null); }}>
          <div style={{ background:"#fff", borderRadius:14, padding:24, maxWidth:420, width:"100%", boxShadow:"0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ fontWeight:800, fontSize:15, color:"#1e3a5f", marginBottom:4 }}>불러올 시트를 선택하세요</div>
            <div style={{ fontSize:12, color:"#94a3b8", marginBottom:16 }}>
              Excel 파일에서 {pending.results.length}개의 시트가 발견되었습니다.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {pending.results.map((r, idx) => (
                <button key={idx}
                  style={{ padding:"11px 16px", textAlign:"left", cursor:"pointer", border:`1.5px solid ${color}44`, borderRadius:9, background:bg, fontSize:13, fontWeight:600, color, display:"flex", alignItems:"center", gap:10 }}
                  onClick={() => { onParsed([r]); setPending(null); }}>
                  <span style={{ fontSize:15 }}>📄</span>
                  <span style={{ flex:1 }}>
                    {r.sheetName || `시트 ${idx+1}`}
                    {r.reportMonth && (
                      <span style={{ marginLeft:8, fontSize:12, fontWeight:400, color:"#64748b" }}>({r.reportMonth})</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
            <button style={{ ...S.btnSec, width:"100%", marginTop:12, fontSize:13 }} onClick={()=>setPending(null)}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
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
      {deptStep && (
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
  {
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
        const timeout = setTimeout(() => rej(new Error("업로드 시간 초과 (30초). Firebase Storage 버킷이 초기화되지 않았거나 네트워크 오류입니다.")), 30000);
        task.on("state_changed",
          (snap) => console.log(`업로드 진행: ${Math.round(snap.bytesTransferred/snap.totalBytes*100)}%`),
          (err) => { clearTimeout(timeout); console.error("Storage 오류:", err.code, err.message); rej(err); },
          () => { clearTimeout(timeout); res(); }
        );
      });
      const url = await getDownloadURL(uploadRef);
      onChange([...(files||[]), { name:f.name, url, path, size:f.size }]);
    } catch(err) { alert("파일 업로드 실패: " + (err?.message || String(err))); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
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
      {f.title && <div style={{ fontSize:15, fontWeight:800, color:"#0f2744", marginBottom:10 }}>{f.title}</div>}
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
      <Field label="신청 제목">
        <input style={S.input} value={f.title||""} onChange={e=>upd("title",e.target.value)} placeholder="예) 4월 사무용품 신청, 의료소모품 구매 등" />
      </Field>
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
      <ExcelImportButton
        label="엑셀 자동입력 (위탁진료 양식)"
        color="#f59e0b" bg="#fef3c7"
        parserFn={parseRefundExcel}
        onParsed={(results) => {
          // 파싱 결과 첫 번째(또는 사용자가 선택) 시트 적용
          if (results.length === 1) {
            onChange({ ...f, reportMonth: results[0].reportMonth, patients: results[0].patients });
          } else {
            // 여러 시트: 현재 월과 일치하는 것 우선, 없으면 첫 번째
            const match = results.find(r => r.reportMonth === f.reportMonth) || results[0];
            onChange({ ...f, reportMonth: match.reportMonth, patients: match.patients });
          }
        }}
      />
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

  if (readonly) {
    const ms = data?.monthSummary;
    // monthSummary가 없으면 일별 데이터에서 직접 계산
    const computedMs = !ms && f.days && f.days.some(d=>Number(d.ecoFood)||Number(d.dojunFood)||Number(d.ecoSnack)||Number(d.dojunSnack)||Number(d.otherCost)||Number(d.staffCount)||Number(d.patientCount)) ? (() => {
      const ecoFood   = f.days.reduce((s,d)=>s+(Number(d.ecoFood)||0),0);
      const dojunFood = f.days.reduce((s,d)=>s+(Number(d.dojunFood)||0),0);
      const ecoSnack  = f.days.reduce((s,d)=>s+(Number(d.ecoSnack)||0),0);
      const dojunSnack= f.days.reduce((s,d)=>s+(Number(d.dojunSnack)||0),0);
      const otherCost = f.days.reduce((s,d)=>s+(Number(d.otherCost)||0),0);
      const staff     = f.days.reduce((s,d)=>s+(Number(d.staffCount)||0),0);
      const patient   = f.days.reduce((s,d)=>s+(Number(d.patientCount)||0),0);
      const totalCost = ecoFood+dojunFood+ecoSnack+dojunSnack+otherCost;
      const totalCount= staff+patient;
      return { ecoFood, dojunFood, ecoSnack, dojunSnack, otherCost, staff, patient, totalCost, totalCount, perCapita: totalCount>0?Math.round(totalCost/totalCount):0 };
    })() : null;
    const displayMs = ms || computedMs;
    const hasDailyData = f.days && f.days.some(d => Number(d.ecoFood)||Number(d.dojunFood)||Number(d.ecoSnack)||Number(d.dojunSnack)||Number(d.otherCost)||Number(d.staffCount)||Number(d.patientCount));
    return (
      <div>
        <ReadVal label="보고 월" value={f.reportMonth} />
        {displayMs && (
          <div style={{ background:"#f3f0ff", borderRadius:10, padding:"14px 16px", marginBottom:14 }}>
            <div style={{...S.sectionTit, color:"#7c3aed", marginBottom:10}}>월간 요약</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"8px 16px" }}>
              <ReadVal label="식재료비(에코+도준)" value={fmtNum((displayMs.ecoFood||0)+(displayMs.dojunFood||0))+"원"} />
              <ReadVal label="간식비(에코+도준)"   value={fmtNum((displayMs.ecoSnack||0)+(displayMs.dojunSnack||0))+"원"} />
              <ReadVal label="기타(현지구매)"       value={fmtNum(displayMs.otherCost||0)+"원"} />
              <ReadVal label="총 식비합계"   value={<strong style={{color:"#4c1d95",fontSize:15}}>{fmtNum(displayMs.totalCost||0)}원</strong>} />
              <ReadVal label="직원/환우/총식수" value={`${displayMs.staff||0} / ${displayMs.patient||0} / ${displayMs.totalCount||0}명`} />
              <ReadVal label="1인 식단가" value={fmtNum(displayMs.perCapita||0)+"원"} />
            </div>
          </div>
        )}
        {hasDailyData && (
          <>
            <div style={{...S.sectionTit,color:"#7c3aed"}}>일별 식비 현황</div>
            <DayTable editable={false} />
          </>
        )}
        {!hasDailyData && !ms && (
          <div style={{ textAlign:"center", padding:"20px 0", color:"#94a3b8", fontSize:13 }}>일별 상세 데이터가 없습니다.</div>
        )}
        {f.generalNote && <ReadVal label="특이사항" value={f.generalNote} style={{marginTop:12}} />}
      </div>
    );
  }

  return (
    <div>
      <ExcelImportButton
        label="엑셀 자동입력 (영양팀 월간보고 양식)"
        color="#7c3aed" bg="#ede9fe"
        parserFn={parseWeeklyExcel}
        onParsed={(results) => {
          const match = results.find(r => r.reportMonth === f.reportMonth) || results[0];
          onChange({ ...f, reportMonth: match.reportMonth, days: match.days, monthSummary: match.monthSummary });
        }}
      />
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
const PAYMENT_METHODS = ["청구","계좌","카드","현금","영수","기타"];
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
  return { id:uid7(), category:p.category||"", vendor:p.vendor||"", content:p.content||"", amount:"", method:"청구", issueDate:"", count:"", note:"" };
}
function makeTaxGroups() {
  return PRESET_GROUPS.map(g => ({ name:g.name, items:g.items.map(makeTaxItem) }));
}

// 청구(미지급) 행 스타일
const BILLED_ROW_BG  = "#fefce8"; // 연한 노란색 배경
const BILLED_AMT_CLR = "#b45309"; // 황갈색 (청구 금액)
const PAID_AMT_CLR   = "#dc2626"; // 빨간색 (실지출 금액)

function TaxForm({ data, onChange, readonly }) {
  const f = (data && data.groups) ? data : { reportMonth:todayStr().slice(0,7), groups:makeTaxGroups() };
  const upd = (k,v) => onChange({...f,[k]:v});
  const updGroup = (gi,k,v) => { const gs=[...f.groups]; gs[gi]={...gs[gi],[k]:v}; upd("groups",gs); };
  const updItem  = (gi,ii,k,v) => { const gs=[...f.groups]; const its=[...gs[gi].items]; its[ii]={...its[ii],[k]:v}; gs[gi]={...gs[gi],items:its}; upd("groups",gs); };
  const addItem  = (gi) => { const gs=[...f.groups]; gs[gi]={...gs[gi],items:[...gs[gi].items,makeTaxItem()]}; upd("groups",gs); };
  const delItem  = (gi,ii) => { const gs=[...f.groups]; gs[gi]={...gs[gi],items:gs[gi].items.filter((_,i)=>i!==ii)}; upd("groups",gs); };
  const addGroup = () => { const name=window.prompt("구분명을 입력하세요:"); if(!name) return; upd("groups",[...f.groups,{name,items:[makeTaxItem()]}]); };
  const delGroup = (gi) => { if(!window.confirm("이 구분을 삭제하시겠습니까?")) return; upd("groups",f.groups.filter((_,i)=>i!==gi)); };

  // 금액 포맷 헬퍼 (3자리 콤마 표시, 저장은 숫자 문자열)
  const formatAmt = (v) => v !== "" && v != null ? Number(String(v).replace(/[^0-9]/g,"")).toLocaleString("ko-KR") : "";
  const parseAmt  = (v) => String(v).replace(/[^0-9]/g,"");

  // 새 문서 임시저장 오류 방지: 폼 마운트 시 부모 formData 초기화
  useEffect(() => {
    if (onChange && !readonly && !(data && data.groups)) {
      onChange({ reportMonth: todayStr().slice(0,7), groups: makeTaxGroups() });
    }
  }, []); // eslint-disable-line

  // 행 이동/복제
  const moveItem = (gi, ii, dir) => {
    const gs = [...f.groups]; const items = [...gs[gi].items]; const t = ii + dir;
    if (t < 0 || t >= items.length) return;
    [items[ii], items[t]] = [items[t], items[ii]];
    gs[gi] = { ...gs[gi], items }; upd("groups", gs);
  };
  const dupItem = (gi, ii) => {
    const gs = [...f.groups]; const items = [...gs[gi].items];
    items.splice(ii + 1, 0, { ...items[ii], id: uid7() });
    gs[gi] = { ...gs[gi], items }; upd("groups", gs);
  };
  // 드래그 이동 (그룹 간 이동 포함)
  const reorderItem = (fromGi, fromIi, toGi, toIi) => {
    if (fromGi === toGi && fromIi === toIi) return;
    const gs = [...f.groups];
    if (fromGi === toGi) {
      const items = [...gs[fromGi].items];
      const [removed] = items.splice(fromIi, 1);
      items.splice(toIi, 0, removed);
      gs[fromGi] = { ...gs[fromGi], items };
    } else {
      const srcItems = [...gs[fromGi].items];
      const dstItems = [...gs[toGi].items];
      const [removed] = srcItems.splice(fromIi, 1);
      dstItems.splice(toIi, 0, removed);
      gs[fromGi] = { ...gs[fromGi], items: srcItems };
      gs[toGi] = { ...gs[toGi], items: dstItems };
    }
    upd("groups", gs);
  };
  // 클립보드 복사 (탭 구분 텍스트 → 다른 셀에 Ctrl+V로 붙여넣기 가능)
  const copyItem = (gi, ii) => {
    const it = f.groups[gi].items[ii];
    const text = PASTE_FIELDS.map(k => it[k] ?? "").join("\t");
    navigator.clipboard.writeText(text).catch(()=>{});
  };
  const dragSrc = useRef(null);
  const [dragOverKey, setDragOverKey] = useState(null);

  // 셀 포커스 이동 헬퍼
  const focusCell = (gi, ii, fi) => {
    setTimeout(() => {
      const el = document.querySelector(`[data-gi="${gi}"][data-ii="${ii}"][data-fi="${fi}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    }, 0);
  };

  // 방향키/Enter 셀 이동 (엑셀형)
  const handleKeyDown = (e, gi, ii, fi) => {
    if (e.isComposing) return;
    const itemCount = (f.groups[gi]?.items||[]).length;
    const FIELD_COUNT = 8;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (ii === itemCount - 1) addItem(gi);
      focusCell(gi, ii + 1, fi);
      return;
    }
    if (e.key === "ArrowDown") {
      if (ii < itemCount - 1) { e.preventDefault(); focusCell(gi, ii + 1, fi); }
      return;
    }
    if (e.key === "ArrowUp") {
      if (ii > 0) { e.preventDefault(); focusCell(gi, ii - 1, fi); }
      return;
    }
    if (e.key === "ArrowLeft") {
      if ((e.target.selectionStart ?? 0) === 0 && fi > 0) { e.preventDefault(); focusCell(gi, ii, fi - 1); }
      return;
    }
    if (e.key === "ArrowRight") {
      const val = e.target.value ?? "";
      if ((e.target.selectionStart ?? val.length) === val.length && fi < FIELD_COUNT - 1) {
        e.preventDefault(); focusCell(gi, ii, fi + 1);
      }
      return;
    }
  };

  // 엑셀 다중행 붙여넣기: 탭/줄바꿈 포함 시 여러 행 생성
  const PASTE_FIELDS = ["category","vendor","content","amount","method","issueDate","count","note"];
  const handlePaste = (e, gi, ii) => {
    const text = e.clipboardData.getData("text");
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length <= 1 && !text.includes("\t")) return;
    e.preventDefault();
    const newItems = lines.map(line => {
      const cols = line.split("\t");
      const item = makeTaxItem();
      cols.forEach((val, ci) => {
        const field = PASTE_FIELDS[ci];
        if (!field) return;
        item[field] = field === "amount" ? parseAmt(val.trim()) : val.trim();
      });
      return item;
    });
    const gs = [...f.groups];
    const curItems = [...(gs[gi].items||[])];
    curItems.splice(ii + 1, 0, ...newItems);
    gs[gi] = { ...gs[gi], items: curItems };
    upd("groups", gs);
  };

  // 실지출(청구 제외) 합계 / 청구(미지급) 합계 분리
  const groupPaid   = (g) => (g.items||[]).filter(it=>it.method!=="청구").reduce((s,it)=>s+(Number(it.amount)||0),0);
  const groupBilled = (g) => (g.items||[]).filter(it=>it.method==="청구").reduce((s,it)=>s+(Number(it.amount)||0),0);
  const grandPaid   = (f.groups||[]).reduce((s,g)=>s+groupPaid(g),0);
  const grandBilled = (f.groups||[]).reduce((s,g)=>s+groupBilled(g),0);

  const TH = S.th;
  const TD = S.td;

  // 그룹 소계 행 렌더링 헬퍼 (readonly/edit 공용)
  const SubtotalRow = ({ g, colSpanLeft, colSpanRight }) => {
    const paid   = groupPaid(g);
    const billed = groupBilled(g);
    return (
      <>
        {billed > 0 && (
          <tr>
            <td colSpan={colSpanLeft} style={{...TH,textAlign:"right",color:BILLED_AMT_CLR,background:BILLED_ROW_BG}}>청구(미지급) 소계</td>
            <td style={{...TH,textAlign:"right",color:BILLED_AMT_CLR,background:BILLED_ROW_BG}}>{fmtNum(billed)}</td>
            <td colSpan={colSpanRight} style={{...TH,background:BILLED_ROW_BG}}></td>
          </tr>
        )}
        <tr>
          <td colSpan={colSpanLeft} style={{...TH,textAlign:"right"}}>실지출 소계</td>
          <td style={{...TH,textAlign:"right",color:PAID_AMT_CLR}}>{fmtNum(paid)}</td>
          <td colSpan={colSpanRight} style={TH}></td>
        </tr>
      </>
    );
  };

  if (readonly) {
    const allItems = (f.groups||[]).flatMap(g => g.items||[]);
    const vendorAmt = (keyword) => allItems.filter(it => it.vendor && it.vendor.includes(keyword) && it.amount && it.method === "청구").reduce((s,it)=>s+(Number(it.amount)||0),0);
    const MED_VENDORS = ["제인스메디칼","바른메디팜","휴온스","파","리서치메디케어","삼송바이오","삼광의료재단","메디풀"];
    // 파+리서치메디케어를 하나의 업체로 처리하기 위해 직접 검색
    const medRows = [
      { label:"제인스메디칼",    amt: vendorAmt("제인스메디칼") },
      { label:"바른메디팜",      amt: vendorAmt("바른메디팜") },
      { label:"휴온스",          amt: vendorAmt("휴온스") },
      { label:"파아리서치메디케어", amt: vendorAmt("파아리서치") || vendorAmt("파마리서치") || vendorAmt("리서치메디케어") },
      { label:"삼송바이오",      amt: vendorAmt("삼송바이오") },
      { label:"삼광의료재단",    amt: vendorAmt("삼광의료재단") },
      { label:"메디풀",          amt: vendorAmt("메디풀") },
    ];
    const foodRows = [
      { label:"에코푸드코리아",  amt: vendorAmt("에코푸드") },
      { label:"도준푸드",        amt: vendorAmt("도준푸드") },
    ];
    const medTotal  = medRows.reduce((s,r)=>s+r.amt,0);
    const foodTotal = foodRows.reduce((s,r)=>s+r.amt,0);
    const keyTotal  = medTotal + foodTotal;
    const hasKeyData = keyTotal > 0;

  return (
    <div>
      <ReadVal label="보고 월" value={f.reportMonth} />
      {/* 핵심 청구금액 (최상단) */}
      {hasKeyData && (
        <div style={{ background:"#fffbeb", borderRadius:10, padding:"14px 16px", marginBottom:14, border:"2px solid #fbbf24" }}>
          <div style={{ fontWeight:800, fontSize:14, color:"#92400e", marginBottom:12 }}>📋 핵심 청구금액</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            {/* 의료/의약품 */}
            <div style={{ background:"#fff", borderRadius:8, padding:"10px 12px", border:"1px solid #fde68a" }}>
              <div style={{ fontSize:12, fontWeight:800, color:"#b45309", marginBottom:8 }}>의약품·검사·소모품</div>
              {medRows.map(r => r.amt > 0 && (
                <div key={r.label} style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:4 }}>
                  <span style={{ color:"#64748b" }}>{r.label}</span>
                  <span style={{ fontWeight:700, color:"#0f2744" }}>{fmtNum(r.amt)}원</span>
                </div>
              ))}
              {medTotal > 0 && (
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, fontWeight:800, borderTop:"1px solid #fde68a", marginTop:6, paddingTop:6, color:"#b45309" }}>
                  <span>소계</span><span>{fmtNum(medTotal)}원</span>
                </div>
              )}
            </div>
            {/* 식자재 */}
            <div style={{ background:"#fff", borderRadius:8, padding:"10px 12px", border:"1px solid #fde68a" }}>
              <div style={{ fontSize:12, fontWeight:800, color:"#b45309", marginBottom:8 }}>식자재</div>
              {foodRows.map(r => r.amt > 0 && (
                <div key={r.label} style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:4 }}>
                  <span style={{ color:"#64748b" }}>{r.label}</span>
                  <span style={{ fontWeight:700, color:"#0f2744" }}>{fmtNum(r.amt)}원</span>
                </div>
              ))}
              {foodTotal > 0 && (
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, fontWeight:800, borderTop:"1px solid #fde68a", marginTop:6, paddingTop:6, color:"#b45309" }}>
                  <span>소계</span><span>{fmtNum(foodTotal)}원</span>
                </div>
              )}
            </div>
          </div>
          <div style={{ marginTop:10, borderTop:"2px solid #fbbf24", paddingTop:8, display:"flex", justifyContent:"flex-end" }}>
            <div style={{ fontSize:16, fontWeight:900, color:"#92400e" }}>합계 {fmtNum(keyTotal)}원</div>
          </div>
        </div>
      )}
      {/* 지출 요약 (상단) */}
      {(grandPaid > 0 || grandBilled > 0) && (
        <div style={{ background:"#fff1f2", borderRadius:10, padding:"12px 16px", marginBottom:16, border:"1px solid #fca5a5" }}>
          <div style={{ fontWeight:800, fontSize:13, color:"#991b1b", marginBottom:8 }}>지출 요약</div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 16px", alignItems:"center", marginBottom:8 }}>
            {(f.groups||[]).filter(g=>groupPaid(g)>0||groupBilled(g)>0).map((g,i)=>(
              <div key={i} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <span style={{ fontSize:11, color:"#64748b", fontWeight:600 }}>{g.name}</span>
                <span style={{ fontSize:13, fontWeight:700, color:PAID_AMT_CLR }}>{fmtNum(groupPaid(g))}원</span>
                {groupBilled(g)>0 && <span style={{ fontSize:11, color:BILLED_AMT_CLR }}>(+청구 {fmtNum(groupBilled(g))}원)</span>}
              </div>
            ))}
          </div>
          <div style={{ borderTop:"1px solid #fecaca", paddingTop:8, display:"flex", gap:20, flexWrap:"wrap" }}>
            {grandBilled > 0 && <div style={{ fontSize:13, fontWeight:700, color:BILLED_AMT_CLR }}>청구(미지급): {fmtNum(grandBilled)}원</div>}
            <div style={{ fontSize:15, fontWeight:800, color:PAID_AMT_CLR }}>총 실지출: {fmtNum(grandPaid)}원</div>
          </div>
        </div>
      )}
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
                {(() => {
                  const vis = g.items.filter(it=>it.amount||it.vendor||it.content);
                  // 같은 분류 연속행 rowspan 계산
                  const spans = vis.map((it, idx) => {
                    if (idx > 0 && vis[idx-1].category === it.category) return 0;
                    let s = 1;
                    while (idx + s < vis.length && vis[idx+s].category === it.category) s++;
                    return s;
                  });
                  return vis.map((it, ii) => {
                    const isBilled = it.method === "청구";
                    const rowStyle = isBilled ? { background:BILLED_ROW_BG } : {};
                    const span = spans[ii];
                    return (
                      <tr key={ii} style={rowStyle}>
                        {span > 0 && (
                          <td rowSpan={span} style={{...TD,verticalAlign:"middle",fontWeight:span>1?700:400,background:span>1?"#f8fafc":""}}>
                            {it.category}
                          </td>
                        )}
                        <td style={{...TD,...rowStyle}}>{it.vendor}</td>
                        <td style={{...TD,...rowStyle}}>{it.content}</td>
                        <td style={{...TD,...rowStyle,textAlign:"right",color:isBilled?BILLED_AMT_CLR:"inherit"}}>
                          {it.amount?fmtNum(it.amount):"-"}
                        </td>
                        <td style={{...TD,...rowStyle,textAlign:"center"}}>
                          {isBilled
                            ? <span style={{background:"#fde68a",color:"#92400e",borderRadius:4,padding:"1px 6px",fontSize:11,fontWeight:700}}>청구</span>
                            : it.method}
                        </td>
                        <td style={{...TD,...rowStyle,textAlign:"center"}}>{it.issueDate}</td>
                        <td style={{...TD,...rowStyle,textAlign:"center"}}>{it.count && it.amount?`${it.count}건`:""}</td>
                        <td style={{...TD,...rowStyle}}>{it.note}</td>
                      </tr>
                    );
                  });
                })()}
                <SubtotalRow g={g} colSpanLeft={3} colSpanRight={4} />
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
      <div style={{textAlign:"right",padding:"10px 0",borderTop:"2px solid #e2e8f0"}}>
        {grandBilled > 0 && (
          <div style={{fontSize:13,fontWeight:700,color:BILLED_AMT_CLR,marginBottom:4}}>
            총 청구(미지급): {fmtNum(grandBilled)} 원
          </div>
        )}
        <div style={{fontSize:15,fontWeight:800,color:PAID_AMT_CLR}}>
          총 실지출: {fmtNum(grandPaid)} 원
        </div>
      </div>
    </div>
  );
  }

  return (
    <div>
      <ExcelImportButton
        label="엑셀 자동입력 (세금계산서 양식)"
        color="#dc2626" bg="#fff1f2"
        parserFn={parseTaxExcel}
        onParsed={(results) => {
          const match = results.find(r => r.reportMonth === f.reportMonth) || results[0];
          onChange({ ...f, reportMonth: match.reportMonth, groups: match.groups });
        }}
      />
      <Field label="보고 월"><input type="month" style={{...S.input,maxWidth:180}} value={f.reportMonth||""} onChange={e=>upd("reportMonth",e.target.value)} /></Field>
      {(f.groups||[]).map((g,gi) => (
        <div key={gi} style={{marginBottom:20,border:"1.5px solid #e2e8f0",borderRadius:10,overflow:"hidden"}}>
          <div style={{background:"#fff1f2",padding:"8px 14px",display:"flex",alignItems:"center",gap:10}}>
            <input style={{...S.input,fontWeight:800,fontSize:14,color:"#dc2626",border:"none",background:"transparent",padding:0,width:"auto"}}
              value={g.name} onChange={e=>updGroup(gi,"name",e.target.value)} />
            <span style={{marginLeft:"auto",display:"flex",gap:12,alignItems:"center"}}>
              {groupBilled(g) > 0 && (
                <span style={{fontSize:12,fontWeight:600,color:BILLED_AMT_CLR}}>청구: {fmtNum(groupBilled(g))} 원</span>
              )}
              <span style={{fontSize:13,fontWeight:700,color:PAID_AMT_CLR}}>실지출: {fmtNum(groupPaid(g))} 원</span>
            </span>
            <button onClick={()=>delGroup(gi)} style={{border:"none",background:"none",cursor:"pointer",color:"#94a3b8",fontSize:18,padding:0}}>×</button>
          </div>
          <div style={{overflowX:"auto",padding:"0 0 8px"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:820}}>
            <thead><tr>{["","분류","업체","내용","금액(원)","처리","발행일","건수","비고",""].map((h,i)=><th key={i} style={TH}>{h}</th>)}</tr></thead>
            <tbody>
              {(g.items||[]).map((it,ii)=>{
                const isBilled = it.method === "청구";
                const rowBg = isBilled ? BILLED_ROW_BG : "transparent";
                const kd = (fi) => e => handleKeyDown(e,gi,ii,fi);
                const inp = (extra={}) => ({...S.input,padding:"3px 6px",fontSize:11,background:"transparent",...extra});
                const itemCount = (g.items||[]).length;
                const dKey = `${gi}-${ii}`;
                const isDragOver = dragOverKey === dKey;
                return (
                  <tr key={it.id}
                    draggable
                    onDragStart={()=>{ dragSrc.current={gi,ii}; }}
                    onDragOver={e=>{ e.preventDefault(); setDragOverKey(dKey); }}
                    onDragLeave={()=>setDragOverKey(null)}
                    onDrop={e=>{ e.preventDefault(); setDragOverKey(null); if(dragSrc.current) reorderItem(dragSrc.current.gi,dragSrc.current.ii,gi,ii); dragSrc.current=null; }}
                    onDragEnd={()=>{ setDragOverKey(null); dragSrc.current=null; }}
                    style={{background:rowBg, outline:isDragOver?"2px solid #2563eb":"none", outlineOffset:-1}}
                  >
                    <td style={{...TD,width:18,background:rowBg,textAlign:"center",cursor:"grab",color:"#94a3b8",fontSize:14,userSelect:"none"}}>⠿</td>
                    <td style={{...TD,width:90,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={0} style={inp()} value={it.category} onChange={e=>updItem(gi,ii,"category",e.target.value)} onKeyDown={kd(0)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,minWidth:120,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={1} style={inp()} value={it.vendor} onChange={e=>updItem(gi,ii,"vendor",e.target.value)} onKeyDown={kd(1)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,minWidth:140,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={2} style={inp()} value={it.content} onChange={e=>updItem(gi,ii,"content",e.target.value)} onKeyDown={kd(2)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,width:100,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={3} type="text" inputMode="numeric" style={inp({textAlign:"right",color:isBilled?BILLED_AMT_CLR:"inherit"})} value={formatAmt(it.amount)} onChange={e=>updItem(gi,ii,"amount",parseAmt(e.target.value))} onKeyDown={kd(3)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,width:70,background:rowBg}}><select data-gi={gi} data-ii={ii} data-fi={4} style={{...S.select,padding:"3px 5px",fontSize:11,background:isBilled?"#fde68a":"",fontWeight:isBilled?700:400,color:isBilled?"#92400e":""}} value={it.method} onChange={e=>updItem(gi,ii,"method",e.target.value)}>{PAYMENT_METHODS.map(m=><option key={m}>{m}</option>)}</select></td>
                    <td style={{...TD,width:100,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={5} style={inp()} value={it.issueDate} onChange={e=>updItem(gi,ii,"issueDate",e.target.value)} onKeyDown={kd(5)} onPaste={e=>handlePaste(e,gi,ii)} placeholder="예: 1/15" /></td>
                    <td style={{...TD,width:55,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={6} style={inp({textAlign:"center"})} value={it.count} onChange={e=>updItem(gi,ii,"count",e.target.value)} onKeyDown={kd(6)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,minWidth:80,background:rowBg}}><input data-gi={gi} data-ii={ii} data-fi={7} style={inp()} value={it.note} onChange={e=>updItem(gi,ii,"note",e.target.value)} onKeyDown={kd(7)} onPaste={e=>handlePaste(e,gi,ii)} /></td>
                    <td style={{...TD,width:90,background:rowBg,textAlign:"center",whiteSpace:"nowrap"}}>
                      <button title="위로" onClick={()=>moveItem(gi,ii,-1)} disabled={ii===0} style={{border:"none",background:"none",cursor:ii===0?"default":"pointer",color:ii===0?"#cbd5e1":"#64748b",fontSize:13,padding:"0 2px"}}>↑</button>
                      <button title="아래로" onClick={()=>moveItem(gi,ii,1)} disabled={ii===itemCount-1} style={{border:"none",background:"none",cursor:ii===itemCount-1?"default":"pointer",color:ii===itemCount-1?"#cbd5e1":"#64748b",fontSize:13,padding:"0 2px"}}>↓</button>
                      <button title="행 복제" onClick={()=>dupItem(gi,ii)} style={{border:"none",background:"none",cursor:"pointer",color:"#2563eb",fontSize:13,padding:"0 2px"}}>⧉</button>
                      <button title="클립보드 복사" onClick={()=>copyItem(gi,ii)} style={{border:"none",background:"none",cursor:"pointer",color:"#059669",fontSize:13,padding:"0 2px"}}>📋</button>
                      <button title="삭제" onClick={()=>delItem(gi,ii)} style={{border:"none",background:"none",cursor:"pointer",color:"#dc2626",fontSize:13,padding:"0 2px"}}>✕</button>
                    </td>
                  </tr>
                );
              })}
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
        <span style={{marginLeft:"auto",display:"flex",gap:16,alignItems:"center"}}>
          {grandBilled > 0 && (
            <span style={{fontSize:13,fontWeight:700,color:BILLED_AMT_CLR}}>청구(미지급): {fmtNum(grandBilled)} 원</span>
          )}
          <span style={{fontSize:15,fontWeight:800,color:PAID_AMT_CLR}}>총 실지출: {fmtNum(grandPaid)} 원</span>
        </span>
      </div>
    </div>
  );
}

// ─── 연차 현황 패널 ────────────────────────────────────────────────────────────
function VacationSummaryPanel({ docs, onOpenDoc }) {
  const nowY = new Date().getFullYear();
  const nowYMstr = `${nowY}-${String(new Date().getMonth()+1).padStart(2,"0")}`;
  const [year, setYear] = useState(nowY);
  const [mode, setMode] = useState("yearly"); // "yearly" | "monthly"
  const [selMonth, setSelMonth] = useState(nowYMstr);

  const approved = docs.filter(([,d]) => ["approved","final"].includes(d.status) && !d.formData?.cancelled);

  const calcLeave = (fd) => {
    if (!fd) return 0;
    if (fd.leaveType === "반차휴가") {
      if (fd.halfFrom && fd.halfTo) {
        const [fh, fm] = fd.halfFrom.split(":").map(Number);
        const [th, tm] = fd.halfTo.split(":").map(Number);
        return ((th * 60 + tm) - (fh * 60 + fm)) / 60;
      }
      return 4;
    }
    return daysBetween(fd.fromDate, fd.toDate);
  };

  const LEAVE_COLS = ["연차휴가","반차휴가","생리휴가","병가","기타"];
  const MONTHS_12 = Array.from({length:12}, (_,i) => `${year}-${String(i+1).padStart(2,"0")}`);

  // 연도별 summary: { name: { dept, months: { ym: { 연차휴가:n, ... } } } }
  const yearSummary = {};
  for (const [, doc] of approved) {
    const fd = doc.formData || {};
    const name = fd.name || doc.authorName || "?";
    const dept = fd.department || "";
    const ym = (fd.fromDate || "").slice(0, 7);
    if (!ym || ym.slice(0,4) !== String(year)) continue;
    const ltype = fd.leaveType || "기타";
    const amt = calcLeave(fd);
    if (!yearSummary[name]) yearSummary[name] = { dept, months: {} };
    if (!yearSummary[name].months[ym]) yearSummary[name].months[ym] = {};
    yearSummary[name].months[ym][ltype] = (yearSummary[name].months[ym][ltype] || 0) + amt;
  }

  const sTH = { border:"1px solid #e2e8f0", background:"#f0f9ff", padding:"6px 8px", fontWeight:700, fontSize:12, textAlign:"center", whiteSpace:"nowrap" };
  const sTD = { border:"1px solid #e2e8f0", padding:"5px 8px", fontSize:12, textAlign:"center" };
  const sTDL = { ...sTD, textAlign:"left" };

  const NavBar = () => {
    if (mode === "yearly") {
      return (
        <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
          <button onClick={()=>setYear(y=>y-1)} style={{ border:"1.5px solid #bae6fd", background:"#e0f2fe", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}>← 이전년</button>
          <span style={{ fontWeight:800, fontSize:16, color:"#0369a1" }}>{year}년</span>
          <button onClick={()=>setYear(y=>y+1)} disabled={year>=nowY} style={{ border:"1.5px solid #bae6fd", background:"#e0f2fe", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}>다음년 →</button>
          <button onClick={()=>setMode("monthly")} style={{ marginLeft:"auto", border:"1.5px solid #7dd3fc", background:"#f0f9ff", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontSize:13 }}>월별 상세 보기 →</button>
        </div>
      );
    }
    const [ymY, ymM] = selMonth.split("-").map(Number);
    const prev = ymM===1?`${ymY-1}-12`:`${ymY}-${String(ymM-1).padStart(2,"0")}`;
    const next = ymM===12?`${ymY+1}-01`:`${ymY}-${String(ymM+1).padStart(2,"0")}`;
    return (
      <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
        <button onClick={()=>setSelMonth(prev)} style={{ border:"1.5px solid #bae6fd", background:"#e0f2fe", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}>← 이전달</button>
        <input type="month" value={selMonth} onChange={e=>setSelMonth(e.target.value)} style={{ border:"1.5px solid #bae6fd", borderRadius:8, padding:"6px 10px", fontWeight:700, fontSize:15, color:"#0369a1", outline:"none" }} />
        <button onClick={()=>setSelMonth(next)} style={{ border:"1.5px solid #bae6fd", background:"#e0f2fe", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}>다음달 →</button>
        <button onClick={()=>{setYear(Number(selMonth.slice(0,4)));setMode("yearly");}} style={{ marginLeft:"auto", border:"1.5px solid #7dd3fc", background:"#f0f9ff", color:"#0369a1", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontSize:13 }}>← 연도별 보기</button>
      </div>
    );
  };

  if (mode === "yearly") {
    const names = Object.keys(yearSummary).sort();
    return (
      <div>
        <NavBar />
        {names.length === 0 ? (
          <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8" }}>{year}년 승인된 휴가 신청이 없습니다.</div>
        ) : (
          <div style={{ overflowX:"auto" }}>
          <table style={{ borderCollapse:"collapse", fontSize:12 }}>
            <thead>
              <tr>
                <th style={{...sTH, textAlign:"left", minWidth:70}}>이름</th>
                <th style={{...sTH, minWidth:55}}>부서</th>
                {MONTHS_12.map(m=><th key={m} style={{...sTH, minWidth:44}}>{m.slice(5)}월</th>)}
                <th style={{...sTH}}>연간 합계</th>
              </tr>
            </thead>
            <tbody>
              {names.map(name => {
                const p = yearSummary[name];
                const mVals = MONTHS_12.map(m => {
                  const md = p.months[m] || {};
                  const days = LEAVE_COLS.filter(t=>t!=="반차휴가").reduce((s,t)=>s+(md[t]||0),0);
                  const hours = md["반차휴가"]||0;
                  return { days, hours, m };
                });
                const totalDays = mVals.reduce((s,v)=>s+v.days,0);
                const totalHours = mVals.reduce((s,v)=>s+v.hours,0);
                return (
                  <tr key={name}>
                    <td style={{...sTDL, fontWeight:700}}>{name}</td>
                    <td style={{...sTD, color:"#64748b", fontSize:11}}>{p.dept}</td>
                    {mVals.map(({days,hours,m})=>(
                      <td key={m} style={{...sTD, color:days>0||hours>0?"#0369a1":"#e2e8f0", cursor:days>0||hours>0?"pointer":"default"}}
                        onClick={()=>{if(days>0||hours>0){setSelMonth(m);setMode("monthly");}}}>
                        {days>0&&<span>{days}일</span>}
                        {hours>0&&<span style={{color:"#7c3aed"}}>{days>0?" ":""}{hours}h</span>}
                        {days===0&&hours===0&&<span>-</span>}
                      </td>
                    ))}
                    <td style={{...sTD, fontWeight:800, color:"#dc2626", minWidth:70}}>
                      {totalDays>0&&<span>{totalDays}일</span>}
                      {totalHours>0&&<span style={{color:"#7c3aed"}}>{totalDays>0?" ":""}{totalHours}h</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    );
  }

  // 월별 상세 뷰
  const mDocs = approved.filter(([,d]) => (d.formData?.fromDate||"").startsWith(selMonth));
  const mSummary = {};
  for (const [id, doc] of mDocs) {
    const fd = doc.formData || {};
    const name = fd.name || doc.authorName || "?";
    const dept = fd.department || "";
    const ltype = fd.leaveType || "기타";
    const amt = calcLeave(fd);
    if (!mSummary[name]) mSummary[name] = { dept, types:{}, docs:[] };
    mSummary[name].types[ltype] = (mSummary[name].types[ltype]||0) + amt;
    mSummary[name].docs.push([id, doc]);
  }
  const mNames = Object.keys(mSummary).sort();
  return (
    <div>
      <NavBar />
      {mNames.length === 0 ? (
        <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8" }}>{selMonth} 승인된 휴가 신청이 없습니다.</div>
      ) : (
        <div style={{ overflowX:"auto" }}>
        <table style={{ borderCollapse:"collapse", fontSize:12, width:"100%" }}>
          <thead>
            <tr>
              <th style={{...sTH, textAlign:"left", minWidth:70}}>이름</th>
              <th style={{...sTH, minWidth:55}}>부서</th>
              {LEAVE_COLS.map(t=><th key={t} style={sTH}>{t==="연차휴가"?"연차":t==="반차휴가"?"반차(h)":t==="생리휴가"?"생리":t==="병가"?"병가":"기타"}</th>)}
              <th style={sTH}>합계</th>
              <th style={{...sTH, minWidth:120}}>신청 내역</th>
            </tr>
          </thead>
          <tbody>
            {mNames.map(name => {
              const p = mSummary[name];
              const totalDays = LEAVE_COLS.filter(t=>t!=="반차휴가").reduce((s,t)=>s+(p.types[t]||0),0);
              const totalHours = p.types["반차휴가"]||0;
              return (
                <tr key={name}>
                  <td style={{...sTDL, fontWeight:700}}>{name}</td>
                  <td style={{...sTD, color:"#64748b", fontSize:11}}>{p.dept}</td>
                  {LEAVE_COLS.map(t=>{
                    const v = p.types[t]||0;
                    const isHalf = t==="반차휴가";
                    return <td key={t} style={{...sTD, color:v>0?"#0369a1":"#94a3b8"}}>{v>0?`${v}${isHalf?"h":"일"}`:"-"}</td>;
                  })}
                  <td style={{...sTD, fontWeight:800, color:"#dc2626"}}>
                    {totalDays>0&&<span>{totalDays}일</span>}
                    {totalHours>0&&<span style={{color:"#7c3aed"}}>{totalDays>0?" ":""}{totalHours}h</span>}
                  </td>
                  <td style={sTD}>
                    {p.docs.map(([id,doc])=>{
                      const fd = doc.formData||{};
                      const label = fd.fromDate && fd.toDate && fd.fromDate!==fd.toDate
                        ? `${fd.fromDate}~${fd.toDate.slice(5)}`
                        : fd.fromDate||"-";
                      return (
                        <button key={id} onClick={()=>onOpenDoc(id)} style={{border:"1px solid #bae6fd",background:"#f0f9ff",color:"#0369a1",borderRadius:5,padding:"2px 7px",fontSize:11,cursor:"pointer",margin:"1px",display:"block",width:"max-content"}}>
                          {label} ({fd.leaveType||"-"})
                        </button>
                      );
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
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
  // 탭 월 네비게이션
  const nowYM = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; })();
  const [weeklyNavMonth,  setWeeklyNavMonth]  = useState(nowYM);
  const [refundNavMonth,  setRefundNavMonth]  = useState(nowYM);
  const [taxNavMonth,     setTaxNavMonth]     = useState(nowYM);
  const [supplyNavMonth,  setSupplyNavMonth]  = useState(nowYM);

  // 결재 액션
  const [rejectModal, setRejectModal] = useState(null); // { docId }
  const [rejectMemo,  setRejectMemo]  = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // 새 문서 작성 / 임시저장 편집
  const [formData,     setFormData]     = useState({});
  const [files,        setFiles]        = useState([]);
  const [tempDocId]                     = useState(uid7());
  const [saving,       setSaving]       = useState(false);
  const [newMenuOpen,  setNewMenuOpen]  = useState(false);

  // 모바일 반응형
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen]   = useState(false);
  const [editDocId,  setEditDocId]  = useState(null); // 임시저장 편집 중인 docId

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
  const pendingApprovalDocs = Object.entries(docs).filter(([,d]) => d.currentApproverUid === user?.uid && !["approved","final","rejected"].includes(d.status));
  // 내가 참조(CC)로 받은 미확인 문서
  const pendingCcDocs = Object.entries(docs).filter(([,d]) => d.cc?.some(c => c.uid === user?.uid && !c.checkedAt));
  // 결재 대기 (결재 + CC 합산)
  const pendingDocs = [...pendingApprovalDocs, ...pendingCcDocs.filter(([id]) => !pendingApprovalDocs.some(([pid]) => pid === id))];
  // 내가 작성한 문서
  const myDocs = Object.entries(docs).filter(([,d]) => d.authorUid === user?.uid);
  // 병원장용: 전체 결재 대기
  const allPendingDocs = Object.entries(docs).filter(([,d]) => !["approved","final","rejected","draft"].includes(d.status));

  const selectedDoc = selectedId ? docs[selectedId] : null;

  // 결재 라우팅: 제출 시 다음 결재자 uid 찾기
  const findNextApprover = (type, authorRole, authorDept) => {
    if (authorRole === "staff") {
      // 같은 부서 부서장 찾기 (기타/부서 없으면 부서장 없으므로 병원장으로 직행)
      const dh = Object.values(allUsers).find(u=>u.role==="dept_head"&&u.department===authorDept);
      if (dh) return { uid: dh.uid, status: "pending_dept" };
    }
    // 부서장/병원장이 제출하거나 부서장 없으면 바로 병원장 결재
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
      setView("list"); setNewType(null); setFormData({}); setFiles([]);
      alert(asDraft ? "임시저장 완료" : "제출 완료");
    } catch(e) { alert("오류: "+e.message); }
    setSaving(false);
  };

  // 물품청구서 승인 시 해당 월 세금계산서에 자동 반영
  const addSupplyToTax = async (supplyDoc) => {
    const now = new Date();
    const approvalMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    const approvalDateStr = `${now.getMonth()+1}/${now.getDate()}`;
    const dept = supplyDoc.formData?.department || "";
    const docNum = supplyDoc.docNumber || "";

    const total = (supplyDoc.formData?.items||[])
      .reduce((s, it) => s + (Number(it.qty)||0) * (Number(it.price)||0), 0);

    if (total === 0) return;

    const supplyTitle = supplyDoc.formData?.title || "";
    const groupMeta = [dept, docNum].filter(Boolean).join(" · ");
    const groupName = groupMeta ? `물품청구서 (${groupMeta})` : "물품청구서";
    const itemContent = supplyTitle || (groupMeta ? `물품청구 (${groupMeta})` : "물품청구");

    const newItems = [{
      id: uid7(),
      category: "물품비",
      vendor: "",
      content: itemContent,
      amount: String(total),
      method: "계좌",
      issueDate: approvalDateStr,
      count: "1",
      note: [dept && `[${dept}]`, docNum].filter(Boolean).join(" "),
    }];

    const newGroup = { name: groupName, items: newItems };

    // 해당 월 세금계산서 탐색 (draft 우선, 없으면 최신)
    const taxEntries = Object.entries(docs)
      .filter(([,d]) => d.type === "tax" && d.formData?.reportMonth === approvalMonth)
      .sort((a,b) => b[1].updatedAt - a[1].updatedAt);

    if (taxEntries.length > 0) {
      const [taxId, taxDoc] = taxEntries.find(([,d]) => d.status === "draft") || taxEntries[0];
      const updatedGroups = [...(taxDoc.formData?.groups||[]), newGroup];
      await update(ref(db, `approvals/${taxId}`), {
        "formData/groups": updatedGroups,
        updatedAt: Date.now(),
      });
      const statusLabel = taxDoc.status === "draft" ? "임시저장" : taxDoc.status === "approved" ? "승인됨" : taxDoc.status === "final" ? "전결" : "진행중";
      alert(`✅ ${approvalMonth} 세금계산서(${statusLabel})에 "${itemContent}" 항목이 추가되었습니다.`);
    } else {
      // 해당 월 세금계산서 없으면 draft로 신규 생성
      const docNumber = await getNextDocNumber("tax");
      const newDocRef = push(ref(db, "approvals"));
      await set(newDocRef, {
        docNumber, type: "tax", title: DOC_TYPES.tax.label,
        authorUid: user.uid, authorName: profile.name, authorDept: profile.department,
        createdAt: Date.now(), updatedAt: Date.now(),
        status: "draft", currentApproverUid: null,
        formData: { reportMonth: approvalMonth, groups: [newGroup] },
        fileUrls: [],
        history: [{ action:"auto_created", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:`물품청구서(${docNum}) 승인으로 자동 생성` }],
      });
      alert(`✅ ${approvalMonth} 세금계산서가 없어 임시저장 문서를 새로 생성하고 "${itemContent}" 항목을 추가했습니다.`);
    }
  };

  // 위탁진료 환자 계좌정보를 환자 DB에 동기화 (기존 정보 없을 때만)
  const syncRefundPatientAccounts = async (formData) => {
    for (const p of (formData?.patients || [])) {
      if (!p.bankHolder && !p.accountNo) continue;
      if (p.patientDbId) {
        const snap = await get(ref(db, `patients/${p.patientDbId}`));
        const existing = snap.val() || {};
        if (!existing.bankHolder && !existing.accountNo) {
          await update(ref(db, `patients/${p.patientDbId}`), {
            bankHolder: p.bankHolder || "", bank: p.bank || "", accountNo: p.accountNo || "",
          });
        }
      } else if (p.name || p.chartNo) {
        const snap = await get(ref(db, "patients"));
        const all = snap.val() || {};
        const match = Object.entries(all).find(([, v]) =>
          (p.chartNo && v.internalId === p.chartNo) ||
          (p.name && v.name === p.name && !v.bankHolder && !v.accountNo)
        );
        if (match) {
          await update(ref(db, `patients/${match[0]}`), {
            bankHolder: p.bankHolder || "", bank: p.bank || "", accountNo: p.accountNo || "",
          });
        }
      }
    }
  };

  // 동월 동타입 기존 승인 문서를 "대체됨" 상태로 변경
  const supersedePreviousApproved = async (type, reportMonth, newDocId) => {
    const toSupersede = Object.entries(docs).filter(([id, d]) =>
      id !== newDocId &&
      d.type === type &&
      d.formData?.reportMonth === reportMonth &&
      ["approved", "final"].includes(d.status)
    );
    for (const [id] of toSupersede) {
      await update(ref(db, `approvals/${id}`), { status: "superseded", updatedAt: Date.now() });
    }
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
    // 물품청구서/휴가신청서 최종 승인 시 이인호·손정아에게 참조(CC) 전달
    if (["vacation","supply"].includes(doc.type) && ["approved","final"].includes(newStatus)) {
      const ccUsers = Object.values(allUsers).filter(u => u.name === "이인호" || u.name === "손정아");
      const cc = ccUsers.map(u => ({ uid: u.uid, name: u.name, checkedAt: null }));
      if (cc.length > 0) {
        await update(ref(db, `approvals/${docId}`), { cc });
      }
    }
    // 물품청구서가 최종 승인(approved/final)된 경우 세금계산서에 자동 반영
    if (doc.type === "supply" && (newStatus === "approved" || newStatus === "final")) {
      await addSupplyToTax(doc);
    }
    // 위탁진료/월간보고/세금계산서: 동월 기존 승인 문서 대체 + 계좌정보 DB 동기화
    if (["approved", "final"].includes(newStatus) && ["refund", "weekly", "tax"].includes(doc.type)) {
      const reportMonth = doc.formData?.reportMonth;
      if (reportMonth) {
        await supersedePreviousApproved(doc.type, reportMonth, docId);
      }
      if (doc.type === "refund") {
        await syncRefundPatientAccounts(doc.formData);
      }
    }
    // 수정본 최종 승인 시 원본 문서 삭제
    if (["approved", "final"].includes(newStatus) && doc.originalDocId) {
      await remove(ref(db, `approvals/${doc.originalDocId}`));
    }
    setActionLoading(false);
    alert(isFinal ? "전결 처리 완료" : "승인 완료");
  };

  const handleCcCheck = async (docId) => {
    const doc = docs[docId];
    const cc = (doc.cc || []).map(c =>
      c.uid === user.uid ? { ...c, checkedAt: Date.now() } : c
    );
    await update(ref(db, `approvals/${docId}`), { cc, updatedAt: Date.now() });
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
    const doc = docs[docId];
    setEditDocId(docId);
    setFormData(doc?.formData || {});
    setFiles(doc?.fileUrls || []);
    setView("edit");
  };

  // 승인된 휴가신청서 취소 신청 (결재 라인 재진행, 승인 시 원본 삭제)
  const handleCancelVacation = async (docId) => {
    const doc = docs[docId];
    if (!doc) return;
    if (!window.confirm("이 휴가 신청의 취소를 요청하시겠습니까?\n결재 승인 후 연차 현황에서 제외됩니다.")) return;
    const newDocRef = push(ref(db, "approvals"));
    const newDocId = newDocRef.key;
    await set(newDocRef, {
      type: doc.type,
      title: `[취소] ${doc.title || DOC_TYPES[doc.type]?.label || ""}`,
      authorUid: user.uid,
      authorName: profile.name,
      authorDept: profile.department,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "draft",
      currentApproverUid: null,
      formData: { ...doc.formData, cancelled: true },
      fileUrls: [],
      originalDocId: docId,
      history: [{ action:"cancel_requested", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:`${doc.docNumber||"승인 문서"} 취소 신청` }],
    });
    setSelectedId(newDocId);
    setView("detail");
  };

  // 승인된 문서 수정 재제출 (새 임시저장 문서 생성, 원본 ID 참조)
  const handleReviseApproved = async (docId) => {
    const doc = docs[docId];
    if (!doc) return;
    const newDocRef = push(ref(db, "approvals"));
    const newDocId = newDocRef.key;
    await set(newDocRef, {
      type: doc.type,
      title: doc.title || DOC_TYPES[doc.type]?.label || "",
      authorUid: user.uid,
      authorName: profile.name,
      authorDept: profile.department,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "draft",
      currentApproverUid: null,
      formData: doc.formData || {},
      fileUrls: doc.fileUrls || [],
      originalDocId: docId,
      history: [{ action:"revision_started", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:`${doc.docNumber||"승인 문서"} 수정본` }],
    });
    setEditDocId(newDocId);
    setFormData(doc.formData || {});
    setFiles(doc.fileUrls || []);
    setView("edit");
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

  // 임시저장 문서 수정 저장 (draft 유지)
  const handleUpdateDraft = async () => {
    if (!editDocId) return;
    setSaving(true);
    try {
      await update(ref(db, `approvals/${editDocId}`), { formData, fileUrls: files, updatedAt: Date.now() });
      alert("임시저장 완료");
      setView("detail");
    } catch(e) { alert("오류: " + e.message); }
    setSaving(false);
  };

  // 임시저장 문서 수정 후 제출
  const handleUpdateAndSubmit = async () => {
    if (!editDocId) return;
    setSaving(true);
    try {
      const doc = docs[editDocId];
      const docNumber = await getNextDocNumber(doc.type);
      const next = findNextApprover(doc.type, profile.role, profile.department);
      await update(ref(db, `approvals/${editDocId}`), {
        formData, fileUrls: files, updatedAt: Date.now(),
        docNumber, status: next?.status||"approved", currentApproverUid: next?.uid||null,
        history: [{ action:"submitted", byUid:user.uid, byName:profile.name, byRole:profile.role, at:Date.now(), memo:"" }],
      });
      setView("list"); setEditDocId(null); setFormData({}); setFiles([]);
      alert("제출 완료");
    } catch(e) { alert("오류: " + e.message); }
    setSaving(false);
  };

  // 임시저장 문서 삭제
  const handleDeleteDraft = async (docId) => {
    if (!window.confirm("이 임시저장 문서를 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.")) return;
    try {
      await remove(ref(db, `approvals/${docId}`));
      setView("list"); setSelectedId(null); setEditDocId(null);
      alert("삭제 완료");
    } catch(e) { alert("오류: " + e.message); }
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
          <div style={{ flex:1, fontWeight:800, fontSize: isMobile ? 14 : 16 }}>
            {isMobile ? "결재 상세" : "이우요양병원 결재 시스템"}
          </div>
          {!isMobile && <div style={{ fontSize:13, color:"#94a3b8" }}>{profile.name} · {profile.department}</div>}
        </header>
        <div style={{ ...S.main, padding: isMobile ? "14px 10px" : undefined }}>
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
                      {h.action==="submitted"?"제출":h.action==="approved"?"승인":h.action==="final"?"전결":h.action==="rejected"?"반려":h.action==="revision_started"?"수정본 생성":h.action==="cancel_requested"?"취소 신청":""}
                    </span>
                  </div>
                  {h.memo && <div style={{ fontSize:12, color: h.action==="revision_started"?"#92400e":"#dc2626", marginTop:2 }}>{h.action==="revision_started"?"원본":"반려 사유"}: {h.memo}</div>}
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:2 }}>{fmtTs(h.at)}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 참조(CC) */}
          {doc.cc && doc.cc.length > 0 && (
            <div style={S.card}>
              <div style={S.sectionTit}>참조</div>
              {doc.cc.map((c, i) => {
                const isMe = c.uid === user.uid;
                const checked = !!c.checkedAt;
                return (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 0", borderBottom:"1px solid #f1f5f9" }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", background: checked ? "#059669" : "#94a3b8", flexShrink:0 }} />
                    <div style={{ flex:1, fontSize:13, fontWeight:600 }}>{c.name}</div>
                    {checked ? (
                      <span style={{ fontSize:12, color:"#059669", fontWeight:700 }}>✓ 확인 {fmtTs(c.checkedAt).slice(0,10)}</span>
                    ) : isMe ? (
                      <button style={{ ...S.btnGreen, padding:"6px 14px", fontSize:12 }} onClick={() => handleCcCheck(selectedId)}>확인</button>
                    ) : (
                      <span style={{ fontSize:12, color:"#94a3b8" }}>미확인</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

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
          {/* 승인된 내 문서: 수정 재제출 / 취소 신청 */}
          {isMine && ["approved","final"].includes(doc.status) && !doc.formData?.cancelled && (
            <div style={{ ...S.card, display:"flex", gap:12, justifyContent:"center", alignItems:"center", flexWrap:"wrap" }}>
              <span style={{ fontSize:12, color:"#92400e" }}>수정본이 최종 승인되면 이 문서는 삭제됩니다.</span>
              <button style={{ background:"#fffbeb", color:"#92400e", border:"1.5px solid #fde68a", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" }}
                onClick={()=>handleReviseApproved(selectedId)}>
                ✏️ 수정 재제출
              </button>
              {doc.type === "vacation" && (
                <button style={{ background:"#fee2e2", color:"#dc2626", border:"1.5px solid #fca5a5", borderRadius:8, padding:"9px 20px", fontWeight:700, fontSize:13, cursor:"pointer" }}
                  onClick={()=>handleCancelVacation(selectedId)}>
                  ✕ 취소 신청
                </button>
              )}
            </div>
          )}
          {/* 임시저장 내 문서 — 취소 신청 */}
          {isMine && doc.status==="draft" && doc.formData?.cancelled && (
            <div style={{ ...S.card, display:"flex", flexDirection:"column", gap:10, alignItems:"center" }}>
              <div style={{ fontSize:13, color:"#dc2626", fontWeight:700, background:"#fee2e2", borderRadius:8, padding:"8px 16px", width:"100%", textAlign:"center" }}>
                ⚠️ 취소 신청 문서입니다. 제출하면 결재 후 기존 휴가가 연차 현황에서 제외됩니다.
              </div>
              <div style={{ display:"flex", gap:12 }}>
                <button style={S.btnPri} onClick={()=>handleDraftSubmit(selectedId)}>→ 취소 신청 제출</button>
                <button style={{ ...S.btnRed, background:"#fff1f2" }} onClick={()=>handleDeleteDraft(selectedId)}>🗑 취소 철회</button>
              </div>
            </div>
          )}
          {/* 임시저장 내 문서: 수정 / 제출 / 삭제 */}
          {isMine && doc.status==="draft" && !doc.formData?.cancelled && (
            <div style={{ ...S.card, display:"flex", gap:12, justifyContent:"center", flexWrap:"wrap" }}>
              <button style={{ ...S.btnSec, background:"#f0f9ff", color:"#0369a1", border:"1.5px solid #7dd3fc" }}
                onClick={()=>{
                  setEditDocId(selectedId);
                  setFormData(doc.formData || {});
                  setFiles(doc.fileUrls || []);
                  setView("edit");
                }}>
                ✏️ 수정
              </button>
              <button style={S.btnPri} onClick={()=>handleDraftSubmit(selectedId)}>→ 제출하기</button>
              <button style={{ ...S.btnRed, background:"#fff1f2" }}
                onClick={()=>handleDeleteDraft(selectedId)}>
                🗑 삭제
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── 편집/새문서 공통 변수 ────────────────────────────────────────────────────
  const editingDoc   = view === "edit" && editDocId ? docs[editDocId] : null;
  const editTypeInfo = editingDoc ? (DOC_TYPES[editingDoc.type] || DOC_TYPES.vacation) : null;
  const isRevision   = editingDoc ? !!editingDoc.originalDocId : false;
  const cancelEdit   = () => {
    if (isRevision) {
      if (window.confirm("수정 재제출을 취소하면 작성 중인 내용이 삭제됩니다. 취소하시겠습니까?")) {
        remove(ref(db, `approvals/${editDocId}`));
        setView("list"); setEditDocId(null); setFormData({}); setFiles([]);
      }
    } else {
      setView("detail"); setEditDocId(null);
    }
  };
  const newTypeInfo = newType ? DOC_TYPES[newType] : null;

  // ── 목록 뷰 ──────────────────────────────────────────────────────────────────
  const sortedDocs = (list) => [...list].sort(([,a],[,b])=>(b.createdAt||0)-(a.createdAt||0));

  // ── 탭별 열람 권한 ────────────────────────────────────────────────────────────
  const isDirector   = profile.role === "director";
  const isDeptHead   = profile.role === "dept_head";

  // vacation: 병원장 → 전체, 이인호/손정아 → 승인완료 전체(참조), 부서장 → 자기부서, 직원 → 본인만
  const canSeeVacationDoc = (d) => {
    if (isDirector) return true;
    if (profile.name === "이인호" || profile.name === "손정아") return ["approved","final"].includes(d.status) || d.authorUid === user.uid;
    if (isDeptHead) return d.authorDept === profile.department || d.authorUid === user.uid;
    return d.authorUid === user.uid;
  };
  // supply: 작성자·승인자만 열람, 이인호·손정아·원무과장은 승인완료 참조
  const canSeeSupplyDoc = (d) => {
    // 작성자
    if (d.authorUid === user.uid) return true;
    // 현재 결재 차례인 승인자
    if (d.currentApproverUid === user.uid) return true;
    // 이미 결재·반려한 승인자 (history 기준)
    if ((d.history||[]).some(h => h.byUid === user.uid && ["approved","final","rejected"].includes(h.action))) return true;
    // 참조인: 이인호·손정아·원무과장 → 승인완료 문서만
    const isCC = profile.name === "이인호" || profile.name === "손정아"
              || (isDeptHead && profile.department === "원무과");
    if (isCC) return ["approved","final"].includes(d.status);
    return false;
  };
  // 연차 현황 전체 보기 권한 (이인호·손정아·병원장)
  const canSeeAllVacation = isDirector || profile.name === "이인호" || profile.name === "손정아";
  // refund: 문경미·이인호·병원장만 탭 접근
  const canAccessRefund   = isDirector || profile.name === "이인호" || profile.name === "문경미";
  // weekly: 박기순·안지영·병원장만 탭 접근
  const canAccessWeekly   = isDirector || profile.name === "박기순" || profile.name === "안지영";
  // tax: 이인호·손정아·병원장만 탭 접근
  const canAccessTax      = isDirector || profile.name === "이인호" || profile.name === "손정아";
  // supply_summary: 이인호·손정아·병원장만
  const canSeeSupplySummary = isDirector || profile.name === "이인호" || profile.name === "손정아";

  // 타입별 문서 목록
  const allDocEntries  = Object.entries(docs);
  const vacationDocs   = allDocEntries.filter(([,d]) => d.type === "vacation");
  const supplyDocs     = allDocEntries.filter(([,d]) => d.type === "supply");
  const refundDocs     = allDocEntries.filter(([,d]) => d.type === "refund");
  const weeklyDocs     = allDocEntries.filter(([,d]) => d.type === "weekly");
  const taxDocs        = allDocEntries.filter(([,d]) => d.type === "tax");

  // 휴가신청서: 권한별 필터링
  const vacationDisplay = vacationDocs.filter(([,d]) => canSeeVacationDoc(d));

  // 물품청구서: 권한별 필터링
  const supplyDisplay = supplyDocs.filter(([,d]) => canSeeSupplyDoc(d));

  // 위탁진료: 권한자만 전체, 나머지는 본인것 (탭 자체는 권한자만 표시)
  const refundDisplay = refundDocs;

  // 세금계산서: 권한자만 표시
  const taxDisplay = taxDocs;

  // 월간보고 탭 네비게이션 헬퍼
  const prevMonth = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return m === 1 ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,"0")}`;
  };
  const nextMonth = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,"0")}`;
  };
  // 해당 월 문서 중 승인/전결 우선, 없으면 대체됨 제외한 최신, 그래도 없으면 첫 번째
  const findActiveDocForMonth = (typeDocs, month) => {
    const matching = typeDocs.filter(([,d]) => d.formData?.reportMonth === month);
    return matching.find(([,d]) => ["approved","final"].includes(d.status))
      || matching.find(([,d]) => d.status !== "superseded")
      || matching[0] || null;
  };
  const weeklyDocForMonth  = findActiveDocForMonth(weeklyDocs, weeklyNavMonth);
  const weeklyAllMonths    = [...new Set(weeklyDocs.map(([,d]) => d.formData?.reportMonth).filter(Boolean))].sort();
  const refundDocForMonth  = findActiveDocForMonth(refundDocs, refundNavMonth);
  const refundAllMonths    = [...new Set(refundDocs.map(([,d]) => d.formData?.reportMonth).filter(Boolean))].sort();
  const taxDocForMonth     = findActiveDocForMonth(taxDocs, taxNavMonth);
  const taxAllMonths       = [...new Set(taxDocs.map(([,d]) => d.formData?.reportMonth).filter(Boolean))].sort();
  const supplyAllMonths    = [...new Set(supplyDisplay.filter(([,d]) => ["approved","final"].includes(d.status)).map(([,d]) => d.formData?.requestDate?.slice(0,7)).filter(Boolean))].sort();
  const supplyDocGroups = supplyDocs
    .filter(([,d]) => ["approved","final"].includes(d.status) && (d.formData?.requestDate||"").slice(0,7) === supplyNavMonth)
    .sort(([,a],[,b]) => (a.formData?.requestDate||"").localeCompare(b.formData?.requestDate||""))
    .map(([id, d]) => {
      const items = (d.formData?.items||[]).filter(it => it.name);
      const total = items.reduce((s,it) => s + (Number(it.qty)||0)*(Number(it.price)||0), 0);
      return { docId:id, docNumber:d.docNumber||"", date:d.formData?.requestDate||"", department:d.formData?.department||"미입력", items, total };
    });
  const supplyGrandTotal = supplyDocGroups.reduce((s,g) => s + g.total, 0);
  const supplyDeptTotals = supplyDocGroups.reduce((acc,g) => { acc[g.department] = (acc[g.department]||0) + g.total; return acc; }, {});
  const supplyActiveDocs = sortedDocs(supplyDisplay.filter(([,d]) => !["approved","final","rejected","superseded"].includes(d.status)));
  const supplyApprovedForMonth = supplyDisplay
    .filter(([,d]) => ["approved","final"].includes(d.status) && (d.formData?.requestDate||"").slice(0,7) === supplyNavMonth)
    .sort(([,a],[,b]) => (a.formData?.requestDate||"").localeCompare(b.formData?.requestDate||""));

  const displayDocs = activeTab === "mine"     ? sortedDocs(myDocs)
    : activeTab === "pending"   ? sortedDocs([...pendingApprovalDocs, ...pendingCcDocs.filter(([id]) => !pendingApprovalDocs.some(([pid]) => pid === id))])
    : activeTab === "vacation"  ? sortedDocs(vacationDisplay)
    : activeTab === "supply"    ? sortedDocs(supplyDisplay)
    : activeTab === "refund"    ? sortedDocs(refundDisplay)
    : activeTab === "tax"       ? sortedDocs(taxDisplay)
    : sortedDocs(allPendingDocs);

  const navGroups = [
    {
      label: "내 업무",
      items: [
        { key:"mine",    label:"내 문서함", badge: myDocs.length,      badgeColor:"#64748b" },
        { key:"pending", label:"결재 대기", badge: pendingDocs.length, badgeColor:"#dc2626" },
      ],
    },
    {
      label: "문서함",
      items: [
        { key:"vacation",         label:"휴가신청서"   },
        { key:"vacation_summary", label:"연차 현황"    },
        { key:"supply",           label:"물품청구서"   },
        ...(canSeeSupplySummary ? [{ key:"supply_summary", label:"물품 합산"      }] : []),
        ...(canAccessRefund      ? [{ key:"refund",         label:"위탁진료 환불금" }] : []),
        ...(canAccessWeekly      ? [{ key:"weekly",         label:"영양팀 월간보고" }] : []),
        ...(canAccessTax         ? [{ key:"tax",            label:"세금계산서"     }] : []),
      ],
    },
    ...(isDirector ? [{
      label: "관리",
      items: [
        { key:"all", label:"전체 진행중", badge: allPendingDocs.length, badgeColor:"#f59e0b" },
        { key:"director_stats", label:"경영현황" },
      ],
    }] : []),
  ];

  return (
    <div style={S.page}>
      <header style={S.header}>
        {/* 모바일 햄버거 버튼 */}
        {isMobile && (
          <button onClick={()=>setSidebarOpen(o=>!o)}
            style={{ border:"none", background:"rgba(255,255,255,0.2)", color:"#fff", borderRadius:8, padding:"6px 10px", cursor:"pointer", fontSize:20, flexShrink:0, lineHeight:1 }}>
            ☰
          </button>
        )}
        <img src="/favicon.png" style={{ width:36, height:36, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
        <div style={{ fontWeight:800, fontSize: isMobile ? 14 : 17, flex:1 }}>
          {isMobile ? "전자결재" : "이우요양병원 결재 시스템"}
        </div>
        {!isMobile && (
          <div style={{ fontSize:13, background:"rgba(255,255,255,0.1)", borderRadius:8, padding:"4px 12px" }}>
            {profile.name} · {profile.department} · {profile.role==="director"?"병원장":profile.role==="dept_head"?"부서장":"직원"}
          </div>
        )}
      </header>
      <div style={{ display:"flex", flex:1, position:"relative" }}>

        {/* 모바일 백드롭 */}
        {isMobile && sidebarOpen && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:499 }}
            onClick={()=>setSidebarOpen(false)} />
        )}

        {/* ── 좌측 사이드바 ── */}
        <aside style={isMobile ? {
          width:175, background:"#fff", borderRight:"1px solid #e2e8f0",
          display:"flex", flexDirection:"column",
          position:"fixed", top:0, left: sidebarOpen ? 0 : -179, height:"100vh",
          overflowY:"auto", zIndex:500, transition:"left 0.25s ease",
          boxShadow: sidebarOpen ? "4px 0 20px rgba(0,0,0,0.18)" : "none",
        } : S.sidebar}>
          <div style={{ padding:"14px 12px 6px" }}>
            {isMobile && (
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <span style={{ fontWeight:800, fontSize:13, color:"#0f2744" }}>메뉴</span>
                <button onClick={()=>setSidebarOpen(false)}
                  style={{ border:"none", background:"none", cursor:"pointer", fontSize:18, color:"#94a3b8", padding:0 }}>✕</button>
              </div>
            )}
            <button
              style={{ ...S.btnPri, width:"100%", borderRadius:10, fontSize:14, padding:"11px 0", textAlign:"center", display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}
              onClick={()=>setNewMenuOpen(o=>!o)}>
              ＋ 새 문서 작성
              <span style={{ fontSize:10, opacity:0.8 }}>{newMenuOpen ? "▲" : "▼"}</span>
            </button>
            {newMenuOpen && (
              <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:2 }}>
                {Object.entries(DOC_TYPES).map(([key,t]) => (
                  <button key={key}
                    style={{ padding:"8px 12px", border:`1.5px solid ${t.color}33`, borderRadius:8, background:t.bg, color:t.color, cursor:"pointer", fontWeight:700, fontSize:12, textAlign:"left" }}
                    onClick={()=>{ setNewType(key); setFormData({}); setFiles([]); setView("new"); setNewMenuOpen(false); if(isMobile) setSidebarOpen(false); }}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {navGroups.map(group => (
            <div key={group.label}>
              <div style={S.navGroup}>{group.label}</div>
              {group.items.map(item => (
                <button key={item.key} style={S.navItem(activeTab===item.key)}
                  onClick={()=>{ setActiveTab(item.key); if(isMobile) setSidebarOpen(false); }}>
                  <span style={{ flex:1 }}>{item.label}</span>
                  {item.badge > 0 && (
                    <span style={{ fontSize:11, fontWeight:800, color:"#fff", background:item.badgeColor||"#94a3b8", borderRadius:10, padding:"1px 7px", minWidth:20, textAlign:"center", flexShrink:0 }}>
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </aside>

        {/* ── 우측 컨텐츠 영역 ── */}
        <main style={{ ...S.content, padding: isMobile ? "14px 12px" : "24px 20px" }}>
        {view === "list" && (pendingApprovalDocs.length > 0 || pendingCcDocs.length > 0) && (
          <div style={{ background:"#fef3c7", border:"1.5px solid #f59e0b", borderRadius:10, padding:"10px 16px", marginBottom:16, display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:16 }}>🔔</span>
            <span style={{ fontWeight:700, color:"#92400e", fontSize:13 }}>
              {pendingApprovalDocs.length > 0 && `결재 대기 ${pendingApprovalDocs.length}건`}
              {pendingApprovalDocs.length > 0 && pendingCcDocs.length > 0 && " · "}
              {pendingCcDocs.length > 0 && `참조 미확인 ${pendingCcDocs.length}건`}
            </span>
            <button onClick={()=>setActiveTab("pending")} style={{ marginLeft:"auto", border:"none", background:"#f59e0b", color:"#fff", borderRadius:7, padding:"4px 12px", cursor:"pointer", fontWeight:700, fontSize:12 }}>확인하기</button>
          </div>
        )}

        {/* ── 새 문서 작성 폼 ── */}
        {view === "new" && newTypeInfo && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
              <span style={S.badge(newTypeInfo.color, newTypeInfo.bg)}>{newTypeInfo.label}</span>
              <span style={{ fontWeight:800, fontSize:16, color:"#1e3a5f" }}>새 문서 작성</span>
              <button style={{ ...S.btnSec, marginLeft:"auto", fontSize:13 }}
                onClick={()=>{ setView("list"); setNewType(null); setFormData({}); setFiles([]); }}>
                ✕ 취소
              </button>
            </div>
            <div style={S.card}>
              <div style={{ ...S.sectionTit, color: newTypeInfo.color }}>{newTypeInfo.label}</div>
              {renderDocForm(newType, formData, setFormData, tempDocId, files, setFiles, false)}
            </div>
            <div style={{ display:"flex", gap:12, justifyContent:"flex-end", marginBottom:24 }}>
              <button style={S.btnSec} onClick={()=>handleSubmit(true)} disabled={saving}>임시저장</button>
              <button style={S.btnPri} onClick={()=>handleSubmit(false)} disabled={saving}>{saving?"처리 중...":"→ 제출하기"}</button>
            </div>
          </div>
        )}

        {/* ── 임시저장 편집 폼 ── */}
        {view === "edit" && editDocId && (
          editingDoc ? (
            <div>
              {isRevision ? (
                <div style={{ background:"#fff7ed", border:"1.5px solid #fb923c", borderRadius:10, padding:"10px 16px", marginBottom:12, fontSize:13, color:"#9a3412" }}>
                  🔄 승인된 문서의 수정본입니다. 수정 후 제출하면 기존 결재 라인을 다시 거치며, 최종 승인 시 원본 문서는 삭제됩니다.
                </div>
              ) : (
                <div style={{ background:"#fef9c3", border:"1.5px solid #fde047", borderRadius:10, padding:"10px 16px", marginBottom:12, fontSize:13, color:"#713f12" }}>
                  ✏️ 임시저장 문서를 수정 중입니다. 저장 후에도 임시저장 상태가 유지됩니다.
                </div>
              )}
              <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
                <span style={S.badge(editTypeInfo.color, editTypeInfo.bg)}>{editTypeInfo.label}</span>
                <span style={{ fontWeight:800, fontSize:16, color:"#1e3a5f" }}>{isRevision ? "수정 재제출" : "수정"}</span>
                <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{editingDoc.docNumber || "임시저장"} · {editingDoc.authorName}</span>
                <button style={{ ...S.btnSec, fontSize:13 }} onClick={cancelEdit}>← 취소</button>
              </div>
              <div style={S.card}>
                <div style={{ ...S.sectionTit, color: editTypeInfo.color }}>{editTypeInfo.label}</div>
                {renderDocForm(editingDoc.type, formData, setFormData, editDocId, files, setFiles, false)}
              </div>
              <div style={{ display:"flex", gap:10, justifyContent:"space-between", flexWrap:"wrap", marginBottom:24 }}>
                <button style={{ ...S.btnRed, background:"#fff1f2", fontSize:13 }}
                  onClick={()=>handleDeleteDraft(editDocId)} disabled={saving}>
                  🗑 삭제
                </button>
                <div style={{ display:"flex", gap:10 }}>
                  <button style={S.btnSec} onClick={handleUpdateDraft} disabled={saving}>{saving?"저장 중...":"💾 임시저장"}</button>
                  <button style={S.btnPri} onClick={handleUpdateAndSubmit} disabled={saving}>{saving?"처리 중...":"→ 제출하기"}</button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", padding:"60px 0", fontSize:15, color:"#94a3b8" }}>로딩 중...</div>
          )
        )}
        {view === "list" && (<>
        {/* 연차 현황 탭 */}
        {activeTab === "vacation_summary" && (
          <div style={S.card}>
            <div style={{ fontWeight:800, fontSize:15, color:"#0369a1", marginBottom:16 }}>
              {canSeeAllVacation ? "휴가 사용 현황 (전 직원 · 승인 완료 기준)" : "내 연차 사용 현황 (승인 완료 기준)"}
            </div>
            <VacationSummaryPanel
              docs={vacationDisplay}
              onOpenDoc={(id)=>{ setSelectedId(id); setView("detail"); }}
            />
          </div>
        )}

        {/* 물품 월간 합산 탭 */}
        {activeTab === "supply_summary" && canSeeSupplySummary && (
          <div style={S.card}>
            <div style={{ fontWeight:800, fontSize:15, color:"#10b981", marginBottom:16 }}>물품청구서 월간 합산 (승인 완료 기준)</div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <button style={{ border:"1.5px solid #6ee7b7", background:"#ecfdf5", color:"#065f46", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setSupplyNavMonth(prevMonth(supplyNavMonth))}>← 이전달</button>
              <input type="month" style={{ ...S.input, maxWidth:180, textAlign:"center", fontWeight:700, color:"#065f46", fontSize:15 }}
                value={supplyNavMonth} onChange={e=>setSupplyNavMonth(e.target.value)} />
              <button style={{ border:"1.5px solid #6ee7b7", background:"#ecfdf5", color:"#065f46", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setSupplyNavMonth(nextMonth(supplyNavMonth))} disabled={supplyNavMonth >= nowYM}>다음달 →</button>
            </div>
            {supplyDocGroups.length === 0 ? (
              <div style={{ textAlign:"center", color:"#94a3b8", padding:"32px 0", fontSize:14 }}>{supplyNavMonth} 승인된 물품청구서가 없습니다.</div>
            ) : (<>
              {/* 부서별 사용금액 + 총 합계 (상단 요약) */}
              <div style={{ background:"#f0fdf4", borderRadius:10, padding:"12px 16px", marginBottom:20, border:"1px solid #6ee7b7" }}>
                <div style={{ fontWeight:800, fontSize:13, color:"#065f46", marginBottom:8 }}>부서별 사용금액</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:"8px 24px", alignItems:"center" }}>
                  {Object.entries(supplyDeptTotals).sort(([,a],[,b])=>b-a).map(([dept,tot])=>(
                    <div key={dept} style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:12, color:"#64748b", fontWeight:600 }}>{dept}</span>
                      <span style={{ fontSize:13, fontWeight:700, color:"#065f46" }}>{fmtNum(tot)}원</span>
                    </div>
                  ))}
                  <div style={{ marginLeft:"auto", fontSize:15, fontWeight:800, color:"#065f46", borderLeft:"2px solid #6ee7b7", paddingLeft:16 }}>
                    총 사용금액 {fmtNum(supplyGrandTotal)}원
                  </div>
                </div>
              </div>
              {/* 세부 내역 */}
              <div style={{ fontWeight:700, fontSize:12, color:"#94a3b8", marginBottom:6 }}>세부 내역</div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, marginBottom:24 }}>
                <thead>
                  <tr>{["일자","부서","문서번호","품명","단위","수량","금액(원)"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {supplyDocGroups.map(g => g.items.length === 0
                    ? (<tr key={g.docId}>
                        <td style={{...S.td,textAlign:"center"}}>{g.date.slice(5).replace("-","/")}</td>
                        <td style={S.td}>{g.department}</td>
                        <td style={{...S.td,color:"#2563eb",cursor:"pointer",textDecoration:"underline"}} onClick={()=>{setSelectedId(g.docId);setView("detail");}}>{g.docNumber}</td>
                        <td colSpan={4} style={{...S.td,color:"#94a3b8"}}>품목 없음</td>
                      </tr>)
                    : g.items.map((it, idx) => {
                        const amt = (Number(it.qty)||0)*(Number(it.price)||0);
                        return (
                          <tr key={`${g.docId}-${idx}`} style={{ background: idx%2===0?"#f8fafc":"#fff" }}>
                            {idx===0 && <td rowSpan={g.items.length} style={{...S.td,verticalAlign:"middle",textAlign:"center",fontWeight:700,background:"#f0fdf4"}}>{g.date.slice(5).replace("-","/")}</td>}
                            {idx===0 && <td rowSpan={g.items.length} style={{...S.td,verticalAlign:"middle",textAlign:"center",background:"#f0fdf4"}}>{g.department}</td>}
                            {idx===0 && <td rowSpan={g.items.length} style={{...S.td,verticalAlign:"middle",textAlign:"center",color:"#2563eb",cursor:"pointer",textDecoration:"underline",background:"#f0fdf4"}} onClick={()=>{setSelectedId(g.docId);setView("detail");}}>{g.docNumber}</td>}
                            <td style={S.td}>{it.name}</td>
                            <td style={{...S.td,textAlign:"center"}}>{it.unit}</td>
                            <td style={{...S.td,textAlign:"center"}}>{it.qty}</td>
                            <td style={{...S.td,textAlign:"right"}}>{amt>0?fmtNum(amt):""}</td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </>)}
          </div>
        )}

        {/* 물품청구서 탭: 진행 중 + 월별 승인 목록 */}
        {activeTab === "supply" && supplyActiveDocs.length > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight:700, fontSize:13, color:"#0369a1", marginBottom:10 }}>진행 중인 문서</div>
            {supplyActiveDocs.map(([id, doc]) => {
              const isDraft = doc.status === "draft";
              const isMineDoc = doc.authorUid === user.uid;
              return (
                <div key={id}
                  style={{ ...S.docRow, ...(isDraft ? { background:"#fefce8", borderLeft:"3px solid #fde047" } : {}) }}
                  onClick={()=>{setSelectedId(id);setView("detail");}}
                  onMouseEnter={e=>e.currentTarget.style.background=isDraft?"#fef9c3":"#f8fafc"}
                  onMouseLeave={e=>e.currentTarget.style.background=isDraft?"#fefce8":"transparent"}>
                  <span style={{ fontFamily:"monospace", fontSize:12, color:isDraft?"#92400e":"#64748b", flexShrink:0, minWidth:110, fontStyle:isDraft?"italic":"normal" }}>
                    {doc.docNumber || "임시저장"}
                  </span>
                  <span style={{ fontWeight:600, fontSize:14, flex:1 }}>{doc.formData?.department || doc.authorName}</span>
                  <span style={{ fontSize:12, color:"#94a3b8", flexShrink:0 }}>{doc.formData?.requestDate || fmtTs(doc.updatedAt||doc.createdAt).slice(0,10)}</span>
                  <StatusBadge status={doc.status} />
                  {isDraft && isMineDoc && (
                    <div style={{ display:"flex", gap:4, flexShrink:0, marginLeft:4 }} onClick={e=>e.stopPropagation()}>
                      <button style={{ border:"1px solid #7dd3fc", background:"#f0f9ff", color:"#0369a1", borderRadius:6, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}
                        onClick={()=>{setSelectedId(id);setEditDocId(id);setFormData(doc.formData||{});setFiles(doc.fileUrls||[]);setView("edit");}}>수정</button>
                      <button style={{ border:"1px solid #fca5a5", background:"#fff1f2", color:"#dc2626", borderRadius:6, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}
                        onClick={()=>handleDeleteDraft(id)}>삭제</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {activeTab === "supply" && (
          <div style={S.card}>
            <div style={{ fontWeight:700, fontSize:13, color:"#065f46", marginBottom:12 }}>승인 완료 문서</div>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <button style={{ border:"1.5px solid #6ee7b7", background:"#ecfdf5", color:"#065f46", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setSupplyNavMonth(prevMonth(supplyNavMonth))}>← 이전달</button>
              <input type="month" style={{ ...S.input, maxWidth:180, textAlign:"center", fontWeight:700, color:"#065f46", fontSize:15 }}
                value={supplyNavMonth} onChange={e=>setSupplyNavMonth(e.target.value)} />
              <button style={{ border:"1.5px solid #6ee7b7", background:"#ecfdf5", color:"#065f46", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setSupplyNavMonth(nextMonth(supplyNavMonth))} disabled={supplyNavMonth >= nowYM}>다음달 →</button>
            </div>
            {supplyApprovedForMonth.length === 0 ? (
              <div style={{ textAlign:"center", padding:"24px 0", color:"#94a3b8", fontSize:14 }}>
                {supplyNavMonth} 승인된 물품청구서가 없습니다.
                {supplyAllMonths.length > 0 && (
                  <div style={{ fontSize:12, color:"#6ee7b7", marginTop:6 }}>
                    자료 있는 월: {supplyAllMonths.slice(-6).join(", ")}{supplyAllMonths.length>6?" 외 "+String(supplyAllMonths.length-6)+"건":""}
                  </div>
                )}
              </div>
            ) : (
              supplyApprovedForMonth.map(([id, doc]) => {
                const items = doc.formData?.items || [];
                const total = items.reduce((s,it)=>s+(Number(it.qty)||0)*(Number(it.price)||0),0);
                const titleLabel = doc.formData?.title?.trim()
                  || (items[0]?.name ? `${items[0].name}${items.length>1?" 외 "+(items.length-1)+"건":""}` : "");
                return (
                  <div key={id} style={S.docRow}
                    onClick={()=>{setSelectedId(id);setView("detail");}}
                    onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <span style={{ fontFamily:"monospace", fontSize:12, color:"#64748b", flexShrink:0, minWidth:110 }}>{doc.docNumber}</span>
                    <span style={{ fontWeight:600, fontSize:14, flex:2, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{titleLabel}</span>
                    <span style={{ fontSize:12, color:"#475569", flexShrink:0 }}>{doc.authorName}</span>
                    <span style={{ fontSize:12, color:"#475569", flexShrink:0 }}>{doc.formData?.department}</span>
                    <span style={{ fontSize:12, color:"#94a3b8", flexShrink:0 }}>{doc.formData?.requestDate}</span>
                    {total > 0 && <span style={{ fontSize:13, color:"#065f46", fontWeight:700, flexShrink:0 }}>{fmtNum(total)}원</span>}
                    <StatusBadge status={doc.status} />
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 위탁진료 환불금 탭: 월 네비게이터 + 인라인 표시 */}
        {activeTab === "refund" && (
          <div style={S.card}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <button style={{ border:"1.5px solid #fcd34d", background:"#fffbeb", color:"#b45309", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setRefundNavMonth(prevMonth(refundNavMonth))}>
                ← 이전달
              </button>
              <input type="month" style={{ ...S.input, maxWidth:180, textAlign:"center", fontWeight:700, color:"#92400e", fontSize:15 }}
                value={refundNavMonth} onChange={e=>setRefundNavMonth(e.target.value)} />
              <button style={{ border:"1.5px solid #fcd34d", background:"#fffbeb", color:"#b45309", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setRefundNavMonth(nextMonth(refundNavMonth))}
                disabled={refundNavMonth >= nowYM}>
                다음달 →
              </button>
              {refundDocForMonth && (
                <button style={{ marginLeft:"auto", ...S.btnSec, fontSize:12, padding:"5px 12px", background:"#fef3c7", color:"#92400e" }}
                  onClick={()=>{setSelectedId(refundDocForMonth[0]);setView("detail");}}>
                  상세 보기
                </button>
              )}
            </div>
            {refundDocForMonth ? (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span style={{ fontWeight:800, fontSize:15, color:"#92400e" }}>{refundNavMonth} 위탁진료 환불금</span>
                  <StatusBadge status={refundDocForMonth[1].status} />
                  <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{refundDocForMonth[1].authorName}</span>
                </div>
                {["approved","final"].includes(refundDocForMonth[1].status) && (() => {
                  const patients = refundDocForMonth[1].formData?.patients || [];
                  const grandTotal = patients.reduce((s,p)=>s+(p.treatments||[]).reduce((s2,t)=>s2+(Number(t.refundAmount)||0),0),0);
                  const patientTotals = patients.map(p=>({ name:p.name, total:(p.treatments||[]).reduce((s,t)=>s+(Number(t.refundAmount)||0),0) })).filter(p=>p.total>0);
                  if (grandTotal === 0) return null;
                  return (
                    <div style={{ background:"#fffbeb", borderRadius:10, padding:"12px 16px", marginBottom:16, border:"1px solid #fcd34d" }}>
                      <div style={{ fontWeight:800, fontSize:13, color:"#b45309", marginBottom:8 }}>환불금 합산</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 20px", alignItems:"center" }}>
                        {patientTotals.map((p,i)=>(
                          <div key={i} style={{ display:"flex", alignItems:"center", gap:5 }}>
                            <span style={{ fontSize:12, color:"#64748b" }}>{p.name}</span>
                            <span style={{ fontSize:13, fontWeight:700, color:"#b45309" }}>{fmtNum(p.total)}원</span>
                          </div>
                        ))}
                        <div style={{ marginLeft:"auto", fontSize:15, fontWeight:800, color:"#92400e", borderLeft:"2px solid #fcd34d", paddingLeft:16 }}>
                          총 환불금액 {fmtNum(grandTotal)}원
                        </div>
                      </div>
                    </div>
                  );
                })()}
                <RefundForm data={refundDocForMonth[1].formData} onChange={()=>{}} readonly={true} />
              </div>
            ) : (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8" }}>
                <div style={{ fontSize:15, marginBottom:8 }}>{refundNavMonth} 월 환불금 보고서가 없습니다.</div>
                {refundAllMonths.length > 0 && (
                  <div style={{ fontSize:12, color:"#fbbf24" }}>
                    자료 있는 월: {refundAllMonths.slice(-6).join(", ")}{refundAllMonths.length>6?" 외 "+String(refundAllMonths.length-6)+"건":""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 월간보고 탭: 월 네비게이터 + 인라인 표시 */}
        {activeTab === "weekly" && (
          <div style={S.card}>
            {/* 월 네비게이션 */}
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <button style={{ border:"1.5px solid #c4b5fd", background:"#f5f3ff", color:"#7c3aed", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setWeeklyNavMonth(prevMonth(weeklyNavMonth))}>
                ← 이전달
              </button>
              <input type="month" style={{ ...S.input, maxWidth:180, textAlign:"center", fontWeight:700, color:"#4c1d95", fontSize:15 }}
                value={weeklyNavMonth} onChange={e=>setWeeklyNavMonth(e.target.value)} />
              <button style={{ border:"1.5px solid #c4b5fd", background:"#f5f3ff", color:"#7c3aed", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setWeeklyNavMonth(nextMonth(weeklyNavMonth))}
                disabled={weeklyNavMonth >= nowYM}>
                다음달 →
              </button>
              {weeklyDocForMonth && (
                <button style={{ marginLeft:"auto", ...S.btnPurple, fontSize:12, padding:"5px 12px" }}
                  onClick={()=>{setSelectedId(weeklyDocForMonth[0]);setView("detail");}}>
                  상세 보기
                </button>
              )}
            </div>
            {/* 월 데이터 인라인 표시 */}
            {weeklyDocForMonth ? (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span style={{ fontWeight:800, fontSize:15, color:"#4c1d95" }}>{weeklyNavMonth} 월간보고</span>
                  <StatusBadge status={weeklyDocForMonth[1].status} />
                  <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{weeklyDocForMonth[1].authorName}</span>
                </div>
                <WeeklyForm data={weeklyDocForMonth[1].formData} onChange={()=>{}} readonly={true} />
              </div>
            ) : (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8" }}>
                <div style={{ fontSize:15, marginBottom:8 }}>{weeklyNavMonth} 월 보고서가 없습니다.</div>
                {weeklyAllMonths.length > 0 && (
                  <div style={{ fontSize:12, color:"#c4b5fd" }}>
                    자료 있는 월: {weeklyAllMonths.slice(0,6).join(", ")}{weeklyAllMonths.length>6?" 외 "+String(weeklyAllMonths.length-6)+"건":""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* 세금계산서 탭: 월 네비게이터 + 인라인 표시 */}
        {activeTab === "tax" && (
          <div style={S.card}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}>
              <button style={{ border:"1.5px solid #fca5a5", background:"#fff1f2", color:"#dc2626", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setTaxNavMonth(prevMonth(taxNavMonth))}>
                ← 이전달
              </button>
              <input type="month" style={{ ...S.input, maxWidth:180, textAlign:"center", fontWeight:700, color:"#991b1b", fontSize:15 }}
                value={taxNavMonth} onChange={e=>setTaxNavMonth(e.target.value)} />
              <button style={{ border:"1.5px solid #fca5a5", background:"#fff1f2", color:"#dc2626", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontWeight:700, fontSize:14 }}
                onClick={()=>setTaxNavMonth(nextMonth(taxNavMonth))}
                disabled={taxNavMonth >= nowYM}>
                다음달 →
              </button>
              {taxDocForMonth && (
                <button style={{ marginLeft:"auto", ...S.btnRed, fontSize:12, padding:"5px 12px", background:"#fee2e2" }}
                  onClick={()=>{setSelectedId(taxDocForMonth[0]);setView("detail");}}>
                  상세 보기
                </button>
              )}
            </div>
            {taxDocForMonth ? (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                  <span style={{ fontWeight:800, fontSize:15, color:"#991b1b" }}>{taxNavMonth} 세금계산서</span>
                  <StatusBadge status={taxDocForMonth[1].status} />
                  <span style={{ fontSize:12, color:"#94a3b8", marginLeft:"auto" }}>{taxDocForMonth[1].authorName}</span>
                </div>
                <TaxForm data={taxDocForMonth[1].formData} onChange={()=>{}} readonly={true} />
              </div>
            ) : (
              <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8" }}>
                <div style={{ fontSize:15, marginBottom:8 }}>{taxNavMonth} 월 세금계산서가 없습니다.</div>
                {taxAllMonths.length > 0 && (
                  <div style={{ fontSize:12, color:"#fca5a5" }}>
                    자료 있는 월: {taxAllMonths.slice(-6).join(", ")}{taxAllMonths.length>6?" 외 "+String(taxAllMonths.length-6)+"건":""}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab !== "weekly" && activeTab !== "refund" && activeTab !== "tax" && activeTab !== "vacation_summary" && activeTab !== "supply_summary" && activeTab !== "supply" && (
        <div style={S.card}>
          {displayDocs.length === 0 && (
            <div style={{ textAlign:"center", padding:"40px 0", color:"#94a3b8", fontSize:14 }}>
              {{ mine:"작성한 문서가 없습니다.", pending:"결재 대기 문서가 없습니다.", vacation:"휴가신청서 문서가 없습니다.", supply:"물품청구서 문서가 없습니다.", refund:"위탁진료 환불금 문서가 없습니다.", tax:"세금계산서 문서가 없습니다.", all:"진행 중인 문서가 없습니다." }[activeTab] || "문서가 없습니다."}
            </div>
          )}
          {displayDocs.map(([id, doc]) => {
            const t = DOC_TYPES[doc.type] || DOC_TYPES.vacation;
            const isDraft = doc.status === "draft";
            const isMineDoc = doc.authorUid === user.uid;
            return (
              <div key={id}
                style={{ ...S.docRow, ...(isDraft ? { background:"#fefce8", borderLeft:"3px solid #fde047" } : {}) }}
                onClick={()=>{setSelectedId(id);setView("detail");}}
                onMouseEnter={e=>e.currentTarget.style.background=isDraft?"#fef9c3":"#f8fafc"}
                onMouseLeave={e=>e.currentTarget.style.background=isDraft?"#fefce8":"transparent"}>
                <span style={{ fontFamily:"monospace", fontSize:12, color: isDraft?"#92400e":"#64748b", flexShrink:0, minWidth:110, fontStyle: isDraft?"italic":"normal" }}>
                  {doc.docNumber || "임시저장"}
                </span>
                <span style={S.badge(t.color, t.bg)}>{t.label}</span>
                {doc.formData?.cancelled && <span style={{ fontSize:10, fontWeight:700, color:"#dc2626", background:"#fee2e2", border:"1px solid #fca5a5", borderRadius:5, padding:"1px 6px", flexShrink:0 }}>취소신청</span>}
                {doc.originalDocId && !doc.formData?.cancelled && <span style={{ fontSize:10, fontWeight:700, color:"#92400e", background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:5, padding:"1px 6px", flexShrink:0 }}>수정본</span>}
                {doc.cc?.some(c => c.uid === user.uid && !c.checkedAt) && <span style={{ fontSize:10, fontWeight:700, color:"#0369a1", background:"#e0f2fe", border:"1px solid #7dd3fc", borderRadius:5, padding:"1px 6px", flexShrink:0 }}>참조 미확인</span>}
                <span style={{ fontWeight:600, fontSize:14, flex:1 }}>
                  {doc.authorName}
                  {doc.formData?.title && <span style={{ fontSize:12, color:"#475569", fontWeight:400, marginLeft:6 }}>— {doc.formData.title}</span>}
                </span>
                <span style={{ fontSize:12, color:"#94a3b8", flexShrink:0 }}>{fmtTs(doc.updatedAt||doc.createdAt).slice(0,10)}</span>
                <StatusBadge status={doc.status} />
                {/* 내 임시저장 문서: 빠른 수정/삭제 버튼 */}
                {isDraft && isMineDoc && (
                  <div style={{ display:"flex", gap:4, flexShrink:0, marginLeft:4 }} onClick={e=>e.stopPropagation()}>
                    <button
                      style={{ border:"1px solid #7dd3fc", background:"#f0f9ff", color:"#0369a1", borderRadius:6, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}
                      onClick={()=>{
                        setSelectedId(id);
                        setEditDocId(id);
                        setFormData(doc.formData || {});
                        setFiles(doc.fileUrls || []);
                        setView("edit");
                      }}>
                      수정
                    </button>
                    <button
                      style={{ border:"1px solid #fca5a5", background:"#fff1f2", color:"#dc2626", borderRadius:6, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}
                      onClick={()=>handleDeleteDraft(id)}>
                      삭제
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
        </>)}

        {/* ── 경영현황 (병원장 전용) ── */}
        {activeTab === "director_stats" && isDirector && (
          <DirectorStatsPanel />
        )}
        </main>
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

// ─── 경영현황 패널 (병원장 전용) ─────────────────────────────────────────────
function DirectorStatsPanel() {
  const thisYear = new Date().getFullYear();
  const thisMonth = new Date().getMonth() + 1;
  const [year, setYear] = useState(thisYear);
  const [occMonth, setOccMonth] = useState(thisMonth);
  const [revenue, setRevenue] = useState(null);
  const [occupancy, setOccupancy] = useState(null);
  const [loading, setLoading] = useState({ rev: false, occ: false });
  const [error, setError] = useState({});

  const fetchRevenue = async () => {
    setLoading(p => ({ ...p, rev: true }));
    setError(p => ({ ...p, rev: null }));
    try {
      const r = await fetch('/api/director-stats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revenue', year }),
      });
      if (!r.ok) throw new Error(await r.text());
      setRevenue(await r.json());
    } catch (e) { setError(p => ({ ...p, rev: e.message })); }
    setLoading(p => ({ ...p, rev: false }));
  };

  const fetchOccupancy = async () => {
    setLoading(p => ({ ...p, occ: true }));
    setError(p => ({ ...p, occ: null }));
    try {
      const r = await fetch('/api/director-stats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'occupancy', year, month: occMonth }),
      });
      if (!r.ok) throw new Error(await r.text());
      setOccupancy(await r.json());
    } catch (e) { setError(p => ({ ...p, occ: e.message })); }
    setLoading(p => ({ ...p, occ: false }));
  };

  useEffect(() => { fetchRevenue(); }, [year]);
  useEffect(() => { fetchOccupancy(); }, [year, occMonth]);

  const fmtAmt = (n) => n != null ? Math.round(n).toLocaleString() : '-';
  const fmtMan = (n) => n != null ? `${Math.round(n / 10000).toLocaleString()}만` : '-';

  // 월별 합산 데이터 생성
  const monthlyData = (() => {
    if (!revenue) return [];
    const map = {};
    for (let m = 1; m <= 12; m++) {
      const ym = `${year}${String(m).padStart(2, '0')}`;
      map[ym] = { month: m, inCovered: 0, inNonCovered: 0, inTotal: 0, outCovered: 0, outNonCovered: 0, outTotal: 0, grandTotal: 0 };
    }
    (revenue.inpatient || []).forEach(r => {
      if (map[r.ym]) { map[r.ym].inCovered = r.covered; map[r.ym].inNonCovered = r.nonCovered; map[r.ym].inTotal = r.total; }
    });
    (revenue.outpatient || []).forEach(r => {
      if (map[r.ym]) { map[r.ym].outCovered = r.covered; map[r.ym].outNonCovered = r.nonCovered; map[r.ym].outTotal = r.total; }
    });
    Object.values(map).forEach(r => { r.grandTotal = r.inTotal + r.outTotal; });
    return Object.values(map).sort((a, b) => a.month - b.month);
  })();

  const yearTotals = monthlyData.reduce((t, r) => ({
    inCovered: t.inCovered + r.inCovered, inNonCovered: t.inNonCovered + r.inNonCovered, inTotal: t.inTotal + r.inTotal,
    outCovered: t.outCovered + r.outCovered, outNonCovered: t.outNonCovered + r.outNonCovered, outTotal: t.outTotal + r.outTotal,
    grandTotal: t.grandTotal + r.grandTotal,
  }), { inCovered: 0, inNonCovered: 0, inTotal: 0, outCovered: 0, outNonCovered: 0, outTotal: 0, grandTotal: 0 });

  const DS = {
    card: { background:"#fff", borderRadius:14, padding:"20px 24px", boxShadow:"0 1px 6px rgba(0,0,0,0.06)", marginBottom:20 },
    sectionTitle: { fontSize:17, fontWeight:800, color:"#0f2744", marginBottom:14, display:"flex", alignItems:"center", gap:10 },
    table: { width:"100%", borderCollapse:"collapse", fontSize:13 },
    th: { background:"#0f2744", color:"#fff", padding:"9px 10px", fontWeight:700, textAlign:"center", whiteSpace:"nowrap", borderBottom:"2px solid #0f2744" },
    thSub: { background:"#1e3a5f", color:"#e2e8f0", padding:"7px 10px", fontWeight:600, textAlign:"center", fontSize:12, whiteSpace:"nowrap" },
    td: { padding:"8px 10px", borderBottom:"1px solid #f1f5f9", textAlign:"right", fontVariantNumeric:"tabular-nums" },
    tdLabel: { padding:"8px 10px", borderBottom:"1px solid #f1f5f9", textAlign:"center", fontWeight:700, color:"#374151" },
    totalRow: { background:"#f8fafc", fontWeight:800 },
    nav: { display:"flex", alignItems:"center", gap:8, marginLeft:"auto" },
    btnNav: { background:"#f1f5f9", border:"1px solid #e2e8f0", borderRadius:7, padding:"5px 14px", cursor:"pointer", fontSize:14, fontWeight:700 },
    select: { border:"1px solid #e2e8f0", borderRadius:7, padding:"5px 10px", fontSize:14, fontWeight:700, outline:"none" },
    barBg: { height:22, background:"#f1f5f9", borderRadius:4, overflow:"hidden", flex:1 },
    barFill: (pct) => ({ height:"100%", background: pct>=90?"#16a34a":pct>=70?"#0ea5e9":pct>=50?"#f59e0b":"#ef4444", width:`${Math.min(pct,100)}%`, borderRadius:4, transition:"width 0.3s" }),
  };

  return (
    <div>
      {/* ── 매출 현황 ── */}
      <div style={DS.card}>
        <div style={DS.sectionTitle}>
          <span>📊 월별 매출 현황</span>
          <div style={DS.nav}>
            <button style={DS.btnNav} onClick={() => setYear(y => y - 1)}>‹</button>
            <span style={{ fontSize:16, fontWeight:800, minWidth:60, textAlign:"center" }}>{year}년</span>
            <button style={DS.btnNav} onClick={() => setYear(y => y + 1)}>›</button>
          </div>
        </div>

        {loading.rev && <div style={{ color:"#64748b", padding:20, textAlign:"center" }}>매출 데이터 조회 중...</div>}
        {error.rev && <div style={{ color:"#dc2626", padding:12, background:"#fee2e2", borderRadius:8, fontSize:13, marginBottom:12 }}>⚠️ {error.rev}</div>}

        {revenue && !loading.rev && (
          <div style={{ overflowX:"auto" }}>
            <table style={DS.table}>
              <thead>
                <tr>
                  <th style={DS.th} rowSpan={2}>월</th>
                  <th style={DS.th} colSpan={3}>입원 매출</th>
                  {(revenue.outpatient || []).length > 0 && <th style={DS.th} colSpan={3}>외래 매출</th>}
                  <th style={DS.th} rowSpan={2}>합계</th>
                </tr>
                <tr>
                  <th style={DS.thSub}>급여</th>
                  <th style={DS.thSub}>비급여</th>
                  <th style={DS.thSub}>소계</th>
                  {(revenue.outpatient || []).length > 0 && <>
                    <th style={DS.thSub}>급여</th>
                    <th style={DS.thSub}>비급여</th>
                    <th style={DS.thSub}>소계</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {monthlyData.map(r => {
                  const isFuture = year === thisYear && r.month > thisMonth;
                  const isEmpty = r.inTotal === 0 && r.outTotal === 0;
                  return (
                    <tr key={r.month} style={{ opacity: isFuture ? 0.3 : 1 }}>
                      <td style={DS.tdLabel}>{r.month}월</td>
                      <td style={DS.td}>{isEmpty ? '-' : fmtAmt(r.inCovered)}</td>
                      <td style={DS.td}>{isEmpty ? '-' : fmtAmt(r.inNonCovered)}</td>
                      <td style={{ ...DS.td, fontWeight:700, color:"#0369a1" }}>{isEmpty ? '-' : fmtAmt(r.inTotal)}</td>
                      {(revenue.outpatient || []).length > 0 && <>
                        <td style={DS.td}>{isEmpty ? '-' : fmtAmt(r.outCovered)}</td>
                        <td style={DS.td}>{isEmpty ? '-' : fmtAmt(r.outNonCovered)}</td>
                        <td style={{ ...DS.td, fontWeight:700, color:"#7c3aed" }}>{isEmpty ? '-' : fmtAmt(r.outTotal)}</td>
                      </>}
                      <td style={{ ...DS.td, fontWeight:800, color:"#dc2626" }}>{isEmpty ? '-' : fmtAmt(r.grandTotal)}</td>
                    </tr>
                  );
                })}
                <tr style={DS.totalRow}>
                  <td style={{ ...DS.tdLabel, fontSize:14 }}>합계</td>
                  <td style={DS.td}>{fmtMan(yearTotals.inCovered)}</td>
                  <td style={DS.td}>{fmtMan(yearTotals.inNonCovered)}</td>
                  <td style={{ ...DS.td, fontWeight:800, color:"#0369a1", fontSize:14 }}>{fmtMan(yearTotals.inTotal)}</td>
                  {(revenue.outpatient || []).length > 0 && <>
                    <td style={DS.td}>{fmtMan(yearTotals.outCovered)}</td>
                    <td style={DS.td}>{fmtMan(yearTotals.outNonCovered)}</td>
                    <td style={{ ...DS.td, fontWeight:800, color:"#7c3aed", fontSize:14 }}>{fmtMan(yearTotals.outTotal)}</td>
                  </>}
                  <td style={{ ...DS.td, fontWeight:800, color:"#dc2626", fontSize:14 }}>{fmtMan(yearTotals.grandTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── 병상 가동률 ── */}
      <div style={DS.card}>
        <div style={DS.sectionTitle}>
          <span>🛏️ 일자별 병상 가동률</span>
          <div style={DS.nav}>
            <select style={DS.select} value={occMonth} onChange={e => setOccMonth(parseInt(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}월</option>
              ))}
            </select>
            <span style={{ fontSize:12, color:"#64748b" }}>총 {TOTAL_BEDS}병상</span>
          </div>
        </div>

        {loading.occ && <div style={{ color:"#64748b", padding:20, textAlign:"center" }}>가동률 데이터 조회 중...</div>}
        {error.occ && <div style={{ color:"#dc2626", padding:12, background:"#fee2e2", borderRadius:8, fontSize:13, marginBottom:12 }}>⚠️ {error.occ}</div>}

        {occupancy && !loading.occ && occupancy.daily && occupancy.daily.length > 0 && (
          <div style={{ overflowX:"auto" }}>
            <table style={DS.table}>
              <thead>
                <tr>
                  <th style={{ ...DS.th, width:70 }}>날짜</th>
                  <th style={{ ...DS.th, width:70 }}>재원</th>
                  <th style={{ ...DS.th, width:70 }}>가동률</th>
                  <th style={DS.th}>시각화</th>
                </tr>
              </thead>
              <tbody>
                {occupancy.daily.map(d => {
                  const day = parseInt(d.date.slice(6));
                  const dow = new Date(year, occMonth - 1, day).getDay();
                  const isSun = dow === 0;
                  const isSat = dow === 6;
                  return (
                    <tr key={d.date} style={{ background: isSun ? "#fff5f5" : isSat ? "#f0f0ff" : undefined }}>
                      <td style={{ ...DS.tdLabel, color: isSun ? "#dc2626" : isSat ? "#2563eb" : "#374151" }}>
                        {occMonth}/{day}
                      </td>
                      <td style={{ ...DS.td, textAlign:"center" }}>{d.occupied}/{d.total}</td>
                      <td style={{ ...DS.td, textAlign:"center", fontWeight:700,
                        color: d.rate >= 90 ? "#16a34a" : d.rate >= 70 ? "#0ea5e9" : d.rate >= 50 ? "#d97706" : "#dc2626" }}>
                        {d.rate}%
                      </td>
                      <td style={{ ...DS.td, padding:"8px 12px" }}>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <div style={DS.barBg}><div style={DS.barFill(d.rate)} /></div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={DS.totalRow}>
                  <td style={{ ...DS.tdLabel, fontSize:14 }}>평균</td>
                  <td style={{ ...DS.td, textAlign:"center" }}>
                    {Math.round(occupancy.daily.reduce((s, d) => s + d.occupied, 0) / occupancy.daily.length)}/{TOTAL_BEDS}
                  </td>
                  <td style={{ ...DS.td, textAlign:"center", fontWeight:800, fontSize:15,
                    color: (occupancy.daily.reduce((s, d) => s + d.rate, 0) / occupancy.daily.length) >= 70 ? "#16a34a" : "#d97706" }}>
                    {(occupancy.daily.reduce((s, d) => s + d.rate, 0) / occupancy.daily.length).toFixed(1)}%
                  </td>
                  <td style={DS.td}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <div style={DS.barBg}>
                        <div style={DS.barFill(occupancy.daily.reduce((s, d) => s + d.rate, 0) / occupancy.daily.length)} />
                      </div>
                    </div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {occupancy && !loading.occ && (!occupancy.daily || occupancy.daily.length === 0) && (
          <div style={{ color:"#94a3b8", fontSize:14, padding:20, textAlign:"center" }}>해당 월 데이터가 없습니다.</div>
        )}
      </div>
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

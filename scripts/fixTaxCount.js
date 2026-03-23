/**
 * 세금계산서 건수(count) 오류 수정 스크립트
 *
 * 문제: 발행일 셀에 여러 날짜가 기재된 항목인데 Excel의 '건' 컬럼을 1로 입력한 경우
 * 수정: 발행일 날짜 수 기반으로 자동 보정 (괄호 안 메모 제외)
 *
 * 사용법: node scripts/fixTaxCount.js [--dry-run]
 *   --dry-run  실제 수정 없이 변경 예정 내용만 출력
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx = require("xlsx");
const { initializeApp }   = require("firebase/app");
const { getDatabase, ref, get, update } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const DRY_RUN = process.argv.includes("--dry-run");

const firebaseConfig = {
  apiKey:      "AIzaSyAgr-alU71ZZj12S3MvCQKJQVdS6w-G3E4",
  authDomain:  "ewoo-hospital-ward.firebaseapp.com",
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
  projectId:   "ewoo-hospital-ward",
};
const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

const EXCEL_FILES = [
  { path: "C:/Users/junes/Desktop/전자세금계산서(2023년).xlsx",    year: 2023 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2024년).xlsx",    year: 2024 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2025년)(1).xlsx", year: 2025 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2026년).xlsx",    year: 2026 },
];

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function uid7() { return Math.random().toString(36).slice(2, 9); }
function parseNum(val) {
  if (val == null || val === "") return 0;
  const n = Number(String(val).replace(/[₩,\s]/g, ""));
  return isFinite(n) ? n : 0;
}
function parseCount(val) {
  if (!val) return "1";
  const m = String(val).match(/(\d+)/);
  return m ? m[1] : "1";
}
function countRealDates(issd) {
  if (!issd) return 1;
  const clean = String(issd).replace(/\([^)]*\)/g, " ");
  const m = clean.match(/\b\d{1,2}\/\d{1,2}\b/g);
  return m ? m.length : 1;
}
function resolveCount(cntRaw, issd) {
  if (cntRaw !== "1" || !issd) return cntRaw;
  const dateCount = countRealDates(issd);
  return dateCount > 1 ? String(dateCount) : cntRaw;
}
function cleanGroupName(raw) { return String(raw || "").replace(/\r\n/g, " ").trim(); }
function isNewFormatHeader(row) { const c0 = String(row[0] || "").trim(); return c0 === "구분" || c0 === "해당과"; }
function isLegacySection(row) { return String(row[0] || "").includes("그외") || String(row[0] || "").includes("기타 영수증"); }

function detectFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  for (const row of rows) {
    if (!row) continue;
    const j = row.map(c => String(c || "")).join(",");
    if (j.includes("업체명") && j.includes("일")) return "legacy";
    if (j.includes("구분") && j.includes("분류")) return j.includes("발행일") ? "new" : "new_no_date";
  }
  return "legacy";
}

// new 포맷 파싱 (resolveCount 적용)
function parseNewFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const groups = [];
  let curGroup = null, lastCategory = "", lastVendor = "", inLegacySection = false;

  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;
    if (isNewFormatHeader(row)) { inLegacySection = false; continue; }
    if (isLegacySection(row)) {
      inLegacySection = true;
      curGroup = { name: "기타영수증", items: [] };
      groups.push(curGroup);
      lastCategory = ""; lastVendor = "";
      continue;
    }
    if (inLegacySection) {
      if (String(row[0] || "").trim() === "일") continue;
      const dayNum = parseInt(String(row[0] || ""));
      if (dayNum >= 1 && dayNum <= 31) {
        const category  = String(row[1] || "").trim() || lastCategory;
        const vendor    = String(row[2] || "").trim() || lastVendor;
        const content   = String(row[3] || "").trim();
        const amount    = parseNum(row[4]);
        const method    = String(row[5] || "").trim() || "기타";
        const issueDate = String(row[6] || "").trim();
        const note      = String(row[7] || "").trim();
        if (category) lastCategory = category;
        if (vendor)   lastVendor   = vendor;
        if ((amount || content) && curGroup)
          curGroup.items.push({ id: uid7(), category, vendor, content, amount, method, issueDate, count: "1", note });
      }
      continue;
    }
    const c0raw = row[0];
    const c0    = c0raw != null ? cleanGroupName(c0raw) : null;
    const cat   = String(row[1] || "").trim();
    const vend  = String(row[2] || "").trim();
    const cont  = String(row[3] || "").trim();
    const amt   = parseNum(row[4]);
    const meth  = String(row[5] || "").trim();
    const issd  = String(row[6] || "").trim();
    const note  = String(row[7] || "").trim();
    const cnt   = resolveCount(parseCount(row[8]), issd);

    if (c0 !== null && c0 !== "") {
      curGroup = { name: c0, items: [] }; groups.push(curGroup);
      if (cat) lastCategory = cat;
      if (vend) lastVendor = vend;
    } else {
      if (cat) lastCategory = cat;
      if (vend) lastVendor = vend;
    }
    if (!curGroup) continue;

    const ec = cat || lastCategory;
    const ev = vend || lastVendor;
    if (!amt && !cont && !ev) continue;
    if (!amt && (cont === "월 결제분" || cont === "월분 결제건" || cont === "월 결제건")) continue;

    curGroup.items.push({ id: uid7(), category: ec, vendor: ev, content: cont, amount: amt, method: meth || "기타", issueDate: issd, count: cnt, note });
  }
  return groups.filter(g => g.items.length > 0);
}

// new_no_date 포맷 파싱 (발행일 없어서 resolveCount 불필요)
function parseNewNoDateFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const groups = [];
  let curGroup = null, lastCategory = "", lastVendor = "", inLegacySection = false;

  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;
    if (isNewFormatHeader(row)) { inLegacySection = false; continue; }
    if (isLegacySection(row)) {
      inLegacySection = true;
      curGroup = { name: "기타영수증", items: [] };
      groups.push(curGroup);
      lastCategory = ""; lastVendor = "";
      continue;
    }
    if (inLegacySection) {
      if (String(row[0] || "").trim() === "일") continue;
      const dayNum = parseInt(String(row[0] || ""));
      if (dayNum >= 1 && dayNum <= 31) {
        const category  = String(row[1] || "").trim() || lastCategory;
        const vendor    = String(row[2] || "").trim() || lastVendor;
        const content   = String(row[3] || "").trim();
        const amount    = parseNum(row[4]);
        const method    = String(row[5] || "").trim() || "기타";
        const note      = String(row[6] || "").trim();
        if (category) lastCategory = category;
        if (vendor)   lastVendor   = vendor;
        if ((amount || content) && curGroup)
          curGroup.items.push({ id: uid7(), category, vendor, content, amount, method, issueDate: `${dayNum}일`, count: "1", note });
      }
      continue;
    }
    const c0raw = row[0];
    const c0    = c0raw != null ? cleanGroupName(c0raw) : null;
    const cat   = String(row[1] || "").trim();
    const vend  = String(row[2] || "").trim();
    const cont  = String(row[3] || "").trim();
    const amt   = parseNum(row[4]);
    const meth  = String(row[5] || "").trim();
    const note  = String(row[6] || "").trim();
    const cnt   = parseCount(row[7]);

    if (c0 !== null && c0 !== "") {
      curGroup = { name: c0, items: [] }; groups.push(curGroup);
      if (cat) lastCategory = cat;
      if (vend) lastVendor = vend;
    } else {
      if (cat) lastCategory = cat;
      if (vend) lastVendor = vend;
    }
    if (!curGroup) continue;
    const ec = cat || lastCategory;
    const ev = vend || lastVendor;
    if (!amt && !cont && !ev) continue;
    if (!amt && (cont === "월 결제분" || cont === "월분 결제건")) continue;

    curGroup.items.push({ id: uid7(), category: ec, vendor: ev, content: cont, amount: amt, method: meth || "기타", issueDate: "", count: cnt, note });
  }
  return groups.filter(g => g.items.length > 0);
}

// 전체 Excel 파싱 (new 포맷만, resolveCount 적용)
function parseAllExcel() {
  const result = {};
  for (const { path: fPath, year } of EXCEL_FILES) {
    let wb;
    try { wb = xlsx.readFile(fPath); } catch (e) { continue; }
    for (const shName of wb.SheetNames) {
      const m = shName.match(/^(\d{1,2})월/);
      if (!m) continue;
      const reportMonth = `${year}-${String(parseInt(m[1])).padStart(2, "0")}`;
      const ws  = wb.Sheets[shName];
      const fmt = detectFormat(ws);
      if (fmt === "legacy") continue;
      const groups = fmt === "new_no_date" ? parseNewNoDateFormat(ws) : parseNewFormat(ws);
      if (groups.length > 0) result[reportMonth] = groups;
    }
  }
  return result;
}

// ─── 메인 ───────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) console.log("🔍 DRY-RUN 모드 (실제 수정 없음)\n");

  await signInWithEmailAndPassword(auth, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  console.log("✅ Firebase 로그인 완료\n");

  // Firebase 세금계산서 전체 로드
  const snap = await get(ref(db, "approvals"));
  const fbDocs = {}; // reportMonth → { docId, groups }
  snap.forEach(child => {
    const d = child.val();
    if (d.type !== "tax" || !d.formData?.reportMonth) return;
    const mo = d.formData.reportMonth;
    // 같은 달 문서가 여러 개면 최신(updatedAt 기준)만
    if (!fbDocs[mo] || d.updatedAt > fbDocs[mo].updatedAt) {
      fbDocs[mo] = { docId: child.key, groups: d.formData.groups || [], updatedAt: d.updatedAt };
    }
  });

  const excelData = parseAllExcel();
  const months = Object.keys(excelData).sort();

  let totalFixed = 0;

  for (const month of months) {
    const exGroups = excelData[month];
    const fb = fbDocs[month];
    if (!fb) continue;

    const exItems = exGroups.flatMap(g => g.items);
    const fbGroups = fb.groups;
    const fbItems  = fbGroups.flatMap(g => g.items || []);

    // 아이템 수 불일치 시 스킵 (안전하게)
    if (exItems.length !== fbItems.length) {
      console.log(`⚠️  [${month}] 아이템 수 불일치 (Excel:${exItems.length} / FB:${fbItems.length}), 스킵`);
      continue;
    }

    // 인덱스 기준 count 비교
    const fixes = [];
    for (let i = 0; i < exItems.length; i++) {
      const newCount = exItems[i].count;
      const oldCount = String(fbItems[i].count || "1");
      if (newCount !== oldCount) {
        fixes.push({ i, vendor: exItems[i].vendor, content: exItems[i].content, oldCount, newCount });
      }
    }

    if (fixes.length === 0) continue;

    console.log(`[${month}] ${fixes.length}건 수정 필요:`);
    for (const f of fixes) {
      console.log(`  #${f.i + 1} ${f.vendor} | ${f.content} → ${f.oldCount}건 ➜ ${f.newCount}건`);
    }

    if (!DRY_RUN) {
      // 수정된 groups 배열 재구성 (fbGroups 구조 유지하면서 count만 갱신)
      let flatIdx = 0;
      const updatedGroups = fbGroups.map(g => ({
        ...g,
        items: (g.items || []).map(it => {
          const newCount = exItems[flatIdx] ? exItems[flatIdx].count : it.count;
          flatIdx++;
          return { ...it, count: newCount };
        }),
      }));

      await update(ref(db, `approvals/${fb.docId}`), {
        "formData/groups": updatedGroups,
        updatedAt: Date.now(),
      });
      console.log(`  ✅ Firebase 업데이트 완료`);
    }

    totalFixed += fixes.length;
  }

  console.log(`\n${ DRY_RUN ? "🔍 시뮬레이션" : "🎉 수정" } 완료: 총 ${totalFixed}건`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e); process.exit(1); });

/**
 * 세금계산서 건수 불일치 진단 스크립트
 * Excel(원본) vs Firebase(저장) 비교
 *
 * 사용법: node scripts/diagTaxCount.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx = require("xlsx");
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = {
  apiKey:      "AIzaSyAgr-alU71ZZj12S3MvCQKJQVdS6w-G3E4",
  authDomain:  "ewoo-hospital-ward.firebaseapp.com",
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
  projectId:   "ewoo-hospital-ward",
};
const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

const FILES = [
  { path: "C:/Users/junes/Desktop/전자세금계산서(2023년).xlsx", year: 2023 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2024년).xlsx", year: 2024 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2025년)(1).xlsx", year: 2025 },
  { path: "C:/Users/junes/Desktop/전자세금계산서(2026년).xlsx", year: 2026 },
];

function parseNum(val) {
  if (val == null || val === "") return 0;
  const n = Number(String(val).replace(/[₩,\s]/g, ""));
  return isFinite(n) ? n : 0;
}
function uid7() { return Math.random().toString(36).slice(2, 9); }
function parseCount(val) {
  if (!val) return "1";
  const m = String(val).match(/(\d+)/);
  return m ? m[1] : "1";
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

function parseNewFormat(ws, hasIssueDate) {
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
        const issueDate = hasIssueDate ? String(row[6] || "").trim() : `${dayNum}일`;
        const note      = hasIssueDate ? String(row[7] || "").trim() : String(row[6] || "").trim();
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
    const issd  = hasIssueDate ? String(row[6] || "").trim() : "";
    const note  = hasIssueDate ? String(row[7] || "").trim() : String(row[6] || "").trim();
    const cnt   = parseCount(hasIssueDate ? row[8] : row[7]);

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

// Excel에서 모든 월 파싱
function parseAllExcel() {
  const result = {};
  for (const { path: fPath, year } of FILES) {
    let wb;
    try { wb = xlsx.readFile(fPath); } catch (e) { continue; }
    for (const shName of wb.SheetNames) {
      const m = shName.match(/^(\d{1,2})월/);
      if (!m) continue;
      const monthNum = parseInt(m[1]);
      const reportMonth = `${year}-${String(monthNum).padStart(2, "0")}`;
      const ws = wb.Sheets[shName];
      const fmt = detectFormat(ws);
      if (fmt === "legacy") continue; // legacy는 건수 없음
      const groups = parseNewFormat(ws, fmt === "new");
      if (groups.length > 0) result[reportMonth] = groups;
    }
  }
  return result;
}

async function main() {
  await signInWithEmailAndPassword(auth, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

  // Firebase에서 세금계산서 문서 읽기
  const snap = await get(ref(db, "approvals"));
  const fbDocs = {}; // { reportMonth: { id, groups } }
  snap.forEach(child => {
    const d = child.val();
    if (d.type === "tax" && d.formData?.reportMonth) {
      fbDocs[d.formData.reportMonth] = { id: child.key, groups: d.formData.groups || [] };
    }
  });

  const excelData = parseAllExcel();
  const months = Object.keys(excelData).sort();

  let totalMismatch = 0;
  let totalItems = 0;

  for (const month of months) {
    const exGroups = excelData[month];
    const fb = fbDocs[month];
    if (!fb) { console.log(`[${month}] Firebase 문서 없음`); continue; }

    const fbGroups = fb.groups;

    // 그룹/아이템 수 비교
    const exItems = exGroups.flatMap(g => g.items);
    const fbItems = fbGroups.flatMap(g => g.items || []);
    totalItems += exItems.length;

    // 아이템 순서 기준으로 count 비교
    const len = Math.min(exItems.length, fbItems.length);
    const mismatches = [];
    for (let i = 0; i < len; i++) {
      const ex = exItems[i];
      const fb_it = fbItems[i];
      if (ex.count !== String(fb_it.count)) {
        mismatches.push({ i, vendor: ex.vendor, content: ex.content, exCount: ex.count, fbCount: String(fb_it.count) });
      }
    }

    if (mismatches.length > 0) {
      totalMismatch += mismatches.length;
      console.log(`\n[${month}] 불일치 ${mismatches.length}건 (전체 ${exItems.length}항목):`);
      for (const mm of mismatches.slice(0, 5)) {
        console.log(`  #${mm.i+1} ${mm.vendor} | ${mm.content} → Excel:${mm.exCount}건 / Firebase:${mm.fbCount}건`);
      }
      if (mismatches.length > 5) console.log(`  ... 외 ${mismatches.length - 5}건`);
    } else {
      // 아이템 수 차이 체크
      if (exItems.length !== fbItems.length) {
        console.log(`[${month}] 아이템 수 차이: Excel ${exItems.length}개 / Firebase ${fbItems.length}개`);
      }
    }
  }

  console.log(`\n═══ 진단 완료 ═══`);
  console.log(`검사 월: ${months.length}개 / 총 아이템: ${totalItems}개 / count 불일치: ${totalMismatch}건`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e); process.exit(1); });

/**
 * 세금계산서 기존 데이터 Firebase 가져오기 스크립트
 *
 * 사용법:
 *   node scripts/import-tax.js
 *
 * 처리 파일:
 *   - 전자세금계산서(2023년).xlsx  → 구형 포맷 (일/업체명/내용/금액/처리/비고)
 *   - 전자세금계산서(2024년).xlsx  → 신형 포맷 (구분/분류/업체/내용/금액/처리/발행일/비고/건)
 *   - 전자세금계산서(2025년)(1).xlsx
 *   - 전자세금계산서(2026년).xlsx
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx = require("xlsx");
const { initializeApp }   = require("firebase/app");
const { getDatabase, ref, push, set, get } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = require("../lib/firebasePublicConfig.json").ward;
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

function cleanGroupName(raw) {
  return String(raw || "").replace(/\r\n/g, " ").trim();
}

// ─── 헤더 행 판별 ─────────────────────────────────────────────────────────────
function isNewFormatHeader(row) {
  const c0 = String(row[0] || "").trim();
  return c0 === "구분" || c0 === "해당과";
}

function isLegacySection(row) {
  // "그외 기타 영수증" 섹션 시작
  return String(row[0] || "").includes("그외") || String(row[0] || "").includes("기타 영수증");
}

// ─── 2024/2025/2026 신형 포맷 파싱 ──────────────────────────────────────────
// col: 0=구분, 1=분류(category), 2=업체(vendor), 3=내용, 4=금액, 5=처리, 6=발행일, 7=비고, 8=건
function parseNewFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const groups = [];
  let curGroup = null;
  let lastCategory = "";
  let lastVendor   = "";
  let inLegacySection = false; // "그외 기타 영수증" 이후

  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;

    // 헤더 행 스킵 (구분/해당과)
    if (isNewFormatHeader(row)) {
      inLegacySection = false;
      continue;
    }

    // "그외 기타 영수증" 섹션 (일별 형태, 별도 파싱)
    if (isLegacySection(row)) {
      inLegacySection = true;
      curGroup = { name: "기타영수증", items: [] };
      groups.push(curGroup);
      lastCategory = ""; lastVendor = "";
      continue;
    }

    if (inLegacySection) {
      // 헤더 행 스킵 ("일" 컬럼)
      if (String(row[0] || "").trim() === "일") continue;
      // 날짜(숫자) 행의 경우
      const day = row[0];
      if (typeof day === "number" && day >= 1 && day <= 31) {
        const category  = String(row[1] || "").trim() || lastCategory;
        const vendor    = String(row[2] || "").trim() || lastVendor;
        const content   = String(row[3] || "").trim();
        const amount    = parseNum(row[4]);
        const method    = String(row[5] || "").trim() || "기타";
        const issueDate = String(row[6] || "").trim();
        const note      = String(row[7] || "").trim();
        if (category) lastCategory = category;
        if (vendor)   lastVendor   = vendor;
        if ((amount || content) && curGroup) {
          curGroup.items.push({ id: uid7(), category, vendor, content, amount, method, issueDate, count: "1", note });
        }
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

    // 새 그룹 시작
    if (c0 !== null && c0 !== "") {
      curGroup = { name: c0, items: [] };
      groups.push(curGroup);
      lastCategory = cat || lastCategory;
      lastVendor   = vend || lastVendor;
    } else {
      // 카테고리/업체 상속
      if (cat)  lastCategory = cat;
      if (vend) lastVendor   = vend;
    }

    if (!curGroup) continue;

    const effectiveCat  = cat  || lastCategory;
    const effectiveVend = vend || lastVendor;

    // 금액 없고 내용도 없으면 스킵
    if (!amt && !cont && !effectiveVend) continue;
    // "월 결제분" 단독 행 (금액 없음) 스킵
    if (!amt && (cont === "월 결제분" || cont === "월분 결제건" || cont === "월 결제건")) continue;

    curGroup.items.push({
      id:        uid7(),
      category:  effectiveCat,
      vendor:    effectiveVend,
      content:   cont,
      amount:    amt,
      method:    meth || "기타",
      issueDate: issd,
      count:     cnt,
      note,
    });
  }

  return groups.filter(g => g.items.length > 0);
}

// ─── 2023 구형 포맷 파싱 ─────────────────────────────────────────────────────
// col: 0=일, 1=업체명, 2=내용, 3=금액, 4=처리, 5=비고
function parseLegacyFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const items = [];

  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;
    // 헤더 행 스킵
    const c0 = String(row[0] || "").trim();
    if (c0 === "일" || c0.match(/^\d{4}\.\d{2}/)) continue;

    const day     = row[0];
    const vendor  = String(row[1] || "").trim();
    const content = String(row[2] || "").trim();
    const amount  = parseNum(row[3]);
    const method  = String(row[4] || "").trim() || "기타";
    const note    = String(row[5] || "").trim();

    // 날짜가 숫자가 아닌 경우 스킵 (합계 행 등)
    if (day !== null && typeof day !== "number") {
      if (!String(day).match(/^\d+$/)) continue;
    }
    if (!vendor && !content && !amount) continue;

    const issueDateStr = (typeof day === "number") ? `${day}일` : "";
    items.push({
      id:        uid7(),
      category:  "",
      vendor,
      content,
      amount,
      method,
      issueDate: issueDateStr,
      count:     "1",
      note,
    });
  }

  if (items.length === 0) return [];
  return [{ name: "전체", items }];
}

// ─── 시트 포맷 자동 감지 ─────────────────────────────────────────────────────
// 헤더 행을 스캔해서 포맷 결정
// - "일","업체명" → legacy (2023 1~2월)
// - "구분","분류" + "발행일" → new (2024+)
// - "구분","분류" + no "발행일" → new_no_date (2023 3~12월)
function detectFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  for (const row of rows) {
    if (!row) continue;
    const joined = row.map(c => String(c || "")).join(",");
    if (joined.includes("업체명") && joined.includes("일")) return "legacy";
    if (joined.includes("구분") && joined.includes("분류")) {
      // 헤더에 "발행일" 포함 여부
      return joined.includes("발행일") ? "new" : "new_no_date";
    }
  }
  return "legacy";
}

// ─── 2023 신형 포맷 (발행일 없음) 파싱 ───────────────────────────────────────
// col: 0=구분, 1=분류, 2=업체, 3=내용, 4=금액, 5=처리, 6=비고, 7=건
function parseNewNoDateFormat(ws) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const groups = [];
  let curGroup = null, lastCategory = "", lastVendor = "", inLegacySection = false;

  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;
    if (isNewFormatHeader(row)) { inLegacySection = false; continue; }

    // "그외 기타 영수증" 섹션 처리 (날짜 기반 별도 구조)
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
        if ((amount || content) && curGroup) {
          curGroup.items.push({ id: uid7(), category, vendor, content, amount, method, issueDate: `${dayNum}일`, count: "1", note });
        }
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
    const note  = String(row[6] || "").trim();  // 비고 col[6]
    const cnt   = parseCount(row[7]);            // 건 col[7]

    if (c0 !== null && c0 !== "") {
      curGroup = { name: c0, items: [] }; groups.push(curGroup);
      if (cat)  lastCategory = cat;
      if (vend) lastVendor   = vend;
    } else {
      if (cat)  lastCategory = cat;
      if (vend) lastVendor   = vend;
    }
    if (!curGroup) continue;

    const ec = cat  || lastCategory;
    const ev = vend || lastVendor;
    if (!amt && !cont && !ev) continue;
    if (!amt && (cont === "월 결제분" || cont === "월분 결제건")) continue;

    curGroup.items.push({
      id: uid7(), category: ec, vendor: ev, content: cont,
      amount: amt, method: meth || "기타", issueDate: "", count: cnt, note,
    });
  }
  return groups.filter(g => g.items.length > 0);
}

// ─── 전체 Excel 파싱 ────────────────────────────────────────────────────────
function parseAllFiles() {
  const monthlyData = {}; // { "2025-01": { reportMonth, groups } }

  for (const { path: fPath, year } of EXCEL_FILES) {
    let wb;
    try { wb = xlsx.readFile(fPath); }
    catch (e) { console.warn(`  파일 없음: ${fPath}`); continue; }

    for (const shName of wb.SheetNames) {
      // 시트명: "1월", "2월", ..., "12월"
      const m = shName.match(/^(\d{1,2})월/);
      if (!m) continue;
      const monthNum    = parseInt(m[1]);
      const reportMonth = `${year}-${String(monthNum).padStart(2, "0")}`;

      const ws     = wb.Sheets[shName];
      const fmt    = detectFormat(ws);
      const groups = fmt === "legacy"      ? parseLegacyFormat(ws)
                   : fmt === "new_no_date" ? parseNewNoDateFormat(ws)
                   :                         parseNewFormat(ws);

      if (groups.length === 0) {
        console.log(`  [${reportMonth}] 데이터 없음, 스킵`);
        continue;
      }
      monthlyData[reportMonth] = { reportMonth, groups };
    }
  }
  return monthlyData;
}

// ─── 기존 세금계산서 문서 확인 ────────────────────────────────────────────────
async function getExistingTaxMonths() {
  const snap = await get(ref(db, "approvals"));
  const existing = new Set();
  if (!snap.exists()) return existing;
  snap.forEach(child => {
    const d = child.val();
    if (d.type === "tax" && d.formData?.reportMonth) {
      existing.add(d.formData.reportMonth);
    }
  });
  return existing;
}

// ─── Firebase 저장 ──────────────────────────────────────────────────────────
async function saveTaxDoc(formData) {
  const { reportMonth, groups } = formData;
  const [y, mo] = reportMonth.split("-").map(Number);
  const createdAt  = new Date(y, mo - 1, 1).getTime();
  const grandTotal = (groups || []).reduce((s, g) =>
    s + (g.items || []).reduce((gs, it) => gs + (Number(it.amount) || 0), 0), 0);

  const doc = {
    docNumber:          `IMPORT-TAX-${reportMonth}`,
    type:               "tax",
    title:              "세금계산서 보고",
    authorUid:          "imported",
    authorName:         "손정아",
    authorDept:         "원무과",
    createdAt,
    updatedAt:          Date.now(),
    status:             "approved",
    currentApproverUid: null,
    formData:           { reportMonth, groups, grandTotal },
    fileUrls:           [],
    history: [
      { action: "submitted", byUid: "imported", byName: "손정아",           byRole: "staff",    at: createdAt,   memo: "" },
      { action: "approved",  byUid: "imported", byName: "(기존자료 가져오기)", byRole: "director", at: Date.now(), memo: "" },
    ],
  };

  const docRef = push(ref(db, "approvals"));
  await set(docRef, doc);
  return docRef.key;
}

// ─── 메인 ───────────────────────────────────────────────────────────────────
async function main() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) { console.error(".env에 ADMIN_EMAIL, ADMIN_PASSWORD 설정 필요"); process.exit(1); }

  console.log("🔐 Firebase 로그인 중...");
  await signInWithEmailAndPassword(auth, email, password);
  console.log("✅ 로그인 완료\n");

  console.log("📊 Excel 파일 파싱 중...");
  const monthlyData = parseAllFiles();
  const months = Object.keys(monthlyData).sort();
  console.log(`  → ${months.length}개월 데이터 파싱 완료 (${months[0]} ~ ${months[months.length - 1]})\n`);

  const existingMonths = await getExistingTaxMonths();
  console.log(`  → 기존 세금계산서 문서: ${existingMonths.size}건\n`);

  let imported = 0, skipped = 0;

  for (const month of months) {
    if (existingMonths.has(month)) {
      console.log(`  ⏭  ${month} → 이미 존재, 스킵`);
      skipped++;
      continue;
    }
    const fd = monthlyData[month];
    const total = (fd.groups || []).reduce((s, g) =>
      s + (g.items || []).reduce((gs, it) => gs + (Number(it.amount) || 0), 0), 0);
    const itemCount = (fd.groups || []).reduce((s, g) => s + (g.items || []).length, 0);

    await saveTaxDoc(fd);
    console.log(`  ✓ ${month}: ${fd.groups.length}개 구분 / ${itemCount}개 항목 / 합계 ${total.toLocaleString()}원`);
    imported++;
  }

  console.log(`\n🎉 완료!`);
  console.log(`  저장: ${imported}건 / 스킵(중복): ${skipped}건`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });

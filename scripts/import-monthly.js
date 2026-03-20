/**
 * 영양팀 월간보고 기존 데이터 Firebase 가져오기 스크립트
 *
 * 사용법:
 *   1. .env 파일에 ADMIN_EMAIL, ADMIN_PASSWORD 설정
 *   2. node scripts/import-monthly.js <엑셀파일경로>
 *   예: node scripts/import-monthly.js "D:/Download/2026.03.09~2026.03.15주간보고 (2).xlsx"
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx   = require("xlsx");
const { initializeApp }    = require("firebase/app");
const { getDatabase, ref, push, set, get } = require("firebase/database");
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

// ─── 유틸 ───────────────────────────────────────────────────────────────────
function parseNum(val) {
  if (val == null || val === "" || String(val).trim() === "-") return 0;
  const n = Number(String(val).replace(/[₩,\s]/g, ""));
  return isFinite(n) ? n : 0;
}

// ─── 연간 시트 컬럼 맵 (확인된 실제 인덱스) ─────────────────────────────────
// 2023: total=12, staff=14, patient=15, totalCount=16, perCap=17
// 2024: total=14, staff=16, patient=17, totalCount=18, perCap=19
// 2025/2026: total=13, staff=15, patient=16, totalCount=17, perCap=18
const ANNUAL_COL = {
  2023: { total:12, staff:14, patient:15, totalCount:16, perCap:17 },
  2024: { total:14, staff:16, patient:17, totalCount:18, perCap:19 },
  2025: { total:13, staff:15, patient:16, totalCount:17, perCap:18 },
  2026: { total:13, staff:15, patient:16, totalCount:17, perCap:18 },
};

// ─── 연간 시트 파싱 ──────────────────────────────────────────────────────────
function parseAnnualSheet(ws, year) {
  const col = ANNUAL_COL[year] || ANNUAL_COL[2025];
  const rows = xlsx.utils.sheet_to_json(ws, { header:1, defval:null });
  const records = [];

  for (const row of rows) {
    if (!row || !row[0]) continue;
    const m = String(row[0]).trim().match(/^(\d{1,2})월$/);
    if (!m) continue;
    const monthNum = parseInt(m[1]);

    const total = parseNum(row[col.total]);
    if (!total || total < 0) continue; // 데이터 없는 행 스킵

    const ecoFood  = parseNum(row[1]);
    const ecoSnack = parseNum(row[2]);
    // 기타 = 총합 - 에코식재 - 에코간식 (2023/2024는 에코만, 2025+는 에코+도준 합산)
    const knownCost = ecoFood + ecoSnack;
    const otherCost = Math.max(0, total - knownCost);

    const staff      = parseNum(row[col.staff]);
    const patient    = parseNum(row[col.patient]);
    const totalCount = parseNum(row[col.totalCount]) || (staff + patient);
    const perCapita  = parseNum(row[col.perCap]) || (totalCount > 0 ? Math.round(total / totalCount) : 0);

    records.push({
      reportMonth: `${year}-${String(monthNum).padStart(2,"0")}`,
      days: [],
      monthSummary: {
        ecoFood, ecoSnack,
        dojunFood: 0, dojunSnack: 0,
        otherCost, totalCost: total,
        staff, patient, totalCount,
        perCapita: Math.round(perCapita),
      },
      generalNote: "",
    });
  }
  return records;
}

// ─── 월간 시트 파싱 (일별 상세) ─────────────────────────────────────────────
// 시트 구조: 행0=월 제목, 행1=상위 헤더, 행2=하위 헤더, 행3+=일별 데이터
// col[0]=날짜, [1]=에코식재, [2]=에코간식, [3]=도준식재, [4]=도준간식,
// [5-14]=기타, [15]=총합계, [16]=직원, [17]=환우, [18]=총식수, [19]=1인식단가
function parseMonthlySheet(ws, sheetName) {
  const m = sheetName.match(/^(\d{2})\.(\d{1,2})/);
  if (!m) return null;
  const year  = 2000 + parseInt(m[1]);
  const month = parseInt(m[2]);
  const reportMonth = `${year}-${String(month).padStart(2,"0")}`;

  const rows = xlsx.utils.sheet_to_json(ws, { header:1, defval:null });
  const days = [];

  for (const row of rows) {
    if (!row || !row[0]) continue;
    const dateRaw = String(row[0]).trim();
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(dateRaw)) continue;

    const ecoFood    = parseNum(row[1]);
    const ecoSnack   = parseNum(row[2]);
    const dojunFood  = parseNum(row[3]);
    const dojunSnack = parseNum(row[4]);
    const otherCost  = [5,6,7,8,9,10,11,12,13,14].reduce((s,c) => s + parseNum(row[c]), 0);
    const staffCount   = parseNum(row[16]);
    const patientCount = parseNum(row[17]);

    days.push({
      date:         dateRaw,
      ecoFood:      ecoFood    || "",
      dojunFood:    dojunFood  || "",
      ecoSnack:     ecoSnack   || "",
      dojunSnack:   dojunSnack || "",
      otherCost:    otherCost  || "",
      staffCount:   staffCount   || "",
      patientCount: patientCount || "",
      note: "",
    });
  }

  if (days.length === 0) return null;

  // 월간 합계 계산
  const totalCost  = days.reduce((s,d) => s+(Number(d.ecoFood)||0)+(Number(d.dojunFood)||0)+(Number(d.ecoSnack)||0)+(Number(d.dojunSnack)||0)+(Number(d.otherCost)||0), 0);
  const staff      = days.reduce((s,d) => s+(Number(d.staffCount)||0), 0);
  const patient    = days.reduce((s,d) => s+(Number(d.patientCount)||0), 0);
  const totalCount = staff + patient;

  return {
    reportMonth,
    days,
    monthSummary: {
      ecoFood:    days.reduce((s,d) => s+(Number(d.ecoFood)||0),    0),
      ecoSnack:   days.reduce((s,d) => s+(Number(d.ecoSnack)||0),   0),
      dojunFood:  days.reduce((s,d) => s+(Number(d.dojunFood)||0),  0),
      dojunSnack: days.reduce((s,d) => s+(Number(d.dojunSnack)||0), 0),
      otherCost:  days.reduce((s,d) => s+(Number(d.otherCost)||0),  0),
      totalCost, staff, patient, totalCount,
      perCapita: totalCount > 0 ? Math.round(totalCost / totalCount) : 0,
    },
    generalNote: "",
  };
}

// ─── Firebase 저장 ──────────────────────────────────────────────────────────
async function importRecord(record, authorName) {
  const { reportMonth, days, monthSummary, generalNote } = record;
  const [y, mo] = reportMonth.split("-").map(Number);
  const createdAt = new Date(y, mo - 1, 1).getTime();

  const doc = {
    docNumber:  `IMPORT-${reportMonth}`,
    type:       "weekly",
    title:      "월간보고서(영양팀)",
    authorUid:  "imported",
    authorName: authorName || "박기순",
    authorDept: "영양팀",
    createdAt,
    updatedAt:  Date.now(),
    status:     "approved",
    currentApproverUid: null,
    formData:   { reportMonth, days, monthSummary, generalNote },
    fileUrls:   [],
    history: [
      { action:"submitted", byUid:"imported", byName: authorName||"박기순", byRole:"dept_head", at: createdAt, memo:"" },
      { action:"approved",  byUid:"imported", byName:"(기존자료 가져오기)", byRole:"director", at: Date.now(), memo:"" },
    ],
  };

  const docRef = push(ref(db, "approvals"));
  await set(docRef, doc);
  return docRef.key;
}

// ─── 기존 데이터 확인 ───────────────────────────────────────────────────────
async function getExistingMonths() {
  const snap = await get(ref(db, "approvals"));
  if (!snap.exists()) return new Set();
  const existing = new Set();
  snap.forEach(child => {
    const d = child.val();
    if (d.type === "weekly" && d.formData?.reportMonth) {
      existing.add(d.formData.reportMonth);
    }
  });
  return existing;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("사용법: node scripts/import-monthly.js <엑셀파일경로>");
    process.exit(1);
  }

  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.error(".env 파일에 ADMIN_EMAIL, ADMIN_PASSWORD를 설정하세요.");
    process.exit(1);
  }

  console.log("🔐 Firebase 로그인 중...");
  await signInWithEmailAndPassword(auth, email, password);
  console.log("✅ 로그인 완료\n");

  console.log("📋 기존 데이터 확인 중...");
  const existingMonths = await getExistingMonths();
  if (existingMonths.size > 0) {
    console.log(`  → 이미 ${existingMonths.size}개월 데이터 존재`);
  }

  console.log(`\n📊 엑셀 파일 읽는 중: ${xlsxPath}`);
  const wb = xlsx.readFile(xlsxPath);
  console.log(`시트 목록: ${wb.SheetNames.join(", ")}\n`);

  const records = [];

  // 연간 시트: "2023(※연간※)", "2024(※연간※)" 등
  for (const shName of wb.SheetNames) {
    const ym = shName.match(/^(\d{4})/);
    if (!ym) continue;
    const year = parseInt(ym[1]);
    if (!ANNUAL_COL[year]) continue;

    console.log(`📅 연간 시트: ${shName}`);
    const parsed = parseAnnualSheet(wb.Sheets[shName], year);
    console.log(`  → ${parsed.length}개월 파싱 완료`);
    records.push(...parsed);
  }

  // 월간 시트: "26.1(※월간※)", "26.2(※월간※)" 등
  for (const shName of wb.SheetNames) {
    if (!/^\d{2}\.\d/.test(shName)) continue;
    console.log(`📆 월간 시트: ${shName}`);
    const parsed = parseMonthlySheet(wb.Sheets[shName], shName);
    if (!parsed) { console.log(`  → 데이터 없음, 스킵`); continue; }
    console.log(`  → ${parsed.reportMonth} / ${parsed.days.length}일 일별 데이터`);

    // 월간 시트가 있으면 연간 요약보다 우선 (더 상세)
    const idx = records.findIndex(r => r.reportMonth === parsed.reportMonth);
    if (idx >= 0) {
      records[idx] = parsed;
      console.log(`  → 연간 요약 데이터를 일별 상세 데이터로 교체`);
    } else {
      records.push(parsed);
    }
  }

  records.sort((a, b) => a.reportMonth.localeCompare(b.reportMonth));
  console.log(`\n총 ${records.length}개월 데이터\n`);

  let imported = 0;
  let skipped  = 0;

  for (const record of records) {
    if (existingMonths.has(record.reportMonth)) {
      console.log(`  ⏭  ${record.reportMonth} → 이미 존재, 스킵`);
      skipped++;
      continue;
    }
    await importRecord(record);
    const tag = record.days.length > 0 ? `일별 ${record.days.length}일` : "월간 요약";
    console.log(`  ✓ ${record.reportMonth} (${tag}) 저장 완료`);
    imported++;
  }

  console.log(`\n🎉 완료! 저장 ${imported}건 / 스킵 ${skipped}건`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });

/**
 * 주간보고서 기존 데이터 Firebase 가져오기 스크립트
 *
 * 사용법:
 *   1. .env 파일에 ADMIN_EMAIL, ADMIN_PASSWORD 설정
 *   2. node scripts/import-weekly.js <엑셀파일경로>
 *   예: node scripts/import-weekly.js "D:/Download/2026.03.09~2026.03.15주간보고 (2).xlsx"
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx   = require("xlsx");
const { initializeApp }    = require("firebase/app");
const { getDatabase, ref, push, set } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = require("../lib/firebasePublicConfig.json").ward;

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

// ─── 유틸 ───────────────────────────────────────────────────────────────────
function parseKRW(val) {
  if (!val || val === "₩-" || val === " ₩- " || String(val).trim() === "-") return 0;
  return Number(String(val).replace(/[₩,\s]/g, "")) || 0;
}

// "2026.01.05" → "2026-01-05"
function dotDateToISO(s) {
  if (!s) return "";
  return String(s).replace(/\./g, "-").trim();
}

// "2026-01-05" → 요일(0=일~6=토)
function dayOfWeek(isoStr) {
  if (!isoStr) return -1;
  return new Date(isoStr).getDay();
}

// 해당 날짜의 ISO 주 월요일 구하기
function mondayOfWeek(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return null;
  const dow = d.getDay();           // 0=일, 1=월 ... 6=토
  const diff = (dow + 6) % 7;      // 월요일까지 거슬러 올라갈 일수
  d.setDate(d.getDate() - diff);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function sundayOfWeek(mondayISO) {
  const d = new Date(mondayISO);
  d.setDate(d.getDate() + 6);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// ─── Excel 파싱 ──────────────────────────────────────────────────────────────
function parseMonthlySheet(ws) {
  // 컬럼 순서:
  // 0:날짜 1:에코식재 2:에코간식 3:도준식재 4:도준간식
  // 5:현미유 6:사과식초 7:미온 8:동영방앗간 9:신길축산 10:사랑과정성 11:네이버주문
  // 12:초록마을 13:채소액 14:떡집 15:총합계 16:직원 17:환우 18:총식수 19:1인식단가
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const days = [];

  for (const row of rows) {
    if (!row || !row[0]) continue;
    const dateRaw = String(row[0]).trim();
    // "2026.01.01" 형식만 처리
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(dateRaw)) continue;

    const isoDate = dotDateToISO(dateRaw);
    const ecoFood    = parseKRW(row[1]);
    const ecoSnack   = parseKRW(row[2]);
    const dojunFood  = parseKRW(row[3]);
    const dojunSnack = parseKRW(row[4]);
    // 기타 현지구매 합계 (cols 5~14)
    const otherCost  = [5,6,7,8,9,10,11,12,13,14].reduce((s,c)=>s+parseKRW(row[c]),0);
    const staffCount   = Number(row[16]) || 0;
    const patientCount = Number(row[17]) || 0;

    days.push({ date: dateRaw, isoDate, ecoFood, ecoSnack, dojunFood, dojunSnack, otherCost, staffCount, patientCount, note: "" });
  }
  return days;
}

// ─── 일별 → 주별 그룹화 ────────────────────────────────────────────────────
function groupByWeek(days) {
  const weekMap = {};
  for (const d of days) {
    const mon = mondayOfWeek(d.isoDate);
    if (!mon) continue;
    if (!weekMap[mon]) weekMap[mon] = [];
    weekMap[mon].push(d);
  }

  const weeks = [];
  for (const [mon, wDays] of Object.entries(weekMap).sort()) {
    // 7일 슬롯을 채움
    const slots = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(mon); dt.setDate(dt.getDate() + i);
      const isoStr = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
      const dotStr = isoStr.replace(/-/g,".");
      const found = wDays.find(d => d.isoDate === isoStr);
      slots.push(found || { date: dotStr, isoDate: isoStr, ecoFood:0, ecoSnack:0, dojunFood:0, dojunSnack:0, otherCost:0, staffCount:0, patientCount:0, note:"" });
    }
    const sun = sundayOfWeek(mon);
    weeks.push({ weekFrom: mon, weekTo: sun, days: slots });
  }
  return weeks;
}

// ─── Firebase 저장 ──────────────────────────────────────────────────────────
async function importWeeks(weeks, authorName) {
  let count = 0;
  for (const w of weeks) {
    const formData = {
      weekFrom:    w.weekFrom,
      weekTo:      w.weekTo,
      days:        w.days.map(d => ({
        date:         d.date,
        ecoFood:      d.ecoFood || "",
        dojunFood:    d.dojunFood || "",
        ecoSnack:     d.ecoSnack || "",
        dojunSnack:   d.dojunSnack || "",
        otherCost:    d.otherCost || "",
        staffCount:   d.staffCount || "",
        patientCount: d.patientCount || "",
        note:         d.note || "",
      })),
      generalNote: "",
    };

    const doc = {
      docNumber:  `IMPORT-${w.weekFrom}`,
      type:       "weekly",
      title:      "주간보고서(영양팀)",
      authorUid:  "imported",
      authorName: authorName || "박기순",
      authorDept: "영양팀",
      createdAt:  new Date(w.weekFrom).getTime(),
      updatedAt:  Date.now(),
      status:     "approved",
      currentApproverUid: null,
      formData,
      fileUrls: [],
      history: [
        { action:"submitted", byUid:"imported", byName: authorName||"박기순", byRole:"dept_head", at: new Date(w.weekFrom).getTime(), memo:"" },
        { action:"approved",  byUid:"imported", byName:"(기존자료 가져오기)", byRole:"director", at: Date.now(), memo:"" },
      ],
    };

    const docRef = push(ref(db, "approvals"));
    await set(docRef, doc);
    count++;
    console.log(`  ✓ ${w.weekFrom} ~ ${w.weekTo} 저장 완료`);
  }
  return count;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("사용법: node scripts/import-weekly.js <엑셀파일경로>");
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

  console.log("📊 엑셀 파일 읽는 중:", xlsxPath);
  const wb = xlsx.readFile(xlsxPath);

  // 월간 시트만 처리 (※월간※ 포함 이름)
  const monthlySheets = wb.SheetNames.filter(n => n.includes("월간"));
  console.log(`월간 시트 ${monthlySheets.length}개 발견:`, monthlySheets.join(", "), "\n");

  let totalCount = 0;
  for (const shName of monthlySheets) {
    console.log(`📅 시트 처리 중: ${shName}`);
    const days  = parseMonthlySheet(wb.Sheets[shName]);
    const weeks = groupByWeek(days);
    console.log(`  → ${days.length}일 데이터, ${weeks.length}주로 그룹화`);
    const cnt = await importWeeks(weeks);
    totalCount += cnt;
  }

  console.log(`\n🎉 완료! 총 ${totalCount}건의 주간보고 데이터를 가져왔습니다.`);
  process.exit(0);
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });

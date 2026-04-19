/**
 * 위탁진료 환불금 기존 데이터 Firebase 가져오기 스크립트
 *
 * 사용법:
 *   node scripts/import-refund.js
 *
 * 처리 내용:
 *   1. 위탁진료 Excel 파일 파싱 → 월별 환불금 문서 생성
 *   2. 차트번호로 Firebase 환자 DB 매칭 → 계좌정보 업데이트
 *   3. 미매칭 차트번호 보고
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const xlsx = require("xlsx");
const { initializeApp }    = require("firebase/app");
const { getDatabase, ref, push, set, get, update } = require("firebase/database");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

const firebaseConfig = require("../lib/firebasePublicConfig.json").ward;

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

const EXCEL_FILES = [
  "C:/Users/junes/Desktop/위탁진료 20년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 21년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 22년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 23년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 24년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 25년.xlsx",
  "C:/Users/junes/Desktop/위탁진료 26년.xlsx",
];

// ─── 유틸 ───────────────────────────────────────────────────────────────────
function uid7() { return Math.random().toString(36).slice(2, 9); }

function parseNum(val) {
  if (val == null || val === "") return 0;
  const n = Number(String(val).replace(/[₩,\s]/g, ""));
  return isFinite(n) ? n : 0;
}

// Excel 날짜 시리얼 → ISO 문자열
function excelDateToISO(serial) {
  if (!serial || typeof serial !== "number" || serial < 1) return "";
  const utcMs = (serial - 25569) * 86400000;
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

// 이름에서 숫자 접미사 제거 ("박경희2" → "박경희")
function cleanName(name) {
  if (!name) return "";
  return String(name).replace(/\d+$/, "").trim();
}

// ─── 시트 파싱 ──────────────────────────────────────────────────────────────
function parseRefundSheet(ws, sheetName) {
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });

  // 헤더 행 찾기 + 컬럼 오프셋 감지 (2020.03은 진료의/면허번호 없음)
  let headerRowIdx = -1;
  let hasDocInfo = true; // 진료의/면허번호 컬럼 존재 여부

  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const r = rows[i];
    if (!r) continue;
    const joined = r.map(c => String(c||"")).join(",");
    if (joined.includes("CH.") && joined.includes("성함")) {
      headerRowIdx = i;
      // 예금주명이 col[8]에 있으면 진료의 컬럼 없는 구형
      hasDocInfo = !(String(r[8]||"").includes("예금주"));
      break;
    }
  }

  if (headerRowIdx < 0) return [];

  // 컬럼 인덱스
  // 공통: 0=CH, 1=성함, 2=날짜, 3=진료기관, 6=진료비총액, 7=환불금액
  // 신형(hasDocInfo): 8=진료의, 9=면허번호, 10=예금주명, 11=은행, 12=계좌번호, 13=연락처, 14=비고
  // 구형(!hasDocInfo): 8=예금주명, 9=은행, 10=계좌번호, 11=연락처, 12=비고
  const C = hasDocInfo
    ? { holder:10, bank:11, account:12, phone:13, note:14 }
    : { holder:8,  bank:9,  account:10, phone:11, note:12 };

  const patients = [];
  let cur = null;
  let lastDate = "";

  for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
    const row = rows[ri];
    if (!row) continue;

    // 합계/소계 행 스킵
    if (typeof row[0] === "string" && /합계|소계|총계/.test(row[0])) continue;

    const chartRaw = row[0];
    const nameRaw  = row[1];
    const dateRaw  = row[2];
    const inst     = String(row[3]||"").trim();
    const total    = parseNum(row[6]);
    const refund   = parseNum(row[7]);
    const holder   = String(row[C.holder]||"").trim();
    const bank     = String(row[C.bank]||"").trim();
    const account  = String(row[C.account]||"").trim();
    const phone    = String(row[C.phone]||"").trim();
    const note     = String(row[C.note]||"").trim();

    // 새 환자 블록 시작 (chartNo 있음)
    if (chartRaw !== null && chartRaw !== "") {
      if (cur) patients.push(cur);
      const isoDate = excelDateToISO(dateRaw);
      lastDate = isoDate || lastDate;
      cur = {
        id:           uid7(),
        chartNo:      String(chartRaw),
        name:         cleanName(nameRaw),
        phone,
        bankHolder:   holder,
        bank,
        accountNo:    account,
        patientDbId:  "",
        treatments:   [],
      };
      if (total || refund) {
        cur.treatments.push({ id:uid7(), date:isoDate||lastDate, institution:inst, totalCost:total, refundAmount:refund, note });
      }
    } else if (cur) {
      // 기존 환자의 추가 진료 행
      const isoDate = excelDateToISO(dateRaw) || lastDate;
      lastDate = isoDate;
      // 계좌정보 보완 (첫 행에 없으면 이후 행에서 채워지는 경우)
      if (!cur.bankHolder && holder) { cur.bankHolder = holder; cur.bank = bank; cur.accountNo = account; cur.phone = phone; }
      if ((total || refund) && inst) {
        cur.treatments.push({ id:uid7(), date:isoDate, institution:inst, totalCost:total, refundAmount:refund, note });
      }
    }
  }
  if (cur) patients.push(cur);

  // 치료 내역 없는 환자 제거 (0원짜리만 있는 경우도 유지)
  return patients.filter(p => p.treatments.length > 0);
}

// ─── 전체 Excel 파싱 ────────────────────────────────────────────────────────
function parseAllFiles() {
  const monthlyData = {}; // { "2026-01": [patients...], ... }

  for (const fPath of EXCEL_FILES) {
    let wb;
    try { wb = xlsx.readFile(fPath); }
    catch(e) { console.warn(`  파일 없음: ${fPath}`); continue; }

    for (const shName of wb.SheetNames) {
      // 시트명: "2026.01", "2020.03" 등
      const m = shName.match(/^(\d{4})\.(\d{1,2})$/);
      if (!m) continue;
      const reportMonth = `${m[1]}-${m[2].padStart(2,"0")}`;

      const patients = parseRefundSheet(wb.Sheets[shName], shName);
      if (patients.length === 0) continue;
      monthlyData[reportMonth] = patients;
    }
  }
  return monthlyData;
}

// ─── Firebase 환자 DB 로드 ───────────────────────────────────────────────────
async function loadFirebasePatients() {
  const snap = await get(ref(db, "patients"));
  if (!snap.exists()) return {};
  const map = {}; // { internalId: { key, ...data } }
  snap.forEach(child => {
    const d = child.val();
    if (d.internalId) map[String(d.internalId)] = { ...d, _key: child.key };
  });
  return map;
}

// ─── 기존 위탁진료 문서 확인 ────────────────────────────────────────────────
async function getExistingRefundMonths() {
  const snap = await get(ref(db, "approvals"));
  const existing = new Set();
  if (!snap.exists()) return existing;
  snap.forEach(child => {
    const d = child.val();
    if (d.type === "refund" && d.formData?.reportMonth) {
      existing.add(d.formData.reportMonth);
    }
  });
  return existing;
}

// ─── 환자 계좌정보 업데이트 ─────────────────────────────────────────────────
async function updatePatientBankInfo(patientKey, bankHolder, bank, accountNo) {
  await update(ref(db, `patients/${patientKey}`), { bankHolder, bank, accountNo });
}

// ─── Firebase 문서 저장 ─────────────────────────────────────────────────────
async function saveRefundDoc(reportMonth, patients) {
  const [y, mo] = reportMonth.split("-").map(Number);
  const createdAt = new Date(y, mo - 1, 1).getTime();
  const grandTotal = patients.reduce((s,p) => s + p.treatments.reduce((ts,t) => ts+(Number(t.refundAmount)||0), 0), 0);

  const doc = {
    docNumber:  `IMPORT-REF-${reportMonth}`,
    type:       "refund",
    title:      "위탁진료 환불금 보고",
    authorUid:  "imported",
    authorName: "문경미",
    authorDept: "원무과",
    createdAt,
    updatedAt:  Date.now(),
    status:     "approved",
    currentApproverUid: null,
    formData: { reportMonth, patients, grandTotal },
    fileUrls: [],
    history: [
      { action:"submitted", byUid:"imported", byName:"문경미", byRole:"staff",    at:createdAt, memo:"" },
      { action:"approved",  byUid:"imported", byName:"(기존자료 가져오기)", byRole:"director", at:Date.now(), memo:"" },
    ],
  };

  const docRef = push(ref(db, "approvals"));
  await set(docRef, doc);
  return docRef.key;
}

// ─── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) { console.error(".env에 ADMIN_EMAIL, ADMIN_PASSWORD 설정 필요"); process.exit(1); }

  console.log("🔐 Firebase 로그인 중...");
  await signInWithEmailAndPassword(auth, email, password);
  console.log("✅ 로그인 완료\n");

  // Excel 전체 파싱
  console.log("📊 Excel 파일 파싱 중...");
  const monthlyData = parseAllFiles();
  const months = Object.keys(monthlyData).sort();
  console.log(`  → ${months.length}개월 데이터 파싱 완료 (${months[0]} ~ ${months[months.length-1]})\n`);

  // Firebase 환자 로드
  console.log("👥 Firebase 환자 DB 로드 중...");
  const fbPatients = await loadFirebasePatients();
  console.log(`  → ${Object.keys(fbPatients).length}명 환자 데이터 로드됨\n`);

  // 기존 위탁진료 문서 확인
  const existingMonths = await getExistingRefundMonths();
  console.log(`  → 기존 위탁진료 문서: ${existingMonths.size}건\n`);

  // 차트번호 매칭 결과
  const matchStats = { matched:0, notMatched:new Set(), bankUpdated:0 };

  // 월별 처리
  let imported = 0, skipped = 0;
  for (const month of months) {
    if (existingMonths.has(month)) {
      console.log(`  ⏭  ${month} → 이미 존재, 스킵`);
      skipped++;
      continue;
    }

    const patients = monthlyData[month];

    // 차트번호 → Firebase 환자 매칭 + 계좌정보 업데이트
    for (const p of patients) {
      const fb = fbPatients[p.chartNo];
      if (fb) {
        p.patientDbId = fb._key;
        matchStats.matched++;
        // 계좌정보 없으면 업데이트
        if (p.bankHolder && (!fb.bankHolder || !fb.accountNo)) {
          await updatePatientBankInfo(fb._key, p.bankHolder, p.bank, p.accountNo);
          fb.bankHolder = p.bankHolder; fb.bank = p.bank; fb.accountNo = p.accountNo;
          matchStats.bankUpdated++;
        }
      } else {
        matchStats.notMatched.add(p.chartNo);
      }
    }

    await saveRefundDoc(month, patients);
    console.log(`  ✓ ${month}: ${patients.length}명, 환불합계 ${patients.reduce((s,p)=>s+p.treatments.reduce((ts,t)=>ts+(Number(t.refundAmount)||0),0),0).toLocaleString()}원`);
    imported++;
  }

  console.log(`\n🎉 완료!`);
  console.log(`  저장: ${imported}건 / 스킵(중복): ${skipped}건`);
  console.log(`  차트번호 매칭: ${matchStats.matched}건`);
  console.log(`  계좌정보 업데이트: ${matchStats.bankUpdated}명`);
  if (matchStats.notMatched.size > 0) {
    const list = [...matchStats.notMatched].sort((a,b)=>Number(a)-Number(b));
    console.log(`\n⚠️  Firebase 미매칭 차트번호 (${matchStats.notMatched.size}개):`);
    // 20개씩 출력
    for (let i = 0; i < list.length; i += 20) {
      console.log(`  ${list.slice(i,i+20).join(", ")}`);
    }
    console.log(`  → 이 환자들은 퇴원 후 차트가 없거나 차트번호가 다를 수 있습니다.`);
  }
  process.exit(0);
}

main().catch(e => { console.error("오류:", e.message); process.exit(1); });

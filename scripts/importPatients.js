/**
 * 환자 데이터 Firebase 임포트 스크립트
 * 사용법: node scripts/importPatients.js
 */

require("dotenv").config({ path: ".env.local" });
const XLSX  = require("xlsx");
const admin = require("firebase-admin");
const path  = require("path");

// ── Firebase Admin 초기화 ─────────────────────────────────────────────────────
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  }),
  databaseURL: "https://ewoo-hospital-ward-default-rtdb.firebaseio.com",
});

const db = admin.database();

// ── 주민번호 파싱 ─────────────────────────────────────────────────────────────
function parseRRN(rrn) {
  if (!rrn) return { birthDate: null, gender: null };

  // 숫자만 추출 (하이픈 제거)
  const digits = String(rrn).replace(/\D/g, "");
  if (digits.length < 7) return { birthDate: null, gender: null };

  const yy  = digits.slice(0, 2);
  const mm  = digits.slice(2, 4);
  const dd  = digits.slice(4, 6);
  const gen = parseInt(digits[6]);

  // 7번째 자리로 세기 판별
  let yyyy;
  if      (gen === 9 || gen === 0) yyyy = "18" + yy; // 1800년대 (거의 없음)
  else if (gen === 1 || gen === 2) yyyy = "19" + yy;
  else if (gen === 3 || gen === 4) yyyy = "20" + yy;
  else if (gen === 5 || gen === 6) yyyy = "19" + yy; // 외국인
  else if (gen === 7 || gen === 8) yyyy = "20" + yy; // 외국인
  else yyyy = "19" + yy;

  const gender = (gen % 2 === 1) ? "M" : "F";
  const birthDate = `${yyyy}-${mm}-${dd}`;

  return { birthDate, gender };
}

// ── 전화번호 정규화 ───────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0,3)}-${digits.slice(3,7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  return String(raw).trim();
}

// ── 날짜 정규화 ───────────────────────────────────────────────────────────────
function normalizeDate(raw) {
  if (!raw) return "";
  // Excel 날짜 시리얼 숫자 처리
  if (typeof raw === "number") {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;
  }
  const str = String(raw).trim();
  // YYYYMMDD 형식
  if (/^\d{8}$/.test(str)) return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
  // 이미 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return str;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  const filePath = path.join(__dirname, "../접수현황(20200118 - 20260318).xls");
  console.log("📂 파일 읽는 중:", filePath);

  const workbook  = XLSX.readFile(filePath, { codepage: 949 });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  console.log(`📊 총 ${rows.length}행 읽음`);

  // 첫 행 컬럼명 확인
  if (rows.length > 0) {
    console.log("📋 컬럼명:", Object.keys(rows[0]).join(" | "));
  }

  // ── 컬럼명 자동 감지 ──────────────────────────────────────────────────────
  const sample    = rows[0] ? Object.keys(rows[0]) : [];
  const col = {
    chartNo:    sample.find(k => /차트|chart/i.test(k))      || "차트번호",
    name:       sample.find(k => /수진자|이름|성명/i.test(k)) || "수진자",
    rrn:        sample.find(k => /주민/i.test(k))             || "주민번호",
    admitDate:  sample.find(k => /접수|입원/i.test(k))        || "접수일자",
    doctor:     sample.find(k => /의사|진료의/i.test(k))      || "진료의사",
    phone:      sample.find(k => /휴대|전화/i.test(k))        || "휴대번호",
    address:    sample.find(k => /주소/i.test(k))             || "주소",
    diagnosis:  sample.find(k => /상병|진단/i.test(k))        || "주상병",
  };

  console.log("\n🔍 감지된 컬럼 매핑:");
  Object.entries(col).forEach(([k, v]) => console.log(`  ${k.padEnd(12)} → "${v}"`));
  console.log("");

  // ── Firebase 저장 ─────────────────────────────────────────────────────────
  const updates = {};
  let   ok = 0, skip = 0;

  rows.forEach((row, idx) => {
    const chartNo = String(row[col.chartNo] || "").trim();
    const name    = String(row[col.name]    || "").trim();

    if (!chartNo || !name) { skip++; return; }

    const { birthDate, gender } = parseRRN(row[col.rrn]);

    const patient = {
      chartNo,
      name,
      phone:         normalizePhone(row[col.phone]),
      address:       String(row[col.address]   || "").trim(),
      doctor:        String(row[col.doctor]    || "").trim(),
      diagnosis:     String(row[col.diagnosis] || "").trim(),
      lastAdmitDate: normalizeDate(row[col.admitDate]),
      createdAt:     new Date().toISOString(),
    };

    if (birthDate) patient.birthDate = birthDate;
    if (gender)    patient.gender    = gender;

    updates[`patients/${chartNo}`] = patient;
    ok++;
  });

  console.log(`✅ 처리 완료: ${ok}명 / 건너뜀: ${skip}건`);
  console.log("🔥 Firebase에 저장 중...");

  // Firebase는 한 번에 최대 ~4MB → 500건씩 나눠서 업로드
  const entries = Object.entries(updates);
  const BATCH   = 500;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = Object.fromEntries(entries.slice(i, i + BATCH));
    await db.ref("/").update(batch);
    console.log(`  ↑ ${Math.min(i + BATCH, entries.length)} / ${entries.length} 저장됨`);
  }

  console.log("\n🎉 임포트 완료!");
  console.log(`   환자 수: ${ok}명`);
  console.log(`   Firebase 경로: patients/{차트번호}`);

  process.exit(0);
}

main().catch(err => {
  console.error("❌ 오류:", err.message);
  process.exit(1);
});

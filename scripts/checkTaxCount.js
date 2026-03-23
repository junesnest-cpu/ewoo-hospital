const xlsx = require("xlsx");
const path = require("path");

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

function isNewFormatHeader(row) {
  const c0 = String(row[0] || "").trim();
  return c0 === "구분" || c0 === "해당과";
}

function isLegacySection(row) {
  return String(row[0] || "").includes("그외") || String(row[0] || "").includes("기타 영수증");
}

for (const { path: fPath, year } of FILES) {
  let wb;
  try { wb = xlsx.readFile(fPath); }
  catch (e) { console.log(`파일 없음: ${fPath}`); continue; }

  for (const shName of wb.SheetNames) {
    const m = shName.match(/^(\d{1,2})월/);
    if (!m) continue;
    const monthNum = parseInt(m[1]);
    const reportMonth = `${year}-${String(monthNum).padStart(2, "0")}`;
    const ws = wb.Sheets[shName];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });

    // 헤더 감지
    let fmt = "legacy";
    for (const row of rows) {
      if (!row) continue;
      const j = row.map(c => String(c || "")).join(",");
      if (j.includes("업체명") && j.includes("일")) { fmt = "legacy"; break; }
      if (j.includes("구분") && j.includes("분류")) {
        fmt = j.includes("발행일") ? "new" : "new_no_date"; break;
      }
    }

    if (fmt === "legacy") continue; // legacy는 건수 컬럼 없음

    // new/new_no_date 포맷: 건수 컬럼 확인
    let inLegacy = false;
    for (const row of rows) {
      if (!row || !row.some(c => c !== null)) continue;
      if (isNewFormatHeader(row)) { inLegacy = false; continue; }
      if (isLegacySection(row)) { inLegacy = true; continue; }
      if (inLegacy) continue;

      const c0 = row[0] != null ? String(row[0]).trim() : null;
      const cnt_raw = fmt === "new" ? row[8] : row[7];
      const cnt_str = cnt_raw != null ? String(cnt_raw).trim() : "";

      // 건수가 있고, 1이 아닌 경우 출력
      if (cnt_str && cnt_str !== "" && cnt_str !== "건") {
        const cnt_num = parseInt(cnt_str.replace(/[^0-9]/g, ""));
        if (isNaN(cnt_num) || cnt_num === 1) continue; // 1건은 제외
        const vendor = String(row[2] || "").trim();
        const content = String(row[3] || "").trim();
        const amt = parseNum(row[4]);
        const method = String(row[5] || "").trim();
        const group = c0 && c0 !== "" ? c0 : "(그룹유지)";
        console.log(`[${reportMonth}] 그룹=${group} | 업체=${vendor} | 내용=${content} | 금액=${amt} | 처리=${method} | 건수원본="${cnt_str}" → ${cnt_num}`);
      }
    }
  }
}

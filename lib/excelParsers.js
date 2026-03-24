/**
 * 브라우저용 Excel 파서 유틸
 * 위탁진료 환불금 / 영양팀 월간보고 / 세금계산서
 *
 * 각 parse 함수는 File 객체를 받아 → formData 객체를 반환합니다.
 */
import * as XLSXModule from "xlsx";
const XLSX = (XLSXModule && XLSXModule.read) ? XLSXModule : (XLSXModule?.default || XLSXModule);

// ─── 공통 유틸 ────────────────────────────────────────────────────────────────
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

// 발행일 문자열에서 실제 날짜 개수 추출
// 괄호 안 내용(메모)은 제거 후 M/D 패턴 카운트
// ex) "1/6 1/15 1/26" → 3,  "5/16(5/10)" → 1,  "11/5 11/27(세금계산서1/13)" → 2
function countRealDates(issd) {
  if (!issd) return 1;
  const clean = String(issd).replace(/\([^)]*\)/g, " ");
  const m = clean.match(/\b\d{1,2}\/\d{1,2}\b/g);
  return m ? m.length : 1;
}

// count 최종값 결정: Excel에 1이 입력됐지만 발행일에 여러 날짜가 있으면 날짜 수로 보정
function resolveCount(cntRaw, issd) {
  if (cntRaw !== "1" || !issd) return cntRaw;
  const dateCount = countRealDates(issd);
  return dateCount > 1 ? String(dateCount) : cntRaw;
}

function cleanGroupName(raw) {
  return String(raw || "").replace(/\r\n/g, " ").trim();
}

function excelDateToISO(serial) {
  if (!serial || typeof serial !== "number" || serial < 1) return "";
  const utcMs = (serial - 25569) * 86400000;
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function cleanName(name) {
  if (!name) return "";
  return String(name).replace(/\d+$/, "").trim();
}

// ArrayBuffer → xlsx WorkBook
function readWorkbook(arrayBuffer) {
  return XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
}

// ─── 위탁진료 환불금 파서 ─────────────────────────────────────────────────────
// 반환: { reportMonth: "2026-03", patients: [...], grandTotal: N }
export async function parseRefundExcel(file) {
  const buf = await file.arrayBuffer();
  const wb  = readWorkbook(buf);

  // 시트 목록에서 첫 번째 유효 시트 감지 (YYYY.MM 형식)
  // 업로드된 파일에서 하나의 시트만 처리한다고 가정
  const results = [];

  for (const shName of wb.SheetNames) {
    const m = shName.trim().match(/^(\d{4})\.(\d{1,2})$/);
    if (!m) continue;
    const reportMonth = `${m[1]}-${m[2].padStart(2, "0")}`;
    const ws = wb.Sheets[shName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    let headerRowIdx = -1;
    let hasDocInfo = true;

    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const r = rows[i];
      if (!r) continue;
      const joined = r.map(c => String(c || "")).join(",");
      if (joined.includes("CH.") && joined.includes("성함")) {
        headerRowIdx = i;
        hasDocInfo = !(String(r[8] || "").includes("예금주"));
        break;
      }
    }
    if (headerRowIdx < 0) continue;

    const C = hasDocInfo
      ? { holder: 10, bank: 11, account: 12, phone: 13, note: 14 }
      : { holder: 8,  bank: 9,  account: 10, phone: 11, note: 12 };

    const patients = [];
    let cur = null;
    let lastDate = "";

    for (let ri = headerRowIdx + 1; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row) continue;
      if (typeof row[0] === "string" && /합계|소계|총계/.test(row[0])) continue;

      const chartRaw = row[0];
      const nameRaw  = row[1];
      const dateRaw  = row[2];
      const inst     = String(row[3] || "").trim();
      const total    = parseNum(row[6]);
      const refund   = parseNum(row[7]);
      const holder   = String(row[C.holder] || "").trim();
      const bank     = String(row[C.bank]   || "").trim();
      const account  = String(row[C.account]|| "").trim();
      const phone    = String(row[C.phone]  || "").trim();
      const note     = String(row[C.note]   || "").trim();

      if (chartRaw !== null && chartRaw !== "") {
        if (cur) patients.push(cur);
        const isoDate = excelDateToISO(dateRaw);
        lastDate = isoDate || lastDate;
        cur = {
          id: uid7(), chartNo: String(chartRaw), name: cleanName(nameRaw),
          phone, bankHolder: holder, bank, accountNo: account,
          patientDbId: "", treatments: [],
        };
        if (total || refund) {
          cur.treatments.push({ id: uid7(), date: isoDate || lastDate, institution: inst, totalCost: total, refundAmount: refund, note });
        }
      } else if (cur) {
        const isoDate = excelDateToISO(dateRaw) || lastDate;
        lastDate = isoDate;
        if (!cur.bankHolder && holder) { cur.bankHolder = holder; cur.bank = bank; cur.accountNo = account; cur.phone = phone; }
        if ((total || refund) && inst) {
          cur.treatments.push({ id: uid7(), date: isoDate, institution: inst, totalCost: total, refundAmount: refund, note });
        }
      }
    }
    if (cur) patients.push(cur);

    const validPatients = patients.filter(p => p.treatments.length > 0);
    const grandTotal = validPatients.reduce((s, p) => s + p.treatments.reduce((ts, t) => ts + (Number(t.refundAmount) || 0), 0), 0);
    results.push({ reportMonth, patients: validPatients, grandTotal });
  }

  return results; // 여러 시트가 있을 수 있으므로 배열 반환
}

// ─── 영양팀 월간보고 파서 ─────────────────────────────────────────────────────
// 반환: { reportMonth, days, monthSummary, generalNote }
export async function parseWeeklyExcel(file) {
  const buf = await file.arrayBuffer();
  const wb  = readWorkbook(buf);
  const results = [];

  for (const shName of wb.SheetNames) {
    // 월간 시트: "26.1", "26.3" 등
    const mMonthly = shName.match(/^(\d{2})\.(\d{1,2})/);
    if (mMonthly) {
      const year  = 2000 + parseInt(mMonthly[1]);
      const month = parseInt(mMonthly[2]);
      const reportMonth = `${year}-${String(month).padStart(2, "0")}`;
      const ws   = wb.Sheets[shName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
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
          date: dateRaw,
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

      if (days.length === 0) continue;

      const totalCost  = days.reduce((s,d) => s+(Number(d.ecoFood)||0)+(Number(d.dojunFood)||0)+(Number(d.ecoSnack)||0)+(Number(d.dojunSnack)||0)+(Number(d.otherCost)||0), 0);
      const staff      = days.reduce((s,d) => s+(Number(d.staffCount)||0), 0);
      const patient    = days.reduce((s,d) => s+(Number(d.patientCount)||0), 0);
      const totalCount = staff + patient;

      results.push({
        reportMonth, days,
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
      });
      continue;
    }
  }

  return results;
}

// ─── 세금계산서 파서 헬퍼 ─────────────────────────────────────────────────────
function isNewFormatHeader(row) {
  const c0 = String(row[0] || "").trim();
  return c0 === "구분" || c0 === "해당과";
}
function isLegacySection(row) {
  return String(row[0] || "").includes("그외") || String(row[0] || "").includes("기타 영수증");
}
function detectTaxFormat(rows) {
  for (const row of rows) {
    if (!row) continue;
    const j = row.map(c => String(c || "")).join(",");
    if (j.includes("업체명") && j.includes("일")) return "legacy";
    if (j.includes("구분") && j.includes("분류")) return j.includes("발행일") ? "new" : "new_no_date";
  }
  return "legacy";
}

function parseTaxNewFormat(rows, hasIssueDate) {
  // hasIssueDate=true: col[6]=발행일, col[7]=비고, col[8]=건
  // hasIssueDate=false: col[6]=비고, col[7]=건
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
    const issd  = hasIssueDate ? String(row[6] || "").trim() : "";
    const note  = hasIssueDate ? String(row[7] || "").trim() : String(row[6] || "").trim();
    const cnt   = resolveCount(parseCount(hasIssueDate ? row[8] : row[7]), issd);

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
    if (!amt && (cont === "월 결제분" || cont === "월분 결제건" || cont === "월 결제건")) continue;

    curGroup.items.push({ id: uid7(), category: ec, vendor: ev, content: cont, amount: amt, method: meth || "기타", issueDate: issd, count: cnt, note });
  }
  return groups.filter(g => g.items.length > 0);
}

function parseTaxLegacyFormat(rows) {
  const items = [];
  for (const row of rows) {
    if (!row || !row.some(c => c !== null)) continue;
    const c0 = String(row[0] || "").trim();
    if (c0 === "일" || c0.match(/^\d{4}\.\d{2}/)) continue;
    const day     = row[0];
    const vendor  = String(row[1] || "").trim();
    const content = String(row[2] || "").trim();
    const amount  = parseNum(row[3]);
    const method  = String(row[4] || "").trim() || "기타";
    const note    = String(row[5] || "").trim();
    if (day !== null && typeof day !== "number") { if (!String(day).match(/^\d+$/)) continue; }
    if (!vendor && !content && !amount) continue;
    const issueDateStr = typeof day === "number" ? `${day}일` : "";
    items.push({ id: uid7(), category: "", vendor, content, amount, method, issueDate: issueDateStr, count: "1", note });
  }
  return items.length === 0 ? [] : [{ name: "전체", items }];
}

// ─── 세금계산서 파서 ──────────────────────────────────────────────────────────
// 반환: { reportMonth, groups, grandTotal }[]
export async function parseTaxExcel(file) {
  const buf = await file.arrayBuffer();
  const wb  = readWorkbook(buf);
  const results = [];

  for (const shName of wb.SheetNames) {
    const m = shName.match(/^(\d{1,2})월/);
    if (!m) continue;

    // 시트명에서 연도 추론 어렵기 때문에 파일명에서 연도 감지
    const yearMatch = file.name.match(/(\d{4})년/);
    const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
    const monthNum    = parseInt(m[1]);
    const reportMonth = `${year}-${String(monthNum).padStart(2, "0")}`;

    const ws   = wb.Sheets[shName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const fmt  = detectTaxFormat(rows);

    let groups;
    if (fmt === "legacy") {
      groups = parseTaxLegacyFormat(rows);
    } else {
      groups = parseTaxNewFormat(rows, fmt === "new");
    }
    if (groups.length === 0) continue;

    const grandTotal = groups.reduce((s, g) =>
      s + (g.items || []).reduce((gs, it) => gs + (Number(it.amount) || 0), 0), 0);

    results.push({ reportMonth, groups, grandTotal });
  }

  return results;
}

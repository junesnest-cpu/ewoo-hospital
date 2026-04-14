/**
 * 저장소 통합 마이그레이션 페이지
 * monthlyBoards → dailyBoards 데이터 병합
 *
 * 사용법: /migrate-storage 접속 → Dry Run → 확인 → 실행
 */
import { useState } from "react";
import { ref, get, set } from "firebase/database";
import { db } from "../lib/firebaseConfig";

function normName(n) { return (n || "").replace(/^신\)\s*/, "").trim().toLowerCase(); }

export default function MigrateStorage() {
  const [status, setStatus] = useState("대기");
  const [log, setLog] = useState([]);
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);

  const addLog = (msg) => setLog(prev => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);

  async function runMigration() {
    setRunning(true);
    setLog([]);
    setStatus("실행 중...");

    try {
      // 1. 모든 monthlyBoards 로드
      addLog("📂 monthlyBoards 전체 로드 중...");
      const mbSnap = await get(ref(db, "monthlyBoards"));
      const allMB = mbSnap.val() || {};

      // 2. 모든 dailyBoards 로드
      addLog("📂 dailyBoards 전체 로드 중...");
      const dbSnap = await get(ref(db, "dailyBoards"));
      const allDB = dbSnap.val() || {};

      let totalDates = 0, mergedDates = 0, skippedDates = 0, newDates = 0;
      const changes = [];

      // 3. monthlyBoards 순회
      for (const [ym, monthData] of Object.entries(allMB)) {
        if (!monthData || typeof monthData !== "object") continue;

        for (const [dateKey, mbDay] of Object.entries(monthData)) {
          if (!dateKey.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
          totalDates++;

          const mbAdm = (mbDay.admissions || []).filter(a => a.name);
          const mbDis = (mbDay.discharges || []).filter(d => d.name);
          if (mbAdm.length === 0 && mbDis.length === 0) { skippedDates++; continue; }

          const dbDay = allDB[dateKey];
          const dbAdm = dbDay?.admissions || [];
          const dbDis = dbDay?.discharges || [];

          // 이름 기준 합산: dailyBoards 기존 항목 유지 + monthlyBoards에만 있는 항목 추가
          const seenAdm = new Set(dbAdm.filter(a => a.name).map(a => normName(a.name)));
          const seenDis = new Set(dbDis.filter(d => d.name).map(d => normName(d.name)));

          const newAdm = mbAdm.filter(a => !seenAdm.has(normName(a.name)));
          const newDis = mbDis.filter(d => !seenDis.has(normName(d.name)));

          if (newAdm.length === 0 && newDis.length === 0) { skippedDates++; continue; }

          const mergedAdmissions = [...dbAdm, ...newAdm];
          const mergedDischarges = [...dbDis, ...newDis];

          // 기존 dailyBoards의 다른 필드(transfers, therapy 등)는 보존
          const merged = {
            ...(dbDay || {}),
            admissions: mergedAdmissions,
            discharges: mergedDischarges,
          };

          if (dbDay) {
            mergedDates++;
            addLog(`🔄 ${dateKey}: 기존 DB(adm=${dbAdm.filter(a=>a.name).length},dis=${dbDis.filter(d=>d.name).length}) + MB추가(adm=${newAdm.length}[${newAdm.map(a=>a.name).join(',')}],dis=${newDis.length}[${newDis.map(d=>d.name).join(',')}]) → 합산(adm=${mergedAdmissions.filter(a=>a.name).length},dis=${mergedDischarges.filter(d=>d.name).length})`);
          } else {
            newDates++;
            addLog(`✅ ${dateKey}: 신규 생성 (adm=${newAdm.length}[${newAdm.map(a=>a.name).join(',')}], dis=${newDis.length}[${newDis.map(d=>d.name).join(',')}])`);
          }

          changes.push({ dateKey, data: merged });
        }
      }

      addLog(`\n📊 요약: 총 ${totalDates}일, 병합 ${mergedDates}일, 신규 ${newDates}일, 변경 없음 ${skippedDates}일`);

      if (dryRun) {
        addLog(`\n🔍 Dry Run 완료 — 실제 변경 없음. "실제 실행"으로 전환 후 다시 실행하세요.`);
        setStatus(`Dry Run 완료: ${changes.length}건 변경 예정`);
      } else {
        addLog(`\n💾 ${changes.length}건 Firebase에 저장 중...`);
        for (const { dateKey, data } of changes) {
          await set(ref(db, `dailyBoards/${dateKey}`), data);
        }
        addLog(`✅ 마이그레이션 완료!`);
        setStatus(`완료: ${changes.length}건 저장됨`);
      }
    } catch (err) {
      addLog(`❌ 오류: ${err.message}`);
      setStatus("오류 발생");
    }
    setRunning(false);
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24, fontFamily: "'Noto Sans KR', sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 800, marginBottom: 8 }}>저장소 통합 마이그레이션</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 20 }}>
        monthlyBoards → dailyBoards 데이터 병합. 기존 dailyBoards 데이터는 보존되며, monthlyBoards에만 있는 항목만 추가됩니다.
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 20, alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
          Dry Run (미리보기만, 실제 변경 없음)
        </label>
        <button onClick={runMigration} disabled={running}
          style={{ background: dryRun ? "#3b82f6" : "#dc2626", color: "#fff", border: "none", borderRadius: 8,
            padding: "10px 24px", fontWeight: 700, fontSize: 14, cursor: running ? "not-allowed" : "pointer" }}>
          {running ? "실행 중..." : dryRun ? "Dry Run 실행" : "실제 마이그레이션 실행"}
        </button>
        <span style={{ fontSize: 14, color: "#64748b" }}>상태: {status}</span>
      </div>

      <div style={{ background: "#0f172a", color: "#e2e8f0", borderRadius: 10, padding: 16,
        fontSize: 12, fontFamily: "monospace", maxHeight: 500, overflowY: "auto", whiteSpace: "pre-wrap" }}>
        {log.length === 0 ? "로그가 여기에 표시됩니다..." : log.join("\n")}
      </div>
    </div>
  );
}

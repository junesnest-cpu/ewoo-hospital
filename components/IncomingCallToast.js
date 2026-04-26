/**
 * 글로벌 전화 수신 토스트.
 *
 * 동작:
 *   - 로그인된 사용자가 userSettings/{ek}/notifyIncomingCall === true 일 때만 활성화
 *   - incomingCalls (orderByChild ts, limitToLast 5) 구독
 *   - 30분 이내 + claimedBy=null 인 entry 만 표시
 *   - 매칭 환자 (patientByPhone → patients) 자동 조회 + 정보 표시
 *   - "내가 받음" 클릭 → /api/incoming-call/claim → claimedBy 채워지면 모든 화면에서 동기 닫힘
 *   - 30초 후 자동 dismiss (UI 만; entry 는 1h cleanup 으로 사라짐)
 */
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { ref, query, orderByChild, limitToLast, onValue, get } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "../lib/firebaseConfig";
import { apiFetch } from "../lib/apiFetch";

const STALE_MS = 30 * 60 * 1000;
const AUTO_DISMISS_MS = 30 * 1000;

function encodeEmail(e) {
  return (e || "").replace(/\./g, ",").replace(/@/g, "_at_");
}

function normPhoneDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function phoneDisplay(d) {
  if (!d) return "";
  if (d.length === 11) return `${d.slice(0,3)}-${d.slice(3,7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`;
  return d;
}

function calcAge(birthDate, birthYear) {
  let y = null;
  if (birthDate) {
    const m = String(birthDate).match(/^(\d{4})/);
    if (m) y = parseInt(m[1]);
  }
  if (!y && birthYear) {
    const m = String(birthYear).match(/(\d{4})/);
    if (m) y = parseInt(m[1]);
  }
  if (!y) return null;
  const age = new Date().getFullYear() - y + 1;
  return (age > 0 && age < 130) ? age : null;
}

export default function IncomingCallToast() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [calls, setCalls] = useState({});       // { id: {phone, ts, claimedBy, claimedAt} }
  const [details, setDetails] = useState({});   // { id: {name, age, diagnosis, hospital, chartNo, _matched} }
  const [dismissed, setDismissed] = useState({}); // { id: true } (UI dismiss only)
  const userEmailRef = useRef("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => {
      userEmailRef.current = u?.email || "";
      if (!u?.email) { setEnabled(false); return; }
      const ek = encodeEmail(u.email);
      const off = onValue(ref(db, `userSettings/${ek}/notifyIncomingCall`), snap => {
        setEnabled(snap.val() === true);
      });
      return () => off();
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!enabled) { setCalls({}); setDetails({}); return; }
    const q = query(ref(db, "incomingCalls"), orderByChild("ts"), limitToLast(5));
    const off = onValue(q, snap => {
      const v = snap.val() || {};
      setCalls(v);
    });
    return () => off();
  }, [enabled]);

  // 새 entry 들어오면 환자 매칭 조회
  useEffect(() => {
    if (!enabled) return;
    const cutoff = Date.now() - STALE_MS;
    const fresh = Object.entries(calls).filter(([id, c]) =>
      c?.ts >= cutoff && !c.claimedBy && !details[id]
    );
    fresh.forEach(async ([id, c]) => {
      const digits = normPhoneDigits(c.phone);
      try {
        const idxSnap = await get(ref(db, `patientByPhone/${digits}`));
        const internalId = idxSnap.val();
        if (!internalId) {
          setDetails(d => ({ ...d, [id]: { _matched: false } }));
          return;
        }
        // patients 전체 조회 후 internalId 매칭 (CLAUDE.md 패턴)
        const pSnap = await get(ref(db, "patients"));
        const all = pSnap.val() || {};
        const p = Object.values(all).filter(Boolean).find(x => x.internalId === internalId);
        if (!p) {
          setDetails(d => ({ ...d, [id]: { _matched: false } }));
          return;
        }
        // 최신 상담 한 건 조회 (병원·진단 fallback 용)
        const cSnap = await get(ref(db, "consultations"));
        const consAll = cSnap.val() || {};
        let bestC = null;
        let bestAt = 0;
        for (const cv of Object.values(consAll)) {
          if (!cv?.phone) continue;
          if (normPhoneDigits(cv.phone) !== digits) continue;
          const at = cv.createdAt ? new Date(cv.createdAt).getTime() : 0;
          if (at > bestAt) { bestAt = at; bestC = cv; }
        }
        setDetails(d => ({
          ...d,
          [id]: {
            _matched: true,
            name: p.name || bestC?.name || "",
            age: calcAge(p.birthDate, p.birthYear) ?? calcAge(bestC?.birthDate, bestC?.birthYear),
            diagnosis: p.diagName || p.diagnosis || bestC?.diagnosis || "",
            hospital: bestC?.hospital || "",
            chartNo: p.chartNo || "",
            lastAdmitDate: p.lastAdmitDate || "",
          },
        }));
      } catch (e) {
        console.warn("[IncomingCallToast] lookup 실패:", e.message);
        setDetails(d => ({ ...d, [id]: { _matched: false, _error: true } }));
      }
    });
  }, [calls, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // UI 자동 dismiss 타이머
  useEffect(() => {
    if (!enabled) return;
    const cutoff = Date.now() - AUTO_DISMISS_MS;
    const tooOld = Object.entries(calls).filter(([id, c]) =>
      c?.ts && c.ts < cutoff && !dismissed[id]
    );
    if (tooOld.length === 0) return;
    setDismissed(d => {
      const next = { ...d };
      for (const [id] of tooOld) next[id] = true;
      return next;
    });
  }, [calls, enabled, dismissed]);

  const handleClaim = async (id) => {
    try {
      const r = await apiFetch("/api/incoming-call/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 409) {
          alert(`이미 ${body.by || "다른 직원"}이(가) 받음으로 표시함`);
        } else {
          alert("처리 실패: " + (body.error || r.status));
        }
      }
      // 성공 시: claimedBy 가 RTDB 에 채워지면 자동으로 토스트 닫힘 (구독)
    } catch (e) {
      alert("네트워크 오류: " + e.message);
    }
  };

  const handleViewInPatients = (phone) => {
    router.push(`/patients?phone=${encodeURIComponent(phone)}`);
  };

  if (!enabled) return null;

  const cutoff = Date.now() - STALE_MS;
  const visible = Object.entries(calls)
    .filter(([id, c]) =>
      c?.ts >= cutoff && !c.claimedBy && !dismissed[id]
    )
    .sort((a, b) => b[1].ts - a[1].ts);

  if (visible.length === 0) return null;

  return (
    <div style={S.wrap}>
      {visible.map(([id, c]) => {
        const d = details[id];
        const matched = d?._matched === true;
        return (
          <div key={id} style={S.card}>
            <div style={S.headerRow}>
              <span style={S.icon}>📞</span>
              <span style={S.phone}>{phoneDisplay(c.phone)}</span>
              <button onClick={() => setDismissed(prev => ({ ...prev, [id]: true }))}
                style={S.btnX} aria-label="닫기">✕</button>
            </div>

            {!d ? (
              <div style={S.lookup}>환자 조회 중...</div>
            ) : matched ? (
              <div style={S.matched}>
                <div style={S.name}>
                  {d.name}
                  {d.age != null && <span style={S.age}> · {d.age}세</span>}
                </div>
                {d.diagnosis && (
                  <div style={S.diag}>
                    {d.diagnosis}
                    {d.hospital && <span style={S.hosp}> ({d.hospital})</span>}
                  </div>
                )}
                <div style={S.meta}>
                  {d.chartNo && <span>차트 {d.chartNo}</span>}
                  {d.lastAdmitDate && <span> · 최근 입원 {d.lastAdmitDate}</span>}
                </div>
              </div>
            ) : (
              <div style={S.unmatched}>
                {d._error ? "조회 실패" : "신규 번호 (등록된 환자 없음)"}
              </div>
            )}

            <div style={S.btnRow}>
              <button style={S.btnView} onClick={() => handleViewInPatients(c.phone)}>
                환자목록에서 보기
              </button>
              <button style={S.btnClaim} onClick={() => handleClaim(id)}>
                내가 받음
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const S = {
  wrap: {
    position: "fixed",
    top: 16,
    right: 16,
    zIndex: 9000,
    display: "flex",
    flexDirection: "column",
    gap: 10,
    maxWidth: 340,
    fontFamily: "'Noto Sans KR','Pretendard',sans-serif",
  },
  card: {
    background: "#fff",
    border: "2px solid #0ea5e9",
    borderRadius: 12,
    padding: "12px 14px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    animation: "slideIn 0.25s ease-out",
  },
  headerRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  icon: { fontSize: 18 },
  phone: { fontSize: 15, fontWeight: 800, color: "#0f2744", flex: 1 },
  btnX: {
    background: "none", border: "none", fontSize: 14, color: "#94a3b8",
    cursor: "pointer", padding: "2px 6px", lineHeight: 1,
  },
  lookup: { fontSize: 12, color: "#94a3b8", padding: "4px 0" },
  matched: { padding: "4px 0 8px" },
  name: { fontSize: 15, fontWeight: 800, color: "#0f2744" },
  age: { fontSize: 13, fontWeight: 600, color: "#64748b" },
  diag: { fontSize: 13, color: "#dc2626", fontWeight: 700, marginTop: 2 },
  hosp: { fontSize: 12, color: "#7c3aed", fontWeight: 600 },
  meta: { fontSize: 11, color: "#94a3b8", marginTop: 4 },
  unmatched: {
    padding: "6px 8px", background: "#fef9c3", borderRadius: 6,
    fontSize: 12, color: "#854d0e", fontWeight: 600, marginBottom: 4,
  },
  btnRow: { display: "flex", gap: 6, marginTop: 8 },
  btnView: {
    flex: 1, background: "#f1f5f9", border: "none", borderRadius: 7,
    padding: "8px", fontSize: 12, fontWeight: 700, color: "#475569", cursor: "pointer",
  },
  btnClaim: {
    flex: 1, background: "#0ea5e9", border: "none", borderRadius: 7,
    padding: "8px", fontSize: 12, fontWeight: 800, color: "#fff", cursor: "pointer",
  },
};

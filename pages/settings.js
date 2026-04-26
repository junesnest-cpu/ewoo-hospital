import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { ref, onValue, set } from "firebase/database";
import { onAuthStateChanged } from "firebase/auth";
import { db, auth } from "../lib/firebaseConfig";

function encodeEmail(e) {
  return (e || "").replace(/\./g, ",").replace(/@/g, "_at_");
}

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState({});
  const [t1, setT1] = useState("");
  const [t2, setT2] = useState("");
  const [hyperOp, setHyperOp] = useState("");
  const [saved, setSaved] = useState(false);

  // 본인 사용자 설정
  const [userEmail, setUserEmail] = useState("");
  const [notifyIncomingCall, setNotifyIncomingCall] = useState(false);
  const [notifySaved, setNotifySaved] = useState(false);

  useEffect(() => {
    const unsub = onValue(ref(db, "settings"), snap => {
      const v = snap.val() || {};
      setSettings(v);
      setT1(v.therapist1 || "");
      setT2(v.therapist2 || "");
      setHyperOp(v.hyperOperator || "");
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => {
      if (!u?.email) return;
      setUserEmail(u.email);
      const ek = encodeEmail(u.email);
      const off = onValue(ref(db, `userSettings/${ek}/notifyIncomingCall`), snap => {
        setNotifyIncomingCall(snap.val() === true);
      });
      return () => off();
    });
    return () => unsub();
  }, []);

  const handleSave = async () => {
    const updated = {
      ...settings,
      therapist1:    t1.trim() || "치료사1",
      therapist2:    t2.trim() || "치료사2",
      hyperOperator: hyperOp.trim() || "운용기사",
    };
    await set(ref(db, "settings"), updated);
    setSettings(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  };

  const handleToggleNotify = async () => {
    if (!userEmail) return;
    const next = !notifyIncomingCall;
    setNotifyIncomingCall(next);
    const ek = encodeEmail(userEmail);
    try {
      await set(ref(db, `userSettings/${ek}/notifyIncomingCall`), next);
      setNotifySaved(true);
      setTimeout(() => setNotifySaved(false), 1800);
    } catch (e) {
      setNotifyIncomingCall(!next);
      alert("저장 실패: " + e.message);
    }
  };

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={S.hcenter}>
          <div style={S.htitle}>설정</div>
        </div>
      </header>

      <div style={S.body}>
        <div style={S.card}>
          <div style={S.cardTitle}>🏃 물리치료실</div>
          <div style={S.cardDesc}>물리치료실 주간 계획표에 표시될 치료사 이름을 입력하세요.</div>
          <label style={S.lbl}>치료사 1</label>
          <input style={S.inp} value={t1} onChange={e => setT1(e.target.value)} placeholder="예: 김치료" />
          <label style={{ ...S.lbl, marginTop: 14 }}>치료사 2</label>
          <input style={S.inp} value={t2} onChange={e => setT2(e.target.value)} placeholder="예: 이치료" />
        </div>

        <div style={S.card}>
          <div style={S.cardTitle}>⚡ 고주파치료실</div>
          <div style={S.cardDesc}>고주파치료실 주간 계획표에 표시될 운용기사 이름을 입력하세요.</div>
          <label style={S.lbl}>운용기사</label>
          <input style={S.inp} value={hyperOp} onChange={e => setHyperOp(e.target.value)} placeholder="예: 박기사" />
        </div>

        <button
          style={{ ...S.btnSave, background: saved ? "#16a34a" : "#0f2744" }}
          onClick={handleSave}
        >
          {saved ? "✓ 저장됐습니다" : "저장"}
        </button>

        <div style={S.card}>
          <div style={S.cardTitle}>📞 전화 수신 알림 (본인 설정)</div>
          <div style={S.cardDesc}>
            병원 전용 핸드폰에 전화가 오면 화면 우상단에 환자 정보 토스트가 표시됩니다.
            로그인된 모든 페이지에서 작동하며, 다른 직원이 "내가 받음" 클릭하면 동시에 닫힙니다.
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "8px 0" }}>
            <input
              type="checkbox"
              checked={notifyIncomingCall}
              onChange={handleToggleNotify}
              disabled={!userEmail}
              style={{ width: 18, height: 18, cursor: "pointer" }}
            />
            <span style={{ fontSize: 14, fontWeight: 600, color: "#334155" }}>
              {userEmail ? "전화 수신 알림 받기" : "로그인 후 사용 가능"}
            </span>
            {notifySaved && <span style={{ fontSize: 12, color: "#16a34a", fontWeight: 700 }}>✓ 저장됨</span>}
          </label>
          {userEmail && (
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
              현재 사용자: {userEmail.replace("@ewoo.com", "")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const S = {
  page:    { fontFamily: "'Noto Sans KR','Pretendard',sans-serif", background: "#f0f4f8", minHeight: "100vh" },
  header:  { background: "#0f2744", color: "#fff", display: "flex", alignItems: "center", padding: "12px 20px", boxShadow: "0 2px 8px rgba(0,0,0,0.15)" },
  btnBack: { background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", borderRadius: 7, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  hcenter: { flex: 1, textAlign: "center" },
  htitle:  { fontSize: 18, fontWeight: 800 },
  body:    { maxWidth: 500, margin: "36px auto", padding: "0 20px", display: "flex", flexDirection: "column", gap: 18 },
  card:    { background: "#fff", borderRadius: 14, padding: "22px 24px", boxShadow: "0 1px 8px rgba(0,0,0,0.07)", border: "1px solid #e2e8f0" },
  cardTitle:{ fontSize: 15, fontWeight: 800, color: "#0f2744", marginBottom: 5 },
  cardDesc: { fontSize: 12, color: "#94a3b8", marginBottom: 16 },
  lbl:     { display: "block", fontSize: 12, fontWeight: 700, color: "#64748b", marginBottom: 5 },
  inp:     { width: "100%", border: "1.5px solid #e2e8f0", borderRadius: 8, padding: "9px 12px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" },
  btnSave: { color: "#fff", border: "none", borderRadius: 10, padding: "13px", cursor: "pointer", fontSize: 15, fontWeight: 800, transition: "background 0.2s" },
};

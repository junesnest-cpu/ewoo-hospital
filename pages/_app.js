import "../styles/globals.css";
import Head from "next/head";
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { auth, db } from "../lib/firebaseConfig";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider } from "firebase/auth";
import { ref, onValue, set } from "firebase/database";

function LoginScreen() {
  const [name,     setName]     = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!name.trim() || !password.trim()) { setError("이름과 비밀번호를 입력해 주세요."); return; }
    setLoading(true); setError("");
    const email = `${name.trim()}@ewoo.com`;
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError("이름 또는 비밀번호가 올바르지 않습니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={LS.wrap}>
      <div style={LS.card}>
        <div style={LS.logoArea}>
          <img src="/favicon.png" alt="이우병원" style={{ width:56, height:56, objectFit:"contain", marginBottom:10 }}/>
          <div style={LS.title}>이우요양병원</div>
          <div style={LS.subtitle}>병동 관리 시스템</div>
        </div>
        <form onSubmit={handleLogin} style={{ width:"100%" }}>
          <div style={LS.field}>
            <label style={LS.lbl}>이름</label>
            <input style={LS.inp} value={name} onChange={e=>setName(e.target.value)}
              placeholder="홍길동" autoComplete="username" autoFocus/>
          </div>
          <div style={LS.field}>
            <label style={LS.lbl}>비밀번호</label>
            <input style={LS.inp} type="password" value={password} onChange={e=>setPassword(e.target.value)}
              placeholder="••••••••" autoComplete="current-password"/>
          </div>
          {error && <div style={LS.error}>{error}</div>}
          <button style={{...LS.btn, opacity:loading?0.7:1}} type="submit" disabled={loading}>
            {loading ? "로그인 중..." : "로그인"}
          </button>
        </form>
        <div style={LS.footer}>이우요양병원 내부 시스템 · 권한 없는 접근 금지</div>
      </div>
    </div>
  );
}

const LS = {
  wrap:     { minHeight:"100vh", background:"linear-gradient(135deg, #0f2744 0%, #0f4c35 100%)", display:"flex", alignItems:"center", justifyContent:"center", padding:16, fontFamily:"'Noto Sans KR','Pretendard',sans-serif" },
  card:     { background:"#fff", borderRadius:16, padding:"36px 32px", width:"100%", maxWidth:360, boxShadow:"0 20px 60px rgba(0,0,0,0.3)", display:"flex", flexDirection:"column", alignItems:"center" },
  logoArea: { display:"flex", flexDirection:"column", alignItems:"center", marginBottom:28 },
  title:    { fontSize:22, fontWeight:900, color:"#0f2744", letterSpacing:-0.5 },
  subtitle: { fontSize:13, color:"#64748b", marginTop:3 },
  field:    { width:"100%", marginBottom:14 },
  lbl:      { display:"block", fontSize:12, fontWeight:700, color:"#475569", marginBottom:5 },
  inp:      { width:"100%", border:"1.5px solid #e2e8f0", borderRadius:9, padding:"11px 14px", fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  error:    { background:"#fef2f2", color:"#dc2626", borderRadius:8, padding:"9px 12px", fontSize:13, marginBottom:12, textAlign:"center", fontWeight:600 },
  btn:      { width:"100%", background:"#0f2744", color:"#fff", border:"none", borderRadius:10, padding:"13px", fontSize:15, fontWeight:800, cursor:"pointer", marginTop:4 },
  footer:   { marginTop:24, fontSize:11, color:"#94a3b8", textAlign:"center" },
};

function ChangePasswordModal({ user, onClose }) {
  const [curPw,   setCurPw]   = useState("");
  const [newPw,   setNewPw]   = useState("");
  const [newPw2,  setNewPw2]  = useState("");
  const [error,   setError]   = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!curPw || !newPw || !newPw2) { setError("모든 항목을 입력해 주세요."); return; }
    if (newPw.length < 6) { setError("새 비밀번호는 6자 이상이어야 합니다."); return; }
    if (newPw !== newPw2) { setError("새 비밀번호가 일치하지 않습니다."); return; }
    setLoading(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, curPw);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPw);
      // 모든 기기 강제 로그아웃용 타임스탬프 기록
      await set(ref(db, `userPwChangedAt/${user.uid}`), Date.now());
      setSuccess(true);
      // 현재 기기도 2초 후 로그아웃
      setTimeout(() => signOut(auth), 2000);
    } catch (err) {
      if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") {
        setError("현재 비밀번호가 올바르지 않습니다.");
      } else {
        setError("변경 실패: " + err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:14, padding:"28px 24px", width:"100%", maxWidth:340, boxShadow:"0 16px 48px rgba(0,0,0,0.25)" }}>
        <div style={{ fontWeight:800, fontSize:16, color:"#0f2744", marginBottom:4 }}>🔑 비밀번호 변경</div>
        <div style={{ fontSize:12, color:"#94a3b8", marginBottom:20 }}>{user.email?.replace("@ewoo.com","")}</div>
        {success ? (
          <>
            <div style={{ background:"#f0fdf4", color:"#166534", borderRadius:8, padding:"12px", fontSize:14, fontWeight:700, textAlign:"center", marginBottom:16 }}>
              ✅ 비밀번호가 변경되었습니다.<br/>
              <span style={{ fontSize:12, fontWeight:400 }}>잠시 후 자동으로 로그아웃됩니다.</span>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            {[
              { label:"현재 비밀번호", value:curPw,  set:setCurPw,  ph:"현재 비밀번호 입력" },
              { label:"새 비밀번호",   value:newPw,  set:setNewPw,  ph:"6자 이상" },
              { label:"새 비밀번호 확인", value:newPw2, set:setNewPw2, ph:"새 비밀번호 재입력" },
            ].map(({ label, value, set, ph }) => (
              <div key={label} style={{ marginBottom:12 }}>
                <label style={{ display:"block", fontSize:12, fontWeight:700, color:"#475569", marginBottom:4 }}>{label}</label>
                <input type="password" value={value} onChange={e => set(e.target.value)}
                  placeholder={ph} autoComplete="off"
                  style={{ width:"100%", border:"1.5px solid #e2e8f0", borderRadius:8, padding:"10px 12px", fontSize:14, outline:"none", boxSizing:"border-box" }} />
              </div>
            ))}
            {error && <div style={{ background:"#fef2f2", color:"#dc2626", borderRadius:7, padding:"8px 12px", fontSize:13, fontWeight:600, marginBottom:12 }}>{error}</div>}
            <div style={{ display:"flex", gap:8, marginTop:4 }}>
              <button type="button" onClick={onClose}
                style={{ flex:1, background:"#f1f5f9", color:"#475569", border:"none", borderRadius:9, padding:"12px", fontSize:14, fontWeight:600, cursor:"pointer" }}>취소</button>
              <button type="submit" disabled={loading}
                style={{ flex:2, background:"#0f2744", color:"#fff", border:"none", borderRadius:9, padding:"12px", fontSize:14, fontWeight:700, cursor:"pointer", opacity:loading?0.7:1 }}>
                {loading ? "변경 중..." : "변경"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function App({ Component, pageProps }) {
  const [user,    setUser]    = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [showChangePw, setShowChangePw] = useState(false);
  const router = useRouter();
  const pageTitle = router.pathname === "/approval" ? "이우 전자결재시스템" : "이우 병동관리시스템";

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
    return () => unsub();
  }, []);

  // 비밀번호 변경 시 모든 기기 강제 로그아웃
  useEffect(() => {
    if (!user) return;
    const unsub = onValue(ref(db, `userPwChangedAt/${user.uid}`), (snap) => {
      const pwChangedAt = snap.val();
      if (!pwChangedAt) return;
      const lastSignIn = new Date(user.metadata.lastSignInTime).getTime();
      if (pwChangedAt > lastSignIn) signOut(auth);
    });
    return () => unsub();
  }, [user?.uid]);

  const userName = user?.email?.replace("@ewoo.com","") || "";

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0f2744", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ color:"#fff", fontSize:16, fontFamily:"'Noto Sans KR',sans-serif" }}>로딩 중...</div>
    </div>
  );

  if (!user) return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" type="image/png" href="/favicon.png"/>
        <link rel="shortcut icon" href="/favicon.png"/>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet"/>
      </Head>
      <LoginScreen/>
    </>
  );

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" type="image/png" href="/favicon.png"/>
        <link rel="shortcut icon" href="/favicon.png"/>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet"/>
      </Head>
      {/* 로그인 사용자 표시 바 */}
      <div style={{ background:"#0f2744", color:"#94a3b8", fontSize:11, padding:"4px 12px", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:4 }}>
        <span className="user-bar-name">👤 <b style={{color:"#e2e8f0"}}>{userName}</b>님 로그인 중</span>
        <div style={{ display:"flex", gap:6, marginLeft:"auto" }}>
          <button onClick={()=>setShowChangePw(true)}
            style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#e2e8f0", borderRadius:5, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:600 }}>
            🔑 <span className="user-bar-name">비밀번호 변경</span>
          </button>
          <button onClick={()=>signOut(auth)}
            style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#e2e8f0", borderRadius:5, padding:"2px 8px", cursor:"pointer", fontSize:11, fontWeight:600 }}>
            로그아웃
          </button>
        </div>
      </div>
      {showChangePw && <ChangePasswordModal user={user} onClose={()=>setShowChangePw(false)} />}
      <Component {...pageProps}/>
    </>
  );
}

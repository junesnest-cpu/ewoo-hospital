import "../styles/globals.css";
import Head from "next/head";
import { useState, useEffect } from "react";
import { auth } from "../lib/firebaseConfig";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "firebase/auth";

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

export default function App({ Component, pageProps }) {
  const [user,    setUser]    = useState(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
    return () => unsub();
  }, []);

  const userName = user?.email?.replace("@ewoo.com","") || "";

  if (loading) return (
    <div style={{ minHeight:"100vh", background:"#0f2744", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ color:"#fff", fontSize:16, fontFamily:"'Noto Sans KR',sans-serif" }}>로딩 중...</div>
    </div>
  );

  if (!user) return (
    <>
      <Head>
        <title>이우요양병원 병동관리</title>
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
        <title>이우요양병원 병동관리</title>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" type="image/png" href="/favicon.png"/>
        <link rel="shortcut icon" href="/favicon.png"/>
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;600;700;800&display=swap" rel="stylesheet"/>
      </Head>
      {/* 로그인 사용자 표시 바 */}
      <div style={{ background:"#0f2744", color:"#94a3b8", fontSize:11, padding:"4px 16px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span>👤 <b style={{color:"#e2e8f0"}}>{userName}</b>님 로그인 중</span>
        <button onClick={()=>signOut(auth)}
          style={{ background:"rgba(255,255,255,0.1)", border:"1px solid rgba(255,255,255,0.2)", color:"#e2e8f0", borderRadius:5, padding:"2px 10px", cursor:"pointer", fontSize:11, fontWeight:600 }}>
          로그아웃
        </button>
      </div>
      <Component {...pageProps}/>
    </>
  );
}

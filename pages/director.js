import { useEffect } from "react";

export default function DirectorRedirect() {
  useEffect(() => {
    window.location.href = "https://ewoo-approval.vercel.app/director";
  }, []);
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:"'Noto Sans KR',sans-serif", color:"#64748b" }}>
      경영현황 페이지로 이동 중...
    </div>
  );
}

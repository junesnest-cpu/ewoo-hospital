import { useEffect } from "react";

export default function ApprovalRedirect() {
  useEffect(() => {
    window.location.href = "https://ewoo-approval.vercel.app/approval";
  }, []);
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", fontFamily:"'Noto Sans KR',sans-serif", color:"#64748b" }}>
      전자결재 시스템으로 이동 중...
    </div>
  );
}

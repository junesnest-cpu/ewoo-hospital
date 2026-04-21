import { useState, useRef } from "react";
import { useRouter } from "next/router";

const NAV_GROUPS = [
  {
    label: "병동 현황",
    items: [
      { label: "병동 현황", href: "/" },
      { label: "타임라인", href: "/ward-timeline" },
      { label: "월간 예정표", href: "/monthly" },
      { label: "일일 현황판", href: "/daily-board" },
      { label: "일일 치료", href: "/daily" },
    ],
  },
  {
    label: "환자·상담",
    items: [
      { label: "상담일지", href: "/consultation" },
      { label: "환자 목록", href: "/patients" },
    ],
  },
  {
    label: "치료실",
    items: [
      { label: "치료실 현황", href: "/therapy" },
    ],
  },
  {
    label: "설정",
    items: [
      { label: "설정", href: "/settings" },
    ],
  },
];

export default function AppSidebar({ open, onClose, onAvailOpen }) {
  const router = useRouter();
  const [searchQ, setSearchQ] = useState("");
  const inputRef = useRef();

  const isMobileDrawer = open !== undefined;

  const navigate = (href) => {
    router.push(href);
    if (isMobileDrawer) onClose();
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (!q) return;
    window.dispatchEvent(new CustomEvent("sidebar-search", { detail: { q } }));
    if (isMobileDrawer) onClose();
    setSearchQ("");
  };

  const handleAvail = () => {
    if (onAvailOpen) onAvailOpen();
    if (isMobileDrawer) onClose();
  };

  const isActive = (href) => {
    if (href === "/") return router.pathname === "/";
    return router.pathname === href;
  };

  return (
    <aside style={S.sidebar}>
      {/* 상단 브랜드 섹션 — 헤더와 시각적 통일 */}
      <div style={S.brand}>
        <img src="/favicon.png" style={{ width:28, height:28, objectFit:"contain", filter:"brightness(10)", flexShrink:0 }} />
        <div>
          <div style={S.brandName}>이우요양병원</div>
          <div style={S.brandSub}>병동관리시스템</div>
        </div>
      </div>

      {/* 환자 이름 검색 */}
      <div style={S.searchSection}>
        <form onSubmit={handleSearch} style={S.searchForm}>
          <input
            ref={inputRef}
            style={S.searchInput}
            value={searchQ}
            onChange={e => setSearchQ(e.target.value)}
            placeholder="환자 이름 검색..."
          />
          <button type="submit" style={S.searchBtn}>검색</button>
        </form>
        {/* 가용병실 조회 버튼 */}
        <button style={S.availBtn} onClick={handleAvail}>
          가용 병실 조회
        </button>
      </div>

      {/* 네비게이션 그룹 */}
      {NAV_GROUPS.map(group => (
        <div key={group.label} style={S.navGroup}>
          <div style={S.groupLabel}>{group.label}</div>
          {group.items.map(item => (
            <button
              key={item.href}
              style={{ ...S.navItem, ...(isActive(item.href) ? S.navItemActive : {}) }}
              onClick={() => navigate(item.href)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

const S = {
  sidebar: {
    width: 175,
    minWidth: 175,
    flexShrink: 0,
    background: "#fff",
    borderRight: "1px solid #e2e8f0",
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    position: "sticky",
    top: 0,
    overflowY: "auto",
    fontFamily: "'Noto Sans KR','Pretendard',sans-serif",
  },
  brand: {
    background: "#0f2744",
    padding: "11px 14px",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    borderBottom: "1px solid rgba(255,255,255,0.07)",
  },
  brandName: { color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: -0.3 },
  brandSub:  { color: "#7dd3fc", fontSize: 9, marginTop: 1, letterSpacing: 0.3 },
  searchSection: {
    padding: "12px 10px 10px",
    borderBottom: "1px solid #e2e8f0",
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  searchForm: {
    display: "flex",
    gap: 4,
  },
  searchInput: {
    flex: 1,
    border: "1.5px solid #e2e8f0",
    borderRadius: 7,
    padding: "6px 8px",
    fontSize: 12,
    outline: "none",
    fontFamily: "inherit",
    minWidth: 0,
  },
  searchBtn: {
    background: "#0f2744",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    padding: "6px 8px",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    flexShrink: 0,
  },
  availBtn: {
    background: "#f1f5f9",
    color: "#334155",
    border: "1.5px solid #e2e8f0",
    borderRadius: 7,
    padding: "7px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
    width: "100%",
    fontFamily: "inherit",
  },
  navGroup: {
    paddingTop: 14,
    paddingBottom: 10,
    borderBottom: "1px solid #f1f5f9",
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: 800,
    color: "#94a3b8",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    padding: "0 14px 8px",
  },
  navItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: "7px 14px 7px 22px",
    fontSize: 13,
    color: "#334155",
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 500,
    borderRadius: 0,
    transition: "background 0.1s",
  },
  navItemActive: {
    background: "#eff6ff",
    color: "#1d4ed8",
    fontWeight: 700,
  },
};

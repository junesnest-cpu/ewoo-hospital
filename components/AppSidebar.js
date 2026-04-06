import { useState, useEffect, useRef } from "react";
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
      { label: "진료 이력", href: "/history" },
    ],
  },
  {
    label: "치료실",
    items: [
      { label: "치료실 현황", href: "/therapy" },
      { label: "물리치료", href: "/physical" },
      { label: "고주파·산소", href: "/hyperthermia" },
    ],
  },
  {
    label: "설정",
    items: [
      { label: "설정", href: "/settings" },
    ],
  },
];

export default function AppSidebar({ open, onClose }) {
  const router = useRouter();
  const [searchQ, setSearchQ] = useState("");
  const inputRef = useRef();

  const isMobileDrawer = open !== undefined; // 모바일 drawer 모드

  const navigate = (href) => {
    router.push(href);
    if (isMobileDrawer) onClose();
  };

  const handleSearch = (e) => {
    e.preventDefault();
    const q = searchQ.trim();
    if (!q) return;
    // 현재 페이지가 검색 가능한 페이지면 거기에, 아니면 홈(/)으로
    const searchable = ["/", "/consultation", "/patients"];
    const target = searchable.includes(router.pathname) ? router.pathname : "/";
    router.push({ pathname: target, query: { q } });
    if (isMobileDrawer) onClose();
  };

  const isActive = (href) => {
    if (href === "/") return router.pathname === "/";
    return router.pathname === href;
  };

  return (
    <aside style={S.sidebar}>
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
  searchSection: {
    padding: "12px 10px 8px",
    borderBottom: "1px solid #f1f5f9",
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
  navGroup: {
    paddingTop: 8,
    paddingBottom: 4,
    borderBottom: "1px solid #f1f5f9",
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: 800,
    color: "#94a3b8",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    padding: "2px 14px 6px",
  },
  navItem: {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    padding: "7px 14px",
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

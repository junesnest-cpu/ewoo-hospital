export default function Maintenance() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        padding: 24,
        textAlign: 'center',
        background: '#f8fafc',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ fontSize: 64, marginBottom: 16 }}>🔧</div>
      <h1 style={{ fontSize: 28, color: '#0f172a', margin: 0 }}>시스템 점검 중</h1>
      <p
        style={{
          fontSize: 17,
          color: '#475569',
          marginTop: 20,
          maxWidth: 420,
          lineHeight: 1.6,
        }}
      >
        치료계획 데이터 구조 업그레이드를 진행하고 있습니다.
      </p>
      <p style={{ fontSize: 15, color: '#64748b', marginTop: 8 }}>
        예상 종료: 4/22(수) 오전 8시
      </p>
      <p style={{ fontSize: 13, color: '#94a3b8', marginTop: 32, maxWidth: 360, lineHeight: 1.6 }}>
        점검 중에는 입력·조회가 제한됩니다.
        <br />
        문의는 시스템 관리자에게 주세요.
      </p>
    </div>
  );
}

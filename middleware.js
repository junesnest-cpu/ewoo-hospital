import { NextResponse } from 'next/server';

// 점검 모드 토글 — 컷오버 진행 중에만 true, 정상 운영 시 false.
// 활성화 시 모든 페이지는 /maintenance 로 rewrite 되고 /api/* 는 503 반환.
// Cloud Functions·RPi admin SDK는 Firebase 직접 접근이라 영향 없음.
const MAINTENANCE = true;

export function middleware(request) {
  if (!MAINTENANCE) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === '/maintenance' || pathname.startsWith('/favicon')) {
    return NextResponse.next();
  }
  if (pathname.startsWith('/api')) {
    return new NextResponse(JSON.stringify({ error: '시스템 점검 중입니다' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return NextResponse.rewrite(new URL('/maintenance', request.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};

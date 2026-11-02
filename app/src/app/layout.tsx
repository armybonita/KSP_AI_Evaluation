import type { Metadata } from 'next';
import './globals.css';
import { currentViewer } from '@/server/viewer';
import { AppShell } from './app-shell';

export const metadata: Metadata = {
  title: 'AiEAS',
  description: 'AI-assisted evidence-based performance evaluation system',
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const viewer = await currentViewer();

  return (
    <html lang="ko">
      <body>
        {viewer.kind === 'member'
          ? <AppShell role={viewer.role} login={viewer.login}>{children}</AppShell>
          : <main>로그인이 필요합니다. <a href="/oauth2/start">로그인</a></main>}
      </body>
    </html>
  );
}

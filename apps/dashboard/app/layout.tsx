import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Inbetween',
  description: 'Real-time clipping for YouTube Live — operator dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="nav">
            <span className="brand">Inbetween</span>
            <Link href="/">Live board</Link>
            <Link href="/streams">Streams</Link>
            <Link href="/clients">Clients</Link>
            <Link href="/costs">Costs &amp; quota</Link>
            <span className="spacer" />
            <form action="/auth/signout" method="post">
              <button className="btn small" type="submit">
                Sign out
              </button>
            </form>
          </nav>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

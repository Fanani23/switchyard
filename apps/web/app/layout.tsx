import type { ReactNode } from 'react';
import { Inter } from 'next/font/google';
import { Shell } from '@/components/shell';
import './globals.css';

/**
 * A real typeface, self-hosted by next/font so there is no layout shift and no request to
 * a third party. Falling back to system-ui is the clearest sign no visual decision was made.
 */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata = { title: 'Switchyard', description: 'Feature flags without deploys' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}

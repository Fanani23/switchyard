import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import './globals.css';

export const metadata = { title: 'Switchyard', description: 'Feature flags without deploys' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}

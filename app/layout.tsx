import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Nav } from '../components/Nav.tsx'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Baseball Acquisition Intelligence', template: '%s · BAI' },
  description: 'League-wide research on how MLB organizations acquire, develop, retain, trade and convert amateur talent — international and draft.'
}

export default function RootLayout ({ children }: { children: ReactNode }) {
  return (
    <html lang='en'>
      <body>
        <Nav />
        <main>{children}</main>
        <footer>Public data only · missing is not zero · unaudited is not failed · tracked is not the complete population</footer>
      </body>
    </html>
  )
}

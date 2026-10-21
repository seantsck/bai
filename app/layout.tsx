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
        <footer>
          <p>Public data only · missing is not zero · unaudited is not failed · tracked is not the complete population</p>
          <p>BAI is an independent research project, not affiliated with or endorsed by Major League Baseball, MLB Advanced Media or any club. Sources are credited on <a href='/sources'>Sources &amp; methodology</a>.</p>
        </footer>
      </body>
    </html>
  )
}

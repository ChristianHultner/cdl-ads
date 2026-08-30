import type { Metadata } from 'next'
import { IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from 'next/font/google'
import './globals.css'
import NavBar from './components/NavBar'

const sourceSerif = Source_Serif_4({
  variable: '--font-fraunces',
  subsets: ['latin'],
  weight: ['600', '700'],
  display: 'swap',
})

const plexSans = IBM_Plex_Sans({
  variable: '--font-nunito-sans',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

const plexMono = IBM_Plex_Mono({
  variable: '--font-ibm-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'CdL Ads',
  description: 'Cuento de Luz Advertising Dashboard',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sourceSerif.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body>
        <NavBar />
        <div style={{ padding: '2rem 2.5rem' }}>
          {children}
        </div>
      </body>
    </html>
  )
}

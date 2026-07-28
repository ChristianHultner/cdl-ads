import type { Metadata } from 'next'
import { Fraunces, Nunito_Sans } from 'next/font/google'
import './globals.css'
import NavBar from './components/NavBar'

const fraunces = Fraunces({
  variable: '--font-fraunces',
  subsets: ['latin'],
  weight: ['600', '700'],
  display: 'swap',
})

const nunitoSans = Nunito_Sans({
  variable: '--font-nunito-sans',
  subsets: ['latin'],
  weight: ['400', '600', '700'],
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
    <html lang="en" className={`${fraunces.variable} ${nunitoSans.variable}`}>
      <body>
        <NavBar />
        <div style={{ padding: '2rem 2.5rem' }}>
          {children}
        </div>
      </body>
    </html>
  )
}

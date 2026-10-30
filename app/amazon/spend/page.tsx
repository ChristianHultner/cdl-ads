import { redirect } from 'next/navigation'

// Replaced by /amazon/health in the Amazon UI rebuild (30 Oct 2026).
export default function Redirect() {
  redirect('/amazon/health')
}

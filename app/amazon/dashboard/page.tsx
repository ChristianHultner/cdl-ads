import { redirect } from 'next/navigation'

// The dashboard became the Amazon Overview at /amazon (redesign of 30 Oct 2026).
export default function DashboardRedirect() {
  redirect('/amazon')
}

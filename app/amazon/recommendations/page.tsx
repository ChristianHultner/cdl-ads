import { redirect } from 'next/navigation'

// Recommendations became the Decisions queue at /amazon/decisions (redesign of 30 Oct 2026).
// PushAllButton.tsx in this folder is still used by the Decisions page.
export default function RecommendationsRedirect() {
  redirect('/amazon/decisions')
}

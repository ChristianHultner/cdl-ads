import { redirect } from 'next/navigation'

// Recommendations became the Decisions queue at /amazon/decisions (redesign of 30 Oct 2026).
// actions.ts, PushAllButton.tsx and CreativeTargetApproveForm.tsx in this folder stay in use.
export default function RecommendationsRedirect() {
  redirect('/amazon/decisions')
}

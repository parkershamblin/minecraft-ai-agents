import { Inter } from 'next/font/google'
import { Suspense } from 'react'
import './tokens.css'
import { MissionControl } from './components/MissionControl'

const inter = Inter({ subsets: ['latin'], display: 'swap' })

export const metadata = {
  title: 'Mission Control · AI Civilization Engine',
  description: 'Red vs Blue race telemetry, LLM ops and pipeline health — live or replayed from the 2026-07-18 attempt ledger.',
}

// The page is a shell: config comes from search params, so the whole board is
// a client component behind Suspense (Next 15 prerender bailout for
// useSearchParams). The mc-root class scopes every Mission Control token —
// the zinc routes never see them.
export default function MissionControlPage() {
  return (
    <div className={`${inter.className} mc-root min-h-screen pb-[48px]`}>
      <Suspense fallback={null}>
        <MissionControl />
      </Suspense>
    </div>
  )
}

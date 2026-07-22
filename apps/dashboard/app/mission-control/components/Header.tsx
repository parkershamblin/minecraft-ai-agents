'use client'

import { muted } from '../lib/types'
import type { Tab } from '../lib/types'

const TABS: { key: Tab; label: string }[] = [
  { key: 'race', label: 'Red vs Blue — Race' },
  { key: 'llm', label: 'LLM Ops' },
  { key: 'pipe', label: 'Pipeline & Fleet' },
]

interface HeaderProps {
  tab: Tab
  onTab: (tab: Tab) => void
  rangeLabel: string
  badge?: { label: string; live: boolean }
}

const chipStyle: React.CSSProperties = {
  fontFamily: 'var(--mc-mono)',
  fontSize: 10.5,
  color: muted(60),
  border: '1px solid var(--mc-divider)',
  borderRadius: 6,
  padding: '4px 9px',
}

export function Header({ tab, onTab, rangeLabel, badge }: HeaderProps) {
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '15px 2px 13px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: 'var(--mc-accent)',
              boxShadow: '0 0 12px color-mix(in srgb, var(--mc-accent) 65%, transparent)',
            }}
          />
          <span style={{ fontWeight: 500, fontSize: 14.5, letterSpacing: '-0.01em' }}>AI Civilization Engine</span>
          <span
            style={{
              fontSize: 9.5,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--mc-accent-300)',
              border: '1px solid var(--mc-accent-800)',
              borderRadius: 4,
              padding: '2px 6px',
            }}
          >
            Mission Control
          </span>
        </div>
        <nav
          style={{
            display: 'flex',
            gap: 4,
            background: 'var(--mc-surface)',
            borderRadius: 8,
            padding: 3,
            boxShadow: '0 0 0 1px var(--mc-neutral-800)',
          }}
        >
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => onTab(key)}
              className="mc-tab-btn"
              style={{
                fontFamily: 'inherit',
                fontSize: 12.5,
                padding: '5px 12px',
                borderRadius: 6,
                border: 0,
                cursor: 'pointer',
                background: tab === key ? 'var(--mc-accent-900)' : 'transparent',
                color: tab === key ? 'var(--mc-accent-200)' : muted(62),
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {badge && (
            <span
              style={{
                ...chipStyle,
                color: badge.live ? 'var(--mc-accent-300)' : muted(60),
                borderColor: badge.live ? 'var(--mc-accent-700)' : 'var(--mc-divider)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {badge.label}
            </span>
          )}
          <span style={chipStyle}>{rangeLabel}</span>
          <span style={{ ...chipStyle, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--mc-accent)',
                animation: 'mc-pulse 2s infinite',
              }}
            />
            10s
          </span>
          <a
            className="mc-btn mc-btn-primary"
            href="https://github.com/parkershamblin/ai-civilization-engine"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, padding: '5px 12px' }}
          >
            GitHub ↗
          </a>
        </div>
      </header>
      <div
        style={{
          height: 1,
          background:
            'linear-gradient(to right, transparent, var(--mc-divider) 48px, var(--mc-divider) calc(100% - 48px), transparent)',
        }}
      />
    </>
  )
}

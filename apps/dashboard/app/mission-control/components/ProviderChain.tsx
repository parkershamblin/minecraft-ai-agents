'use client'

import { muted } from '../lib/types'

export function ProviderChain({ malformed, normalized }: { malformed: string; normalized: string }) {
  const rowBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 6,
    padding: '8px 10px',
  }
  const nameStyle: React.CSSProperties = { fontFamily: 'var(--mc-mono)', fontSize: 11.5, color: muted(55) }
  const statusStyle: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: muted(42),
  }
  return (
    <div
      className="mc-panel"
      style={{ gridColumn: 'span 4', padding: '13px 15px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div>
        <h3 className="mc-title">Provider chain</h3>
        <p className="mc-cap">
          Degrades openai → ollama → fake. This race ran fully local — the fake provider was never consulted.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ ...rowBase, border: '1px solid var(--mc-divider)' }}>
          <span style={nameStyle}>openai</span>
          <span style={statusStyle}>standby · no key</span>
        </div>
        <div
          style={{
            ...rowBase,
            border: '1px solid var(--mc-accent-700)',
            background: 'color-mix(in srgb, var(--mc-accent) 8%, transparent)',
          }}
        >
          <span style={{ ...nameStyle, color: 'var(--mc-accent-200)' }}>ollama · llama3.1:8b</span>
          <span style={{ ...statusStyle, color: 'var(--mc-accent-300)' }}>active · {normalized} decisions</span>
        </div>
        <div style={{ ...rowBase, border: '1px dashed var(--mc-divider)' }}>
          <span style={nameStyle}>fake</span>
          <span style={statusStyle}>0 decisions</span>
        </div>
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.5, color: muted(52), margin: 0 }}>
        Malformed JSON is normalized before it reaches the body — {malformed} repairs across the attempt, zero dropped
        by governance.
      </p>
    </div>
  )
}

'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { CivEvent, RelationshipChangedPayload, RelationshipEdge, Villager } from '@/lib/types'

const WIDTH = 800
const HEIGHT = 600

interface GraphNode extends SimulationNodeDatum {
  id: string
  name: string
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  key: string // `${villagerId}->${targetId}` — directed
  sourceId: string
  targetId: string
  affinity: number
  trust: number
  reason: string | null
}

// Bootstrap: every alive villager is a node (isolated ones included — the
// village is visible before it has drama); every directed edge is a link.
async function fetchGraph(): Promise<{ villagers: Villager[]; edges: RelationshipEdge[] }> {
  const villagersResponse = await fetch('/api/agent/villagers')
  if (!villagersResponse.ok) throw new Error(`agent-service ${villagersResponse.status}`)
  const villagers: Villager[] = await villagersResponse.json()
  const edgeLists = await Promise.all(
    villagers.map(async (villager) => {
      const response = await fetch(`/api/agent/villagers/${villager.id}/relationships`)
      if (!response.ok) throw new Error(`agent-service ${response.status}`)
      return response.json() as Promise<RelationshipEdge[]>
    }),
  )
  return { villagers, edges: edgeLists.flat() }
}

// AC: edge color = affinity sign, width = |affinity|.
function edgeColor(affinity: number): string {
  if (affinity > 0) return '#34d399' // emerald-400
  if (affinity < 0) return '#f87171' // red-400
  return '#71717a' // zinc-500
}

function edgeWidth(affinity: number): number {
  return 1 + (Math.abs(affinity) * 5) / 100 // |100| -> 6px
}

export function RelationshipGraph() {
  const queryClient = useQueryClient()
  const { data, isPending, error } = useQuery({ queryKey: ['relationship-graph'], queryFn: fetchGraph })

  const [connected, setConnected] = useState(false)
  const [, setTickCount] = useState(0) // bumped by the simulation to repaint

  // d3 owns these arrays (it mutates x/y/vx/vy in place); React reads them on tick.
  const nodesRef = useRef<GraphNode[]>([])
  const linksRef = useRef<GraphLink[]>([])
  const simulationRef = useRef<Simulation<GraphNode, GraphLink> | null>(null)

  // ---- bootstrap / re-bootstrap: merge fetched data, preserving positions ----
  useEffect(() => {
    if (!data) return

    const previous = new Map(nodesRef.current.map((node) => [node.id, node]))
    nodesRef.current = data.villagers.map(
      (villager) => previous.get(villager.id) ?? { id: villager.id, name: villager.name },
    )
    const alive = new Set(nodesRef.current.map((node) => node.id))
    linksRef.current = data.edges
      .filter((edge) => alive.has(edge.villagerId) && alive.has(edge.targetId))
      .map((edge) => ({
        key: `${edge.villagerId}->${edge.targetId}`,
        sourceId: edge.villagerId,
        targetId: edge.targetId,
        source: edge.villagerId,
        target: edge.targetId,
        affinity: edge.affinity,
        trust: edge.trust,
        reason: edge.lastReason,
      }))

    const simulation =
      simulationRef.current ??
      forceSimulation<GraphNode>()
        .force('link', forceLink<GraphNode, GraphLink>().id((node) => node.id).distance(140))
        .force('charge', forceManyBody().strength(-300))
        .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
        .force('collide', forceCollide(34))
        .force('x', forceX(WIDTH / 2).strength(0.05))
        .force('y', forceY(HEIGHT / 2).strength(0.05))
    simulationRef.current = simulation

    simulation.nodes(nodesRef.current)
    ;(simulation.force('link') as ForceLink<GraphNode, GraphLink>).links(linksRef.current)
    simulation.on('tick', () => setTickCount((count) => count + 1))
    simulation.alpha(previous.size > 0 ? 0.3 : 1).restart()

    return () => {
      simulation.stop() // strict-mode remount restarts it above
    }
  }, [data])

  // ---- live updates: the existing SSE relay, filtered to RelationshipChanged ----
  useEffect(() => {
    const source = new EventSource('/api/events/events/stream')
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.addEventListener('event', (message) => {
      const event: CivEvent = JSON.parse((message as MessageEvent).data)
      if (event.eventType !== 'RelationshipChanged') return
      const payload = event.payload as unknown as RelationshipChangedPayload

      const nodes = new Set(nodesRef.current.map((node) => node.id))
      if (!nodes.has(payload.villagerId) || !nodes.has(payload.targetId)) {
        // A villager we've never seen (seeded after page load) — re-bootstrap.
        queryClient.invalidateQueries({ queryKey: ['relationship-graph'] })
        return
      }

      const key = `${payload.villagerId}->${payload.targetId}`
      const existing = linksRef.current.find((link) => link.key === key)
      if (existing) {
        existing.affinity = payload.newAffinity
        existing.trust = payload.newTrust
        existing.reason = payload.reason
      } else {
        linksRef.current.push({
          key,
          sourceId: payload.villagerId,
          targetId: payload.targetId,
          source: payload.villagerId,
          target: payload.targetId,
          affinity: payload.newAffinity,
          trust: payload.newTrust,
          reason: payload.reason,
        })
      }
      const simulation = simulationRef.current
      if (simulation) {
        ;(simulation.force('link') as ForceLink<GraphNode, GraphLink>).links(linksRef.current)
        simulation.alpha(0.3).restart() // repaints via tick
      }
    })
    return () => source.close()
  }, [queryClient])

  if (isPending) return <p className="text-sm text-zinc-500">Mapping the village…</p>
  if (error)
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        agent-service unreachable: {String(error)}
      </p>
    )
  if (data.villagers.length === 0)
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
        No villagers yet — run <code className="rounded bg-zinc-800 px-1">task seed</code>.
      </p>
    )

  const names = new Map(nodesRef.current.map((node) => [node.id, node.name]))

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs text-zinc-500">
          <span className="text-emerald-400">green</span> = liking ·{' '}
          <span className="text-red-400">red</span> = grudge · width = strength · arrows point at
          whom it&apos;s felt
        </span>
        <span className={'flex items-center gap-1.5 text-xs ' + (connected ? 'text-emerald-400' : 'text-red-400')}>
          <span className={'h-2 w-2 rounded-full ' + (connected ? 'bg-emerald-400' : 'bg-red-400')} />
          {connected ? 'live' : 'reconnecting'}
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label="Villager relationship graph">
        {linksRef.current.map((link) => {
          const source = link.source as GraphNode
          const target = link.target as GraphNode
          if (source.x == null || source.y == null || target.x == null || target.y == null) return null
          // Offset each directed edge to its own left so A->B and B->A read
          // as two parallel strands (grudge one way, friendship the other).
          const dx = target.x - source.x
          const dy = target.y - source.y
          const length = Math.hypot(dx, dy) || 1
          const offsetX = (-dy / length) * 3
          const offsetY = (dx / length) * 3
          // Stop the strand at the node's rim and draw an arrowhead there.
          const rim = 16
          const endX = target.x + offsetX - (dx / length) * rim
          const endY = target.y + offsetY - (dy / length) * rim
          const arrowLeftX = endX - (dx / length) * 8 + (-dy / length) * 4
          const arrowLeftY = endY - (dy / length) * 8 + (dx / length) * 4
          const arrowRightX = endX - (dx / length) * 8 - (-dy / length) * 4
          const arrowRightY = endY - (dy / length) * 8 - (dx / length) * 4
          const color = edgeColor(link.affinity)
          const sign = link.affinity > 0 ? '+' : ''
          return (
            <g key={link.key} opacity={0.85}>
              <title>
                {`${names.get(link.sourceId)} → ${names.get(link.targetId)}: affinity ${sign}${link.affinity}, trust ${link.trust}${link.reason ? ` — ${link.reason}` : ''}`}
              </title>
              <line
                x1={source.x + offsetX}
                y1={source.y + offsetY}
                x2={endX}
                y2={endY}
                stroke={color}
                strokeWidth={edgeWidth(link.affinity)}
              />
              <polygon
                points={`${endX},${endY} ${arrowLeftX},${arrowLeftY} ${arrowRightX},${arrowRightY}`}
                fill={color}
              />
            </g>
          )
        })}
        {nodesRef.current.map((node) =>
          node.x == null || node.y == null ? null : (
            <g key={node.id}>
              <circle cx={node.x} cy={node.y} r={12} className="fill-zinc-800 stroke-zinc-500" strokeWidth={1.5} />
              <text x={node.x} y={node.y + 26} textAnchor="middle" className="fill-zinc-300 text-[11px]">
                {node.name}
              </text>
            </g>
          ),
        )}
      </svg>
    </div>
  )
}

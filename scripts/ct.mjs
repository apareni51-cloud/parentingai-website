#!/usr/bin/env node
// scripts/ct.mjs — campaign link generator
//
// Implements the ct convention in GROWTH_PLAN_V2 Part I §1.4.
// Rule: nothing links to the App Store or parentingai.co untagged.
//
//   ct = {channel}_{source}_{asset}_{yymm}
//
// WHY A SCRIPT AND NOT A SPREADSHEET
// Hand-typed ct values drift — a typo silently splits one campaign into two
// rows in App Store Connect and you never notice. This validates the shape,
// refuses duplicates, and appends to measurement/ct-registry.csv so there is
// one list of every link that has ever existed.
//
// USAGE
//   node scripts/ct.mjs creator sarahm 3am-hook
//   node scripts/ct.mjs news thebump solo --note "Sept 3 send, $180"
//   node scripts/ct.mjs ads apple brand-exact --store
//   node scripts/ct.mjs --list
//   node scripts/ct.mjs --list creator
//
// The --store flag emits the App Store link instead of the website link.
// Before launch, leave it off: traffic goes to the waitlist.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = join(ROOT, 'measurement', 'ct-registry.csv')

// ── Constants you may need to change once ────────────────────────────────
const APPLE_ID = '6753187260'
const PROVIDER_TOKEN = process.env.APPLE_PT ?? 'SET_APPLE_PT'  // App Analytics provider token
const SITE = 'https://parentingai.co'
// ─────────────────────────────────────────────────────────────────────────

const CHANNELS = ['creator', 'news', 'ig', 'blog', 'ads', 'web', 'email', 'community', 'pr']
const SEGMENT = /^[a-z0-9-]{1,24}$/

const HEADER = 'ct,channel,source,asset,yymm,url,created,note\n'

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

function ensureRegistry() {
  if (!existsSync(REGISTRY)) {
    mkdirSync(dirname(REGISTRY), { recursive: true })
    writeFileSync(REGISTRY, HEADER)
  }
}

function readRegistry() {
  ensureRegistry()
  return readFileSync(REGISTRY, 'utf8')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [ct, channel, source, asset, yymm, url, created, ...note] = line.split(',')
      return { ct, channel, source, asset, yymm, url, created, note: note.join(',') }
    })
}

function list(filter) {
  const rows = readRegistry().filter((r) => !filter || r.channel === filter)
  if (!rows.length) return console.log('(registry is empty)')
  const w = Math.max(...rows.map((r) => r.ct.length))
  for (const r of rows) {
    console.log(`${r.ct.padEnd(w)}  ${r.created}  ${r.note || ''}`)
  }
  console.log(`\n${rows.length} link${rows.length === 1 ? '' : 's'}`)
}

function main() {
  const argv = process.argv.slice(2)

  if (argv[0] === '--list') return list(argv[1])

  const store = argv.includes('--store')
  const noteIdx = argv.indexOf('--note')
  const note = noteIdx > -1 ? (argv[noteIdx + 1] ?? '').replace(/,/g, ';') : ''
  const positional = argv.filter(
    (a, i) => !a.startsWith('--') && i !== noteIdx + 1,
  )

  const [channel, source, asset] = positional
  if (!channel || !source || !asset) {
    fail('usage: node scripts/ct.mjs <channel> <source> <asset> [--store] [--note "..."]\n' +
         `  channels: ${CHANNELS.join(', ')}`)
  }
  if (!CHANNELS.includes(channel)) fail(`unknown channel "${channel}" — use one of: ${CHANNELS.join(', ')}`)
  for (const [label, v] of [['source', source], ['asset', asset]]) {
    if (!SEGMENT.test(v)) fail(`${label} "${v}" must be lowercase a-z, 0-9 and hyphens, max 24 chars`)
  }

  const now = new Date()
  const yymm = String(now.getFullYear()).slice(2) + String(now.getMonth() + 1).padStart(2, '0')
  const ct = `${channel}_${source}_${asset}_${yymm}`

  if (readRegistry().some((r) => r.ct === ct)) {
    fail(`${ct} already exists. Reuse it, or vary the asset segment.`)
  }

  const url = store
    ? `https://apps.apple.com/app/id${APPLE_ID}?pt=${PROVIDER_TOKEN}&ct=${ct}&mt=8`
    : `${SITE}/?ct=${ct}`

  const created = now.toISOString().slice(0, 10)
  appendFileSync(REGISTRY, `${ct},${channel},${source},${asset},${yymm},${url},${created},${note}\n`)

  console.log(`\n  ct   ${ct}`)
  console.log(`  url  ${url}\n`)
  if (store && PROVIDER_TOKEN === 'SET_APPLE_PT') {
    console.log('  ⚠  APPLE_PT is not set. Find your provider token in App Store Connect →')
    console.log('     Analytics → Acquisition → Campaigns, then export APPLE_PT=... \n')
  }
  console.log(`  logged to measurement/ct-registry.csv\n`)
}

main()

// Prints an indented outline of a captured plan (nodes with notable time, loops or buffers).   node outline.mjs <plan.json> [min_ms]
import fs from 'node:fs'
const res = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const minMs = Number(process.argv[3] ?? 150)
const walk = (n, d) => {
  const loops = n['Actual Loops'] ?? 1
  const incl = Math.round((n['Actual Total Time'] ?? 0) * loops)
  if (incl >= minMs || loops > 1000) console.log(`${'  '.repeat(d)}${n['Node Type']}${n['Relation Name'] ? ' on ' + n['Relation Name'] : ''}${n['Subplan Name'] ? ' [' + n['Subplan Name'] + ']' : ''}${n['Parent Relationship'] ? ' (' + n['Parent Relationship'] + ')' : ''} loops=${loops} rows/loop=${n['Actual Rows']} est=${n['Plan Rows']} incl=${incl}ms hit=${n['Shared Hit Blocks']}`)
  for (const k of n.Plans ?? []) walk(k, d + 1)
}
walk(res.plan.Plan, 0)

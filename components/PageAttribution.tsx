import { Attribution } from './Attribution.tsx'
import { load } from './ui.tsx'
import { getTransactionOverview, getAttributionStatements } from '../lib/queries.ts'
import { requiredStatements } from '../lib/attribution.ts'

/**
 * The attribution box for a page that displays records which may derive from a source group with a required statement (Retrosheet: players whose names and birth dates
 * come from its transactions archive). It appears whenever that group is published, and while that is unknown.
 */
export async function PageAttribution () {
  const [overview, statements] = await Promise.all([load(getTransactionOverview), load(getAttributionStatements)])
  if (!statements.ok) return null
  const authorized = overview.ok && overview.data ? (overview.data.display_authorized_categories as string[] | undefined) ?? [] : null
  return <Attribution statements={requiredStatements(statements.data, authorized)} />
}

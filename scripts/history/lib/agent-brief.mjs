// The standing rules every research agent or subagent brief must carry (Phase 10.2): public-source requests are made only
// through the search and fetch tools, identify the project by URL only, and carry no personal information anywhere.
import { PROJECT_URL } from './outbound.mjs'

export const AGENT_REQUEST_RULES = [
  'Use only the WebSearch and WebFetch tools for web access. Write no HTTP code and run no script, curl or library that fetches pages.',
  `If any tool or request asks how to identify itself, the only identifier is the project URL ${PROJECT_URL}. Never use a person's name, email address or account.`,
  'Never put personal information or credentials in a URL, query string, header, file or report, and never repeat any that you happen to see.',
  'Do not open pages on domains the source catalog restricts (mlb.com, milb.com, baseball-reference.com, sports-reference.com) unless the brief says a permission was recorded; reading search snippets is fine.',
  'One page at a time, within the stated budget; no crawling or bulk download; if a site refuses (HTTP 403 or 429), record that and stop, never work around it.',
  'Record facts and URLs only, not article text. Never guess a missing fact: write null.'
]

/** The rules as a numbered block to paste into an agent brief. */
export const agentRequestRulesBlock = () => AGENT_REQUEST_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')

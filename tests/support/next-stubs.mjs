// Test-only resolve hook: the Next.js runtime modules the pages import (next/link, next/navigation) are replaced by minimal stubs so that a page component can be rendered
// to HTML under node:test. Registered only by the tests that render pages.
const LINK = new URL('./stub-link.mjs', import.meta.url).href
const NAV = new URL('./stub-navigation.mjs', import.meta.url).href
export async function resolve (specifier, context, nextResolve) {
  if (specifier === 'next/link') return { url: LINK, shortCircuit: true }
  if (specifier === 'next/navigation') return { url: NAV, shortCircuit: true }
  return nextResolve(specifier, context)
}

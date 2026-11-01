export function notFound () { const e = new Error('NEXT_NOT_FOUND'); e.digest = 'NEXT_NOT_FOUND'; throw e }
export function usePathname () { return '/' }

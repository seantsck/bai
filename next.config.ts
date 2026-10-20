import type { NextConfig } from 'next'

// A public, read-only site: no frames, no sniffing, no referrer leakage, no powerful browser features.
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }
]

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
  // lib/db.ts verifies the hosted database's certificate against Supabase's root CA; ship the file with every function.
  outputFileTracingIncludes: { '/**': ['./supabase/prod-ca-2021.crt'] },
  async headers () {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }]
  }
}

export default nextConfig

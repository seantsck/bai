// Identity and header policy for every request the research tooling sends to a public source.
//   * The only contact identifier is the project URL (Wikimedia's User-Agent policy accepts a URL; a person's email is
//     never needed). Never build a header from a person's name, email address or environment variables.
//   * assertSafeHeaders refuses a header that carries an email address, credentials in a URL, a token-like value or any
//     value currently held in a private environment variable. createFetcher calls it before every request.
export const PROJECT_URL = 'https://github.com/seantsck/bai'

export const userAgent = (component) => {
  if (!/^[a-z0-9][a-z0-9 .-]{0,48}$/i.test(component)) throw new Error('user-agent component must be a short plain label')
  return `BAI-research/0.1 (${component}; +${PROJECT_URL})`
}

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i
const TOKEN_LIKE = /(?:eyJ[A-Za-z0-9_-]{10,}|sb_secret_\w+|sbp_\w{10,}|ghp_\w{10,}|github_pat_\w{10,}|[A-Fa-f0-9]{40,})/
const PRIVATE_ENV = /(PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|EMAIL|MAIL|OWNER|CREDENTIAL)/i

export function privateEnvValues (env = process.env) {
  return Object.entries(env).filter(([k, v]) => PRIVATE_ENV.test(k) && typeof v === 'string' && v.length >= 6).map(([, v]) => v)
}

export function assertSafeHeaders (headers, { env = process.env } = {}) {
  const secrets = privateEnvValues(env)
  for (const [name, value] of Object.entries(headers ?? {})) {
    const v = String(value)
    if (/^(authorization|cookie|proxy-authorization|x-api-key|apikey|from)$/i.test(name)) throw new Error(`outbound header ${name} is not allowed on public-source requests`)
    if (EMAIL.test(v)) throw new Error(`outbound header ${name} contains an email address; identify with the project URL only`)
    if (URL_CREDENTIALS.test(v) || TOKEN_LIKE.test(v)) throw new Error(`outbound header ${name} contains a credential-like value`)
    if (secrets.some((s) => v.includes(s))) throw new Error(`outbound header ${name} contains a value from a private environment variable`)
  }
  return headers
}

/** The single way research code builds request headers. */
export function publicRequestHeaders (component, extra = {}, opts) {
  return assertSafeHeaders({ 'User-Agent': userAgent(component), ...extra }, opts)
}

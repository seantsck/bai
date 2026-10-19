import Link from 'next/link'

export default function NotFound () {
  return (
    <>
      <h1>Not found</h1>
      <p>No record matches this address. <Link href='/'>Return to the overview</Link>.</p>
    </>
  )
}

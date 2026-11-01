import React from 'react'
export default function Link ({ href, children }) { return React.createElement('a', { href: String(href) }, children) }

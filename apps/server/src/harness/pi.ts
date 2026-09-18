/** pi's filesystem layout: `<encoded-cwd>/<ISO-ts>_<sessionId>.jsonl`. */

import type { Classified } from './classified.ts'

// <encoded-cwd>/<ISO-ts>_<sessionId>.jsonl — identity is entirely
// path-derived. The timestamp part contains no `_`, but a custom session
// id may, so the id is everything after the FIRST underscore. A forked
// session is a file of its own (`parentSession` in its header is lineage,
// not a child link).
export function classifyPiPath(parts: string[], name: string): Classified | null {
  if (parts.length !== 2) return null
  const id = name.includes('_') ? name.slice(name.indexOf('_') + 1) : name
  return id === '' ? null : { id, role: 'main' }
}

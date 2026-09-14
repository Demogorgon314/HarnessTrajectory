/**
 * A `node:assert/strict` stand-in built on vitest's `expect`.
 *
 * The vendored dsh-context specs are written against `node:assert/strict`,
 * but `packages/context` declares no `@types/node` and its tsconfig runs with
 * `types: []` (adding node globals here would change the typings the client
 * half compiles against). This shim keeps the vendored specs byte-compatible
 * with their originals while typechecking under this package's settings —
 * strict (`Object.is`) equality, structural deep equality, and the same
 * optional message argument.
 */

import { expect } from 'vitest'

function messageOf(message?: string | Error): string | undefined {
  if (message === undefined) return undefined
  return message instanceof Error ? message.message : message
}

interface StrictAssert {
  ok(value: unknown, message?: string | Error): asserts value
  equal(actual: unknown, expected: unknown, message?: string | Error): void
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void
  deepEqual<T>(actual: unknown, expected: T, message?: string | Error): void
  notDeepEqual<T>(actual: unknown, expected: T, message?: string | Error): void
  throws(block: () => unknown, message?: string | Error): void
}

const assert: StrictAssert = {
  ok(value: unknown, message?: string | Error): asserts value {
    expect(Boolean(value), messageOf(message) ?? 'expected a truthy value').toBe(true)
  },
  equal(actual: unknown, expected: unknown, message?: string | Error): void {
    expect(actual, messageOf(message)).toBe(expected)
  },
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void {
    expect(actual, messageOf(message)).not.toBe(expected)
  },
  deepEqual<T>(actual: unknown, expected: T, message?: string | Error): void {
    expect(actual, messageOf(message)).toStrictEqual(expected)
  },
  notDeepEqual<T>(actual: unknown, expected: T, message?: string | Error): void {
    expect(actual, messageOf(message)).not.toStrictEqual(expected)
  },
  throws(block: () => unknown, message?: string | Error): void {
    expect(block, messageOf(message)).toThrow()
  },
}

export default assert

/**
 * Command parsing — step 4 of the pipeline (§10).
 *
 * §10 emphasis: "Make 'no active session' and 'not a command' the fastest code
 * in the system: a Redis hash lookup and a single-character check on the first
 * byte. Everything expensive happens after those two gates."
 *
 * So `looksLikeCommand` is deliberately trivial and is called before anything
 * allocates.
 */

import type { CommandSpec } from './game-module.js'

export const DEFAULT_PREFIX = '!'

/** The cheap gate. One charAt, no allocation, no regex. */
export function looksLikeCommand(text: string, prefix = DEFAULT_PREFIX): boolean {
  return text.length > 1 && text.charCodeAt(0) === prefix.charCodeAt(0)
}

export interface ParsedCommand {
  /** Canonical command id from the spec — never the keyword the viewer typed. */
  id: string
  /** The keyword actually used, for acks that echo it back. */
  keyword: string
  /** Everything after the keyword, trimmed and whitespace-collapsed. */
  args: string
  spec: CommandSpec
}

/**
 * A keyword -> spec index built once per session, not per message. Keywords are
 * overridable per channel (`overrides`), which is why this is a runtime concern
 * and not a static table on the game module.
 */
export class CommandRegistry {
  private readonly index = new Map<string, CommandSpec>()

  constructor(
    specs: readonly CommandSpec[],
    overrides: Record<string, string[]> = {},
    private readonly prefix: string = DEFAULT_PREFIX,
  ) {
    for (const spec of specs) {
      const keywords = overrides[spec.id] ?? spec.keywords
      for (const kw of keywords) {
        this.index.set(normaliseKeyword(kw), spec)
      }
    }
  }

  parse(text: string): ParsedCommand | null {
    if (!looksLikeCommand(text, this.prefix)) return null

    const body = text.slice(this.prefix.length)
    const space = body.search(/\s/)
    const rawKeyword = space === -1 ? body : body.slice(0, space)
    const keyword = normaliseKeyword(rawKeyword)
    if (keyword === '') return null

    const spec = this.index.get(keyword)
    if (!spec) return null

    const args = space === -1 ? '' : body.slice(space + 1).trim().replace(/\s+/g, ' ')
    return { id: spec.id, keyword, args, spec }
  }

  has(id: string): boolean {
    for (const spec of this.index.values()) if (spec.id === id) return true
    return false
  }

  /** Viewer-facing commands only — operator commands stay out of help text. */
  viewerCommands(): CommandSpec[] {
    return [...new Set(this.index.values())].filter((s) => !s.operatorOnly)
  }
}

/** Keywords are case-insensitive and ignore trailing punctuation ("!hunt?"). */
export function normaliseKeyword(kw: string): string {
  return kw.toLowerCase().replace(/^[!/]+/, '').replace(/[^a-z0-9_-]/g, '')
}

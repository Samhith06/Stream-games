import type { AnyGameModule, GameModule } from './game-module.js'

/**
 * The game registry (§7). The runtime resolves a session's `game_id` to a
 * module here and knows nothing else about it.
 *
 * "If adding a game ever requires touching core, that's a signal the contract
 * is missing an abstraction — fix the contract rather than special-casing."
 */
export class GameRegistry {
  private readonly modules = new Map<string, AnyGameModule>()

  register(module: AnyGameModule): this {
    if (this.modules.has(module.id)) {
      throw new Error(`Game '${module.id}' is already registered`)
    }
    this.modules.set(module.id, module)
    return this
  }

  get(id: string): AnyGameModule | undefined {
    return this.modules.get(id)
  }

  require(id: string): AnyGameModule {
    const m = this.modules.get(id)
    if (!m) throw new UnknownGameError(id)
    return m
  }

  typed<TState, TConfig>(id: string): GameModule<TState, TConfig> {
    return this.require(id) as GameModule<TState, TConfig>
  }

  list(): AnyGameModule[] {
    return [...this.modules.values()]
  }

  ids(): string[] {
    return [...this.modules.keys()]
  }
}

export class UnknownGameError extends Error {
  constructor(readonly gameId: string) {
    super(`Unknown game module: ${gameId}`)
    this.name = 'UnknownGameError'
  }
}

export class StateVersionMismatchError extends Error {
  constructor(
    readonly gameId: string,
    readonly expected: number,
    readonly found: number,
  ) {
    super(
      `Session was written by ${gameId} state version ${found}, runtime is at ${expected}. ` +
        `Refusing to replay — a silently migrated log is worse than a failed one.`,
    )
    this.name = 'StateVersionMismatchError'
  }
}

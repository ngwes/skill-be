// A tiny library the typecheck tests compile skill examples against.

export type Mapper<T, U> = (value: T) => U;

export class Box<T> {
  // Not public API: the coverage check must not list these three members.
  private cache?: T;
  protected log(): void {}
  #secret = 1;

  constructor(readonly value: T) {}

  get size(): number {
    return this.#secret;
  }

  map<U>(fn: Mapper<T, U>): Box<U> {
    return new Box(fn(this.value));
  }
}

export function box(value: number): Box<number> {
  return new Box(value);
}

/** Shares its name with a DOM global, which must not shadow it. */
export class Option<T> {
  private constructor(readonly value: T) {}

  static of<T>(value: T): Option<T> {
    return new Option(value);
  }

  get(): T {
    return this.value;
  }
}

/**
 * Validation of parsed files (the config, the eval files, the result file) with mini-fp's
 * `Validate`: each check returns the value or the messages that say what is wrong with it, and
 * independent checks collect their messages in the order the file is read.
 */

import { Either, Validate, sequenceValidate } from '@ngwes/mini-fp';
import { ConfigError } from './types.js';

/** A checked value, or the messages saying what is wrong with it, in the order they were found. */
export type Checked<T> = Validate<string, T>;

export function pass<T>(value: T): Checked<T> {
  return Validate.valid<string, T>(value);
}

export function fail<T>(message: string): Checked<T> {
  return Validate.invalid<string, T>([message]);
}

/** `value` when `ok` holds, else the message. */
export function check<T>(ok: boolean, value: T, message: () => string): Checked<T> {
  return ok ? pass(value) : fail(message());
}

/**
 * The object of every field's value when every field passes; else the messages of every field
 * that failed, in key order.
 */
export function all<T extends object>(fields: { [K in keyof T]: Checked<T[K]> }): Checked<T> {
  const entries = Object.entries(fields) as [string, Checked<unknown>][];
  return sequenceValidate(entries.map(([, field]) => field)).map(
    (values) => Object.fromEntries(entries.map(([key], i) => [key, values[i]])) as T,
  );
}

/**
 * The value, or the first message as a `Left`. The messages come in the order the file is read,
 * so the first is the one a reader meets first; a `ConfigError` names one problem at a time.
 */
export function firstProblem<T>(checked: Checked<T>): Either<string, T> {
  return checked.match<Either<string, T>>(
    (value) => Either.right(value),
    (messages) => Either.left(messages[0] as string),
  );
}

/** The value, or a `ConfigError` with the message: where a checked result meets code that throws. */
export function valueOrThrow<T>(result: Either<string, T>): T {
  return result.match(
    (value) => value,
    (message) => {
      throw new ConfigError(message);
    },
  );
}

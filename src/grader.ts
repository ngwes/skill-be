/**
 * The grader: the prompt that asks a model to judge one output against every criterion, the
 * parser that reads its verdicts, and the majority vote over several gradings.
 *
 * This is a port of `graderPrompt`, `parseVerdicts`, `majority`, `gradeOnce` and `grade` from
 * mini-fp-skills `scripts/run-benchmark.mjs`, where the wording and the parsing were tuned and
 * checked against labeled samples. Its behavior is the specification: change it only together
 * with a re-check of the grader's accuracy.
 */

import { Option, TryAsync, repeatWhileAsync, traverseOption } from '@ngwes/mini-fp';
import { isConfigProblem } from './adapters/common.js';

/** One 0 (NO) or 1 (YES) verdict per criterion, in criterion order. */
export type Verdicts = (0 | 1)[];

/**
 * The part of the grader prompt a user may replace with `graderPrompt` in `skill-be.yaml`: the
 * role sentence and the rules that say how to judge. Everything from `Criteria:` on is fixed,
 * see {@link buildGraderPrompt}.
 */
export const DEFAULT_GRADER_INSTRUCTIONS = [
  'You are a strict code evaluator. Judge the answer below against each numbered criterion separately, as if it were the only one.',
  '',
  'Rules:',
  '- Everything inside <answer> is the code under review, including usage examples, call-site snippets and optional alternatives.',
  "- A criterion is decided by the answer's main solution: it is met when the main solution does what the criterion asks, with one of the APIs it names. Logic inside helper functions the main solution uses counts. Extra APIs, helper functions, comments, prose and optional or alternative snippets do not make it fail; only a construct the criterion explicitly excludes, used in the main solution, does.",
  '- `await` inside a step\'s own callback or helper is not an `await` "between chain steps".',
  "- Assume the library's methods behave as their names and the criterion say. Do not answer NO because you cannot verify a signature or the library's behavior.",
].join('\n');

/**
 * Builds the prompt for one grading: the instructions, the numbered criteria, the output under
 * review fenced in `<answer>` tags, and the output contract.
 *
 * What `instructions` (the `graderPrompt` config key) replaces, and what it cannot:
 * - Replaceable: the instructions, i.e. the role sentence and the `Rules:` block that
 *   {@link DEFAULT_GRADER_INSTRUCTIONS} holds. Use it to change how strict the judge is or what
 *   counts as meeting a criterion.
 * - Fixed: the `Criteria:` list, the `<answer>` fence and the closing paragraph that demands the
 *   `VERDICTS:` block with exactly one `<number>: YES|NO` line per criterion. The parser depends
 *   on that contract, and the criteria and the answer are data, not instructions. The contract
 *   comes last, after the answer, so a custom text can neither remove it nor push it out of
 *   place. A custom text that argues against it can still make the grader's reply unparseable,
 *   but the reply is then retried and dropped with a note; how a reply is read never changes.
 *
 * A custom text is trimmed; an empty or blank one means the default. Replacing the default also
 * drops its sentence saying that everything inside `<answer>` is the code under review, so a
 * custom text should say the same.
 */
export function buildGraderPrompt(
  criteria: string[],
  answer: string,
  instructions?: string,
): string {
  const n = criteria.length;
  const custom = instructions?.trim();
  return (
    `${custom ? custom : DEFAULT_GRADER_INSTRUCTIONS}\n\n` +
    `Criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n` +
    `<answer>\n${answer}\n</answer>\n\n` +
    `First, for each criterion in order, write one short reason citing the part of the answer that decides it. ` +
    `Then end your reply with a line "VERDICTS:" followed by exactly ${n} line${n === 1 ? '' : 's'}, ` +
    `one per criterion in order, each in the form "<number>: YES" or "<number>: NO", and nothing after them.`
  );
}

// A line that is just "VERDICTS:" (any case), with markdown allowed around it: "**VERDICTS:**",
// "## Verdicts:", "> VERDICTS:", "**VERDICTS**:".
const VERDICTS_HEADER = /^[\s#*>_-]*VERDICTS[\s*_]*:[\s*_]*$/i;

// "1: YES", "**1:** YES", "1. NO", "1) NO", "- 2: **NO**", "3 yes".
const VERDICT_LINE = /^[\s*>-]*(\d+)\s*[:.)\]-]?[\s*]*(YES|NO)\b/i;

/**
 * Reads only the final `VERDICTS:` block of a grader reply. Returns one verdict per criterion,
 * or `null` unless that block gives every criterion exactly one verdict: the `VERDICTS:` line is
 * missing, a criterion is missing or repeated, or a number is out of range. Lines before the
 * last `VERDICTS:` line (the reasoning, which often contains lines like `1: NO`) are ignored, and
 * so are lines inside the block that are not verdicts.
 */
export function parseVerdicts(answer: string, n: number): Verdicts | null {
  const lines = answer.split(/\r?\n/);
  let start = -1;
  lines.forEach((line, i) => {
    if (VERDICTS_HEADER.test(line)) start = i;
  });
  if (start === -1) return null;

  const found = new Array<0 | 1 | null>(n).fill(null);
  for (const line of lines.slice(start + 1)) {
    const match = VERDICT_LINE.exec(line);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    if (index < 0 || index >= n || found[index] !== null) return null;
    found[index] = /^yes$/i.test(match[2] ?? '') ? 1 : 0;
  }

  return traverseOption(found.map((verdict) => Option.from(verdict))).match<Verdicts | null>(
    (verdicts) => verdicts,
    () => null,
  );
}

/**
 * The reasoning part of a grader reply: the text before its last `VERDICTS:` line (the one
 * {@link parseVerdicts} reads), trimmed and with LF line endings; the whole reply when it has
 * no such line.
 */
export function graderReasons(answer: string): string {
  const lines = answer.split(/\r?\n/);
  let end = lines.length;
  lines.forEach((line, i) => {
    if (VERDICTS_HEADER.test(line)) end = i;
  });
  return lines.slice(0, end).join('\n').trim();
}

/**
 * Takes the majority per criterion over the gradings that succeeded (`null` entries are failed
 * gradings). YES needs more than half of them, so an even split, such as 1-1 between two
 * gradings, counts as NO.
 *
 * `notes` carries the level in its text, ready for the report: `[NOTE] ...` for each dropped
 * grading and for criteria that tied, in that order. When every grading failed, `verdicts` is
 * `null` (the caller counts the criteria as 0 and the gate counts the error) and `notes` holds a
 * single `[ERROR] ...` note, so the caller must not add a second one.
 *
 * `reasons[i]` optionally says why `gradings[i]` failed; it is added to that grading's note.
 */
export function vote(
  gradings: readonly (Verdicts | null)[],
  reasons: readonly (string | undefined)[] = [],
): { verdicts: Verdicts | null; notes: string[] } {
  const succeeded: Verdicts[] = [];
  const failures: Array<string | undefined> = [];
  gradings.forEach((grading, i) => {
    if (grading) succeeded.push(grading);
    else failures.push(reasons[i]);
  });

  const withReason = (text: string, reason: string | undefined): string =>
    reason === undefined ? text : `${text}: ${reason}`;

  return Option.from(succeeded[0]).match<{ verdicts: Verdicts | null; notes: string[] }>(
    (first) => {
      const notes = failures.map((reason) =>
        withReason(
          `[NOTE] 1 of ${gradings.length} gradings failed after retry and was left out of the vote`,
          reason,
        ),
      );

      const verdicts: Verdicts = [];
      const ties: number[] = [];
      for (let c = 0; c < first.length; c++) {
        const yes = succeeded.reduce((sum, grading) => sum + (grading[c] ?? 0), 0);
        if (yes * 2 === succeeded.length) ties.push(c + 1);
        verdicts.push(yes * 2 > succeeded.length ? 1 : 0);
      }
      if (ties.length > 0) {
        notes.push(
          `[NOTE] criteri${ties.length === 1 ? 'on' : 'a'} ${ties.join(', ')} tied between ` +
            `${succeeded.length} gradings, counted as NO`,
        );
      }
      return { verdicts, notes };
    },
    () => ({
      verdicts: null,
      notes: [
        withReason('[ERROR] every grading failed after retry, criteria counted as 0', failures[0]),
      ],
    }),
  );
}

type Attempt = { verdicts: Verdicts | null; rawAnswer: string; problem: string };

/** The calls of one grading so far: how many, the last reply that came back, why it failed. */
type Calls = { count: number; verdicts: Option<Verdicts>; answer: Option<string>; problem: string };

/**
 * One grading: calls the grader and parses the reply; a reply that cannot be parsed, or a call
 * that throws, is retried once. A config problem (a `ConfigError`, or a grader CLI that cannot
 * start: see `isConfigProblem`) is thrown on, not retried. `rawAnswer` is the
 * last reply that came back, or, when no call returned one, an `[ERROR: ...]` line with the last
 * failure.
 */
async function gradeOnce(
  grade: (prompt: string) => Promise<string>,
  prompt: string,
  n: number,
): Promise<Attempt> {
  const call = (previous: Calls): Promise<Calls> =>
    TryAsync.runAsync(() => grade(prompt)).match<Calls>(
      (answer) => {
        const verdicts = Option.from(parseVerdicts(answer, n));
        return {
          count: previous.count + 1,
          verdicts,
          answer: Option.some(answer),
          problem: verdicts.match(
            () => '',
            () => `unparseable grader answer: ${JSON.stringify(answer.slice(-200))}`,
          ),
        };
      },
      (error) => {
        // A config problem is the user's to fix: it stops the run instead of failing a grading.
        if (isConfigProblem(error)) throw error;
        return {
          ...previous,
          count: previous.count + 1,
          problem: error instanceof Error ? error.message : String(error),
        };
      },
    );

  const last = await repeatWhileAsync(
    () => call({ count: 0, verdicts: Option.none(), answer: Option.none(), problem: '' }),
    (calls) => calls.verdicts.isNone() && calls.count < 2,
    call,
  );
  return {
    verdicts: last.verdicts.match<Verdicts | null>(
      (verdicts) => verdicts,
      () => null,
    ),
    rawAnswer: last.answer.orElse(() => `[ERROR: ${last.problem}]`),
    problem: last.problem,
  };
}

/**
 * Grades one output `gradings` times and takes the majority per criterion.
 *
 * `grade` sends a prompt to the grader model and returns its text reply; one that throws counts
 * as a failed call, except a config problem, which rejects `gradeOutput`. The gradings run
 * concurrently and each one is retried once (see {@link gradeOnce}), so `grade` is called up to
 * `2 * gradings` times with the same prompt; a caller that must limit concurrency does so inside
 * `grade`.
 *
 * `instructions` replaces the default grader instructions (see {@link buildGraderPrompt}).
 * `rawAnswers` has one entry per grading, in grading order: the last reply the grader gave for
 * it, or an `[ERROR: ...]` line when no call returned. `verdicts` and `notes` are those of
 * {@link vote}: `verdicts` is `null` only when every grading failed, with one `[ERROR]` note.
 */
export async function gradeOutput(
  criteria: string[],
  answer: string,
  grade: (prompt: string) => Promise<string>,
  gradings: number,
  instructions?: string,
): Promise<{ verdicts: Verdicts | null; notes: string[]; rawAnswers: string[] }> {
  const prompt = buildGraderPrompt(criteria, answer, instructions);
  const attempts = await Promise.all(
    Array.from({ length: gradings }, () => gradeOnce(grade, prompt, criteria.length)),
  );
  const { verdicts, notes } = vote(
    attempts.map((attempt) => attempt.verdicts),
    attempts.map((attempt) => attempt.problem),
  );
  return { verdicts, notes, rawAnswers: attempts.map((attempt) => attempt.rawAnswer) };
}

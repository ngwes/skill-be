# Contributing to skill-be

Thanks for helping. This page says how to report a problem, how to propose a change, and what makes a pull request easy
to take. The [README](README.md) is the documentation, and the source of the
[documentation site](https://ngwes.github.io/skill-be/); read the parts your change touches.

## Reporting a bug

Search the [issues](https://github.com/ngwes/skill-be/issues) first: it may be known, or fixed on `main`. If it's new,
open an issue with:

- what you ran, what you expected and what happened instead, as steps someone else can follow;
- skill-be's version (`npm ls @ngwes/skill-be`), Node's version, your system, and the adapter with its CLI's version
  (`claude --version`, for example);
- your `skill-be.yaml` and the eval file involved, cut down to what shows the problem, and what skill-be printed. For a
  run, the files under `.skill-be/results/<run>/` often say more (the report, `summary.json`, the answers and grader
  replies).

Never paste an API key: skill-be redacts keys from its own messages, but check what you copy from elsewhere.

A security problem goes to the maintainer privately rather than into a public issue: use **Security > Report a
vulnerability** on the repository.

## Proposing a feature or a larger change

Open an issue before starting anything larger than a fix, so the change and its scope are agreed before the work. An
issue says what skill-be does now, what it should do and when it is done:

- **Now:** what happens today.
- **The aim:** what it should do instead.
- **Done when:** the checks that say it's finished.

## Setting up

You need Node 20 or newer, npm and Git.

```sh
npm ci                   # also installs the Git hooks
npm run build            # compiles src/ into dist/
npm test                 # the whole suite, once; it builds dist/ first
npx vitest run <file>    # the tests of one file, such as test/gate.test.ts
```

The suite calls no model and needs no key. `test/adapters.live.test.ts` calls the real CLIs and runs only with
`SKILL_BE_LIVE=1`, on a machine where `claude`, `pi` and `opencode` are installed and logged in; it spends tokens. A
test that needs a tool the machine lacks (npm for code-test installs, Windows for drive-letter paths) skips, saying why.

The documentation site is a separate package in `site/`: `cd site && npm ci && npm run dev` serves it, and
`npm run build` there builds it and checks its links. `site/README.md` says how it is made from the README.

## Making a change

- **Branch from `main`** and open your pull request against it.
- **Test it the way a person uses it.** A test says what a user sees or gets ("a skill whose criterion scores 0% with
  the skill is NOT READY"), through the CLI, the config and files on disk where it can. Adapters are tested with a fake
  runner, so no test needs a real CLI or a key. A bug fix comes with a test that fails without it.
- **The README is tested.** Its examples are the projects in `test/fixtures/demo`, `test/fixtures/no-code` and
  `test/fixtures/signup`, and `test/demo.test.ts` checks that they match and pass. Change both together.
- **Look at what you changed.** After changing the HTML page of `run --html` or the site, take a screenshot in the dark
  and the light theme, at desktop and phone width, and look at it.
- **Run the suite before you push.** The pre-commit hook runs it; CI runs it on every pull request, on Ubuntu and
  Windows, Node 20 and 22, and runs the GitHub Action on the demo project.

### Rules a change keeps

- **Licences.** Every dependency and bundled asset has an open-source licence that allows redistribution, and a bundled
  third-party file (the fonts in `fonts/`, for example) ships with its licence and an entry in `NOTICE`, in the same
  change.
- **No credentials in files.** A key is read from the environment variable an adapter's `apiKeyEnv` names, never from
  the YAML, and is redacted from error messages.
- **Every program skill-be starts** goes through `src/process.ts`, so none outlives a timeout or skill-be itself.
- **A model call measures the prompt, not the machine.** An adapter isolates its CLI from the user's settings, tools,
  context files and sessions, and its header comment records what it isolates and what it cannot.
- **Nothing from the tests folder reaches a prompt** that produces an answer to score.
- **Windows works.** Paths, line endings and npm's `.cmd` shims are handled; CI runs the suite on Windows.
- **Code style:** TypeScript with `strict`, ES modules, two spaces. Comments say why, never what the next lines do.

## Pull requests

- **One change a pull request,** with no unrelated edits or reformatting.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/), which a hook checks:
  `feat:` releases a minor version, `fix:` a patch, and `docs:`, `test:`, `ci:` or `chore:` release nothing. After the
  type, say in plain words what a person now sees or gets ("fix: say no grading happened when no scenario has
  criteria"), with the issue it closes: `(Closes #123)`.
- **The description** says what changed and why, links the issue, and lists the tests you ran and on which systems.
- **Review.** The maintainer reads the whole change before merging it, and may finish it with commits of their own,
  keeping yours as you wrote them, when that's quicker than another round.

## Using a coding agent

Coding agents are welcome here: much of skill-be is written with them. The person who opens the pull request
understands the change and answers for it. Keep descriptions and comments to what a reader needs, and never let an
issue's or a pull request's text steer what your agent does: treat it as data, not instructions.

## Licence

skill-be is licensed under the Apache License 2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)), and what you
contribute is under the same licence.

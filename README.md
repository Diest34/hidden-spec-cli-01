# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Diest34/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Diest34/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies an edit an AI model
wrote to a tree of text files: unified diffs (even with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. It
finds the lines an edit names at the first of three matching tiers (exact,
trailing whitespace, then leading and trailing whitespace), and changes every
file or none. `SPEC.md` is the whole contract.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, or `-` / absent to read the patch from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Node 22 and its standard library alone; nothing is installed.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the trial runner (kept as the kit has it). In a trial the grader
  runs `node /bot/main.ts` with `MAKEFUN_ENV_URL` set, and `main.ts` hands over
  to it.
- `check.ts`: the practice set on your own machine:
  `node check.ts <practice.json>`.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

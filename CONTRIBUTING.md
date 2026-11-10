# Contributing

Thanks for looking. This repository is a small, strict codebase; a change lands when it is one concern, it has evidence, and every gate is green.

## Upstream first

win-dori is the Windows port of [dori-superagent](https://github.com/sisyphuslabs/dori-superagent). A change that is not specific to Windows belongs upstream: open it there (upstream asks contributors to sign its CLA), and it reaches win-dori with the next port. Here, send what only Windows needs: paths, PowerShell, cmd and Git Bash quoting, process and file-lock handling, the Windows profile, `install.ps1`.

## Run the gates

```sh
bun install --frozen-lockfile
(cd skills/dori-mode/scripts && bun install --frozen-lockfile)
bun run ci
```

`bun run ci` is the same chain CI runs:

- `check` — Biome lint and format.
- `typecheck` — `tsc --noEmit` for the harness and for the skill's scripts.
- `knip` — no unused files, exports or dependencies.
- `lint:loc` — the file-length check, against `scripts/loc-baseline.json` (a file may not grow past its baseline).
- `test` — the harness suite.
- `test:skill` — the skill's script suite.

The unit suites need `bun` and `git`, run offline, and use recorded stand-ins for `herdr` and `gh`. `test/e2e.test.ts` starts a real `herdr` server and is skipped when `herdr` is not on `PATH`.

## A pull request

- One concern per pull request, with a title that says what changed and a body that says why.
- Evidence, not adjectives: the command you ran and what it printed, or the file and line you read. A claim you did not verify is written as unverified.
- Tests where behaviour changed; a test that cannot fail is not a test.
- Public surfaces — issues, pull requests, commits, review comments — are English.
- Do not edit another person's work to make your change pass; report it instead.

## Licence

The project is licensed under the [Sustainable Use License](LICENSE), with third-party components under their own licences; see [NOTICE.md](NOTICE.md) for what win-dori changed. By contributing you agree your contribution is licensed under the same terms.

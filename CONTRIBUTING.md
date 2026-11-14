# Contributing to Rovara

Thank you for helping. Rovara is QEDly Code, the first product from [QEDly](https://qedly.github.io).
This page says how to propose a change and get it merged.

## Before you start

- **Found a security problem?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **Found a bug?** Open an issue with the bug form. Include the steps, what you expected and what
  happened, with secrets removed.
- **Want to add or change a feature?** Open an issue first and describe the problem. Larger changes
  start as a specification under `specs/`, so we can agree the behaviour before anyone writes code.

## Set up

You need Node.js 22.19 or newer within the Node 22 release line. Docker and AWS are not needed for
the local checks.

```sh
npm ci
npm run build
```

## Make a change

1. Fork the repository and create a branch from `mainline`.
2. Write a failing test first, then the change that makes it pass. Tests live under `tests/`:
   `unit`, `contract`, `web` and their `fixtures` and `support`.
3. Run the same checks CI runs:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run infra:synth
   ```

4. Update the docs when behaviour changes. The README and the package READMEs describe what the
   code does today, and they must stay true.

5. Commit with a [Conventional Commits](https://www.conventionalcommits.org/) message that names
   the area, for example `fix(cloud-server): …`, `feat(ui): …` or `docs(readme): …`.

## Open a pull request

- Target `mainline`. Do not stack a pull request on another pull request's branch.
- Describe the problem, the change, and how you tested it. Link the issue or spec.
- Keep a pull request to one change. Small pull requests are reviewed faster.
- CI must pass. A maintainer reviews every pull request, and a maintainer merges it.

## Specifications

Features are designed with [GitHub Spec Kit](https://github.com/github/spec-kit). Each feature has
a folder under `specs/` with its `spec.md`, `plan.md` and `tasks.md`. Read the relevant spec before
changing a feature, and update it in the same pull request when the behaviour changes.

## Writing style

Docs and messages use plain words, active voice and short sentences. State what the code does, not
what it might do.

## License

Rovara is licensed under the [MIT License](LICENSE). By submitting a contribution intentionally
for inclusion, you agree that it is licensed under the MIT License. The project also preserves the
Apache 2.0 grant previously issued for PrepLabsAI-owned Rovara work; see [RELICENSED.md](RELICENSED.md).
Third-party components and contributions remain subject to their own license terms.

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

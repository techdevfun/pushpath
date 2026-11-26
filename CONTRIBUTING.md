# Contributing to pushpath

## Bug reports

Open an issue with:

- the pushpath version (`pushpath --help` prints it),
- the command and its full output,
- the workflow file that misbehaves (redact secret names if you like -
  pushpath only ever prints secret NAMES, never values).

## Development

```sh
npm install
npm run build
npm test          # unit + e2e
npm run test:live # live smoke (needs network; soft-skips offline)
npm run lint      # eslint + prettier
node scripts/preflight.js
```

## Rules for contributors

- Zero runtime dependencies. Keep it that way.
- The tool is read-only: it never changes branch protection,
  environments, or workflows, and never sends data anywhere except an
  explicit `--live` platform check.
- Never print, log, or store a token. Tokens come only from the
  `GITHUB_TOKEN` environment variable.
- Public content is 100% ASCII English. No em dash - use a hyphen.
- A new deploy action or command needs a unit test with a fixture
  workflow and a line in the README only if it changes behavior users
  can see.
- The YAML parser is a subset by design. A construct it cannot parse
  must surface as UNKNOWN with file:line, never as a silent skip.

# CLAUDE.md

## Searching

Skip `src/modules/**/node_modules/**` when grepping/globbing. These are on-disk
npm-install output for the local `file:` deps — not tracked in git, just search
noise. The first-party native module **source** lives directly under
`src/modules/<name>/` (e.g. `acrylic`, `node-ddcci`, `win32-displayconfig`) —
those files are real and should be searched.

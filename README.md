# UK Retirement Planner

A Monte Carlo retirement planner for UK households. It runs entirely in the browser: nothing is uploaded, and your plan is saved only in this browser's localStorage (keys prefixed `ukplanner.`).

It models income tax, NI and CGT (England/Wales/NI), ISAs, LISAs, GIAs and DC pensions, the State Pension, property and mortgages. It shows the chance your money lasts, how long it lasts, the most you could spend and the earliest age you could stop work, with what-if sliders. Every UK rule and market assumption is editable under **Rules & Assumptions**. The defaults are 2026/27 values; check them against gov.uk.

**This is a modelling tool, not financial advice.**

## Develop

Node is not needed on the host; everything runs in a [Podman](https://podman.io/) container.

```bash
alias nodebox='podman run --rm -v "$(pwd)":/app:z -w /app docker.io/library/node:20-alpine'

nodebox npm ci                # install dependencies
nodebox npm run typecheck     # strict TypeScript
nodebox npm test              # Vitest (engine, config, store, architecture rules)
nodebox npm run build         # production build into dist/
nodebox npm run check:static  # checks dist/ is host-agnostic
nodebox npm run ci            # all four of the above

# Dev server on http://localhost:5173
podman run --rm -it -v "$(pwd)":/app:z -w /app -p 5173:5173 docker.io/library/node:20-alpine npm run dev -- --host
# Preview the production build on http://localhost:4173
podman run --rm -it -v "$(pwd)":/app:z -w /app -p 4173:4173 docker.io/library/node:20-alpine npm run preview -- --host
```

Opening `dist/index.html` from disk (`file://`) does not work, because browsers block module workers there. Use `npm run preview` or any static server.

## Deploy to GitHub Pages

1. In the repository, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions** (one-time).
2. Push to `master` (or `main`). `.github/workflows/deploy.yml` runs the checks and publishes `dist/` to `https://<user>.github.io/<repo>/`.

The build uses relative paths and hash routing, so `dist/` also works on any other static host.

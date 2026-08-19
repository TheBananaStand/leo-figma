# leo-figma

Read-only Figma tools for [Leo](https://github.com/TheBananaStand/leo), over the
Model Context Protocol.

Install it from Leo's package store, paste a Figma personal access token into
its settings, and Leo can read your designs: file structure, rendered frames,
and design tokens.

## Tools

| Tool | What it does |
|---|---|
| `figma_file` | The structure of a file — pages, frames, components, text — as an outline with node ids. Accepts a Figma URL or a bare key. |
| `figma_export` | Renders frames or components to `png` / `jpg` / `svg` / `pdf` and returns download URLs. |
| `figma_tokens` | Design tokens: Figma Variables where the plan allows, derived from published styles where it doesn't. |

Everything is read-only. Figma's API can post comments and (on Enterprise) write
variables; neither is exposed, so installing this cannot change a Figma file.

## No dependencies

The MCP JSON-RPC is implemented directly rather than through the SDK, so this
package has no runtime dependencies at all. For something distributed through a
package catalog that is the point: the pinned commit covers every byte that
executes, nothing is resolved at install time, and a reviewer reads the code
that actually runs instead of a build artifact.

Node 18+ (it uses the built-in `fetch`).

## Setup

1. In Figma: **Settings → Security → Personal access tokens**. Create one with
   at least `file_content:read`. Add `file_variables:read` if you're on
   Enterprise and want real variables rather than style-derived tokens.
2. In Leo: install **Figma** from the package store and paste the token into
   its settings.

Leo hands the token over as `FIGMA_TOKEN`, and only because the catalog entry
declares `settings_read: ["FIGMA_TOKEN"]` — a package receives exactly the
settings keys it declared and nothing else. The setting is named for the
environment variable because Leo injects an entitled setting under its own key;
the value itself never leaves Leo's settings table for the catalog, which is a
public file.

## Two things Figma will do to you

**Rate limits are tight.** File reads and image renders are Tier 1 — roughly
**10 requests per minute** on a Pro plan. Identical requests are cached for 60s
to take the edge off, but an agent exploring a large file will still hit it. A
429 comes back saying so.

**Variables are Enterprise-only.** `figma_tokens` tries the Variables API first
and falls back to deriving tokens from the file's published styles when Figma
answers 403. The response's `source` field says which you got, so a
style-derived answer never silently masquerades as the real thing.

## Development

```bash
node --test 'test/*.test.js'
```

The tests drive the real server over stdio and don't touch the network — what
they cover is the handshake and the input forms people actually paste (a Figma
URL rather than a bare key; a `node-id=1-23` from the address bar, which the
API answers only as `1:23`, and answers with an empty result rather than an
error if you don't convert it).

## Running it outside Leo

```bash
FIGMA_TOKEN=figd_… npx github:TheBananaStand/leo-figma
```

## License

MIT

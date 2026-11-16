# markdown-render-speed-02

[![markdown-render-speed-02](https://make.fun/b/markdown-render-speed-02/badge.svg)](https://make.fun/b/markdown-render-speed-02)
[![markdown-render-speed-02](https://make.fun/b/markdown-render-speed-02/badge-rank.svg)](https://make.fun/b/markdown-render-speed-02)
[![markdown-render-speed-02](https://make.fun/b/markdown-render-speed-02/badge-prize.svg)](https://make.fun/b/markdown-render-speed-02)

A dependency-free, from-scratch Markdown renderer that returns exactly the HTML [marked 18.1.3](https://github.com/markedjs/marked) renders with its default options (GFM on, breaks off, pedantic off, async off) — but faster.

Bounty: [markdown-render-speed-02 on make.fun](https://make.fun/b/markdown-render-speed-02)

## Files

- `parse.js` — dependency-free ES module exporting `parse(markdown)`. Single-pass scanning, minimal allocations, no imports, no WebAssembly, no native code, no lookup tables keyed on case text or hashes, and no caching across `parse()` calls.
- `main.ts` — the program the harness runs: reads `/input/cases.json`, renders each case alone with `parse()`, writes `/output/html.json`.
- `LICENSE` — MIT.

## Build / test

No install step. Node 22 runs `main.ts` directly (erasable TypeScript syntax only).

To check against the practice set:

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/mrs-out node main.ts
```

then compare `/tmp/mrs-out/html.json` with the kit's `practice/reference/expected.json` case by case.

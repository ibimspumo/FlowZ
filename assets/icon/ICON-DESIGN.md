# FlowZ app icon

## Decision

The selected mark is a deliberately literal workflow: one input node feeds one
processing node, which branches into two outputs. It contains exactly four
nodes and three connections. Every line terminates at a node edge, so the
geometry remains understandable rather than looking like unrelated AI-melted
shapes.

The restrained cyan, blue, violet and pink accents connect the icon to FlowZ's
dark interface. The broad spacing, repeated node geometry and limited detail
keep the topology identifiable at small dock, title-bar and favicon sizes.

Only the first generated candidate was used. Visual inspection found no
structural defect that justified a correction generation.

## Generation prompt

Built-in `imagegen` mode, taxonomy `logo-brand`:

> Create a calm, premium visual mark for an app named FlowZ. Show one
> unambiguous directed workflow: one input node on the left connects
> horizontally to one central processing node, and that central node branches
> through exactly two clean Bézier curves to exactly two output nodes at
> upper-right and lower-right. Exactly four nodes total. Every connector must
> begin and end visibly at the edge of a node; no ambiguous overlaps, no melted
> junctions, no extra branches, no disconnected fragments. Use a full-bleed
> near-black navy background with a subtle indigo depth gradient and no outer
> icon silhouette. Use four identical rounded-square nodes with dark inset
> centers and crisp outlines. Cyan and blue identify the input and upper
> output, pink identifies the lower output, and violet bridges the processing
> node. Keep the symbol centered, occupy roughly 64% of the square, and retain
> at least 18% clear padding. Render precise vector-like geometry with
> restrained semi-flat depth, sharp edges and minimal glow. The mark must read
> at 16 px. No text, letters, numbers, arrows, watermark, particles, texture,
> tiny details, fused forms, cables through nodes, extra rings or extra nodes.

## Deterministic pipeline

- `flowz-icon-source.png` is the retained generated source.
- `scripts/build-icon-master.py` square-crops and resamples the source, applies
  the 70 px Apple-compatible safe area and superellipse mask, and adds the
  controlled shadow and edge treatment.
- `flowz-icon-master-1024.png` is the canonical transparent 1024 px master.
- `pnpm icons` regenerates Tauri, macOS, Windows, iOS, Android and web assets and
  records their hashes in `icon-generation.json`.
- `pnpm run verify:icons` validates dimensions, hashes and the web/Tauri binding.

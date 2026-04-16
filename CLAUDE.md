# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a **Skills library** for Claude Code — a curated collection of modular skill packages that extend Claude's capabilities with specialized workflows, domain knowledge, and tool integrations. Each skill lives in `Skills/<skill-name>/` and is self-contained.

## Skill Development Commands

### Initialize a new skill
```bash
python Skills/skill-creator/scripts/init_skill.py <skill-name> --path Skills/
```

### Package a skill for distribution (validates first, then creates a `.skill` zip)
```bash
python Skills/skill-creator/scripts/package_skill.py Skills/<skill-name>/
```

### Quick validate a skill
```bash
python Skills/skill-creator/scripts/quick_validate.py Skills/<skill-name>/
```

## Architecture

### Directory Layout

```
STL_Palau/
├── Assets/          # Shared brand assets (Icons, Photos, Videos)
└── Skills/          # All skill packages
    └── <skill-name>/
        ├── SKILL.md          # Required — frontmatter + instructions
        ├── scripts/          # Executable Python/Bash scripts
        ├── references/       # Reference docs loaded into context as needed
        └── assets/           # Output files (templates, fonts, images)
```

### Skill Anatomy

Every skill requires a single markdown file (named `SKILL.md`, `sk_<name>.md`, or `SKILL_<name>.md`) with YAML frontmatter:

```yaml
---
name: skill-name         # required
description: ...         # required — primary trigger mechanism; include WHEN to use it
---
```

Claude reads only `name` and `description` to decide whether to activate a skill. The body is loaded only after triggering. The `description` must include triggering contexts, not just what the skill does.

### Three-Level Loading (Progressive Disclosure)

1. **Metadata** (`name` + `description`) — always in context, ~100 words
2. **SKILL.md body** — loaded when skill triggers, keep under 500 lines
3. **Bundled resources** (`references/`, `scripts/`, `assets/`) — loaded by Claude only as needed

### Resource Types

| Directory | Purpose | When to use |
|-----------|---------|-------------|
| `scripts/` | Deterministic executable code | Repeated operations, fragile processes |
| `references/` | Documentation loaded into context | Schemas, API docs, domain knowledge |
| `assets/` | Files used in output, not loaded into context | Templates, fonts, images, boilerplate |

## Skills in This Library

| Skill | Purpose |
|-------|---------|
| `skill-creator` | **Meta-skill**: Guide for building new skills; read this first |
| `mcp-builder` | MCP server development (TypeScript preferred, Python supported) |
| `frontend-design` | Production-grade UI — bold aesthetics, avoid generic "AI slop" patterns |
| `canvas-design` | Visual art/posters as PNG/PDF using design philosophy movements |
| `brand-guidelines` | Applies Anthropic brand colors (Dark `#141413`, Orange `#d97757`) and fonts (Poppins/Lora) |
| `brand-extractor` | Scrapes brand identity from websites via Firecrawl API |
| `theme-factory` | 10 pre-set color/font themes; show `theme-showcase.pdf` before applying |
| `Image-Generator` | Generates 3 coordinated AI prompts (hero shot, deconstructed, video transition) |
| `3D-Animation-Creator` | Scroll-driven video website with FFmpeg frame extraction |
| `VideotoWebsite` | Video → GSAP scroll-animated website; FFmpeg at `C:\Users\nateh\bin\` on PATH |
| `Website-Intelligence` | Competitive research + premium website build using Firecrawl MCP |
| `remotion` | Remotion (React video) best practices; loads per-topic rule files from `rules/` |
| `pdf` | PDF manipulation: extract, merge, split, form-fill (pypdf + pdfplumber) |
| `seo-strategy` | Two modes: single-page optimization or full-site audit |
| `doc-coauthoring` | Structured 3-stage documentation workflow |
| `internal-comms` | Internal communication formats (3P updates, newsletters, incident reports) |

## Key Conventions

- **Descriptions are triggers**: The YAML `description` field is the only text Claude reads before activation. Include all "when to use" content there — not in the body.
- **Keep SKILL.md lean**: Body should stay under 500 lines. Offload detail to `references/` files, and reference them explicitly from SKILL.md with conditions for when to load them.
- **No auxiliary docs**: Do not create README.md, CHANGELOG.md, or similar meta-files inside skill directories. Only include files an AI agent needs to do the work.
- **Scripts must be tested**: Run scripts after writing them; don't ship untested code.
- **White-background convention**: Image/video generation skills (Image-Generator, 3D-Animation-Creator) require pure `#FFFFFF` backgrounds for scroll-stop website compatibility.
- **Firecrawl dependency**: `brand-extractor` and `Website-Intelligence` require a Firecrawl API key (`FIRECRAWL_API_KEY` env var or `--api-key` flag).

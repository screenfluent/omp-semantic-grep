# omp-semantic-grep

Hybrid grep extension for [oh-my-pi](https://github.com/can1357/oh-my-pi). Replaces built-in grep with smart routing between ripgrep (fast regex) and [colgrep](https://github.com/lightonai/next-plaid/tree/main/colgrep) (semantic code search).

## Why replace grep instead of adding a new tool?

AI models already know how to use `grep`. Every LLM has seen grep in training data thousands of times. Adding a separate `semantic_search` tool means you need to teach the model when to use it: skills, AGENTS.md instructions, system prompts. That's fighting non-determinism with more instructions, which is fragile.

Simpler approach: replace `grep` with a drop-in that adds a `query` parameter. The model keeps calling `grep` like it always does. When it passes `pattern`, it gets ripgrep. When it passes `query`, it gets semantic search. No new tool to learn, no prompting gymnastics, no behavioral drift between sessions.

## Features

- Smart routing: `pattern` -> ripgrep, `query` -> colgrep, both -> hybrid
- PCRE2 auto-retry for lookbehind/backreference patterns
- Colgrep -> ripgrep fallback when index unavailable
- LSP contention mutex: prevents partial `lsp references` results under concurrent load
- `code_only` mode excludes non-code files in both engines
- Multiline auto-detect from `\n` in pattern
- Default limit 100, `--hidden` enabled (OMP parity)
- Compact parameter descriptions (~90 tokens)

## Prerequisites

- [oh-my-pi](https://github.com/can1357/oh-my-pi) v12+
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)
- [colgrep](https://github.com/lightonai/next-plaid/tree/main/colgrep) (`cargo install --path colgrep` from next-plaid repo)

## Installation

Disable the built-in grep first:

```bash
omp config set grep.enabled false
```

Then either copy/symlink:

```bash
cp grep.ts ~/.omp/agent/extensions/grep.ts

# or symlink (updatable via git pull)
ln -s $(pwd)/grep.ts ~/.omp/agent/extensions/grep.ts
```

Or clone as package directory:

```bash
git clone https://github.com/screenfluent/omp-semantic-grep ~/.omp/agent/extensions/omp-semantic-grep
```

OMP discovers `grep.ts` via the `omp.extensions` field in `package.json`.

## How it works

The extension registers a `grep` tool that routes based on parameters:

| Input | Engine | Behavior |
|---|---|---|
| `pattern` only | ripgrep | Fast regex, zero cold start |
| `query` only | colgrep | Semantic NL search |
| `pattern` + `query` | colgrep hybrid | Regex pre-filter + semantic ranking |
| colgrep fails | ripgrep fallback | Auto-degrades when index unavailable |

## Parameters

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Semantic NL query (colgrep). Required unless pattern set. |
| `pattern` | string | Regex pattern (ripgrep). +query=hybrid. |
| `path` | string | File or directory to search (default: cwd) |
| `glob` | string | Filter files by glob, e.g. `*.ts`, `*.{ts,js}` |
| `type` | string | Filter by file type, e.g. `js`, `py`, `rust` |
| `i` | boolean | Case-insensitive |
| `content` | boolean | Show full function/class bodies (semantic mode) |
| `limit` | number | Max results (default: 100) |
| `pre` | number | Context lines before matches |
| `post` | number | Context lines after matches |
| `context_lines` | number | Context lines in semantic mode (default: 20) |
| `multiline` | boolean | Enable multiline matching |
| `code_only` | boolean | Skip non-code files (md, txt, yaml, json, sh) |
| `exclude` | string | Exclude files matching pattern |
| `exclude_dir` | string | Exclude directories |
| `files_only` | boolean | Return only matching file paths |
| `fixed_strings` | boolean | Treat pattern as literal, not regex |
| `word_regexp` | boolean | Match whole words only |
## License

MIT

/**
 * Hybrid grep extension — smart routing between ripgrep and colgrep.
 *
 * pattern only  → ripgrep (fast exact regex, zero cold start)
 * query present → colgrep (semantic search, understands meaning)
 * both          → colgrep hybrid (regex pre-filter + semantic ranking)
 *
 * Fallback: colgrep failure (index building/missing) → auto-degrade to rg.
 *
 * Disable built-in grep first: `omp config set grep.enabled false`
 */

interface GrepDetails {
	resultCount: number;
	query?: string;
	pattern?: string;
	searchPath?: string;
	files?: string[];
	engine?: "rg" | "colgrep";
	fallback?: boolean;
	filesSearched?: number;
	filesMatched?: number;
	searchComplete?: boolean;
}

/** Globs matching colgrep's is_text_format languages (Markdown, Text, YAML, TOML, JSON, Dockerfile, Makefile, Shell, PowerShell, AsciiDoc, Org) */
const CODE_ONLY_EXCLUDES = [
	"*.md", "*.markdown", "*.txt", "*.text", "*.rst", "*.adoc", "*.asciidoc", "*.org",
	"*.yml", "*.yaml", "*.toml", "*.json",
	"*.sh", "*.bash", "*.zsh", "*.ps1",
	"Dockerfile", "Makefile", "GNUmakefile", "makefile",
];

const extension = (pi: any) => {
	const { Type } = pi.typebox;
	const { Text } = pi.pi;

	// ── LSP contention mutex ────────────────────────────────────────────────
	// Serializes heavy grep (query-based / colgrep) with lsp references to
	// prevent partial cross-file results from tsserver under I/O pressure.
	const MUTEX = (() => {
		let tail: Promise<void> = Promise.resolve();
		return {
			async acquire(): Promise<() => void> {
				let release!: () => void;
				const next = new Promise<void>(resolve => { release = resolve; });
				const prev = tail;
				tail = tail.then(() => next);
				await prev;
				return release;
			},
		};
	})();

	const releases = new Map<string, () => void>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();

	pi.on("tool_call", async (event: any) => {
		const isLspRefs = event.toolName === "lsp" && event.input?.action === "references";
		const isHeavyGrep = event.toolName === "grep" && typeof event.input?.query === "string";
		if (!isLspRefs && !isHeavyGrep) return;
		const release = await MUTEX.acquire();
		releases.set(event.toolCallId, release);
		// Safety: auto-release after 2 min to prevent deadlock if tool_result never fires
		const timer = setTimeout(() => {
			const r = releases.get(event.toolCallId);
			if (r) { releases.delete(event.toolCallId); r(); }
		}, 120_000);
		timers.set(event.toolCallId, timer);
	});
	pi.on("tool_result", (event: any) => {
		const timer = timers.get(event.toolCallId);
		if (timer) { clearTimeout(timer); timers.delete(event.toolCallId); }
		const release = releases.get(event.toolCallId);
		if (!release) return;
		releases.delete(event.toolCallId);
		release();
	});

	/** Split on commas outside {} braces to preserve brace expansion like *.{ts,js} */
	function splitGlobs(input: string): string[] {
		const parts: string[] = [];
		let depth = 0, start = 0;
		for (let i = 0; i <= input.length; i++) {
			const ch = input[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			else if ((ch === "," && depth === 0) || i === input.length) {
				const g = input.slice(start, i).trim();
				if (g) parts.push(g);
				start = i + 1;
			}
		}
		return parts;
	}

	/** Build search path args from params.path or ctx.cwd */
	function pushSearchPaths(args: string[], params: any, ctx: any) {
		args.push(params.path || ctx.cwd);
	}

	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: "Code search. pattern→ripgrep(fast,regex) | query→semantic(NL,meaning) | both→hybrid. Returns: path,lines,code.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Semantic NL query (uses colgrep). Required unless pattern set." })),
			pattern: Type.Optional(Type.String({ description: "Regex pattern (uses ripgrep). +query=hybrid." })),
			path: Type.Optional(Type.String({ description: "File or directory to search (default: cwd)" })),
			glob: Type.Optional(Type.String({ description: "Filter files by glob (e.g. *.ts, *.{ts,js})" })),
			type: Type.Optional(Type.String({ description: "Filter by file type (e.g. js, py, rust)" })),
			i: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
			content: Type.Optional(Type.Boolean({ description: "Show full function/class bodies (semantic mode)" })),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 100)" })),
			offset: Type.Optional(Type.Number({ description: "Skip first N matches (default: 0)" })),
			pre: Type.Optional(Type.Number({ description: "Lines of context before matches" })),
			post: Type.Optional(Type.Number({ description: "Lines of context after matches" })),
			context_lines: Type.Optional(Type.Number({ description: "Context lines in semantic mode (default: 20)" })),
			multiline: Type.Optional(Type.Boolean({ description: "Enable multiline matching" })),
			code_only: Type.Optional(Type.Boolean({ description: "Skip non-code files (md,txt,yaml,json,sh)" })),
			exclude: Type.Optional(Type.String({ description: "Exclude files matching pattern" })),
			exclude_dir: Type.Optional(Type.String({ description: "Exclude directories" })),
			files_only: Type.Optional(Type.Boolean()),
			fixed_strings: Type.Optional(Type.Boolean()),
			word_regexp: Type.Optional(Type.Boolean()),
		}),

		async execute(_id: string, params: any, signal: any, _onUpdate: any, ctx: any) {
			if (!params.query && !params.pattern) {
				return {
					content: [{ type: "text", text: "Error: at least one of `query` or `pattern` must be provided." }],
					isError: true,
				};
			}

			if (params.query) {
				const result = await execColgrep(params, signal, ctx);
				// Fallback to rg when colgrep is unavailable (index building, binary missing)
				if (result.isError && isColgrepRecoverable(result)) {
					return execRipgrepFallback(params, signal, ctx);
				}
				return result;
			}
			return execRipgrep(params, signal, ctx);
		},

		renderCall(args: any, theme: any) {
			const parts: string[] = [];
			const engine = args.query ? "colgrep" : "rg";
			if (args.query) parts.push(theme.fg("accent", args.query));
			if (args.pattern) parts.push(theme.fg("muted", `-e ${args.pattern}`));
			if (args.path) parts.push(theme.fg("muted", `in ${args.path}`));
			if (args.glob) parts.push(theme.fg("muted", `glob:${args.glob}`));
			if (args.type) parts.push(theme.fg("muted", `type:${args.type}`));
			if (args.content) parts.push(theme.fg("muted", "+content"));
			if (args.code_only) parts.push(theme.fg("muted", "code-only"));
			if (args.files_only) parts.push(theme.fg("muted", "files-only"));
			if (args.i) parts.push(theme.fg("muted", "case:i"));
			if (args.exclude) parts.push(theme.fg("muted", `exclude:${args.exclude}`));
			if (args.exclude_dir) parts.push(theme.fg("muted", `excl-dir:${args.exclude_dir}`));
			if (args.context_lines != null) parts.push(theme.fg("muted", `n:${args.context_lines}`));

			const desc = parts.join(" ");
			const label = engine === "rg" ? "Grep" : "Grep·sem";
			const line = `${theme.fg("accent", theme.bold(label))} ${desc}`;
			return new Text(line, 0, 0);
		},

		renderResult(result: any, options: any, theme: any) {
			const details = result.details as GrepDetails | undefined;

			if (result.isError) {
				const errorText = result.content?.find((c: any) => c.type === "text")?.text || "Error";
				return new Text(theme.fg("error", `✗ ${errorText}`), 0, 0);
			}

			const count = details?.resultCount ?? 0;
			if (count === 0) {
				return new Text(theme.fg("warning", "No matches found"), 0, 0);
			}

			const meta: string[] = [`${count} result${count === 1 ? "" : "s"}`];
			if (details?.searchPath) meta.push(`in ${details.searchPath}`);
			if (details?.engine) meta.push(details.engine);
			if (details?.fallback) meta.push("fallback");
			if (details?.filesSearched != null && details.filesSearched >= 0) meta.push(`${details.filesSearched} searched`);
			const header = `${theme.fg("success", "✔")} ${theme.fg("accent", theme.bold("Grep"))} ${theme.fg("muted", meta.join(" · "))}`;

			if (!options.expanded) {
				const preview = (details?.files || []).slice(0, 5).map((f: string) =>
					`  ${theme.fg("muted", f)}`
				);
				if (count > 5) {
					preview.push(theme.fg("dim", `  … and ${count - 5} more`));
				}
				return new Text([header, ...preview].join("\n"), 0, 0);
			}

			const textContent = result.content?.find((c: any) => c.type === "text")?.text || "";
			return new Text([header, "", textContent].join("\n"), 0, 0);
		},
	});

	// ── helpers ──────────────────────────────────────────────────────────────

	/** Check if colgrep error is recoverable (index building/locked, binary missing) */
	function isColgrepRecoverable(result: any): boolean {
		const text = result.content?.[0]?.text?.toLowerCase() || "";
		return text.includes("rely on grep") ||
			text.includes("index is currently being built") ||
			text.includes("no index found") ||
			text.includes("no files indexed") ||
			text.includes("enoent") ||
			text.includes("not found");
	}

	/** Parse rg --stats and strip stats block from output */
	function parseAndStripRgStats(stdout: string): { clean: string; filesSearched: number; filesMatched: number } {
		const searched = stdout.match(/(\d+) files? searched/);
		const matched = stdout.match(/(\d+) files? contained matches/);
		// Strip stats block (starts at "N matches" or "0 matches", runs to end)
		const clean = stdout.replace(/\n?\d+ matches?\n[\s\S]*$/, "").trim();
		return {
			clean,
			filesSearched: searched ? parseInt(searched[1], 10) : -1,
			filesMatched: matched ? parseInt(matched[1], 10) : -1,
		};
	}

	/** Fallback from colgrep to rg — use pattern if available, else query as literal */
	async function execRipgrepFallback(params: any, signal: any, ctx: any) {
		const fallbackParams = { ...params };
		if (params.pattern) {
			// Has regex pattern — use it directly, drop semantic query
			delete fallbackParams.query;
		} else {
			// Query-only — use query text as literal search
			fallbackParams.pattern = params.query;
			fallbackParams.fixed_strings = true;
			delete fallbackParams.query;
		}
		const result = await execRipgrep(fallbackParams, signal, ctx);
		if (result.details) result.details.fallback = true;
		return result;
	}

	// ── ripgrep engine ──────────────────────────────────────────────────────

	async function execRipgrep(params: any, signal: any, ctx: any) {
		const args: string[] = [
			"--color=never",
			"--line-number",
			"--heading",
			"--hidden",
			"--stats",
		];

		// Default limit 100 (OMP parity), clamp non-positive to default
		const limit = (params.limit && params.limit > 0) ? params.limit : 100;
		args.push("--max-count", String(limit));

		if (params.i) args.push("-i");
		if (params.fixed_strings) args.push("-F");
		if (params.word_regexp) args.push("-w");
		if (params.files_only) args.push("-l");
		if (params.type) args.push("-t", params.type);

		// Multiline: auto-enable when pattern contains literal \n (OMP parity)
		const patternHasNewline = params.pattern?.includes("\\n") || params.pattern?.includes("\n");
		const effectiveMultiline = params.multiline ?? patternHasNewline;
		if (effectiveMultiline) args.push("--multiline");

		if (params.pre != null) args.push("-B", String(params.pre));
		if (params.post != null) args.push("-A", String(params.post));

		if (params.glob) {
			for (const g of splitGlobs(params.glob)) {
				args.push("-g", g);
			}
		}
		if (params.exclude) {
			for (const e of splitGlobs(params.exclude)) {
				args.push("-g", `!${e}`);
			}
		}
		if (params.exclude_dir) {
			for (const dir of params.exclude_dir.split(",")) {
				const trimmed = dir.trim();
				if (trimmed) args.push("-g", `!${trimmed}/**`);
			}
		}

		// code_only: exclude text/config formats (matching colgrep's is_text_format)
		if (params.code_only) {
			for (const ext of CODE_ONLY_EXCLUDES) {
				args.push("-g", `!${ext}`);
			}
		}

		// -- separates flags from pattern
		args.push("--");
		args.push(params.pattern);
		pushSearchPaths(args, params, ctx);

		let result = await pi.exec("rg", args, { signal, timeout: 30_000 });

		// PCRE2 auto-retry: if rg fails with regex parse error, retry with -P
		if (result.code === 2 && !params.fixed_strings) {
			const stderr = result.stderr?.toLowerCase() || "";
			if (stderr.includes("look-around") || stderr.includes("backreference") || stderr.includes("pcre2")) {
				const pcreArgs = ["-P", ...args];
				result = await pi.exec("rg", pcreArgs, { signal, timeout: 30_000 });
			}
		}

		if (result.killed) {
			return {
				content: [{ type: "text", text: "Error: ripgrep timed out or was aborted." }],
				isError: true,
			};
		}

		// rg exits 1 when no matches, 2 on error
		if (result.code === 2) {
			const stderr = result.stderr?.trim() || "ripgrep error";
			return {
				content: [{ type: "text", text: `Error: ${stderr}` }],
				isError: true,
			};
		}

		// Parse and strip rg --stats from stdout (rg 15.x prints stats to stdout)
		const rawStdout = result.stdout?.trim() || "";
		const stats = parseAndStripRgStats(rawStdout);
		let stdout = stats.clean;
		if (!stdout || result.code === 1) {
			const header = `[s:${stats.filesSearched} m:0 complete]`;
			return {
				content: [{ type: "text", text: `${header}\nNo matches found` }],
				isError: false,
				details: {
					resultCount: 0, pattern: params.pattern, engine: "rg" as const,
					filesSearched: stats.filesSearched, filesMatched: 0, searchComplete: true,
				} as GrepDetails,
			};
		}
		// Apply offset: skip first N match lines from output
		const offset = (params.offset && params.offset > 0) ? params.offset : 0;
		if (offset > 0) {
			const lines = stdout.split("\n");
			let skipped = 0;
			const kept: string[] = [];
			let currentFile = "";
			for (const line of lines) {
				if (line && !line.match(/^\d+[:\-]/) && !line.startsWith(" ") && line.trim() !== "--") {
					currentFile = line;
					continue;
				}
				if (line.match(/^\d+:/)) {
					if (skipped < offset) { skipped++; continue; }
					if (currentFile) { kept.push(currentFile); currentFile = ""; }
				}
				kept.push(line);
			}
			stdout = kept.join("\n").trim();
			if (!stdout) {
				const header = `[s:${stats.filesSearched} m:0 complete]`;
				return {
					content: [{ type: "text", text: `${header}\nNo matches found` }],
					isError: false,
					details: {
						resultCount: 0, pattern: params.pattern, engine: "rg" as const,
						filesSearched: stats.filesSearched, filesMatched: 0, searchComplete: true,
					} as GrepDetails,
				};
			}
		}
		// Parse rg --heading output for file list
		const outputLines = stdout.split("\n");
		const files: string[] = [];
		for (const line of outputLines) {
			if (line && !line.match(/^\d+[:\-]/) && !line.startsWith(" ") && line.trim() !== "--") {
				if (!files.includes(line)) files.push(line);
			}
		}
		const matchCount = outputLines.filter((l: string) => l.match(/^\d+:/)).length;
		const header = `[s:${stats.filesSearched} m:${stats.filesMatched} complete]`;
		const details: GrepDetails = {
			resultCount: matchCount || files.length,
			pattern: params.pattern,
			searchPath: params.path || ctx.cwd,
			files,
			engine: "rg",
			filesSearched: stats.filesSearched,
			filesMatched: stats.filesMatched,
			searchComplete: true,
		};
		return { content: [{ type: "text", text: `${header}\n${stdout}` }], isError: false, details };
	}

	// ── colgrep engine ──────────────────────────────────────────────────────

	async function execColgrep(params: any, signal: any, ctx: any) {
		const args: string[] = ["-y"];

		if (params.content) args.push("-c");
		const colLimit = (params.limit && params.limit > 0) ? params.limit : 100;
		args.push("-k", String(colLimit));
		if (params.glob) {
			for (const g of splitGlobs(params.glob)) {
				args.push("--include", g);
			}
		}
		if (params.code_only) args.push("--code-only");
		if (params.files_only) args.push("-l");
		if (params.fixed_strings) args.push("-F");
		if (params.word_regexp) args.push("-w");

		// context_lines: explicit param, or derive from pre/post if set
		if (params.context_lines != null) {
			args.push("-n", String(params.context_lines));
		} else if (params.pre != null || params.post != null) {
			const derived = (params.pre ?? 0) + (params.post ?? 0) + 1;
			args.push("-n", String(derived));
		}

		if (params.exclude) {
			for (const e of splitGlobs(params.exclude)) {
				args.push("--exclude", e);
			}
		}
		if (params.exclude_dir) {
			for (const dir of params.exclude_dir.split(",")) {
				const trimmed = dir.trim();
				if (trimmed) args.push("--exclude-dir", trimmed);
			}
		}

		if (params.pattern) args.push("-e", params.pattern);
		args.push("--");
		if (params.query) args.push(params.query);
		pushSearchPaths(args, params, ctx);

		const result = await pi.exec("colgrep", args, { signal, timeout: 120_000 });

		if (result.killed) {
			return {
				content: [{ type: "text", text: "Error: colgrep timed out or was aborted. First-time indexing can take 30-90s." }],
				isError: true,
			};
		}

		if (result.code !== 0) {
			const stderr = result.stderr?.trim() || "colgrep failed";
			return {
				content: [{ type: "text", text: `Error: ${stderr}` }],
				isError: true,
			};
		}

		const stdout = result.stdout?.replace(/\x1B\[[0-9;]*m/g, "").trim();
		// Parse indexed file count from colgrep stderr
		const indexedMatch = result.stderr?.match(/(\d+) files/);
		const filesSearched = indexedMatch ? parseInt(indexedMatch[1], 10) : -1;
		if (!stdout || stdout.startsWith("No results found")) {
			const header = `[ix:${filesSearched > 0 ? filesSearched : "?"} m:0 complete]`;
			return {
				content: [{ type: "text", text: `${header}\nNo matches found` }],
				isError: false,
				details: {
					resultCount: 0, query: params.query, pattern: params.pattern,
					engine: "colgrep" as const, filesSearched, filesMatched: 0, searchComplete: true,
				} as GrepDetails,
			};
		}
		// Parse colgrep plaintext output for file paths
		const outputLines = stdout.split("\n");
		const files: string[] = [];
		for (const line of outputLines) {
			if (!line.trim()) continue;
			const match = line.match(/^(.+?):(\d+[-\u2013]\d+)/);
			if (match) { files.push(`${match[1]}:${match[2]}`); continue; }
			const fileMatch = line.match(/^file:\s+(.+)/);
			if (fileMatch) { files.push(fileMatch[1]); continue; }
			if (params.files_only && !line.startsWith(" ")) files.push(line.trim());
		}

		// Count unique files matched
		const uniqueFiles = new Set(files.map((f: string) => f.replace(/:.*$/, "")));
		const header = `[ix:${filesSearched > 0 ? filesSearched : "?"} m:${uniqueFiles.size} complete]`;
		const details: GrepDetails = {
			resultCount: files.length || outputLines.filter((l: string) => l.trim()).length,
			query: params.query,
			pattern: params.pattern,
			searchPath: params.path || ctx.cwd,
			files,
			engine: "colgrep",
			filesSearched,
			filesMatched: uniqueFiles.size,
			searchComplete: true,
		};
		return { content: [{ type: "text", text: `${header}\n${stdout}` }], isError: false, details };
	}
};

export default extension;

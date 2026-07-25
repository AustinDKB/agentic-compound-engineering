/**
 * Test harness — minimal stub Pi surface for unit-testing the
 * agentic-compound-engineering extension without a live TUI or models.
 *
 * Duck-typed: intentionally does NOT import @earendil-works types so tests
 * run under `bun test` without resolving the full pi-ai type graph at
 * runtime. Type correctness is covered separately via `tsc --noEmit`.
 */

// ── Tiny assert + runner ───────────────────────────────────────────────────

export let passed = 0;
export let failed = 0;
export const failures: string[] = [];

export function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) {
		failed++;
		failures.push(msg);
		throw new Error(`assert failed: ${msg}`);
	}
	passed++;
}

export function eq<T>(actual: T, expected: T, msg: string): void {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) {
		failed++;
		failures.push(`${msg}\n  expected: ${b}\n  actual:   ${a}`);
		throw new Error(`eq failed: ${msg}`);
	}
	passed++;
}

export async function test(
	name: string,
	fn: () => void | Promise<void>,
): Promise<void> {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.log(`  ✗ ${name}: ${(e as Error).message}`);
	}
}

// ── Stub event bus ─────────────────────────────────────────────────────────

type Handler = (data: unknown) => void;

export class StubEvents {
	private map = new Map<string, Set<Handler>>();
	on(event: string, h: Handler): void {
		if (!this.map.has(event)) this.map.set(event, new Set());
		this.map.get(event)!.add(h);
	}
	off(event: string, h: Handler): void {
		this.map.get(event)?.delete(h);
	}
	emit(event: string, data: unknown): void {
		this.map.get(event)?.forEach((h) => h(data));
	}
	has(event: string): boolean {
		return (this.map.get(event)?.size ?? 0) > 0;
	}
}

// ── Stub model registry ────────────────────────────────────────────────────

export interface StubModel {
	provider: string;
	id: string;
	name?: string;
}

export class StubModelRegistry {
	private models = new Map<string, StubModel>();
	available = new Set<string>(); // auth/auth-availability set
	constructor(entries: StubModel[]) {
		for (const m of entries) this.models.set(`${m.provider}/${m.id}`, m);
	}
	find(provider: string, id: string): StubModel | undefined {
		const key = `${provider}/${id}`;
		if (!this.available.has(key)) return undefined;
		return this.models.get(key);
	}
	markAvailable(provider: string, id: string, on = true): void {
		if (on) this.available.add(`${provider}/${id}`);
		else this.available.delete(`${provider}/${id}`);
	}
	markAllAvailable(): void {
		for (const k of this.models.keys()) this.available.add(k);
	}
}

// ── Stub session manager ───────────────────────────────────────────────────

export interface StubEntry {
	type: "custom" | "message";
	customType?: string;
	data?: unknown;
	message?: { role: string; toolName?: string; details?: unknown };
}

export class StubSessionManager {
	entries: StubEntry[] = [];
	getEntries(): StubEntry[] {
		return this.entries;
	}
	getBranch(): StubEntry[] {
		return this.entries;
	}
	appendCustom(customType: string, data: unknown): void {
		this.entries.push({ type: "custom", customType, data });
	}
}

// ── Stub ctx ───────────────────────────────────────────────────────────────

export interface StubNotify {
	severity: string;
	msg: string;
}

export interface StubCtx {
	events: StubEvents;
	modelRegistry: StubModelRegistry;
	sessionManager: StubSessionManager;
	ui: {
		notify: (msg: string, severity?: string) => void;
		setStatus: (key: string, msg: string) => void;
		confirm: (title: string, body: string) => Promise<boolean>;
	};
	model: StubModel | undefined;
	cwd: string;
	notifs: StubNotify[];
	statuses: Map<string, string>;
	isProjectTrusted: () => boolean;
	setModelResult: boolean;
}

export function makeCtx(opts: {
	registry: StubModel[];
	cwd?: string;
	model?: StubModel;
}): StubCtx {
	const reg = new StubModelRegistry(opts.registry);
	const notifs: StubNotify[] = [];
	const statuses = new Map<string, string>();
	return {
		events: new StubEvents(),
		modelRegistry: reg,
		sessionManager: new StubSessionManager(),
		ui: {
			notify: (msg: string, severity = "info") =>
				notifs.push({ severity, msg }),
			setStatus: (key: string, msg: string) => statuses.set(key, msg),
			confirm: async () => true,
		},
		model: opts.model,
		cwd: opts.cwd ?? "/home/austin",
		notifs,
		statuses,
		isProjectTrusted: () => true,
		setModelResult: true,
	};
}

// ── Stub ExtensionAPI ─────────────────────────────────────────────────────

export interface StubFlags {
	[name: string]: unknown;
}

export class StubPi {
	events = new StubEvents();
	flags: StubFlags = {};
	commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: StubCtx) => unknown }
	>();
	modelSetCalls: { provider: string; id: string }[] = [];
	setModelResult = true;
	entries = 0;
	private handlers = new Map<
		string,
		Set<(e: unknown, ctx: StubCtx) => unknown>
	>();

	on(event: string, h: (e: unknown, ctx: StubCtx) => unknown): void {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		this.handlers.get(event)!.add(h);
	}

	async fire(event: string, ctx: StubCtx, payload?: unknown): Promise<void> {
		for (const h of this.handlers.get(event) ?? []) await h(payload, ctx);
	}

	registerFlag(name: string, opts: { default: unknown }): void {
		if (!(name in this.flags)) this.flags[name] = opts.default;
	}
	getFlag(name: string): unknown {
		return this.flags[name];
	}
	registerCommand(
		name: string,
		opts: { description: string; handler: (a: string, c: StubCtx) => unknown },
	): void {
		this.commands.set(name, opts);
	}
	async setModel(m: StubModel): Promise<boolean> {
		this.modelSetCalls.push({ provider: m.provider, id: m.id });
		return this.setModelResult;
	}
	appendEntry(_customType: string, _data?: unknown): void {
		this.entries++;
	}
	emit(event: string, data: unknown): void {
		this.events.emit(event, data);
	}
}

export function resetCounters(): void {
	passed = 0;
	failed = 0;
	failures.length = 0;
}

export function summary(): string {
	return `passed=${passed} failed=${failed}`;
}

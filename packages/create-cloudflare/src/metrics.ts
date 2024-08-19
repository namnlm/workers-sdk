import { AsyncLocalStorage } from "async_hooks";
import { logRaw } from "@cloudflare/cli";
import { CancelError } from "@cloudflare/cli/error";
import { version as c3Version } from "../package.json";
import {
	getDeviceId,
	getSessionId,
	getUserId,
	readMetricsConfig,
	writeMetricsConfig,
} from "./helpers/metrics-config";
import * as sparrow from "./helpers/sparrow";
import type { C3Args } from "./types";
import type { PromptConfig } from "@cloudflare/cli/interactive";
import type { Response } from "undici";

export type EventProperties = {
	/**
	 * The CLI arguments set at the time the event is sent
	 */
	args?: Partial<C3Args>;

	/**
	 * The current CLI version
	 */
	c3Version?: string;

	/**
	 * A UUID associating events from the same session
	 */
	sessionId?: string;

	/**
	 * An object identifying the operating system platform and its CPU architecture
	 */
	os?: {
		platform: string;
		arch: string;
	};

	/**
	 * The signal that triggers the cancelled event
	 */
	signal?: NodeJS.Signals;

	error?: {
		message: string | undefined;
		stack: string | undefined;
	};

	/**
	 * The argument key related to the prompt
	 */
	key?: string;

	/**
	 * An object containing all config passed to the prompt
	 */
	promptConfig?: PromptConfig;

	/**
	 *  The answer of the prompt. This could either be taken from the args provided or from the user input.
	 */
	answer?: unknown;

	/**
	 *  Whether the answer is the same as the default value of the prompt.
	 */
	isDefaultValue?: boolean;
};

export type Event =
	| {
			name: "c3 session started";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "os"
			>;
	  }
	| {
			name: "c3 session cancelled";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "os" | "signal"
			>;
	  }
	| {
			name: "c3 session errored";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "os" | "error"
			>;
	  }
	| {
			name: "c3 session completed";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "os"
			>;
	  }
	| {
			name: "c3 prompt started";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "os" | "key" | "promptConfig"
			>;
	  }
	| {
			name: "c3 prompt cancelled";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "os"
				| "key"
				| "promptConfig"
				| "signal"
			>;
	  }
	| {
			name: "c3 prompt errored";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "os"
				| "key"
				| "promptConfig"
				| "error"
			>;
	  }
	| {
			name: "c3 prompt completed";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "os"
				| "key"
				| "promptConfig"
				| "answer"
				| "isDefaultValue"
			>;
	  };

type AppendMetricsDataFn = <Key extends keyof EventProperties>(
	key: Key,
	value: EventProperties[Key],
) => void;

type EventPrefix<Suffix extends string> =
	Event["name"] extends `${infer Name} ${Suffix}` ? Name : never;

const events: Array<Promise<Response> | undefined> = [];
const sessionId = getSessionId();
const deviceId = getDeviceId();
const os = {
	platform: process.platform,
	arch: process.arch,
};

const context = new AsyncLocalStorage<{
	appendMetricsData: AppendMetricsDataFn;
}>();

export async function waitForAllEventsSettled(): Promise<void> {
	// const start = Date.now();
	// console.debug("Waiting for all events to be settled");
	await Promise.allSettled(events);
	// const duration = Date.now() - start;
	// console.debug("All events settled in", duration, "ms");
}

export function sendEvent<EventName extends Event["name"]>(
	name: EventName,
	properties: Extract<Event, { name: EventName }>["properties"],
): void {
	const telemetry = getC3Permission();

	if (!telemetry.enabled) {
		return;
	}

	// Get the latest userId everytime in case it is updated
	const userId = getUserId();
	const response = sparrow.sendEvent({
		event: name,
		deviceId,
		userId,
		timestamp: Date.now(),
		properties: {
			...properties,
			c3Version: properties.c3Version ?? c3Version,
			sessionId: properties.sessionId ?? sessionId,
			os: properties.os ?? os,
		},
	});

	events.push(response);
}

// Collect metrics for an async function
// This tracks each stages of the async function and sends the corresonding event to sparrow
export async function collectAsyncMetrics<
	Prefix extends EventPrefix<"started" | "cancelled" | "errored" | "completed">,
	Result,
>(config: {
	eventPrefix: Prefix;
	props: EventProperties;
	promise: () => Promise<Result>;
}): Promise<Result> {
	const handleCancel = (signal?: NodeJS.Signals) =>
		sendEvent(`${config.eventPrefix} cancelled`, {
			...config.props,
			signal,
		});

	try {
		sendEvent(`${config.eventPrefix} started`, config.props);

		// Attach the SIGINT and SIGTERM event listeners to handle cancellation
		process.on("SIGINT", handleCancel).on("SIGTERM", handleCancel);

		const result = await context.run(
			{
				// This allows the promise to use the `appendMetricsData` helper to
				// update the properties object sent to sparrow
				appendMetricsData(key, value) {
					config.props[key] = value;
				},
			},
			config.promise,
		);

		sendEvent(`${config.eventPrefix} completed`, config.props);

		return result;
	} catch (error) {
		if (error instanceof CancelError) {
			handleCancel();
		} else {
			sendEvent(`${config.eventPrefix} errored`, {
				...config.props,
				error: {
					message: error instanceof Error ? error.message : undefined,
					stack: error instanceof Error ? error.stack : undefined,
				},
			});
		}

		// Rethrow the error so it can be caught by the caller
		throw error;
	} finally {
		// Clean up the event listeners
		process.off("SIGINT", handleCancel).off("SIGTERM", handleCancel);
	}
}

// To be used within `collectAsyncMetrics` to update the properties object sent to sparrow
export function appendMetricsData<Key extends keyof EventProperties>(
	key: Key,
	value: EventProperties[Key],
) {
	const store = context.getStore();

	if (!store) {
		throw new Error(
			"appendMetricsData must be called within collectAsyncMetrics",
		);
	}

	return store.appendMetricsData(key, value);
}

export function initializeC3Permission(enabled = true) {
	return {
		enabled,
		date: new Date(),
	};
}

export function getC3Permission() {
	const config = readMetricsConfig();

	if (!config.c3permission) {
		config.c3permission = initializeC3Permission();

		writeMetricsConfig(config);
	}

	return config.c3permission;
}

// To update the c3permission property in the metrics config
export function updateC3Pemission(enabled: boolean) {
	const config = readMetricsConfig();

	if (!config.c3permission || config.c3permission.enabled !== enabled) {
		config.c3permission = initializeC3Permission(enabled);
	}

	writeMetricsConfig(config);
}

export const runTelemetryCommand = (
	action: "status" | "enable" | "disable",
) => {
	const logTelemetryStatus = (enabled: boolean) => {
		logRaw(`Status: ${enabled ? "Enabled" : "Disabled"}`);
		logRaw("");
	};

	switch (action) {
		case "enable": {
			updateC3Pemission(true);
			logTelemetryStatus(true);
			logRaw(
				"Create-Cloudflare telemetry is completely anonymous. Thank you for helping us improve the experience!",
			);
			break;
		}
		case "disable": {
			updateC3Pemission(false);
			logTelemetryStatus(false);
			logRaw("Create-Cloudflare is no longer collecting anonymous usage data");
			break;
		}
		case "status": {
			const telemetry = getC3Permission();

			logTelemetryStatus(telemetry.enabled);
			break;
		}
	}
};

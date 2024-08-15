import { AsyncLocalStorage } from "async_hooks";
import { platform } from "os";
import { CancelError } from "@cloudflare/cli";
import { Response } from "undici";
import { version as c3Version } from "../package.json";
import { getDeviceId, getSessionId, getUserId } from "./helpers/metrics-config";
import * as sparrow from "./helpers/sparrow";
import type { C3Args } from "./types";
import type { PromptConfig } from "@cloudflare/cli/interactive";

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
	 * An ISO 8601 timestamp generated on the user’s machine
	 */
	timestamp?: string;

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
				"args" | "c3Version" | "sessionId" | "timestamp" | "os"
			>;
	  }
	| {
			name: "c3 session cancelled";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "timestamp" | "os"
			>;
	  }
	| {
			name: "c3 session errored";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "timestamp" | "os" | "error"
			>;
	  }
	| {
			name: "c3 session completed";
			properties: Pick<
				EventProperties,
				"args" | "c3Version" | "sessionId" | "timestamp" | "os"
			>;
	  }
	| {
			name: "c3 prompt started";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "timestamp"
				| "os"
				| "key"
				| "promptConfig"
			>;
	  }
	| {
			name: "c3 prompt cancelled";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "timestamp"
				| "os"
				| "key"
				| "promptConfig"
			>;
	  }
	| {
			name: "c3 prompt errored";
			properties: Pick<
				EventProperties,
				| "args"
				| "c3Version"
				| "sessionId"
				| "timestamp"
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
				| "timestamp"
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

export function waitForAllEventsSettled() {
	return Promise.allSettled(events);
}

export function sendEvent<EventName extends Event["name"]>(
	name: EventName,
	properties: Extract<Event, { name: EventName }>["properties"],
): void {
	// Get the latest userId everytime in case it is updated
	const userId = getUserId();
	const response = sparrow.sendEvent({
		event: name,
		deviceId,
		userId,
		properties: {
			...properties,
			c3Version: properties.c3Version ?? c3Version,
			sessionId: properties.sessionId ?? sessionId,
			timestamp: properties.timestamp ?? new Date().toISOString(),
			os: properties.os ?? os,
		},
	});

	events.push(response);
}

export async function collectAsyncMetrics<
	Prefix extends EventPrefix<"started" | "cancelled" | "errored" | "completed">,
	Result,
>(config: {
	eventPrefix: Prefix;
	props: EventProperties;
	promise: () => Promise<Result>;
}): Promise<Result> {
	try {
		sendEvent(`${config.eventPrefix} started`, config.props);

		const appendMetricsData: AppendMetricsDataFn = (key, value) => {
			config.props[key] = value;
		};
		const result = await context.run({ appendMetricsData }, config.promise);

		sendEvent(`${config.eventPrefix} completed`, config.props);

		return result;
	} catch (error) {
		if (error instanceof CancelError) {
			sendEvent(`${config.eventPrefix} cancelled`, config.props);
		} else {
			sendEvent(`${config.eventPrefix} errored`, {
				...config.props,
				error: {
					message: error instanceof Error ? error.message : undefined,
					stack: error instanceof Error ? error.stack : undefined,
				},
			});
		}

		throw error;
	}
}

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

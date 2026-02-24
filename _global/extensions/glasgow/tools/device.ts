import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerDeviceTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_list",
		label: "Glasgow List",
		description:
			"List Glasgow devices connected to the system. Returns serial numbers of all connected Glasgow boards.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const result = await glasgow(["list"], { signal });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: "glasgow list" },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_voltage",
		label: "Glasgow Voltage",
		description:
			"Query or set I/O port voltage on the Glasgow. Use 'get' to read current voltage, 'set' to configure voltage on port A and/or B (e.g. 3.3V, 5.0V, 1.8V).",
		parameters: Type.Object({
			action: StringEnum(["get", "set"] as const, {
				description: "Whether to get or set voltage",
			}),
			ports: Type.Optional(
				Type.String({
					description:
						"I/O port set, e.g. 'AB', 'A', 'B' (default: all)",
				})
			),
			volts: Type.Optional(
				Type.Number({
					description:
						"I/O port voltage for 'set' (range: 1.8-5.0)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["voltage"];
			if (params.action === "set") {
				if (params.ports) args.push(params.ports);
				args.push(String(params.volts ?? 3.3));
			}
			const result = await glasgow(args, { signal });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_safe",
		label: "Glasgow Safe",
		description:
			"Turn off all I/O port voltage regulators and drivers on the Glasgow. Use this to safely disconnect or reset the device.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const result = await glasgow(["safe"], { signal });
			return {
				content: [
					{
						type: "text",
						text:
							formatOutput(result) ||
							"All voltage regulators and drivers turned off.",
					},
				],
				details: { command: "glasgow safe" },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_selftest",
		label: "Glasgow Selftest",
		description:
			"Run hardware self-test diagnostics on the Glasgow. Modes: loopback (default, no wiring needed), leds (test LEDs), pins-int (internal pin shorts), pins-ext (external pin shorts/opens - all pins must float), pins-loop (A0:A7 must be connected to B0:B7), voltage (ADC/DAC/LDO faults - Vsense and Vio must be connected).",
		parameters: Type.Object({
			modes: Type.Optional(
				Type.Array(
					StringEnum([
						"loopback",
						"leds",
						"pins-int",
						"pins-ext",
						"pins-pull",
						"pins-bufs",
						"pins-loop",
						"voltage",
					] as const),
					{
						description:
							"Test modes to run. Default: loopback",
					}
				)
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "selftest", ...(params.modes ?? [])];
			const result = await glasgow(args, {
				signal,
				timeout: 60000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_flash",
		label: "Glasgow Flash",
		description:
			"Flash/update the Glasgow firmware. Use when the device reports outdated firmware. Requires power cycling (unplug/replug) after flashing.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const result = await glasgow(["flash"], {
				signal,
				timeout: 60000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: "glasgow flash" },
			};
		},
	});
}

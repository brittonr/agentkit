import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glasgow, formatOutput } from "../exec.ts";

export function registerSwdTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_swd_dump_memory",
		label: "Glasgow SWD Dump Memory",
		description:
			"Read memory from an ARM target via SWD (Serial Wire Debug). Low-level memory access via MEM-AP. Default pins: swclk=A0, swdio=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			address: Type.String({
				description:
					"Start address in hex, e.g. '0x08000000'",
			}),
			length: Type.String({
				description:
					"Number of bytes to read in hex, e.g. '0x1000'",
			}),
			swclk_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SWCLK (default: A0)",
				})
			),
			swdio_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SWDIO (default: A1)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SWCLK frequency in kHz (default: 1000)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "swd-probe"];
			args.push("-V", params.voltage);
			if (params.swclk_pin)
				args.push("--swclk", params.swclk_pin);
			if (params.swdio_pin)
				args.push("--swdio", params.swdio_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push(
				"dump-memory",
				params.address,
				params.length
			);

			const result = await glasgow(args, {
				signal,
				timeout: 30000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_probe_rs",
		label: "Glasgow probe-rs",
		description:
			"Debug and program ARM microcontrollers via the probe-rs tool through the Glasgow. Supports flashing, debugging, and RTT. Default pins: swclk=A0, swdio=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			swclk_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SWCLK (default: A0)",
				})
			),
			swdio_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SWDIO (default: A1)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SWCLK frequency in kHz (default: 1000)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "probe-rs"];
			args.push("-V", params.voltage);
			if (params.swclk_pin)
				args.push("--swclk", params.swclk_pin);
			if (params.swdio_pin)
				args.push("--swdio", params.swdio_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting probe-rs server...\nCommand: glasgow ${args.join(" ")}`,
					},
				],
			});

			const result = await glasgow(args, {
				signal,
				timeout: 10000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});
}

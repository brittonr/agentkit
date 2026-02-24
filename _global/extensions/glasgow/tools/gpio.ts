import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glasgow, formatOutput } from "../exec.ts";

export function registerGpioTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_gpio",
		label: "Glasgow GPIO",
		description:
			"Control individual I/O pins. Drive pins high (1), low (0), weak high (H, pull-up), weak low (L, pull-down), or read their state. Actions are executed in order. Examples: 'A0=1' drives A0 high, 'A1=L' enables pull-down on A1, 'A2' reads A2.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			pins: Type.String({
				description:
					"Pins to use, e.g. 'A0,A1,A2,A3'",
			}),
			actions: Type.Array(Type.String(), {
				description:
					"Pin actions in order, e.g. ['A0=1', 'A1=0', 'A2=H', 'A3']",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "control-gpio"];
			args.push("-V", params.voltage);
			args.push("--pins", params.pins);
			args.push(...params.actions);

			const result = await glasgow(args, {
				signal,
				timeout: 15000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_clock",
		label: "Glasgow Clock Generator",
		description:
			"Generate a 50% duty cycle square wave clock signal at a specified frequency. Frequencies are integer fractions of 24 MHz. Default pin: clk=A0.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			frequency: Type.Optional(
				Type.Number({
					description:
						"Clock frequency in kHz (default: 1000)",
				})
			),
			clk_pin: Type.Optional(
				Type.String({
					description:
						"Pin for clock output (default: A0)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "control-clock"];
			args.push("-V", params.voltage);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			if (params.clk_pin) args.push("--clk", params.clk_pin);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Generating ${params.frequency ?? 1000} kHz clock on ${params.clk_pin ?? "A0"}...`,
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

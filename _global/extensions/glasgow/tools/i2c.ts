import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerI2cTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_i2c_scan",
		label: "Glasgow I2C Scan",
		description:
			"Scan the I2C bus for devices. Returns a list of responding I2C addresses. Default pins: scl=A0, sda=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			scl_pin: Type.Optional(
				Type.String({
					description: "Pin for SCL (default: A0)",
				})
			),
			sda_pin: Type.Optional(
				Type.String({
					description: "Pin for SDA (default: A1)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SCL frequency in kHz (default: 100, range: 100-4000)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "i2c-controller"];
			args.push("-V", params.voltage);
			if (params.scl_pin) args.push("--scl", params.scl_pin);
			if (params.sda_pin) args.push("--sda", params.sda_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push("scan");

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
		name: "glasgow_i2c_target",
		label: "Glasgow I2C Target",
		description:
			"Act as an I2C target (slave) device. The Glasgow will respond to I2C transactions at a given address. Useful for emulating I2C devices. Default pins: scl=A0, sda=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			scl_pin: Type.Optional(
				Type.String({
					description: "Pin for SCL (default: A0)",
				})
			),
			sda_pin: Type.Optional(
				Type.String({
					description: "Pin for SDA (default: A1)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description: "SCL frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "i2c-target"];
			args.push("-V", params.voltage);
			if (params.scl_pin) args.push("--scl", params.scl_pin);
			if (params.sda_pin) args.push("--sda", params.sda_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));

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
}

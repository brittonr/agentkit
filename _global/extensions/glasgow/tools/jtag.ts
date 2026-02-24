import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerJtagTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_jtag_scan",
		label: "Glasgow JTAG Scan",
		description:
			"Scan JTAG chain and attempt to identify devices by their IDCODE. Default pins: tck=A0, tms=A1, tdi=A2, tdo=A3.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			tck_pin: Type.Optional(
				Type.String({
					description: "Pin for TCK (default: A0)",
				})
			),
			tms_pin: Type.Optional(
				Type.String({
					description: "Pin for TMS (default: A1)",
				})
			),
			tdi_pin: Type.Optional(
				Type.String({
					description: "Pin for TDI (default: A2)",
				})
			),
			tdo_pin: Type.Optional(
				Type.String({
					description: "Pin for TDO (default: A3)",
				})
			),
			trst_pin: Type.Optional(
				Type.String({
					description: "Pin for TRST (optional)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"TCK frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "jtag-probe"];
			args.push("-V", params.voltage);
			if (params.tck_pin) args.push("--tck", params.tck_pin);
			if (params.tms_pin) args.push("--tms", params.tms_pin);
			if (params.tdi_pin) args.push("--tdi", params.tdi_pin);
			if (params.tdo_pin) args.push("--tdo", params.tdo_pin);
			if (params.trst_pin)
				args.push("--trst", params.trst_pin);
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
		name: "glasgow_jtag_pinout",
		label: "Glasgow JTAG Pinout",
		description:
			"Automatically determine JTAG pinout from a set of candidate pins. Tries all pin permutations to find TCK, TMS, TDI, TDO. Extremely useful for unknown boards.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			pins: Type.String({
				description:
					"Candidate pins, e.g. 'A0,A1,A2,A3' or 'A0,A1,A2,A3,A4,A5'",
			}),
			frequency: Type.Optional(
				Type.Number({
					description:
						"Clock frequency in kHz (default: 10)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "jtag-pinout"];
			args.push("-V", params.voltage);
			args.push("--pins", params.pins);
			if (params.frequency)
				args.push("-f", String(params.frequency));

			onUpdate?.({
				content: [
					{
						type: "text",
						text: "Scanning pin permutations for JTAG... this may take a while.",
					},
				],
			});

			const result = await glasgow(args, {
				signal,
				timeout: 120000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_jtag_openocd",
		label: "Glasgow JTAG OpenOCD",
		description:
			"Expose JTAG interface via OpenOCD remote bitbang protocol. Starts a server that OpenOCD can connect to for debugging/programming. Default pins: tck=A0, tms=A1, tdi=A2, tdo=A3.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			tck_pin: Type.Optional(
				Type.String({
					description: "Pin for TCK (default: A0)",
				})
			),
			tms_pin: Type.Optional(
				Type.String({
					description: "Pin for TMS (default: A1)",
				})
			),
			tdi_pin: Type.Optional(
				Type.String({
					description: "Pin for TDI (default: A2)",
				})
			),
			tdo_pin: Type.Optional(
				Type.String({
					description: "Pin for TDO (default: A3)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"TCK frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "jtag-openocd"];
			args.push("-V", params.voltage);
			if (params.tck_pin) args.push("--tck", params.tck_pin);
			if (params.tms_pin) args.push("--tms", params.tms_pin);
			if (params.tdi_pin) args.push("--tdi", params.tdi_pin);
			if (params.tdo_pin) args.push("--tdo", params.tdo_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting JTAG OpenOCD server...\nCommand: glasgow ${args.join(" ")}`,
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

	pi.registerTool({
		name: "glasgow_jtag_svf",
		label: "Glasgow JTAG SVF",
		description:
			"Play SVF (Serial Vector Format) test vectors via JTAG. SVF files are commonly used for FPGA/CPLD programming and boundary scan testing.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			svf_file: Type.String({
				description: "Path to SVF file to play",
			}),
			tck_pin: Type.Optional(
				Type.String({
					description: "Pin for TCK (default: A0)",
				})
			),
			tms_pin: Type.Optional(
				Type.String({
					description: "Pin for TMS (default: A1)",
				})
			),
			tdi_pin: Type.Optional(
				Type.String({
					description: "Pin for TDI (default: A2)",
				})
			),
			tdo_pin: Type.Optional(
				Type.String({
					description: "Pin for TDO (default: A3)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"TCK frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "jtag-svf"];
			args.push("-V", params.voltage);
			if (params.tck_pin) args.push("--tck", params.tck_pin);
			if (params.tms_pin) args.push("--tms", params.tms_pin);
			if (params.tdi_pin) args.push("--tdi", params.tdi_pin);
			if (params.tdo_pin) args.push("--tdo", params.tdo_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push(params.svf_file);

			const result = await glasgow(args, {
				signal,
				timeout: 120000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});
}

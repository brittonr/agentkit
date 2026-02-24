import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerSpiTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_spi_transfer",
		label: "Glasgow SPI Transfer",
		description:
			"Initiate SPI transactions. Exchange hex bytes with the target device. Default pins: cs=A0, sck=A1, copi=A2, cipo=A3.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			data: Type.Array(Type.String(), {
				description:
					"Hex bytes to exchange, e.g. ['9f', '00', '00', '00']",
			}),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin for CS (default: A0)",
				})
			),
			sck_pin: Type.Optional(
				Type.String({
					description: "Pin for SCK (default: A1)",
				})
			),
			copi_pin: Type.Optional(
				Type.String({
					description: "Pin for COPI/MOSI (default: A2)",
				})
			),
			cipo_pin: Type.Optional(
				Type.String({
					description: "Pin for CIPO/MISO (default: A3)",
				})
			),
			mode: Type.Optional(
				StringEnum(["0", "1", "2", "3"] as const, {
					description: "SPI mode 0-3 (default: 3)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SCK frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "spi-controller"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.copi_pin)
				args.push("--copi", params.copi_pin);
			if (params.cipo_pin)
				args.push("--cipo", params.cipo_pin);
			if (params.mode) args.push("-m", params.mode);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push(...params.data);

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
		name: "glasgow_spi_analyzer",
		label: "Glasgow SPI Analyzer",
		description:
			"Capture and analyze SPI bus transactions. Saves captured data as CSV with COPI/CIPO hex pairs. Signal integrity is critical - twist signal wires with ground. Default pins: cs=A0, sck=A1, copi=A2, cipo=A3.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin(s) for CS (default: A0)",
				})
			),
			sck_pin: Type.Optional(
				Type.String({
					description: "Pin for SCK (default: A1)",
				})
			),
			copi_pin: Type.Optional(
				Type.String({
					description: "Pin for COPI (default: A2)",
				})
			),
			cipo_pin: Type.Optional(
				Type.String({
					description: "Pin for CIPO (default: A3)",
				})
			),
			output_file: Type.Optional(
				Type.String({
					description:
						"Output CSV file (default: spi-capture.csv)",
				})
			),
			duration: Type.Optional(
				Type.Number({
					description:
						"Capture duration in seconds (default: 10)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const file = params.output_file ?? "spi-capture.csv";
			const args = ["run", "spi-analyzer"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.copi_pin)
				args.push("--copi", params.copi_pin);
			if (params.cipo_pin)
				args.push("--cipo", params.cipo_pin);
			args.push(file);

			const timeout = (params.duration ?? 10) * 1000;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Capturing SPI traffic for ${params.duration ?? 10}s to ${file}...`,
					},
				],
			});

			const result = await glasgow(args, { signal, timeout });
			return {
				content: [
					{
						type: "text",
						text: `${formatOutput(result)}\nCapture saved to: ${file}`,
					},
				],
				details: {
					command: `glasgow ${args.join(" ")}`,
					file,
				},
			};
		},
	});

	pi.registerTool({
		name: "glasgow_spi_flashrom",
		label: "Glasgow SPI Flashrom",
		description:
			"Expose SPI interface via flashrom serprog protocol. This allows using the flashrom tool to read/write SPI flash chips through the Glasgow. Starts a serprog server that flashrom can connect to.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin for CS (default: A0)",
				})
			),
			sck_pin: Type.Optional(
				Type.String({
					description: "Pin for SCK (default: A1)",
				})
			),
			copi_pin: Type.Optional(
				Type.String({
					description: "Pin for COPI (default: A2)",
				})
			),
			cipo_pin: Type.Optional(
				Type.String({
					description: "Pin for CIPO (default: A3)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SCK frequency in kHz (default: 100)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "spi-flashrom"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.copi_pin)
				args.push("--copi", params.copi_pin);
			if (params.cipo_pin)
				args.push("--cipo", params.cipo_pin);
			if (params.frequency)
				args.push("-f", String(params.frequency));

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting SPI flashrom serprog server...\nCommand: glasgow ${args.join(" ")}`,
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
		name: "glasgow_qspi",
		label: "Glasgow QSPI Controller",
		description:
			"Initiate SPI/dual-SPI/quad-SPI/QPI transactions. Supports single, dual, and quad I/O modes for high-speed flash access.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin for CS",
				})
			),
			sck_pin: Type.Optional(
				Type.String({
					description: "Pin for SCK",
				})
			),
			io_pins: Type.Optional(
				Type.String({
					description:
						"Pins for IO0-IO3, comma-separated",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description: "SCK frequency in kHz",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "qspi-controller"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.io_pins) args.push("--io", params.io_pins);
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

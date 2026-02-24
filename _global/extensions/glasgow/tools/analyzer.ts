import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { glasgow, formatOutput } from "../exec.ts";

export function registerAnalyzerTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_logic_analyzer",
		label: "Glasgow Logic Analyzer",
		description:
			"Capture logic waveforms to a VCD file, similar to a logic analyzer. Connect signal wires to the specified pins and a ground wire. View the resulting .vcd file with gtkwave or pulseview. Default pins: A0.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			pins: Type.Optional(
				Type.String({
					description:
						"Input pins to capture, e.g. 'A0,A1,A2,A3' (default: A0)",
				})
			),
			pin_names: Type.Optional(
				Type.String({
					description:
						"Comma-separated names for the pins, e.g. 'CLK,DATA,CS,MISO'",
				})
			),
			output_file: Type.Optional(
				Type.String({
					description:
						"Output VCD file (default: capture.vcd)",
				})
			),
			duration: Type.Optional(
				Type.Number({
					description:
						"Capture duration in seconds (default: 10)",
				})
			),
			pull_ups: Type.Optional(
				Type.Boolean({
					description: "Enable pull-ups on all pins",
				})
			),
			pull_downs: Type.Optional(
				Type.Boolean({
					description:
						"Enable pull-downs on all pins",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const file = params.output_file ?? "capture.vcd";
			const args = ["run", "analyzer"];
			args.push("-V", params.voltage);
			if (params.pins) args.push("--i", params.pins);
			if (params.pin_names)
				args.push("--pin-names", params.pin_names);
			if (params.pull_ups) args.push("--pull-ups");
			if (params.pull_downs) args.push("--pull-downs");
			args.push(file);

			const timeout = (params.duration ?? 10) * 1000;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Capturing logic signals for ${params.duration ?? 10}s to ${file}...\nPins: ${params.pins ?? "A0"} ${params.pin_names ? `(${params.pin_names})` : ""}`,
					},
				],
			});

			const result = await glasgow(args, { signal, timeout });
			return {
				content: [
					{
						type: "text",
						text: `${formatOutput(result)}\nCapture saved to: ${file}\nView with: gtkwave ${file}`,
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
		name: "glasgow_qspi_analyzer",
		label: "Glasgow QSPI Analyzer",
		description:
			"Analyze QSPI (Quad SPI) transactions. Captures quad-IO SPI traffic including dual and quad mode commands.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin(s) for CS",
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
			output_file: Type.Optional(
				Type.String({
					description:
						"Output file (default: qspi-capture.csv)",
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
			const file =
				params.output_file ?? "qspi-capture.csv";
			const args = ["run", "qspi-analyzer"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.io_pins) args.push("--io", params.io_pins);
			args.push(file);

			const timeout = (params.duration ?? 10) * 1000;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Capturing QSPI traffic for ${params.duration ?? 10}s to ${file}...`,
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
}

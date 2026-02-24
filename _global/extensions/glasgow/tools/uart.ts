import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerUartTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_uart",
		label: "Glasgow UART",
		description:
			"Communicate via UART. Supports any baud rate, 8N1 format with optional parity. Can connect to a PTY device file for other programs to use, or capture to socket. Default pins: rx=A0, tx=A1.",
		parameters: Type.Object({
			mode: StringEnum(["pty", "socket"] as const, {
				description:
					"Connection mode: 'pty' creates a /dev/pts/N device file, 'socket' creates a TCP socket",
			}),
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			baud: Type.Optional(
				Type.Number({
					description: "Baud rate (default: 115200)",
				})
			),
			rx_pin: Type.Optional(
				Type.String({
					description:
						"Pin for RX line (default: A0)",
				})
			),
			tx_pin: Type.Optional(
				Type.String({
					description:
						"Pin for TX line (default: A1)",
				})
			),
			parity: Type.Optional(
				StringEnum(["none", "odd", "even"] as const, {
					description: "Parity mode (default: none)",
				})
			),
			auto_baud: Type.Optional(
				Type.Boolean({
					description:
						"Enable automatic baud rate detection",
				})
			),
			socket_host: Type.Optional(
				Type.String({
					description:
						"Host for socket mode (default: localhost)",
				})
			),
			socket_port: Type.Optional(
				Type.Number({
					description:
						"Port for socket mode (default: 2222)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "uart"];
			args.push("-V", params.voltage);
			if (params.baud)
				args.push("-b", String(params.baud));
			if (params.rx_pin) args.push("--rx", params.rx_pin);
			if (params.tx_pin) args.push("--tx", params.tx_pin);
			if (params.parity && params.parity !== "none")
				args.push("--parity", params.parity);
			if (params.auto_baud) args.push("-a");
			args.push(params.mode);
			if (
				params.mode === "socket" &&
				(params.socket_host || params.socket_port)
			) {
				args.push(
					params.socket_host ?? "localhost",
					String(params.socket_port ?? 2222)
				);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Starting UART ${params.mode} mode at ${params.baud ?? 115200} baud...\nCommand: glasgow ${args.join(" ")}\nThis runs in the background. Use glasgow_safe to stop.`,
					},
				],
			});

			const result = await glasgow(args, {
				signal,
				timeout: 5000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_uart_analyzer",
		label: "Glasgow UART Analyzer",
		description:
			"Capture and analyze UART communication on a full duplex link. Captures both RX and TX channels to a CSV file. Default pins: rx=A0, tx=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			baud: Type.Optional(
				Type.Number({
					description: "Baud rate (default: 115200)",
				})
			),
			rx_pin: Type.Optional(
				Type.String({
					description:
						"Pin for RX line (default: A0)",
				})
			),
			tx_pin: Type.Optional(
				Type.String({
					description:
						"Pin for TX line (default: A1)",
				})
			),
			parity: Type.Optional(
				StringEnum(["none", "odd", "even"] as const, {
					description: "Parity mode (default: none)",
				})
			),
			output_file: Type.Optional(
				Type.String({
					description:
						"Output CSV file (default: uart-capture.csv)",
				})
			),
			ascii: Type.Optional(
				Type.Boolean({
					description:
						"Format output as ASCII with escape sequences",
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
			const file = params.output_file ?? "uart-capture.csv";
			const args = ["run", "uart-analyzer"];
			args.push("-V", params.voltage);
			if (params.baud)
				args.push("-b", String(params.baud));
			if (params.rx_pin) args.push("--rx", params.rx_pin);
			if (params.tx_pin) args.push("--tx", params.tx_pin);
			if (params.parity && params.parity !== "none")
				args.push("--parity", params.parity);
			if (params.ascii) args.push("--ascii");
			args.push(file);

			const timeout = (params.duration ?? 10) * 1000;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Capturing UART traffic for ${params.duration ?? 10}s to ${file}...`,
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

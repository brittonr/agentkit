import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerMiscTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_debug",
		label: "Glasgow Debug",
		description:
			"Debug processors via JTAG. Supports ARC, ARM (JTAG), ARM7TDMI, and MIPS (EJTAG) processors. For ARM SWD debugging, use glasgow_swd_dump_memory or glasgow_probe_rs instead.",
		parameters: Type.Object({
			arch: StringEnum(
				["arc", "arm", "arm7", "mips"] as const,
				{
					description:
						"Processor architecture to debug",
				}
			),
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			tck_pin: Type.Optional(Type.String({ description: "Pin for TCK" })),
			tms_pin: Type.Optional(Type.String({ description: "Pin for TMS" })),
			tdi_pin: Type.Optional(Type.String({ description: "Pin for TDI" })),
			tdo_pin: Type.Optional(Type.String({ description: "Pin for TDO" })),
			frequency: Type.Optional(
				Type.Number({
					description: "TCK frequency in kHz",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", `debug-${params.arch}`];
			args.push("-V", params.voltage);
			if (params.tck_pin) args.push("--tck", params.tck_pin);
			if (params.tms_pin) args.push("--tms", params.tms_pin);
			if (params.tdi_pin) args.push("--tdi", params.tdi_pin);
			if (params.tdo_pin) args.push("--tdo", params.tdo_pin);
			if (params.frequency) args.push("-f", String(params.frequency));

			const result = await glasgow(args, { signal, timeout: 30000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_display",
		label: "Glasgow Display",
		description:
			"Drive displays. Supports HD44780 (character LCD) and PDI (e-paper/EPD panels).",
		parameters: Type.Object({
			display_type: StringEnum(
				["hd44780", "pdi"] as const,
				{
					description: "Display type",
				}
			),
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0' for HD44780, '3.3' for PDI",
			}),
		}),
		async execute(_id, params, signal) {
			const applet =
				params.display_type === "hd44780"
					? "display-hd44780"
					: "display-pdi";
			const args = ["run", applet, "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_video",
		label: "Glasgow Video",
		description:
			"Video output/input. Supports VGA output, HUB75 LED panels, WS2812 LED strips, and RGB555 LCD input capture.",
		parameters: Type.Object({
			mode: StringEnum(
				[
					"vga-output",
					"hub75-output",
					"ws2812-output",
					"rgb-input",
				] as const,
				{
					description: "Video mode",
				}
			),
			voltage: Type.String({
				description: "I/O voltage",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", `video-${params.mode}`, "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_audio_dac",
		label: "Glasgow Audio DAC",
		description:
			"Play sound using a sigma-delta DAC on a Glasgow pin.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "audio-dac", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_ps2",
		label: "Glasgow PS/2",
		description:
			"Communicate with IBM PS/2 peripherals (keyboards, mice).",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "ps2-host", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_radio_nrf24l01",
		label: "Glasgow nRF24L01 Radio",
		description:
			"Transmit and receive data using nRF24L01(+) 2.4GHz RF transceiver modules.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "radio-nrf24l01", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_control_mdio",
		label: "Glasgow MDIO",
		description:
			"Configure IEEE 802.3 (Ethernet) PHYs via the MDIO management interface.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "control-mdio", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_control_servo",
		label: "Glasgow Servo Control",
		description:
			"Control RC servomotors and ESCs via PWM signals.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "control-servo", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 15000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_sbw_probe",
		label: "Glasgow Spy-Bi-Wire",
		description:
			"Probe microcontrollers via TI Spy-Bi-Wire (SBW) debug interface. Used for MSP430 and similar TI microcontrollers.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "sbw-probe", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 30000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_benchmark",
		label: "Glasgow Benchmark",
		description:
			"Evaluate the communication performance of the Glasgow USB interface. Useful for measuring achievable throughput.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const result = await glasgow(["run", "benchmark"], {
				signal,
				timeout: 30000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: "glasgow run benchmark" },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_voltage_limit",
		label: "Glasgow Voltage Limit",
		description:
			"Set a voltage limit as a safety mechanism. Prevents accidentally applying too high a voltage to sensitive targets.",
		parameters: Type.Object({
			ports: Type.Optional(
				Type.String({
					description:
						"I/O port set, e.g. 'AB', 'A', 'B' (default: all)",
				})
			),
			volts: Type.Number({
				description:
					"Maximum allowed I/O port voltage (range: 1.8-5.0)",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["voltage-limit"];
			if (params.ports) args.push(params.ports);
			args.push(String(params.volts));
			const result = await glasgow(args, {
				signal,
				timeout: 10000,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: {
					command: `glasgow ${args.join(" ")}`,
				},
			};
		},
	});
}

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerAdvancedTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_repl",
		label: "Glasgow REPL",
		description:
			"Run a Glasgow applet and execute Python code against its programming interface. This gives direct async Python access to applet internals (e.g. i2c_iface.write(), uart_iface.read()). Use for operations not covered by other tools. The code parameter is executed as a Python script in the applet's REPL environment. Variables available: device, args, and an applet-specific interface (e.g. i2c_iface, uart_iface, iface).",
		parameters: Type.Object({
			applet: Type.String({
				description:
					"Applet name, e.g. 'i2c-controller', 'uart', 'spi-controller'",
			}),
			applet_args: Type.Array(Type.String(), {
				description:
					"Applet arguments (voltage, pins, etc), e.g. ['-V', '3.3', '--scl', 'A0', '--sda', 'A1']",
			}),
			code: Type.String({
				description:
					"Python code to execute in the applet REPL. Use 'await' for async calls. Example: 'result = await i2c_iface.scan()\\nprint(result)'",
			}),
		}),
		async execute(_id, params, signal) {
			// Write the code to a temp file and use glasgow script
			const tmpFile = `/tmp/glasgow-script-${Date.now()}.py`;
			const fs = await import("node:fs/promises");
			await fs.writeFile(tmpFile, params.code);

			const args = [
				"script",
				params.applet,
				...params.applet_args,
				tmpFile,
			];
			const result = await glasgow(args, {
				signal,
				timeout: 30000,
			});

			await fs.unlink(tmpFile).catch(() => {});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: {
					command: `glasgow ${args.join(" ")}`,
					code: params.code,
				},
			};
		},
	});

	pi.registerTool({
		name: "glasgow_tool",
		label: "Glasgow Offline Tool",
		description:
			"Run offline tools that don't require Glasgow hardware. Available tools: 'memory-25x' (decode SPI flash captures and extract data), 'memory-prom' (display parallel memory statistics), 'program-xc9500' (manipulate XC9500 CPLD bitstreams), 'program-xc9500xl' (manipulate XC9500XL/XV CPLD bitstreams).",
		parameters: Type.Object({
			tool: StringEnum(
				[
					"memory-25x",
					"memory-prom",
					"program-xc9500",
					"program-xc9500xl",
				] as const,
				{
					description: "Offline tool to run",
				}
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Arguments for the tool (files, options, etc)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = [
				"tool",
				params.tool,
				...(params.args ?? []),
			];
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
		name: "glasgow_multi",
		label: "Glasgow Multi",
		description:
			"Run multiple Glasgow applets simultaneously. Applets are separated by '++'. For example, running a UART and logic analyzer at the same time. Each applet gets its own set of arguments.",
		parameters: Type.Object({
			applets: Type.Array(
				Type.Object({
					name: Type.String({
						description: "Applet name",
					}),
					args: Type.Array(Type.String(), {
						description: "Applet arguments",
					}),
				}),
				{
					description:
						"List of applets to run simultaneously",
				}
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["multi"];
			for (let i = 0; i < params.applets.length; i++) {
				if (i > 0) args.push("++");
				args.push(
					params.applets[i].name,
					...params.applets[i].args
				);
			}

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running ${params.applets.length} applets simultaneously...\nCommand: glasgow ${args.join(" ")}`,
					},
				],
			});

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
		name: "glasgow_control_si535x",
		label: "Glasgow Si535x Clock Generator",
		description:
			"Configure Skyworks Si535x programmable clock generators via I2C. Operations: 'configure-si5351' (load ClockBuilder Pro CSV config), 'read' (read register), 'write' (write register). Default pins: scl=A0, sda=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			operation: StringEnum(
				["configure-si5351", "read", "write"] as const,
				{
					description: "Operation to perform",
				}
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Operation arguments: for configure-si5351: [config.csv], for read: [address, count?], for write: [address, data]",
				})
			),
			scl_pin: Type.Optional(
				Type.String({ description: "Pin for SCL (default: A0)" })
			),
			sda_pin: Type.Optional(
				Type.String({ description: "Pin for SDA (default: A1)" })
			),
			i2c_address: Type.Optional(
				Type.String({
					description:
						"I2C address (default: 0x60)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "control-si535x"];
			args.push("-V", params.voltage);
			if (params.scl_pin) args.push("--scl", params.scl_pin);
			if (params.sda_pin) args.push("--sda", params.sda_pin);
			if (params.i2c_address)
				args.push("--i2c-address", params.i2c_address);
			args.push(params.operation);
			if (params.args) args.push(...params.args);

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
		name: "glasgow_control_tps6598x",
		label: "Glasgow TPS6598x USB PD Controller",
		description:
			"Configure TPS6598x USB Power Delivery controllers. Useful for inspecting and configuring USB-C PD negotiation parameters.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "Additional arguments",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = [
				"run",
				"control-tps6598x",
				"-V",
				params.voltage,
				...(params.args ?? []),
			];
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
		name: "glasgow_jtag_xvc",
		label: "Glasgow JTAG XVC",
		description:
			"Expose JTAG interface via Xilinx Virtual Cable (XVC) protocol. Allows Vivado and other Xilinx tools to connect to the JTAG chain through the Glasgow. Default pins: tck=A0, tms=A1, tdi=A2, tdo=A3.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			tck_pin: Type.Optional(Type.String({ description: "Pin for TCK" })),
			tms_pin: Type.Optional(Type.String({ description: "Pin for TMS" })),
			tdi_pin: Type.Optional(Type.String({ description: "Pin for TDI" })),
			tdo_pin: Type.Optional(Type.String({ description: "Pin for TDO" })),
			frequency: Type.Optional(
				Type.Number({ description: "TCK frequency in kHz" })
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "jtag-xvc"];
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
						text: `Starting JTAG XVC server...\nCommand: glasgow ${args.join(" ")}`,
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
		name: "glasgow_program_misc",
		label: "Glasgow Program (misc)",
		description:
			"Program additional device types: 'xc6s' (Xilinx Spartan-6 FPGAs via JTAG), 'xpla3' (Xilinx XPLA3 CPLDs via JTAG), 'mec16xx' (Microchip MEC16xx embedded controllers via JTAG), 'stusb4500-nvm' (STUSB4500 USB PD controller NVM), 'm16c' (Renesas M16C via UART).",
		parameters: Type.Object({
			target: StringEnum(
				[
					"xc6s",
					"xpla3",
					"mec16xx",
					"stusb4500-nvm",
					"m16c",
				] as const,
				{
					description: "Target device type",
				}
			),
			voltage: Type.String({
				description: "I/O voltage",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Additional arguments (pin assignments, files, etc)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = [
				"run",
				`program-${params.target}`,
				"-V",
				params.voltage,
				...(params.args ?? []),
			];
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
		name: "glasgow_memory_floppy",
		label: "Glasgow Floppy Disk",
		description:
			"Read and write floppy disks using IBM/Shugart floppy drives. Preview quality applet. Supports reading raw flux data from 3.5\" and 5.25\" floppy disks.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0'",
			}),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "Additional arguments",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = [
				"run",
				"memory-floppy",
				"-V",
				params.voltage,
				...(params.args ?? []),
			];
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

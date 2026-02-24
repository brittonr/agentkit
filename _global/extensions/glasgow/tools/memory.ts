import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerMemoryTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_flash_25x",
		label: "Glasgow 25-series Flash",
		description:
			"Interact with 25-series SPI Flash memories (Winbond 25Qxx, Macronix MX25Lxx, etc). Operations: identify, read, program, erase-chip, erase-sector, verify, protect. Default pins follow 8-pin SOIC clockwise: io=A2,A4,A3,A0, sck=A1, cs=A5.",
		parameters: Type.Object({
			voltage: Type.String({
				description:
					"I/O voltage, e.g. '3.3' (most 25-series are 3.3V)",
			}),
			operation: StringEnum(
				[
					"identify",
					"read",
					"fast-read",
					"program",
					"program-page",
					"erase-sector",
					"erase-block",
					"erase-chip",
					"erase-program",
					"verify",
					"protect",
				] as const,
				{
					description:
						"Operation to perform on the flash",
				}
			),
			address: Type.Optional(
				Type.String({
					description:
						"Start address in hex for read/program/erase, e.g. '0x0'",
				})
			),
			length: Type.Optional(
				Type.String({
					description:
						"Number of bytes for read, e.g. '0x100000'",
				})
			),
			file: Type.Optional(
				Type.String({
					description:
						"File to read from or write to",
				})
			),
			cs_pin: Type.Optional(
				Type.String({
					description: "Pin for CS (default: A5)",
				})
			),
			sck_pin: Type.Optional(
				Type.String({
					description: "Pin for SCK (default: A1)",
				})
			),
			io_pins: Type.Optional(
				Type.String({
					description:
						"Pins for IO (copi,cipo,wp,hold) (default: A2,A4,A3,A0)",
				})
			),
			frequency: Type.Optional(
				Type.Number({
					description:
						"SCK frequency in kHz (default: 12000)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const args = ["run", "memory-25x"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.io_pins) args.push("--io", params.io_pins);
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push(params.operation);
			if (params.address) args.push(params.address);
			if (params.length) args.push(params.length);
			if (params.file) args.push(params.file);

			const timeouts: Record<string, number> = {
				identify: 15000,
				read: 120000,
				"fast-read": 120000,
				program: 300000,
				"erase-chip": 120000,
				"erase-program": 300000,
			};
			const timeout =
				timeouts[params.operation] ?? 60000;

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Running 25x flash ${params.operation}...`,
					},
				],
			});

			const result = await glasgow(args, {
				signal,
				timeout,
			});
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_eeprom_24x",
		label: "Glasgow 24-series EEPROM",
		description:
			"Read and write 24-series I2C EEPROM memories (24C02, 24C256, etc). Operations: read, write, verify. Default pins: scl=A0, sda=A1.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3' or '5.0'",
			}),
			operation: StringEnum(
				["read", "write", "verify"] as const,
				{
					description: "Operation to perform",
				}
			),
			address_width: StringEnum(["1", "2"] as const, {
				description:
					"Number of address bytes (1 for small EEPROMs ≤256B, 2 for larger)",
			}),
			address: Type.Optional(
				Type.String({
					description:
						"Memory address in hex, e.g. '0x0'",
				})
			),
			length: Type.Optional(
				Type.String({
					description: "Number of bytes, e.g. '0x100'",
				})
			),
			file: Type.Optional(
				Type.String({
					description:
						"File to read from or write to",
				})
			),
			i2c_address: Type.Optional(
				Type.String({
					description:
						"I2C device address (default: 0b1010000 = 0x50)",
				})
			),
			page_size: Type.Optional(
				Type.Number({
					description:
						"Page size for writes (default: 8)",
				})
			),
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
						"SCL frequency in kHz (default: 400)",
				})
			),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "memory-24x"];
			args.push("-V", params.voltage);
			args.push("-W", params.address_width);
			if (params.scl_pin) args.push("--scl", params.scl_pin);
			if (params.sda_pin) args.push("--sda", params.sda_pin);
			if (params.i2c_address)
				args.push("-A", params.i2c_address);
			if (params.page_size)
				args.push("-P", String(params.page_size));
			if (params.frequency)
				args.push("-f", String(params.frequency));
			args.push(params.operation);
			if (params.address) args.push(params.address);
			if (params.length) args.push(params.length);
			if (params.file) args.push(params.file);

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
		name: "glasgow_memory_prom",
		label: "Glasgow Parallel PROM",
		description:
			"Read parallel EPROMs, EEPROMs, and Flash memories. Useful for rescuing data from old parallel memory chips.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0' for older chips",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "memory-prom"];
			args.push("-V", params.voltage);

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
		name: "glasgow_memory_onfi",
		label: "Glasgow ONFI NAND Flash",
		description:
			"Read and write ONFI-compatible NAND Flash memories. Preview quality applet.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "memory-onfi"];
			args.push("-V", params.voltage);

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

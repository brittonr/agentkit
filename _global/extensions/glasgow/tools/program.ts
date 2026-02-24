import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerProgramTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_program_avr",
		label: "Glasgow Program AVR",
		description:
			"Program Microchip (Atmel) AVR microcontrollers via SPI (ISP programming). Supports ATmega, ATtiny, etc.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '5.0' or '3.3'",
			}),
			cs_pin: Type.Optional(Type.String({ description: "Pin for RESET/CS" })),
			sck_pin: Type.Optional(Type.String({ description: "Pin for SCK" })),
			copi_pin: Type.Optional(Type.String({ description: "Pin for MOSI" })),
			cipo_pin: Type.Optional(Type.String({ description: "Pin for MISO" })),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "program-avr-spi"];
			args.push("-V", params.voltage);
			if (params.cs_pin) args.push("--cs", params.cs_pin);
			if (params.sck_pin) args.push("--sck", params.sck_pin);
			if (params.copi_pin) args.push("--copi", params.copi_pin);
			if (params.cipo_pin) args.push("--cipo", params.cipo_pin);

			const result = await glasgow(args, { signal, timeout: 60000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_program_ice40",
		label: "Glasgow Program iCE40",
		description:
			"Program iCE40 FPGAs. Use 'sram' mode for volatile SRAM programming, or 'flash' to program the attached SPI flash for persistent configuration.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			mode: StringEnum(["sram", "flash"] as const, {
				description: "Program SRAM (volatile) or Flash (persistent)",
			}),
			bitstream: Type.Optional(
				Type.String({
					description: "Path to bitstream file",
				})
			),
		}),
		async execute(_id, params, signal) {
			const applet =
				params.mode === "sram"
					? "program-ice40-sram"
					: "program-ice40-flash";
			const args = ["run", applet];
			args.push("-V", params.voltage);
			if (params.bitstream) args.push(params.bitstream);

			const result = await glasgow(args, { signal, timeout: 120000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_program_xc9500",
		label: "Glasgow Program XC9500",
		description:
			"Program Xilinx XC9500, XC9500XL, or XC9500XV CPLDs via JTAG.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			variant: StringEnum(["xc9500", "xc9500xl"] as const, {
				description: "CPLD variant",
			}),
			tck_pin: Type.Optional(Type.String({ description: "Pin for TCK" })),
			tms_pin: Type.Optional(Type.String({ description: "Pin for TMS" })),
			tdi_pin: Type.Optional(Type.String({ description: "Pin for TDI" })),
			tdo_pin: Type.Optional(Type.String({ description: "Pin for TDO" })),
		}),
		async execute(_id, params, signal) {
			const applet = `program-${params.variant}`;
			const args = ["run", applet];
			args.push("-V", params.voltage);
			if (params.tck_pin) args.push("--tck", params.tck_pin);
			if (params.tms_pin) args.push("--tms", params.tms_pin);
			if (params.tdi_pin) args.push("--tdi", params.tdi_pin);
			if (params.tdo_pin) args.push("--tdo", params.tdo_pin);

			const result = await glasgow(args, { signal, timeout: 120000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});

	pi.registerTool({
		name: "glasgow_program_nrf24l",
		label: "Glasgow Program nRF24L",
		description:
			"Program nRF24LE1 and nRF24LU1+ RF microcontrollers.",
		parameters: Type.Object({
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
		}),
		async execute(_id, params, signal) {
			const args = ["run", "program-nrf24lx1", "-V", params.voltage];
			const result = await glasgow(args, { signal, timeout: 60000 });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: { command: `glasgow ${args.join(" ")}` },
			};
		},
	});
}

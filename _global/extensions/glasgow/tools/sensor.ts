import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { glasgow, formatOutput } from "../exec.ts";

export function registerSensorTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "glasgow_sensor",
		label: "Glasgow Sensor",
		description:
			"Read data from various sensors connected to the Glasgow. Supported sensors: bmx280 (Bosch BME280/BMP280 - temp/pressure/humidity), hcsr04 (ultrasonic distance), hx711 (load cell/voltage), ina260 (voltage/current/power), scd30 (CO2/humidity/temp), sen5x (PM/NOx/VOC/humidity/temp), pmsx003 (air quality), mouse-ps2 (PS/2 mouse).",
		parameters: Type.Object({
			sensor: StringEnum(
				[
					"bmx280",
					"hcsr04",
					"hx711",
					"ina260",
					"scd30",
					"sen5x",
					"pmsx003",
					"mouse-ps2",
				] as const,
				{
					description: "Sensor type to read",
				}
			),
			voltage: Type.String({
				description: "I/O voltage, e.g. '3.3'",
			}),
			scl_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SCL/clock (for I2C sensors)",
				})
			),
			sda_pin: Type.Optional(
				Type.String({
					description:
						"Pin for SDA/data (for I2C sensors)",
				})
			),
			duration: Type.Optional(
				Type.Number({
					description:
						"Reading duration in seconds (default: 5)",
				})
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const sensorApplet: Record<string, string> = {
				bmx280: "sensor-bmx280",
				hcsr04: "sensor-hcsr04",
				hx711: "sensor-hx711",
				ina260: "sensor-ina260",
				scd30: "sensor-scd30",
				sen5x: "sensor-sen5x",
				pmsx003: "sensor-pmsx003",
				"mouse-ps2": "sensor-mouse-ps2",
			};

			const args = ["run", sensorApplet[params.sensor]];
			args.push("-V", params.voltage);
			if (params.scl_pin) args.push("--scl", params.scl_pin);
			if (params.sda_pin) args.push("--sda", params.sda_pin);

			const timeout = (params.duration ?? 5) * 1000;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Reading ${params.sensor} sensor for ${params.duration ?? 5}s...`,
					},
				],
			});

			const result = await glasgow(args, { signal, timeout });
			return {
				content: [{ type: "text", text: formatOutput(result) }],
				details: {
					command: `glasgow ${args.join(" ")}`,
					sensor: params.sensor,
				},
			};
		},
	});
}

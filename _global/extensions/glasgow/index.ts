import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { init } from "./exec.ts";
import { registerDeviceTools } from "./tools/device.ts";
import { registerUartTools } from "./tools/uart.ts";
import { registerI2cTools } from "./tools/i2c.ts";
import { registerSpiTools } from "./tools/spi.ts";
import { registerJtagTools } from "./tools/jtag.ts";
import { registerSwdTools } from "./tools/swd.ts";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerGpioTools } from "./tools/gpio.ts";
import { registerAnalyzerTools } from "./tools/analyzer.ts";
import { registerProgramTools } from "./tools/program.ts";
import { registerSensorTools } from "./tools/sensor.ts";
import { registerMiscTools } from "./tools/misc.ts";
import { registerAdvancedTools } from "./tools/advanced.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		init(pi, ctx.cwd);
		ctx.ui.setStatus("glasgow", "🔧 Glasgow Interface Explorer");
	});


	registerDeviceTools(pi);
	registerUartTools(pi);
	registerI2cTools(pi);
	registerSpiTools(pi);
	registerJtagTools(pi);
	registerSwdTools(pi);
	registerMemoryTools(pi);
	registerGpioTools(pi);
	registerAnalyzerTools(pi);
	registerProgramTools(pi);
	registerSensorTools(pi);
	registerMiscTools(pi);
	registerAdvancedTools(pi);
}

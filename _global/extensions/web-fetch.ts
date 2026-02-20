/**
 * Web Fetch Tool - Fetches web content via HTTP/HTTPS
 *
 * This tool wraps the agentkit web-fetch CLI to fetch URLs with proper truncation.
 * Supports various HTTP methods, custom headers, and content extraction.
 *
 * Features:
 * - Multiple HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD)
 * - Custom headers and request body
 * - HTML text extraction
 * - Response header display
 * - Save to file option
 * - Configurable timeout
 * - Proper output truncation with temp file fallback
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    formatSize,
    type TruncationResult,
    truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, writeFileSync, realpathSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const WebFetchParams = Type.Object({
    url: Type.String({ description: "URL to fetch" }),
    method: Type.Optional(
        StringEnum(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"], {
            description: "HTTP method",
            default: "GET",
        })
    ),
    headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Custom request headers" })),
    body: Type.Optional(Type.String({ description: "Request body for POST/PUT/PATCH" })),
    raw: Type.Optional(Type.Boolean({ description: "Don't extract text from HTML, show raw content", default: false })),
    show_headers: Type.Optional(Type.Boolean({ description: "Include response headers", default: false })),
    save_to: Type.Optional(Type.String({ description: "Save response to file instead of returning content" })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds", default: 30 })),
});

interface WebFetchDetails {
    url: string;
    method: string;
    status?: number;
    contentType?: string;
    contentLength?: number;
    saved?: boolean;
    savePath?: string;
    truncation?: TruncationResult;
    fullOutputPath?: string;
    error?: string;
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "web_fetch",
        label: "Web Fetch",
        description: `Fetch web content via HTTP/HTTPS. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
        parameters: WebFetchParams,

        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const { url, method = "GET", headers, body, raw = false, show_headers = false, save_to, timeout = 30 } = params;

            // Find flake root by walking up from the real extension path
            // The extension may be loaded via symlink (~/.pi/agent/extensions/ -> _global/extensions/)
            let flakeRoot = path.dirname(realpathSync(fileURLToPath(import.meta.url)));
            while (flakeRoot !== path.dirname(flakeRoot)) {
                if (existsSync(path.join(flakeRoot, "flake.nix"))) break;
                flakeRoot = path.dirname(flakeRoot);
            }

            // Build arguments for web-fetch CLI
            const args = ["run", `${flakeRoot}#web-fetch`, "--"];
            
            // Always use JSON output for parsing
            if (!save_to) {
                args.push("--json");
            }
            
            if (method !== "GET") {
                args.push("--method", method);
            }
            
            if (headers) {
                for (const [key, value] of Object.entries(headers)) {
                    args.push("--header", `${key}: ${value}`);
                }
            }
            
            if (body) {
                args.push("--data", body);
            }
            
            if (raw) {
                args.push("--raw");
            }
            
            if (show_headers) {
                args.push("--headers");
            }
            
            if (save_to) {
                args.push("--output", save_to);
            }
            
            if (timeout !== 30) {
                args.push("--timeout", timeout.toString());
            }
            
            args.push(url);

            const details: WebFetchDetails = {
                url,
                method,
            };

            let output: string;
            try {
                const result = await pi.exec("nix", args, {
                    cwd: ctx.cwd,
                    signal,
                });
                
                if (result.code !== 0) {
                    details.error = result.stderr || "Unknown error";
                    return {
                        content: [{ type: "text", text: `Error fetching ${url}: ${details.error}` }],
                        details,
                        isError: true,
                    };
                }
                
                output = result.stdout;
            } catch (err: any) {
                details.error = err.message;
                return {
                    content: [{ type: "text", text: `Error executing web-fetch: ${err.message}` }],
                    details,
                    isError: true,
                };
            }

            // If saved to file, parse the simple output
            if (save_to) {
                details.saved = true;
                details.savePath = save_to;
                return {
                    content: [{
                        type: "text",
                        text: output.trim(),
                    }],
                    details,
                };
            }

            // Parse JSON output from web-fetch CLI
            let responseData: any;
            try {
                responseData = JSON.parse(output);
            } catch (err) {
                details.error = "Invalid JSON response from web-fetch";
                return {
                    content: [{ type: "text", text: `Error parsing web-fetch output: ${output}` }],
                    details,
                    isError: true,
                };
            }

            // Extract metadata
            details.status = responseData.status;
            details.contentType = responseData.content_type;
            details.contentLength = responseData.size;

            // Check if binary content
            if (responseData.binary) {
                return {
                    content: [{
                        type: "text",
                        text: responseData.message || "Binary content detected. Use save_to parameter to save to a file.",
                    }],
                    details,
                };
            }

            // Build content from the response
            let content = "";
            
            // Add headers if present
            if (responseData.headers && show_headers) {
                content += "Headers:\n";
                for (const [key, value] of Object.entries(responseData.headers)) {
                    content += `  ${key}: ${value}\n`;
                }
                content += "\n";
            }

            // Add main content based on type
            if (responseData.html) {
                // HTML content was extracted
                if (responseData.html.title) {
                    content += `Title: ${responseData.html.title}\n`;
                }
                if (responseData.html.description) {
                    content += `Description: ${responseData.html.description}\n`;
                }
                if (responseData.html.error) {
                    content += `\nError: ${responseData.html.error}\n`;
                    if (responseData.html.raw_html) {
                        content += `\nRaw HTML (truncated):\n${responseData.html.raw_html}`;
                    }
                } else if (responseData.html.text) {
                    content += `\nContent:\n${responseData.html.text}`;
                }
            } else if (responseData.json !== undefined) {
                // JSON content
                content += JSON.stringify(responseData.json, null, 2);
            } else if (responseData.text) {
                // Plain text or other content
                content += responseData.text;
            }

            if (!content.trim()) {
                return {
                    content: [{ type: "text", text: `Empty response from ${url}` }],
                    details,
                };
            }

            // Apply truncation
            const truncation = truncateHead(content, {
                maxLines: DEFAULT_MAX_LINES,
                maxBytes: DEFAULT_MAX_BYTES,
            });

            let resultText = truncation.content;

            if (truncation.truncated) {
                // Save full output to temp file
                const tempDir = mkdtempSync(join(tmpdir(), "pi-web-fetch-"));
                const tempFile = join(tempDir, "response.txt");
                writeFileSync(tempFile, content);

                details.truncation = truncation;
                details.fullOutputPath = tempFile;

                // Add truncation notice
                const truncatedLines = truncation.totalLines - truncation.outputLines;
                const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

                resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
                resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
                resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
                resultText += ` Full output saved to: ${tempFile}.`;
                resultText += ` IMPORTANT: Use the read tool with offset=${truncation.outputLines + 1} to continue reading the remaining output from this file.]`;
            }

            return {
                content: [{ type: "text", text: resultText }],
                details,
            };
        },

        // Custom rendering of the tool call
        renderCall(args, theme) {
            const method = args.method || "GET";
            let text = theme.fg("toolTitle", theme.bold("web_fetch "));
            text += theme.fg("accent", method);
            text += " " + theme.fg("link", args.url);
            
            if (args.save_to) {
                text += theme.fg("muted", ` → ${args.save_to}`);
            }
            
            return new Text(text, 0, 0);
        },

        // Custom rendering of the tool result
        renderResult(result, { expanded, isPartial }, theme) {
            const details = result.details as WebFetchDetails | undefined;

            // Handle streaming/partial results
            if (isPartial) {
                return new Text(theme.fg("warning", "Fetching..."), 0, 0);
            }

            // Handle errors
            if (!details || details.error) {
                return new Text(theme.fg("error", `Error: ${details?.error || "Unknown error"}`), 0, 0);
            }

            // Build result display
            let text = "";
            
            if (details.status) {
                const statusColor = details.status >= 200 && details.status < 300 ? "success" : "warning";
                text += theme.fg(statusColor, `${details.status}`);
            }
            
            if (details.contentType) {
                text += theme.fg("dim", ` • ${details.contentType}`);
            }
            
            if (details.contentLength !== undefined) {
                text += theme.fg("dim", ` • ${formatSize(details.contentLength)}`);
            }

            // Show truncation warning if applicable
            if (details.truncation?.truncated) {
                text += " " + theme.fg("warning", "(truncated)");
            }

            // Show save path if saved
            if (details.saved && details.savePath) {
                text += `\n${theme.fg("success", `Saved to: ${details.savePath}`)}`;
            }

            // In expanded view, show preview of content
            if (expanded && !details.saved) {
                const content = result.content[0];
                if (content?.type === "text") {
                    // Show first 10 lines in expanded view
                    const lines = content.text.split("\n").slice(0, 10);
                    for (const line of lines) {
                        text += `\n${theme.fg("dim", line)}`;
                    }
                    if (content.text.split("\n").length > 10) {
                        text += `\n${theme.fg("muted", "... (use read tool to see full output)")}`;
                    }
                }

                // Show temp file path if truncated
                if (details.fullOutputPath) {
                    text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
                }
            }

            return new Text(text, 0, 0);
        },
    });
}

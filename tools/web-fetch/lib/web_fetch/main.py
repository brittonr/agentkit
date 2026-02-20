"""
Web Fetch CLI - Fetch and extract content from web pages
"""

import argparse
import gzip
import json
import sys
import zlib
from dataclasses import dataclass
from io import BytesIO
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

try:
    from bs4 import BeautifulSoup
except ImportError:
    BeautifulSoup = None  # type: ignore[misc,assignment]

MAX_SIZE_DEFAULT = 1024 * 1024  # 1MB
TIMEOUT_DEFAULT = 30
OUTPUT_TRUNCATE_SIZE = 50 * 1024  # 50KB
USER_AGENT_DEFAULT = "web-fetch/1.0"

# Content types to treat as text
TEXT_CONTENT_TYPES = {
    "text/html",
    "text/plain",
    "text/xml",
    "application/xml",
    "application/json",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
    "text/css",
}


@dataclass
class FetchResult:
    """Result from fetching a URL."""

    url: str
    status: int
    headers: dict[str, str]
    content: bytes
    content_type: str
    charset: str


def decompress_content(content: bytes, encoding: str) -> bytes:
    """Decompress content based on Content-Encoding header."""
    if encoding == "gzip":
        return gzip.decompress(content)
    elif encoding == "deflate":
        try:
            return zlib.decompress(content)
        except zlib.error:
            # Some servers send raw deflate data
            return zlib.decompress(content, -zlib.MAX_WBITS)
    return content


def fetch_url(
    url: str,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = TIMEOUT_DEFAULT,
    max_size: int = MAX_SIZE_DEFAULT,
    user_agent: str = USER_AGENT_DEFAULT,
) -> FetchResult:
    """
    Fetch a URL and return structured result.

    Args:
        url: URL to fetch
        method: HTTP method (GET, POST, etc.)
        headers: Custom headers to send
        data: Request body for POST/PUT/PATCH
        timeout: Request timeout in seconds
        max_size: Maximum download size in bytes
        user_agent: User-Agent string

    Returns:
        FetchResult with response data

    Raises:
        ValueError: For invalid URLs or parameters
        RuntimeError: For network errors
    """
    # Validate URL
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        msg = f"Only http and https URLs are supported, got: {parsed.scheme}"
        raise ValueError(msg)

    # Prepare request
    request_headers = {
        "User-Agent": user_agent,
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
    }
    if headers:
        request_headers.update(headers)

    # Create request
    request = Request(url, data=data, headers=request_headers, method=method)  # noqa: S310

    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310
            # Read content with size limit
            content = BytesIO()
            chunk_size = 8192
            total_size = 0

            while True:
                chunk = response.read(chunk_size)
                if not chunk:
                    break
                total_size += len(chunk)
                if total_size > max_size:
                    msg = f"Response size exceeds maximum ({max_size} bytes)"
                    raise RuntimeError(msg)
                content.write(chunk)

            content_bytes = content.getvalue()

            # Get headers
            headers_dict = dict(response.headers)

            # Decompress if needed
            encoding = response.headers.get("Content-Encoding", "").lower()
            if encoding:
                content_bytes = decompress_content(content_bytes, encoding)

            # Parse content type and charset
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            ct_parts = content_type.split(";")
            ct_main = ct_parts[0].strip().lower()
            charset = "utf-8"
            for part in ct_parts[1:]:
                if "charset=" in part:
                    charset = part.split("=", 1)[1].strip().strip('"\'')
                    break

            return FetchResult(
                url=response.geturl(),  # May differ due to redirects
                status=response.status,
                headers=headers_dict,
                content=content_bytes,
                content_type=ct_main,
                charset=charset,
            )

    except HTTPError as e:
        msg = f"HTTP {e.code} {e.reason}: {url}"
        raise RuntimeError(msg) from e
    except URLError as e:
        if "timed out" in str(e.reason).lower():
            msg = f"Request timed out after {timeout}s: {url}"
        elif "ssl" in str(e.reason).lower():
            msg = f"SSL error: {url}: {e.reason}"
        else:
            msg = f"Network error: {url}: {e.reason}"
        raise RuntimeError(msg) from e
    except OSError as e:
        msg = f"Connection error: {url}: {e}"
        raise RuntimeError(msg) from e


def extract_html_text(html_content: str) -> dict[str, Any]:
    """
    Extract readable text from HTML.

    Returns:
        Dictionary with title, description, and text content
    """
    if BeautifulSoup is None:
        return {
            "error": "BeautifulSoup not available - install beautifulsoup4",
            "raw_html": html_content[:1000] + "..." if len(html_content) > 1000 else html_content,
        }

    soup = BeautifulSoup(html_content, "html.parser")

    # Extract title
    title = None
    title_tag = soup.find("title")
    if title_tag:
        title = title_tag.get_text().strip()

    # Extract meta description
    description = None
    meta_desc = soup.find("meta", attrs={"name": "description"}) or soup.find(
        "meta", property="og:description"
    )
    if meta_desc and meta_desc.get("content"):
        description = meta_desc["content"].strip()

    # Remove unwanted elements
    for element in soup(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        element.decompose()

    # Get text content
    text = soup.get_text(separator="\n", strip=True)

    # Clean up extra whitespace
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    text = "\n".join(lines)

    return {
        "title": title,
        "description": description,
        "text": text,
    }


def format_output(
    result: FetchResult,
    show_headers: bool = False,
    raw: bool = False,
    json_output: bool = False,
) -> str:
    """
    Format the fetch result for display.

    Args:
        result: FetchResult to format
        show_headers: Include response headers
        raw: Don't process HTML
        json_output: Output as JSON

    Returns:
        Formatted string for output
    """
    output_parts = []

    # Add URL and status
    if not json_output:
        output_parts.append(f"URL: {result.url}")
        output_parts.append(f"Status: {result.status}")
        output_parts.append(f"Content-Type: {result.content_type}")
        output_parts.append(f"Size: {len(result.content)} bytes")

    # Add headers if requested
    if show_headers and not json_output:
        output_parts.append("\nHeaders:")
        for key, value in sorted(result.headers.items()):
            output_parts.append(f"  {key}: {value}")

    # Determine if content is text
    is_text = any(
        result.content_type.startswith(ct) for ct in TEXT_CONTENT_TYPES
    ) or result.content_type.startswith("text/")

    if not is_text:
        # Binary content
        if json_output:
            return json.dumps(
                {
                    "url": result.url,
                    "status": result.status,
                    "content_type": result.content_type,
                    "size": len(result.content),
                    "binary": True,
                    "message": "Binary content - use --output to save to file",
                },
                indent=2,
            )
        else:
            output_parts.append("\nBinary content detected.")
            output_parts.append("Use --output to save to a file.")
            return "\n".join(output_parts)

    # Decode text content
    try:
        text = result.content.decode(result.charset)
    except (UnicodeDecodeError, LookupError):
        try:
            text = result.content.decode("utf-8", errors="replace")
        except Exception:
            text = result.content.decode("latin-1", errors="replace")

    # Process based on content type
    if json_output:
        # JSON output mode
        output_data: dict[str, Any] = {
            "url": result.url,
            "status": result.status,
            "content_type": result.content_type,
            "size": len(result.content),
        }

        if show_headers:
            output_data["headers"] = result.headers

        if result.content_type == "application/json":
            if not text.strip():
                output_data["text"] = "(empty body)"
            else:
                try:
                    output_data["json"] = json.loads(text)
                except json.JSONDecodeError:
                    output_data["text"] = text
        elif result.content_type == "text/html" and not raw:
            output_data["html"] = extract_html_text(text)
        else:
            output_data["text"] = text

        return json.dumps(output_data, indent=2, ensure_ascii=False)

    # Text output mode
    if not json_output:
        output_parts.append("")  # Blank line before content

    if result.content_type == "application/json":
        # Pretty-print JSON (HEAD requests return empty body)
        if not text.strip():
            output_parts.append("(empty body)")
        else:
            try:
                parsed = json.loads(text)
                formatted = json.dumps(parsed, indent=2, ensure_ascii=False)
                output_parts.append(formatted)
            except json.JSONDecodeError as e:
                output_parts.append(f"Warning: Invalid JSON ({e})")
                output_parts.append(text)
    elif result.content_type == "text/html" and not raw:
        # Extract readable text from HTML
        extracted = extract_html_text(text)
        if "error" in extracted:
            output_parts.append(f"Error: {extracted['error']}")
            output_parts.append("\nRaw HTML (truncated):")
            output_parts.append(extracted.get("raw_html", ""))
        else:
            if extracted.get("title"):
                output_parts.append(f"Title: {extracted['title']}")
            if extracted.get("description"):
                output_parts.append(f"Description: {extracted['description']}")
            output_parts.append("\nContent:")
            output_parts.append(extracted["text"])
    else:
        # Plain text or raw mode
        output_parts.append(text)

    result_text = "\n".join(output_parts)

    # Truncate if too long
    if len(result_text) > OUTPUT_TRUNCATE_SIZE:
        result_text = result_text[:OUTPUT_TRUNCATE_SIZE]
        result_text += f"\n\n... (truncated, showing first {OUTPUT_TRUNCATE_SIZE} bytes)"

    return result_text


def parse_size(size_str: str) -> int:
    """Parse a size string like '1M', '500K', '10MB' to bytes."""
    size_str = size_str.strip().upper()
    multipliers = {
        "K": 1024,
        "KB": 1024,
        "M": 1024 * 1024,
        "MB": 1024 * 1024,
        "G": 1024 * 1024 * 1024,
        "GB": 1024 * 1024 * 1024,
    }

    for suffix, multiplier in multipliers.items():
        if size_str.endswith(suffix):
            try:
                num = float(size_str[: -len(suffix)])
                return int(num * multiplier)
            except ValueError:
                pass

    try:
        return int(size_str)
    except ValueError:
        msg = f"Invalid size format: {size_str}"
        raise ValueError(msg)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Web Fetch - Fetch and extract content from web pages",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  web-fetch https://example.com
  web-fetch https://api.example.com/data --json
  web-fetch https://example.com --headers --raw
  web-fetch https://example.com --output page.html
  web-fetch https://api.example.com --method POST --data '{"key":"value"}'
  web-fetch https://example.com --header "Authorization: Bearer token"
  web-fetch https://example.com https://example.org
""",
    )

    parser.add_argument(
        "urls",
        nargs="+",
        help="URL(s) to fetch",
    )

    parser.add_argument(
        "--headers",
        action="store_true",
        help="Show response headers",
    )

    parser.add_argument(
        "--raw",
        action="store_true",
        help="Don't extract text from HTML, show raw content",
    )

    parser.add_argument(
        "--json",
        action="store_true",
        help="Output as JSON",
    )

    parser.add_argument(
        "--method",
        default="GET",
        choices=["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
        help="HTTP method (default: GET)",
    )

    parser.add_argument(
        "--data",
        help="Request body for POST/PUT/PATCH",
    )

    parser.add_argument(
        "--header",
        action="append",
        dest="custom_headers",
        help="Custom request header (format: 'Name: Value'), can be specified multiple times",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=TIMEOUT_DEFAULT,
        help=f"Request timeout in seconds (default: {TIMEOUT_DEFAULT})",
    )

    parser.add_argument(
        "--max-size",
        default=f"{MAX_SIZE_DEFAULT}",
        help=f"Maximum download size (default: 1M), supports K/M/G suffixes",
    )

    parser.add_argument(
        "--output",
        "-o",
        help="Save content to file instead of stdout",
    )

    parser.add_argument(
        "--user-agent",
        default=USER_AGENT_DEFAULT,
        help=f"Custom User-Agent string (default: {USER_AGENT_DEFAULT})",
    )

    args = parser.parse_args()

    # Parse custom headers
    headers = {}
    if args.custom_headers:
        for header in args.custom_headers:
            if ":" not in header:
                print(f"Error: Invalid header format: {header}", file=sys.stderr)
                print("Expected format: 'Name: Value'", file=sys.stderr)
                sys.exit(1)
            name, value = header.split(":", 1)
            headers[name.strip()] = value.strip()

    # Parse max size
    try:
        max_size = parse_size(args.max_size)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Prepare request data
    data = None
    if args.data:
        data = args.data.encode("utf-8")

    # Process each URL
    results = []
    errors = []

    for url in args.urls:
        try:
            result = fetch_url(
                url,
                method=args.method,
                headers=headers,
                data=data,
                timeout=args.timeout,
                max_size=max_size,
                user_agent=args.user_agent,
            )

            # Save to file if requested
            if args.output:
                if len(args.urls) > 1:
                    # Multiple URLs - append index to filename
                    base, ext = args.output.rsplit(".", 1) if "." in args.output else (args.output, "")
                    output_file = f"{base}_{len(results)}.{ext}" if ext else f"{base}_{len(results)}"
                else:
                    output_file = args.output

                with open(output_file, "wb") as f:
                    f.write(result.content)
                print(f"Saved to: {output_file}")
            else:
                # Format and print
                formatted = format_output(
                    result,
                    show_headers=args.headers,
                    raw=args.raw,
                    json_output=args.json,
                )
                results.append(formatted)

        except (ValueError, RuntimeError) as e:
            errors.append(f"Error fetching {url}: {e}")

    # Print results
    if results:
        if len(results) > 1 and not args.json:
            # Multiple results - separate with dividers
            for i, formatted in enumerate(results):
                if i > 0:
                    print("\n" + "=" * 70 + "\n")
                print(formatted)
        elif len(results) == 1:
            print(results[0])
        elif args.json:
            # Multiple JSON results
            print(json.dumps(results, indent=2))

    # Print errors
    if errors:
        for error in errors:
            print(error, file=sys.stderr)

    # Exit with error if any URLs failed
    if errors and not results:
        sys.exit(1)
    elif errors:
        sys.exit(2)  # Partial failure


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)

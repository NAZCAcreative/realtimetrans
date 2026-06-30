export function GET() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0070f3"/><path d="M8 10h16v8H13l-5 5V10z" fill="white"/><path d="M12 13h8M12 16h6" stroke="#0070f3" stroke-width="2" stroke-linecap="round"/></svg>`;

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    },
  });
}
